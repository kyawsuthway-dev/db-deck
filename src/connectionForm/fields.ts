// The connection form's fields: initial values, and checking what the form sends back. No `vscode`,
// so it can be smoke-tested in plain Node. The form is a webview, so its messages are untrusted
// (webview.md): every field is checked here, never only in the form.
import * as path from 'path';
import type { ConnectionConfig, ConnectionScope, DbType, SshConfig, SslMode } from '../types';

/** Everything the form edits, as the form holds it (text inputs are strings). */
export interface FormValues {
  /** A DbKind label (MariaDB and MySQL share a type). */
  kind: string;
  name: string;
  folder: string;
  /** ConnectionScope: 'global' (all workspaces) or 'workspace'. */
  scope: string;
  host: string;
  port: string;
  user: string;
  /** Typed in the form. Empty: none when adding, keep the stored one when editing. */
  password: string;
  database: string;
  ssl: string;
  filePath: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: string;
  sshKeyPath: string;
  /** SSH password or key passphrase; empty keeps the stored one when that's possible (see checkForm). */
  sshSecret: string;
  readOnly: boolean;
}

/** What the form needs to know about each database kind (sent to the webview, so it needs no registry). */
export interface KindInfo {
  label: string;
  type: DbType;
  defaultPort?: number;
  defaultUser?: string;
  defaultDatabase?: string;
  /** Logo name (DbKind.logo). */
  logo: string;
  /** Can go through an SSH tunnel (USES_NETWORK). */
  network: boolean;
  /** none: a file; required/optional: the database field (DATABASE_SCOPE). */
  database: 'none' | 'required' | 'optional';
}

export type FieldErrors = Partial<Record<keyof FormValues, string>>;

export interface FormContext {
  mode: 'add' | 'edit';
  id: string;
  kinds: KindInfo[];
  /** The connection being edited. */
  existing?: ConnectionConfig;
  /** Editing: an SSH secret is stored, so an empty one can mean "keep". */
  hasSshSecret: boolean;
  /** A folder or workspace is open, so "This Workspace" is possible. */
  hasWorkspace: boolean;
  /** For SQLite paths; injected so this file stays free of I/O. */
  fileExists: (file: string) => boolean;
}

export type CheckedForm =
  | { ok: true; config: ConnectionConfig; scope: ConnectionScope; password?: string; sshSecret?: string }
  | { ok: false; errors: FieldErrors };

const SSL_MODES: Record<SslMode, true> = { off: true, require: true, 'no-verify': true };
const MAX_TEXT = 4096;
export const MAX_FOLDER = 100;

const STRING_FIELDS = [
  'kind', 'name', 'folder', 'scope', 'host', 'port', 'user', 'password', 'database', 'ssl', 'filePath',
  'sshHost', 'sshPort', 'sshUser', 'sshAuth', 'sshKeyPath', 'sshSecret',
] as const;
const BOOLEAN_FIELDS = ['sshEnabled', 'readOnly'] as const;

/** The form's values from an untrusted message, or undefined if it isn't shaped like FormValues. */
export function readValues(raw: unknown): FormValues | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  for (const f of STRING_FIELDS) if (typeof r[f] !== 'string' || (r[f] as string).length > MAX_TEXT) return undefined;
  for (const f of BOOLEAN_FIELDS) if (typeof r[f] !== 'boolean') return undefined;
  const values = {} as Record<string, unknown>;
  for (const f of [...STRING_FIELDS, ...BOOLEAN_FIELDS]) values[f] = r[f];
  return values as unknown as FormValues;
}

/**
 * The form's starting values: the connection being edited (or copied from .env), or the kind's defaults.
 * Never a password.
 */
export function initialValues(kind: KindInfo, existing?: Omit<ConnectionConfig, 'id'>): FormValues {
  const c = existing;
  return {
    kind: kind.label,
    name: c?.name ?? '',
    folder: c?.folder ?? '',
    scope: c?.source === 'workspace' ? 'workspace' : 'global',
    host: c?.host ?? (kind.network ? 'localhost' : ''),
    port: String(c?.port ?? kind.defaultPort ?? ''),
    user: c?.user ?? kind.defaultUser ?? '',
    password: '',
    database: c ? (c.database ?? '') : (kind.defaultDatabase ?? ''),
    ssl: c?.ssl ?? 'off',
    filePath: c?.filePath ?? '',
    sshEnabled: !!c?.ssh,
    sshHost: c?.ssh?.host ?? '',
    sshPort: String(c?.ssh?.port ?? 22),
    sshUser: c?.ssh?.user ?? '',
    sshAuth: c?.ssh?.auth ?? 'password',
    sshKeyPath: c?.ssh?.keyPath ?? '',
    sshSecret: '',
    readOnly: !!c?.readOnly,
  };
}

/** Checks the form and builds the connection. Secrets left undefined mean none (add) or keep (edit). */
export function checkForm(v: FormValues, ctx: FormContext): CheckedForm {
  const errors: FieldErrors = {};
  const editing = ctx.mode === 'edit' && ctx.existing;
  const kind = ctx.kinds.find((k) => k.label === v.kind);
  if (!kind) return { ok: false, errors: { kind: 'Choose a database type.' } };

  const folder = v.folder.trim();
  if (folder.length > MAX_FOLDER) errors.folder = `Use at most ${MAX_FOLDER} characters.`;
  if (v.scope !== 'global' && v.scope !== 'workspace') errors.scope = 'Choose where to save the connection.';
  else if (v.scope === 'workspace' && !ctx.hasWorkspace) errors.scope = 'Open a folder to save a connection for it.';
  const scope = v.scope as ConnectionScope;

  const base = {
    id: ctx.id,
    type: kind.type,
    ...(folder ? { folder } : {}),
    ...(v.readOnly ? { readOnly: true } : {}),
  };

  if (kind.database === 'none') {
    const filePath = v.filePath.trim();
    if (!filePath) errors.filePath = 'Choose a database file.';
    else if (!path.isAbsolute(filePath)) errors.filePath = 'Use a full path, or Browse….';
    else if (!ctx.fileExists(filePath)) errors.filePath = 'This file doesn’t exist. Use Create New… to make one.';
    if (Object.keys(errors).length) return { ok: false, errors };
    // A file has no password: '' deletes one stored before the type changed (the SSH secret goes with `ssh`).
    return { ok: true, config: { ...base, name: v.name.trim() || path.basename(filePath), filePath }, scope, password: '' };
  }

  const host = v.host.trim();
  const user = v.user.trim();
  const database = v.database.trim();
  if (!host) errors.host = 'Required.';
  const port = portNumber(v.port);
  if (port === undefined) errors.port = 'A port between 1 and 65535.';
  if (!user) errors.user = 'Required.';
  if (kind.database === 'required' && !database) errors.database = 'Required.';
  if (!Object.prototype.hasOwnProperty.call(SSL_MODES, v.ssl)) errors.ssl = 'Choose an encryption setting.';

  let ssh: SshConfig | undefined;
  let sshSecret: string | undefined;
  if (v.sshEnabled && kind.network) {
    const sshHost = v.sshHost.trim();
    const sshUser = v.sshUser.trim();
    const sshPort = portNumber(v.sshPort);
    if (!sshHost) errors.sshHost = 'Required.';
    if (sshPort === undefined) errors.sshPort = 'A port between 1 and 65535.';
    if (!sshUser) errors.sshUser = 'Required.';
    if (v.sshAuth !== 'password' && v.sshAuth !== 'key') errors.sshAuth = 'Choose how to log in.';
    const keyPath = v.sshKeyPath.trim();
    if (v.sshAuth === 'key' && !keyPath) errors.sshKeyPath = 'Choose a private key file.';
    if (sshPort !== undefined && (v.sshAuth === 'password' || v.sshAuth === 'key')) {
      ssh = { host: sshHost, port: sshPort, user: sshUser, auth: v.sshAuth, ...(v.sshAuth === 'key' ? { keyPath } : {}) };
    }
    // An empty secret keeps the stored one only for the same kind of login; otherwise it means none.
    const keep = !!editing && ctx.hasSshSecret && ctx.existing!.ssh?.auth === v.sshAuth;
    sshSecret = v.sshSecret || (keep ? undefined : '');
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      ...base,
      name: v.name.trim() || defaultServerName(user, host, database || undefined),
      host,
      port: port!,
      user,
      ...(database ? { database } : {}),
      ssl: v.ssl as SslMode,
      ...(ssh ? { ssh } : {}),
    },
    scope,
    password: v.password || undefined,
    sshSecret,
  };
}

/** The name suggested for a server connection; Switch Database… keeps it in step when unchanged. */
export function defaultServerName(user: string | undefined, host: string | undefined, database: string | undefined): string {
  return `${user ?? ''}@${host ?? ''}${database ? `/${database}` : ''}`;
}

function portNumber(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : undefined;
}
