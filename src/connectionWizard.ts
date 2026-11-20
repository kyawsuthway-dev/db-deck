import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { DB_KINDS, type DbKind } from './drivers';
import type { ConnectionConfig, SslMode } from './types';

export interface WizardResult {
  config: ConnectionConfig;
  password?: string;
}

const SQLITE_FILTERS = { 'SQLite databases': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] };

/**
 * Asks for a new connection's settings step by step. Pressing Escape at any step cancels.
 * Pass a previous result to edit it (for example after a failed connection test).
 */
export async function runConnectionWizard(previous?: WizardResult): Promise<WizardResult | undefined> {
  const kind = previous ? kindOf(previous.config) : await pickKind();
  if (!kind) return undefined;
  const id = previous?.config.id ?? randomUUID();
  return kind.type === 'sqlite' ? sqliteSteps(id, previous) : serverSteps(id, kind, previous);
}

function kindOf(config: ConnectionConfig): DbKind {
  return DB_KINDS.find((k) => k.type === config.type)!;
}

async function pickKind(): Promise<DbKind | undefined> {
  const picked = await vscode.window.showQuickPick(
    DB_KINDS.map((dbKind) => ({ label: dbKind.label, dbKind })), // QuickPickItem reserves `kind`
    { title: 'Add Connection', placeHolder: 'Database type', ignoreFocusOut: true },
  );
  return picked?.dbKind;
}

async function sqliteSteps(id: string, previous?: WizardResult): Promise<WizardResult | undefined> {
  const title = 'Add SQLite Connection';
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(folder-opened) Open existing file…', create: false },
      { label: '$(new-file) Create new file…', create: true },
    ],
    { title, placeHolder: previous?.config.filePath ?? 'SQLite database file', ignoreFocusOut: true },
  );
  if (!choice) return undefined;

  const defaultUri = previous?.config.filePath
    ? vscode.Uri.file(previous.config.filePath)
    : vscode.workspace.workspaceFolders?.[0]?.uri;
  let filePath: string | undefined;
  if (choice.create) {
    const uri = await vscode.window.showSaveDialog({
      title,
      defaultUri: defaultUri && vscode.Uri.joinPath(defaultUri, 'database.sqlite'),
      filters: SQLITE_FILTERS,
    });
    filePath = uri?.fsPath;
    // An empty file is a valid empty SQLite database. Never truncate a file that already exists.
    if (filePath && !fs.existsSync(filePath)) fs.writeFileSync(filePath, new Uint8Array());
  } else {
    const uris = await vscode.window.showOpenDialog({ title, defaultUri, canSelectMany: false, filters: SQLITE_FILTERS });
    filePath = uris?.[0]?.fsPath;
  }
  if (!filePath) return undefined;

  const name = await ask(title, 'Connection name', previous?.config.name ?? path.basename(filePath), requireText);
  if (name === undefined) return undefined;
  return { config: { id, name, type: 'sqlite', filePath } };
}

async function serverSteps(id: string, kind: DbKind, previous?: WizardResult): Promise<WizardResult | undefined> {
  const prev = previous?.config;
  const title = `Add ${kind.label} Connection`;

  const host = await ask(title, 'Host', prev?.host ?? 'localhost', requireText);
  if (host === undefined) return undefined;

  const portText = await ask(title, 'Port', String(prev?.port ?? kind.defaultPort), (v) =>
    /^\d+$/.test(v.trim()) && +v >= 1 && +v <= 65535 ? undefined : 'Enter a port number between 1 and 65535',
  );
  if (portText === undefined) return undefined;

  const user = await ask(title, 'User', prev?.user ?? kind.defaultUser ?? '', requireText);
  if (user === undefined) return undefined;

  const password = await vscode.window.showInputBox({
    title,
    prompt: 'Password (stored in VS Code’s secret storage; leave empty for none)',
    value: previous?.password ?? '',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) return undefined;

  const database = await ask(
    title,
    kind.type === 'mysql' ? 'Database (optional; empty shows all databases)' : 'Database',
    prev?.database ?? kind.defaultDatabase ?? '',
    kind.type === 'mysql' ? undefined : requireText,
  );
  if (database === undefined) return undefined;

  const ssl = await vscode.window.showQuickPick(
    [
      { label: 'No SSL', description: 'Local or trusted network', value: 'off' as SslMode },
      { label: 'SSL', description: 'Verify the server certificate', value: 'require' as SslMode },
      { label: 'SSL, allow self-signed', description: 'Encrypted, certificate not verified', value: 'no-verify' as SslMode },
    ],
    { title, placeHolder: 'Encryption', ignoreFocusOut: true },
  );
  if (!ssl) return undefined;

  const defaultName = `${user}@${host}${database ? `/${database}` : ''}`;
  const name = await ask(title, 'Connection name', prev?.name ?? defaultName, requireText);
  if (name === undefined) return undefined;

  return {
    config: {
      id,
      name: name.trim(),
      type: kind.type,
      host: host.trim(),
      port: Number(portText),
      user: user.trim(),
      database: database.trim() || undefined,
      ssl: ssl.value,
    },
    password: password || undefined,
  };
}

function ask(title: string, prompt: string, value: string, validateInput?: (v: string) => string | undefined) {
  return vscode.window.showInputBox({ title, prompt, value, validateInput, ignoreFocusOut: true });
}

function requireText(value: string): string | undefined {
  return value.trim() ? undefined : 'Required';
}
