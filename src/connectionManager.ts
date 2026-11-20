import * as vscode from 'vscode';
import { createDriver } from './drivers';
import type { ConnectionConfig, Driver } from './types';

const CONNECTIONS_KEY = 'dbDeck.connections';
const passwordKey = (id: string) => `dbDeck.password.${id}`;

/**
 * Saved connections live in globalState; passwords only in SecretStorage.
 * Drivers are opened on first use and kept until disconnect.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly drivers = new Map<string, Promise<Driver>>();
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

  async add(config: ConnectionConfig, password: string | undefined): Promise<void> {
    if (password) await this.context.secrets.store(passwordKey(config.id), password);
    await this.context.globalState.update(CONNECTIONS_KEY, [...this.list(), config]);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.context.secrets.delete(passwordKey(id));
    await this.context.globalState.update(
      CONNECTIONS_KEY,
      this.list().filter((c) => c.id !== id),
    );
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
    if (!pending) return;
    this.drivers.delete(id);
    this.connected.delete(id);
    this.changed.fire();
    try {
      await (await pending).close();
    } catch {
      // Already broken or never connected; nothing to close.
    }
  }

  /** Connects with an unsaved config and lists tables, so the wizard can report problems before saving. */
  static async test(config: ConnectionConfig, password: string | undefined): Promise<void> {
    const driver = createDriver(config, password);
    try {
      await driver.connect();
      await driver.listTables();
    } finally {
      await driver.close().catch(() => undefined);
    }
  }

  dispose(): void {
    for (const id of [...this.drivers.keys()]) void this.disconnect(id);
    this.changed.dispose();
  }

  private async open(id: string): Promise<Driver> {
    const config = this.get(id);
    if (!config) throw new Error('This connection no longer exists.');
    const password = await this.context.secrets.get(passwordKey(id));
    const driver = createDriver(config, password);
    await driver.connect();
    return driver;
  }
}
