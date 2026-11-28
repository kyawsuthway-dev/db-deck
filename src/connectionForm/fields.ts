// The connection form's fields: initial values, and checking what the form sends back. No `vscode`,
// so it can be smoke-tested in plain Node. The form is a webview, so its messages are untrusted
// (webview.md): every field is checked here, never only in the form.
import * as path from 'path';
import type { ConnectionConfig, ConnectionScope, DbType, OraclePrivilege, SignIn, SshConfig, SslMode } from '../types';

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
  /** SQL Server named instance; empty for none. */
  instance: string;
  /** A SignIn; 'password' for kinds that only have that. */
  signIn: string;
  /** Oracle "Connect as": '' for a normal session, or one of the kind's privileges (SYSDBA…). */
  privilege: string;
  /** Oracle: 'service' (the Database field is a service name) or 'sid'. */
  target: string;
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
  /** none: a file; required/optional: the database field (DATABASE_SCOPE, or `databaseRequired`). */
  database: 'none' | 'required' | 'optional';
  /** The SSL setting a new connection starts with (DbKind.defaultSsl, else off). */
  defaultSsl: SslMode;
  /** Shows the Instance field (DbKind.instances). */
  instances: boolean;
  /** Sign-in methods offered, first is the default (DbKind.signIns, else only a password). */
  signIns: SignIn[];
  /** The read-only switch's description when it differs from the usual one (DbKind.readOnlyNote). */
  readOnlyNote?: string;
  /** The connection string example (DbKind.urlExample). */
  urlExample?: string;
  /** Encryption settings offered (DbKind.sslModes, else all three). */
  sslModes: SslMode[];
  /** The Database field's label (DbKind.databaseLabel, else "Database"). */
  databaseLabel: string;
  /** Offers Service name / SID for the Database field (DbKind.sid). */
  sid: boolean;
  /** "Connect as" privileges (DbKind.privileges); empty: no such field. */
  privileges: OraclePrivilege[];
  /** Through SSH the driver listens on a 127.0.0.1 port (DbKind.sshLocalPort). */
  sshLocalPort: boolean;
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
const SIGN_INS: Record<SignIn, true> = { password: true, 'entra-account': true, 'entra-default': true };
/** SQL Server instance names: up to 16 letters, digits, `_`, `$` or `#`, starting with a letter or `_`. */
const INSTANCE_NAME = /^[A-Za-z_][A-Za-z0-9_$#]{0,15}$/;
const MAX_TEXT = 4096;
export const MAX_FOLDER = 100;

/** Characters that would change an Oracle connect descriptor's structure (oracle.ts builds one from the fields). */
const DESCRIPTOR_SYNTAX = /[()=]/;

const STRING_FIELDS = [
  'kind', 'name', 'folder', 'scope', 'host', 'port', 'user', 'password', 'database', 'ssl', 'filePath',
  'sshHost', 'sshPort', 'sshUser', 'sshAuth', 'sshKeyPath', 'sshSecret', 'instance', 'signIn', 'privilege', 'target',
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
    ssl: c ? (c.ssl ?? 'off') : kind.defaultSsl,
    filePath: c?.filePath ?? '',
    sshEnabled: !!c?.ssh,
    sshHost: c?.ssh?.host ?? '',
    sshPort: String(c?.ssh?.port ?? 22),
    sshUser: c?.ssh?.user ?? '',
    sshAuth: c?.ssh?.auth ?? 'password',
    sshKeyPath: c?.ssh?.keyPath ?? '',
    sshSecret: '',
    readOnly: !!c?.readOnly,
    instance: c?.instance ?? '',
    signIn: c?.signIn ?? kind.signIns[0] ?? 'password',
    privilege: c?.privilege ?? '',
    target: c?.sid ? 'sid' : 'service',
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
  const database = v.database.trim();
  const instance = kind.instances ? v.instance.trim() : '';
  // Entra ID sign-in has no user or password: the token says who it is.
  const signIn = Object.prototype.hasOwnProperty.call(SIGN_INS, v.signIn) && kind.signIns.includes(v.signIn as SignIn) ? (v.signIn as SignIn) : undefined;
  if (!signIn) errors.signIn = 'Choose how to sign in.';
  const withPassword = signIn === 'password' || !signIn;
  const user = withPassword ? v.user.trim() : '';
  if (!host) errors.host = 'Required.';
  const port = portNumber(v.port);
  // A named instance's port comes from SQL Browser, so the port field may stay as it is.
  if (port === undefined && !instance) errors.port = 'A port between 1 and 65535.';
  if (instance && !INSTANCE_NAME.test(instance)) errors.instance = 'An instance name: up to 16 letters, digits or _ (like SQLEXPRESS).';
  if (instance && v.sshEnabled && kind.network) errors.instance = 'A named instance can’t be found through an SSH tunnel. Use its port instead.';
  if (withPassword && !user) errors.user = 'Required.';
  if (kind.database === 'required' && !database) errors.database = 'Required.';
  if (!Object.prototype.hasOwnProperty.call(SSL_MODES, v.ssl) || !kind.sslModes.includes(v.ssl as SslMode)) errors.ssl = 'Choose an encryption setting.';
  const privilege = kind.privileges.includes(v.privilege as OraclePrivilege) ? (v.privilege as OraclePrivilege) : undefined;
  if (v.privilege && !privilege) errors.privilege = 'Choose how to connect.';
  if (kind.sid && v.target !== 'service' && v.target !== 'sid') errors.target = 'Choose service name or SID.';
  const sid = kind.sid && v.target === 'sid';
  if (kind.sid) {
    if (DESCRIPTOR_SYNTAX.test(host)) errors.host = 'A host name or address (no parentheses or =).';
    if (DESCRIPTOR_SYNTAX.test(database)) errors.database = 'A name without parentheses or =.';
  }

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
      name: v.name.trim() || defaultServerName(user || undefined, instance ? `${host}\\${instance}` : host, database || undefined),
      host,
      port: port ?? kind.defaultPort ?? 1,
      ...(user ? { user } : {}),
      ...(database ? { database } : {}),
      ssl: v.ssl as SslMode,
      ...(instance ? { instance } : {}),
      ...(signIn && signIn !== 'password' ? { signIn } : {}),
      ...(privilege ? { privilege } : {}),
      ...(sid ? { sid: true } : {}),
      ...(ssh ? { ssh } : {}),
    },
    scope,
    // Entra ID sign-in has no password: '' deletes one stored for an earlier login.
    password: withPassword ? v.password || undefined : '',
    sshSecret,
  };
}

/** The name suggested for a server connection; Switch Database… keeps it in step when unchanged. */
export function defaultServerName(user: string | undefined, host: string | undefined, database: string | undefined): string {
  return `${user ? `${user}@` : ''}${host ?? ''}${database ? `/${database}` : ''}`;
}

function portNumber(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : undefined;
}
