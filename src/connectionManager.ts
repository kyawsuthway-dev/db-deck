import * as vscode from 'vscode';
import { createDriver, USES_NETWORK } from './drivers';
import { errorMessage } from './drivers/common';
import type { EnvConnections } from './env/envConnections';
import { SshTunnel } from './ssh/sshTunnel';
import type { ConnectionConfig, ConnectionScope, Driver, StreamOpener } from './types';

const CONNECTIONS_KEY = 'dbDeck.connections';
/** Connections saved for this workspace only: private VS Code storage, never a file in the project. */
const WORKSPACE_CONNECTIONS_KEY = 'dbDeck.workspaceConnections';
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
 * Connections from three places: all workspaces (globalState), this workspace (workspaceState) and the
 * project's .env files (EnvConnections, read live). Passwords only in SecretStorage, or in memory for .env.
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

  private readonly envSubscription: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly env: EnvConnections,
  ) {
    // A .env edit that changes an open connection's settings closes it, so the next use reads the file again.
    this.envSubscription = env.onDidChange(({ changedIds }) => {
      const open = changedIds.filter((id) => this.drivers.has(id));
      for (const id of open) void this.disconnect(id);
      if (open.length) {
        void vscode.window.showInformationMessage(
          open.length === 1 ? 'A .env connection changed, so DB Deck disconnected it. It reconnects with the new settings when you next use it.' : `${open.length} .env connections changed, so DB Deck disconnected them. They reconnect with the new settings when you next use them.`,
        );
      }
      this.changed.fire();
    });
  }

  /** Every connection: all-workspace ones, then this workspace's, then .env ones. */
  list(): ConnectionConfig[] {
    return [
      ...this.stored('global'),
      ...this.stored('workspace').map((c) => ({ ...c, source: 'workspace' as const })),
      ...this.env.list().map((e) => e.config),
    ];
  }

  /** Whether "This Workspace" is possible: a folder or workspace is open. */
  hasWorkspace(): boolean {
    return !!vscode.workspace.workspaceFolders?.length;
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  isConnected(id: string): boolean {
    return this.connected.has(id);
  }

  async add(config: ConnectionConfig, secrets: ConnectionSecrets, scope: ConnectionScope = 'global'): Promise<void> {
    if (secrets.password) await this.context.secrets.store(passwordKey(config.id), secrets.password);
    if (config.ssh && secrets.sshSecret) await this.context.secrets.store(sshSecretKey(config.id), secrets.sshSecret);
    await this.saveStored(scope, [...this.stored(scope), withoutSource(config)]);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    const scope = this.scopeOf(id);
    if (!scope) return;
    await this.disconnect(id);
    await this.context.secrets.delete(passwordKey(id));
    await this.context.secrets.delete(sshSecretKey(id));
    await this.saveStored(scope, this.stored(scope).filter((c) => c.id !== id));
    this.changed.fire();
  }

  /**
   * Saves changed settings and disconnects, so the next use connects with them. Secrets left undefined keep
   * the stored ones; the SSH secret is deleted when the connection no longer uses SSH. `scope` moves the
   * connection between all workspaces and this workspace (same id, so its history and saved queries follow).
   */
  async update(config: ConnectionConfig, secrets: ConnectionSecrets = {}, scope?: ConnectionScope): Promise<void> {
    const from = this.scopeOf(config.id);
    if (!from) throw new Error(config.source === 'env' ? 'Connections from .env are edited in the .env file.' : 'This connection no longer exists.');
    const to = scope ?? from;
    await this.disconnect(config.id);
    if (secrets.password !== undefined) await this.storeOrDelete(passwordKey(config.id), secrets.password);
    if (!config.ssh) await this.context.secrets.delete(sshSecretKey(config.id));
    else if (secrets.sshSecret !== undefined) await this.storeOrDelete(sshSecretKey(config.id), secrets.sshSecret);
    const clean = withoutSource(config);
    if (to === from) {
      await this.saveStored(to, this.stored(to).map((c) => (c.id === config.id ? clean : c)));
    } else {
      await this.saveStored(to, [...this.stored(to), clean]);
      await this.saveStored(from, this.stored(from).filter((c) => c.id !== config.id));
    }
    this.changed.fire();
  }

  /** Where a saved connection is stored; undefined for .env connections and unknown ids. */
  scopeOf(id: string): ConnectionScope | undefined {
    if (this.stored('global').some((c) => c.id === id)) return 'global';
    if (this.stored('workspace').some((c) => c.id === id)) return 'workspace';
    return undefined;
  }

  /** .env connections: read-only on or off (the only setting they have outside the file). */
  setEnvReadOnly(id: string, readOnly: boolean): Promise<void> {
    return this.env.setReadOnly(id, readOnly);
  }

  /** The .env file a connection comes from, and the keys it was read from. */
  envInfo(id: string): { file: vscode.Uri; group: string; keys: string[]; via?: string } | undefined {
    const e = this.env.get(id);
    return e && { file: e.file, group: e.group, keys: e.keys, via: e.via };
  }

  /** The stored secrets, for testing an edited connection whose secrets weren't retyped. */
  async storedSecrets(id: string): Promise<ConnectionSecrets> {
    const env = this.env.get(id);
    if (env) return { password: env.password };
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
    const scope = this.scopeOf(id);
    if (!scope) return;
    await this.saveStored(scope, this.stored(scope).map((c) => (c.id === id ? withFolder(c, folder) : c)));
    this.changed.fire();
  }

  /** Renames a folder in both stores; renaming onto an existing folder merges them. */
  async renameFolder(from: string, to: string): Promise<void> {
    for (const scope of ['global', 'workspace'] as const) {
      await this.saveStored(scope, this.stored(scope).map((c) => (c.folder === from ? withFolder(c, to) : c)));
    }
    this.changed.fire();
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
    this.envSubscription.dispose();
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
      // A Docker database (reached through a compose published port) is usually just not started.
      if (this.env.get(id)?.via && (err as { code?: string }).code === 'ECONNREFUSED') {
        throw new Error(`${errorMessage(err)} Is the container running? Start it with \`docker compose up -d\`.`);
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

  private stored(scope: ConnectionScope): ConnectionConfig[] {
    return scope === 'global'
      ? this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, [])
      : this.context.workspaceState.get<ConnectionConfig[]>(WORKSPACE_CONNECTIONS_KEY, []);
  }

  private async saveStored(scope: ConnectionScope, list: ConnectionConfig[]): Promise<void> {
    if (scope === 'global') await this.context.globalState.update(CONNECTIONS_KEY, list);
    else await this.context.workspaceState.update(WORKSPACE_CONNECTIONS_KEY, list);
  }
}

function opener(tunnel: SshTunnel): StreamOpener {
  return (host, port) => tunnel.openStream(host, port);
}

/** `source` is derived when listing, never stored. */
function withoutSource(config: ConnectionConfig): ConnectionConfig {
  const { source: _source, ...rest } = config;
  return rest;
}

function withFolder(config: ConnectionConfig, folder: string | undefined): ConnectionConfig {
  const { folder: _old, ...rest } = config;
  return folder ? { ...rest, folder } : rest;
}
