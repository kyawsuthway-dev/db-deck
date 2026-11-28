// Connection strings: pasted into the connection form, or read from a project's .env (DATABASE_URL).
// Shared by the extension and the webview, so no `vscode`, no Node and no DOM (architecture.md).
// The result only fills in settings; the extension checks them like anything else.

export interface ParsedConnectionString {
  /** A DbKind label: SQLite, PostgreSQL, MySQL, MariaDB, SQL Server, Azure SQL or Oracle. */
  kind: string;
  /** SQLite: the path as written (may be relative; the caller decides what it's relative to). */
  filePath?: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  ssl?: 'off' | 'require' | 'no-verify';
  /** SQL Server: a named instance (`host\SQLEXPRESS` in an ADO.NET string). */
  instance?: string;
  /** SQL Server: Microsoft Entra ID sign-in from `Authentication=…` (ConnectionConfig.signIn). */
  signIn?: 'password' | 'entra-account' | 'entra-default';
  /** Oracle: `database` is a SID (from a descriptor's `(SID=…)`), not a service name. */
  sid?: boolean;
}

const SCHEMES: Record<string, string> = {
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlserver: 'SQL Server',
  mssql: 'SQL Server',
  // Laravel's DB_URL for its sqlsrv driver.
  sqlsrv: 'SQL Server',
  oracle: 'Oracle',
  // Oracle Easy Connect with a protocol: tcps://host:2484/service.
  tcp: 'Oracle',
  tcps: 'Oracle',
};

/**
 * postgres://user:password@host:5432/db?sslmode=require, mysql://…, mariadb://…, and SQLite as file:./dev.db
 * (Prisma), sqlite:///relative or sqlite:////absolute (Django), sqlite3:db/dev.sqlite3 (Rails).
 * Returns an error message for anything else. Percent-encoded parts are decoded.
 */
export function parseConnectionString(text: string): ParsedConnectionString | string {
  const t = text.trim();
  const sqlite = sqlitePath(t);
  if (sqlite !== undefined) return sqlite ? { kind: 'SQLite', filePath: sqlite } : 'The SQLite URL has no file path.';
  if (ADO_NET.test(t)) return parseAdoNet(t);
  if (/^\(\s*DESCRIPTION\s*=/i.test(t)) return parseDescriptor(t);
  const easy = EASY_CONNECT.exec(t);
  if (easy) {
    const [, user, password, host, port, service] = easy;
    return { kind: 'Oracle', host: host.replace(/^\[(.*)\]$/, '$1'), ...(port ? { port } : {}), ...(user ? { user } : {}), ...(password ? { password } : {}), database: service };
  }
  const scheme = /^([a-z]+):\/\//i.exec(t)?.[1]?.toLowerCase();
  const kind = scheme ? SCHEMES[scheme] : undefined;
  if (!kind) return 'Use a postgres://, mysql://, mariadb://, sqlserver://, oracle:// or SQLite (file:) URL, a SQL Server connection string (Server=…;Database=…), or Oracle’s host:1521/service.';
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return 'This isn’t a valid URL.';
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const params = url.searchParams;
  const result: ParsedConnectionString = { kind };
  // IPv6 hosts come back bracketed.
  if (url.hostname) result.host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (url.port) result.port = url.port;
  if (url.username) result.user = decode(url.username);
  if (url.password) result.password = decode(url.password);
  const database = decode(url.pathname.replace(/^\//, ''));
  if (database) result.database = database;
  if (!database && params.get('database')) result.database = params.get('database')!;
  const ssl =
    kind === 'SQL Server'
      ? sqlServerSsl(params.get('encrypt'), params.get('trustServerCertificate'))
      : sslFrom(params.get('sslmode') ?? params.get('ssl-mode') ?? params.get('ssl'));
  if (ssl) result.ssl = ssl;
  if (kind === 'SQL Server' && result.host?.endsWith('.database.windows.net')) result.kind = 'Azure SQL';
  if (scheme === 'tcps') result.ssl = 'require';
  else if (scheme === 'tcp') result.ssl = 'off';
  return result;
}

/**
 * Oracle Easy Connect, as SQL*Plus takes it: `[user[/password]@]host[:port]/service`. Only a host, a port and one
 * service name (Easy Connect's `:server` and `/instance` parts and `?options` aren't settings DB Deck has).
 */
const EASY_CONNECT = /^(?:([^/@\s:]+)(?:\/([^@\s]*))?@)?([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::(\d+))?\/([A-Za-z0-9_.$#-]+)$/;

/**
 * An Oracle connect descriptor (tnsnames.ora style): the first address's HOST, PORT and PROTOCOL (TCPS = SSL), and
 * CONNECT_DATA's SERVICE_NAME or SID. Keys are case-insensitive; values are taken as written.
 */
function parseDescriptor(text: string): ParsedConnectionString | string {
  const value = (key: string) => new RegExp(`\\(\\s*${key}\\s*=\\s*([^()]*?)\\s*\\)`, 'i').exec(text)?.[1];
  const host = value('HOST');
  if (!host) return 'The descriptor has no HOST.';
  const result: ParsedConnectionString = { kind: 'Oracle', host };
  const port = value('PORT');
  if (port && /^\d+$/.test(port)) result.port = port;
  const protocol = value('PROTOCOL')?.toUpperCase();
  if (protocol === 'TCPS') result.ssl = 'require';
  else if (protocol === 'TCP') result.ssl = 'off';
  const service = value('SERVICE_NAME');
  const sid = value('SID');
  if (service) result.database = service;
  else if (sid) {
    result.database = sid;
    result.sid = true;
  }
  return result;
}

/** An ADO.NET connection string: `key=value;` pairs with a Server / Data Source key (what the Azure portal gives). */
const ADO_NET = /(^|;)\s*(server|data source|address|addr|network address)\s*=[^;]+(;|$)/i;

/**
 * `Server=tcp:host,1433;Initial Catalog=db;User ID=u;Password=p;Encrypt=True;TrustServerCertificate=False;`
 * Keys are case-insensitive; a value may be quoted ('…', "…") or braced ({…}) to hold a `;`.
 */
function parseAdoNet(text: string): ParsedConnectionString | string {
  const pairs = new Map<string, string>();
  const re = /\s*([^=;]+?)\s*=\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|\{(?:[^}]|\}\})*\}|[^;]*)\s*(?:;|$)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0]) {
    let value = m[2].trim();
    if (/^".*"$/s.test(value)) value = value.slice(1, -1).replace(/""/g, '"');
    else if (/^'.*'$/s.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    else if (/^\{.*\}$/s.test(value)) value = value.slice(1, -1).replace(/\}\}/g, '}');
    pairs.set(m[1].toLowerCase().replace(/\s+/g, ' '), value);
  }
  const get = (...keys: string[]) => keys.map((k) => pairs.get(k)).find((v) => v !== undefined && v !== '');
  const server = get('server', 'data source', 'address', 'addr', 'network address');
  if (!server) return 'The connection string has no Server.';
  // tcp:host,port or host\instance (np: and lpc: are Windows-only transports DB Deck doesn't use).
  const target = server.replace(/^tcp:/i, '');
  const [hostPart, port] = target.split(',').map((s) => s.trim());
  const [host, instance] = hostPart.split('\\');
  const result: ParsedConnectionString = { kind: host.toLowerCase().endsWith('.database.windows.net') ? 'Azure SQL' : 'SQL Server', host };
  if (port && /^\d+$/.test(port)) result.port = port;
  if (instance) result.instance = instance;
  const database = get('database', 'initial catalog');
  if (database) result.database = database;
  const user = get('user id', 'uid', 'user', 'username');
  if (user) result.user = user;
  const password = get('password', 'pwd');
  if (password) result.password = password;
  const ssl = sqlServerSsl(get('encrypt') ?? null, get('trustservercertificate', 'trust server certificate') ?? null);
  if (ssl) result.ssl = ssl;
  const auth = get('authentication')?.toLowerCase().replace(/[\s_-]+/g, '');
  if (auth === 'activedirectorydefault' || auth === 'activedirectorymanagedidentity' || auth === 'activedirectorymsi') result.signIn = 'entra-default';
  else if (auth?.startsWith('activedirectory')) result.signIn = 'entra-account';
  else if (auth === 'sqlpassword') result.signIn = 'password';
  return result;
}

/** SQL Server's Encrypt / TrustServerCertificate: encrypted unless Encrypt is off; trusting the certificate skips its check. */
function sqlServerSsl(encrypt: string | null, trust: string | null): ParsedConnectionString['ssl'] {
  const yes = (v: string | null) => /^(true|yes|1|mandatory|strict)$/i.test(v ?? '');
  const no = (v: string | null) => /^(false|no|0|optional|disable)$/i.test(v ?? '');
  if (no(encrypt)) return 'off';
  if (yes(trust)) return 'no-verify';
  if (yes(encrypt) || no(trust)) return 'require';
  return undefined;
}

/** The file of a SQLite URL ('' when it has none), or undefined when the text isn't one. Query strings are dropped. */
function sqlitePath(t: string): string | undefined {
  const m = /^(file:|sqlite3?:)(.*)$/i.exec(t);
  if (!m) return undefined;
  let rest = m[2].replace(/[?#].*$/, '');
  if (m[1].toLowerCase() !== 'file:' && rest.startsWith('//')) {
    // sqlite:///relative and sqlite:////absolute (the third slash ends the empty host).
    rest = rest.slice(3);
    if (rest.startsWith('/') && /^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
  } else if (rest.startsWith('//')) {
    // file:///abs or file://localhost/abs
    rest = rest.replace(/^\/\/(localhost)?/i, '');
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/**
 * libpq's sslmode and MySQL's ssl-mode: only the verify modes check the certificate. `prefer`/`allow`
 * (SSL if available) have no DB Deck equivalent, so they leave the SSL setting as it is.
 */
function sslFrom(value: string | null): ParsedConnectionString['ssl'] {
  switch (value?.toLowerCase()) {
    case 'disable':
    case 'disabled':
    case 'false':
      return 'off';
    case 'require':
    case 'required':
    case 'no-verify':
    case 'true':
      return 'no-verify';
    case 'verify-ca':
    case 'verify-full':
    case 'verify_ca':
    case 'verify_identity':
      return 'require';
    default:
      return undefined;
  }
}
