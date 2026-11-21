import * as vscode from 'vscode';
import { createDriver, USES_NETWORK } from './drivers';
import { SshTunnel } from './ssh/sshTunnel';
import type { ConnectionConfig, Driver, StreamOpener } from './types';

const CONNECTIONS_KEY = 'dbDeck.connections';
/** Trusted SSH host keys: `host:port` → fingerprint. Per SSH host, so they outlive a removed connection. */
const HOST_KEYS_KEY = 'dbDeck.sshHostKeys';
const passwordKey = (id: string) => `dbDeck.password.${id}`;
/** The SSH password or private key passphrase. */
const sshSecretKey = (id: string) => `dbDeck.sshSecret.${id}`;

/** Secrets typed in the wizard. On update, undefined keeps the stored one. */
export interface ConnectionSecrets {
  password?: string;
  sshSecret?: string;
}

/**
 * Saved connections live in globalState; passwords only in SecretStorage.
 * Drivers are opened on first use and kept until disconnect.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly drivers = new Map<string, Promise<Driver>>();
  /** SSH sessions of open connections; closed on disconnect. */
  private readonly tunnels = new Map<string, SshTunnel>();
  /** Host-key questions being asked, so two connections to the same new host ask once. */
  private readonly trusting = new Map<string, Promise<boolean>>();
  private readonly connected = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when connections are added/removed or connect/disconnect. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    return this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  isConnected(id: string): boolean {
    return this.connected.has(id);
  }

  async add(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<void> {
    if (secrets.password) await this.context.secrets.store(passwordKey(config.id), secrets.password);
    if (config.ssh && secrets.sshSecret) await this.context.secrets.store(sshSecretKey(config.id), secrets.sshSecret);
    await this.context.globalState.update(CONNECTIONS_KEY, [...this.list(), config]);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.context.secrets.delete(passwordKey(id));
    await this.context.secrets.delete(sshSecretKey(id));
    await this.context.globalState.update(
      CONNECTIONS_KEY,
      this.list().filter((c) => c.id !== id),
    );
    this.changed.fire();
  }

  /**
   * Saves changed settings and disconnects, so the next use connects with them. Secrets left undefined keep
   * the stored ones; the SSH secret is deleted when the connection no longer uses SSH.
   */
  async update(config: ConnectionConfig, secrets: ConnectionSecrets = {}): Promise<void> {
    await this.disconnect(config.id);
    if (secrets.password !== undefined) await this.storeOrDelete(passwordKey(config.id), secrets.password);
    if (!config.ssh) await this.context.secrets.delete(sshSecretKey(config.id));
    else if (secrets.sshSecret !== undefined) await this.storeOrDelete(sshSecretKey(config.id), secrets.sshSecret);
    await this.saveList(this.list().map((c) => (c.id === config.id ? config : c)));
  }

  /** The stored secrets, for testing an edited connection whose secrets weren't retyped. */
  async storedSecrets(id: string): Promise<ConnectionSecrets> {
    return {
      password: await this.context.secrets.get(passwordKey(id)),
      sshSecret: await this.context.secrets.get(sshSecretKey(id)),
    };
  }

  /** Folder names in use, sorted. A folder exists only while a connection is in it. */
  folders(): string[] {
    return [...new Set(this.list().flatMap((c) => (c.folder ? [c.folder] : [])))].sort((a, b) => a.localeCompare(b));
  }

  /** Moves a connection into a folder, or out of any folder (undefined). Doesn't disconnect. */
  async moveToFolder(id: string, folder: string | undefined): Promise<void> {
    await this.saveList(this.list().map((c) => (c.id === id ? withFolder(c, folder) : c)));
  }

  /** Renames a folder; renaming onto an existing folder merges them. */
  async renameFolder(from: string, to: string): Promise<void> {
    await this.saveList(this.list().map((c) => (c.folder === from ? withFolder(c, to) : c)));
  }

  /** Returns a connected driver, connecting first if needed. Concurrent callers share one attempt. */
  getDriver(id: string): Promise<Driver> {
    let pending = this.drivers.get(id);
    if (!pending) {
      const attempt = this.open(id);
      pending = attempt;
      this.drivers.set(id, attempt);
      attempt.then(
        () => {
          this.connected.add(id);
          this.changed.fire();
        },
        () => {
          if (this.drivers.get(id) === attempt) this.drivers.delete(id);
        },
      );
    }
    return pending;
  }

  async disconnect(id: string): Promise<void> {
    const pending = this.drivers.get(id);
    const tunnel = this.tunnels.get(id);
    this.tunnels.delete(id);
    if (pending) {
      this.drivers.delete(id);
      this.connected.delete(id);
      this.changed.fire();
      try {
        await (await pending).close();
      } catch {
        // Already broken or never connected; nothing to close.
      }
    }
    tunnel?.close();
  }

  /** Connects with an unsaved config and lists tables, so the wizard can report problems before saving. */
  async test(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<void> {
    const tunnel = this.tunnelFor(config, secrets.sshSecret);
    const driver = createDriver(config, secrets.password, tunnel && opener(tunnel));
    try {
      await driver.connect();
      await driver.listTables();
    } finally {
      await driver.close().catch(() => undefined);
      tunnel?.close();
    }
  }

  dispose(): void {
    for (const id of [...this.drivers.keys(), ...this.tunnels.keys()]) void this.disconnect(id);
    this.changed.dispose();
  }

  private async open(id: string): Promise<Driver> {
    const config = this.get(id);
    if (!config) throw new Error('This connection no longer exists.');
    const { password, sshSecret } = await this.storedSecrets(id);
    const tunnel = this.tunnelFor(config, sshSecret);
    if (tunnel) {
      this.tunnels.get(id)?.close();
      this.tunnels.set(id, tunnel);
    }
    const driver = createDriver(config, password, tunnel && opener(tunnel));
    try {
      await driver.connect();
    } catch (err) {
      if (tunnel && this.tunnels.get(id) === tunnel) {
        this.tunnels.delete(id);
        tunnel.close();
      }
      throw err;
    }
    return driver;
  }

  private tunnelFor(config: ConnectionConfig, sshSecret: string | undefined): SshTunnel | undefined {
    if (!config.ssh || !USES_NETWORK[config.type]) return undefined;
    return new SshTunnel(config.ssh, sshSecret, (host, port, print) => this.trustHostKey(host, port, print));
  }

  /** Trust on first use: ask once per SSH host, refuse silently changed keys unless the user accepts the new one. */
  private trustHostKey(host: string, port: number, print: string): Promise<boolean> {
    const key = `${host}:${port}`;
    const known = this.context.globalState.get<Record<string, string>>(HOST_KEYS_KEY, {});
    if (known[key] === print) return Promise.resolve(true);
    let pending = this.trusting.get(key);
    if (!pending) {
      pending = this.askHostKey(key, known[key], print).finally(() => this.trusting.delete(key));
      this.trusting.set(key, pending);
    }
    return pending;
  }

  private async askHostKey(key: string, previous: string | undefined, print: string): Promise<boolean> {
    const button = previous ? 'Trust New Key and Connect' : 'Trust and Connect';
    const choice = previous
      ? await vscode.window.showWarningMessage(
          `The SSH host key of ${key} has changed.`,
          {
            modal: true,
            detail:
              `Trusted key: ${previous}\nNew key: ${print}\n\n` +
              'This happens when the server was reinstalled or its keys were replaced, but it can also mean someone ' +
              'is intercepting the connection. Trust the new key only if you know why it changed.',
          },
          button,
        )
      : await vscode.window.showInformationMessage(
          `DB Deck hasn’t connected to the SSH host ${key} before.`,
          {
            modal: true,
            detail: `Its key fingerprint is:\n${print}\n\nIf you can, check it with the server’s administrator. DB Deck remembers the key and warns you if it changes.`,
          },
          button,
        );
    if (choice !== button) return false;
    const known = this.context.globalState.get<Record<string, string>>(HOST_KEYS_KEY, {});
    await this.context.globalState.update(HOST_KEYS_KEY, { ...known, [key]: print });
    return true;
  }

  private async storeOrDelete(key: string, value: string): Promise<void> {
    if (value) await this.context.secrets.store(key, value);
    else await this.context.secrets.delete(key);
  }

  private async saveList(list: ConnectionConfig[]): Promise<void> {
    await this.context.globalState.update(CONNECTIONS_KEY, list);
    this.changed.fire();
  }
}

function opener(tunnel: SshTunnel): StreamOpener {
  return (host, port) => tunnel.openStream(host, port);
}

function withFolder(config: ConnectionConfig, folder: string | undefined): ConnectionConfig {
  const { folder: _old, ...rest } = config;
  return folder ? { ...rest, folder } : rest;
}
