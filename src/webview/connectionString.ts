// Connection strings pasted into the connection form. DOM-free, so it can be tested in plain Node.
// Only fills form fields: the extension checks the result like anything else the form sends.

export interface ParsedConnectionString {
  /** A DbKind label: PostgreSQL, MySQL or MariaDB. */
  kind: string;
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
 * postgres://user:password@host:5432/db?sslmode=require, mysql://…, mariadb://…
 * Returns an error message for anything else. Percent-encoded parts are decoded.
 */
export function parseConnectionString(text: string): ParsedConnectionString | string {
  const t = text.trim();
  const scheme = /^([a-z]+):\/\//i.exec(t)?.[1]?.toLowerCase();
  const kind = scheme ? SCHEMES[scheme] : undefined;
  if (!kind) return 'Use a postgres://, postgresql://, mysql:// or mariadb:// URL.';
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
