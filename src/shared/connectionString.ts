// Connection strings: pasted into the connection form, or read from a project's .env (DATABASE_URL).
// Shared by the extension and the webview, so no `vscode`, no Node and no DOM (architecture.md).
// The result only fills in settings; the extension checks them like anything else.

export interface ParsedConnectionString {
  /** A DbKind label: SQLite, PostgreSQL, MySQL or MariaDB. */
  kind: string;
  /** SQLite: the path as written (may be relative; the caller decides what it's relative to). */
  filePath?: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  ssl?: 'off' | 'require' | 'no-verify';
}

const SCHEMES: Record<string, string> = {
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
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
  const scheme = /^([a-z]+):\/\//i.exec(t)?.[1]?.toLowerCase();
  const kind = scheme ? SCHEMES[scheme] : undefined;
  if (!kind) return 'Use a postgres://, postgresql://, mysql://, mariadb:// or SQLite (file:) URL.';
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
  const ssl = sslFrom(params.get('sslmode') ?? params.get('ssl-mode') ?? params.get('ssl'));
  if (ssl) result.ssl = ssl;
  return result;
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
