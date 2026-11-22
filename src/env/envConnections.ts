import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DB_KINDS } from '../drivers';
import type { ConnectionConfig } from '../types';
import { COMPOSE_FILES, composeDatabases, publishedPort } from './compose';
import { detectConnections, type EnvSource } from './detect';
import { parseDotenv } from './dotenv';

const ENV_FILES_SETTING = 'dbDeck.envFiles';
/** .env connections marked read-only (by id), per workspace. */
const ENV_READ_ONLY_KEY = 'dbDeck.envReadOnly';

export interface EnvConnection {
  config: ConnectionConfig;
  /** From the file; kept in memory only. */
  password?: string;
  file: vscode.Uri;
  /** "<workspace folder> · <file name>", the tree group it's shown in. */
  group: string;
  keys: string[];
  /** Set when DB_HOST named a Docker Compose service and the published port is used instead. */
  via?: string;
}

/**
 * Connections read live from the .env files at the root of each workspace folder (setting `dbDeck.envFiles`).
 * Nothing is stored except read-only marks: settings and passwords are re-read from the file when it changes,
 * and passwords never leave memory. VS Code doesn't run DB Deck in Restricted Mode, so only trusted
 * workspaces are read.
 */
export class EnvConnections implements vscode.Disposable {
  private connections: EnvConnection[] = [];
  private watchers: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<{ changedIds: string[] }>();
  /** Fires after a re-read; `changedIds` are connections whose settings or password changed or that went away. */
  readonly onDidChange = this.changed.event;
  private reloading?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.restart()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(ENV_FILES_SETTING)) this.restart();
      }),
    );
    this.restart();
  }

  list(): EnvConnection[] {
    return this.connections;
  }

  get(id: string): EnvConnection | undefined {
    return this.connections.find((c) => c.config.id === id);
  }

  async setReadOnly(id: string, readOnly: boolean): Promise<void> {
    const ids = new Set(this.context.workspaceState.get<string[]>(ENV_READ_ONLY_KEY, []));
    if (readOnly) ids.add(id);
    else ids.delete(id);
    await this.context.workspaceState.update(ENV_READ_ONLY_KEY, [...ids]);
    await this.reload();
  }

  /** Re-reads every .env now (also done on file changes). */
  reload(): Promise<void> {
    // Serialized, so a burst of file events can't interleave two reads.
    const run = (this.reloading ?? Promise.resolve()).then(() => this.read());
    this.reloading = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    for (const d of [...this.watchers, ...this.subscriptions]) d.dispose();
    this.changed.dispose();
  }

  private restart(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // Compose files too: their published ports decide where a Docker database is reachable.
      for (const name of [...envFileNames(), ...COMPOSE_FILES]) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, name));
        const reload = () => void this.reload();
        watcher.onDidChange(reload);
        watcher.onDidCreate(reload);
        watcher.onDidDelete(reload);
        this.watchers.push(watcher);
      }
    }
    void this.reload();
  }

  private async read(): Promise<void> {
    const readOnly = new Set(this.context.workspaceState.get<string[]>(ENV_READ_ONLY_KEY, []));
    const next: EnvConnection[] = [];
    const composeFound: EnvConnection[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const compose = await readCompose(folder.uri);
      // Docker Compose fills ${VAR} in the compose file from the project's `.env`.
      let composeVars = new Map<string, string>();
      for (const name of envFileNames()) {
        const file = vscode.Uri.joinPath(folder.uri, name);
        let text: string;
        try {
          text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        } catch {
          continue; // no such file
        }
        const dir = path.dirname(file.fsPath);
        const vars = parseDotenv(text);
        if (name === '.env') composeVars = vars;
        const detected = detectConnections(vars, { kinds: DB_KINDS, dir, exists: (f) => fs.existsSync(f) });
        for (const d of detected) {
          const id = envId(folder.uri, name, d.source);
          // DB_HOST=pgsql (a Compose service) only resolves inside Docker: use its published port here.
          const docker =
            compose && d.config.host && d.config.port ? publishedPort(compose.text, compose.name, d.config.host, d.config.port, vars) : undefined;
          next.push({
            config: {
              ...d.config,
              ...(docker ? { host: docker.host, port: docker.port } : {}),
              id,
              source: 'env',
              ...(readOnly.has(id) ? { readOnly: true } : {}),
            },
            via: docker?.via,
            password: d.password,
            file,
            group: `${folder.name} · ${name}`,
            keys: d.keys,
          });
        }
      }
      // Databases in the compose file, also when there's no .env (see below for duplicates).
      if (compose) {
        const file = vscode.Uri.joinPath(folder.uri, compose.name);
        for (const db of composeDatabases(compose.text, compose.name, composeVars, DB_KINDS)) {
          const id = envId(folder.uri, compose.name, `service:${db.service}`);
          composeFound.push({
            config: { ...db.config, id, source: 'env', ...(readOnly.has(id) ? { readOnly: true } : {}) },
            via: db.via,
            password: db.password,
            file,
            group: `${folder.name} · ${compose.name}`,
            keys: [`services.${db.service}`, ...db.keys],
          });
        }
      }
    }
    // A compose database that a .env connection already reaches (same type, host and port) is shown once,
    // from .env: it has the app's own user, password and database.
    next.push(...composeFound.filter((c) => !next.some((e) => sameAddress(e.config, c.config))));
    const before = new Map(this.connections.map((c) => [c.config.id, c]));
    const changedIds = [...before.keys()].filter((id) => {
      const now = next.find((c) => c.config.id === id);
      const was = before.get(id)!;
      return !now || JSON.stringify(now.config) !== JSON.stringify(was.config) || now.password !== was.password;
    });
    this.connections = next;
    this.changed.fire({ changedIds });
  }
}

/** The first compose file Docker would use in this folder, or undefined. */
async function readCompose(folder: vscode.Uri): Promise<{ name: string; text: string } | undefined> {
  for (const name of COMPOSE_FILES) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name)));
      return { name, text };
    } catch {
      // not there; try the next name
    }
  }
  return undefined;
}

/** File names from the setting; anything with a path separator is ignored (only the folder root is read). */
function envFileNames(): string[] {
  const names = vscode.workspace.getConfiguration().get<unknown>(ENV_FILES_SETTING, ['.env']);
  if (!Array.isArray(names)) return ['.env'];
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && !!n && !/[\\/]/.test(n) && n !== '.' && n !== '..'))];
}

/** Same database server: type, port and host, with localhost / 127.0.0.1 / ::1 treated as one. */
function sameAddress(a: ConnectionConfig, b: ConnectionConfig): boolean {
  const local = (h?: string) => (h === '127.0.0.1' || h === '::1' || h === '[::1]' ? 'localhost' : h?.toLowerCase());
  return a.type === b.type && a.port === b.port && local(a.host) === local(b.host);
}

/** Stable across reloads, so editor links, history and saved queries keep pointing at the connection. */
function envId(folder: vscode.Uri, file: string, source: EnvSource | `service:${string}`): string {
  return `env:${createHash('sha256').update(`${folder.toString()}\u0000${file}\u0000${source}`).digest('hex').slice(0, 16)}`;
}
