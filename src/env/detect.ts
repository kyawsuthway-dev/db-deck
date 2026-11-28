// Database connections described by a project's .env: Laravel's DB_* keys, and DATABASE_URL (Prisma,
// Rails, Django, Node). No `vscode` and no I/O (file checks are injected), so it can be tested in plain Node.
import * as path from 'path';
import type { DbKind } from '../drivers';
import { parseConnectionString } from '../shared/connectionString';
import { defaultServerName } from '../connectionForm/fields';
import type { ConnectionConfig, SslMode } from '../types';

/** Where in the .env a connection came from; part of its id, so keep the values stable. */
export type EnvSource = 'DB_*' | 'DB_URL' | 'DATABASE_URL';

export interface DetectedConnection {
  source: EnvSource;
  /** The keys it was read from, for the tooltip. */
  keys: string[];
  /** Everything but `id` (the service derives it from the file and the source). */
  config: Omit<ConnectionConfig, 'id'>;
  /** Kept in memory only, and only until the connection opens. */
  password?: string;
}

export interface DetectOptions {
  kinds: DbKind[];
  /** The folder the .env is in; relative SQLite paths resolve against it. */
  dir: string;
  exists: (file: string) => boolean;
}

/** Laravel's own fallbacks when a DB_* key is missing (config/database.php). */
const LARAVEL_HOST = '127.0.0.1';
const LARAVEL_USER = 'root';
const LARAVEL_DATABASE = 'laravel';

export function detectConnections(env: Map<string, string>, opts: DetectOptions): DetectedConnection[] {
  const found: DetectedConnection[] = [];
  const get = (key: string) => {
    const v = env.get(key);
    return v === undefined || v === '' ? undefined : v;
  };

  // Laravel: DB_CONNECTION picks the driver; DB_URL, when set, overrides the separate keys.
  const driver = get('DB_CONNECTION')?.toLowerCase();
  const laravelKind = driver ? opts.kinds.find((k) => k.laravel?.includes(driver)) : undefined;
  const dbUrl = get('DB_URL');
  if (laravelKind) {
    const fromUrl = dbUrl ? fromConnectionString(dbUrl, 'DB_URL', opts) : undefined;
    if (fromUrl && fromUrl.config.type === laravelKind.type) {
      found.push({ ...fromUrl, source: 'DB_*', keys: ['DB_CONNECTION', 'DB_URL'] });
    } else if (laravelKind.type === 'sqlite') {
      const file = get('DB_DATABASE') ?? path.join('database', 'database.sqlite');
      const filePath = resolveFile(file, [opts.dir], opts);
      found.push({
        source: 'DB_*',
        keys: ['DB_CONNECTION', 'DB_DATABASE'],
        config: { name: path.basename(filePath), type: 'sqlite', filePath },
      });
    } else {
      const host = get('DB_HOST') ?? LARAVEL_HOST;
      const port = portOf(get('DB_PORT')) ?? laravelKind.defaultPort;
      const user = get('DB_USERNAME') ?? LARAVEL_USER;
      const database = get('DB_DATABASE') ?? LARAVEL_DATABASE;
      found.push({
        source: 'DB_*',
        keys: ['DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD'].filter((k) => env.has(k)),
        config: {
          name: defaultServerName(user, host, database),
          type: laravelKind.type,
          host,
          port: port ?? 0,
          user,
          database,
          ssl: sslFrom(get('DB_SSLMODE')) ?? encryptFrom(get('DB_ENCRYPT'), get('DB_TRUST_SERVER_CERTIFICATE')) ?? laravelKind.defaultSsl ?? 'off',
        },
        password: get('DB_PASSWORD'),
      });
    }
  } else if (dbUrl) {
    const fromUrl = fromConnectionString(dbUrl, 'DB_URL', opts);
    if (fromUrl) found.push(fromUrl);
  }

  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl) {
    const fromUrl = fromConnectionString(databaseUrl, 'DATABASE_URL', opts);
    if (fromUrl) found.push(fromUrl);
  }

  // The same database described twice (DB_* and DATABASE_URL) is shown once.
  return found.filter((c, i) => found.findIndex((o) => sameTarget(o.config, c.config)) === i);
}

function fromConnectionString(url: string, source: EnvSource, opts: DetectOptions): DetectedConnection | undefined {
  const parsed = parseConnectionString(url);
  if (typeof parsed === 'string') return undefined;
  const kind = opts.kinds.find((k) => k.label === parsed.kind);
  if (!kind) return undefined;
  const keys = [source];
  if (parsed.filePath !== undefined) {
    // Prisma resolves file: paths against its schema folder (usually prisma/), others against the project.
    const filePath = resolveFile(parsed.filePath, [path.join(opts.dir, 'prisma'), opts.dir], opts);
    return { source, keys, config: { name: path.basename(filePath), type: kind.type, filePath } };
  }
  const host = parsed.host || 'localhost';
  const port = portOf(parsed.port) ?? kind.defaultPort ?? 0;
  const user = parsed.user ?? kind.defaultUser ?? '';
  return {
    source,
    keys,
    config: {
      name: defaultServerName(user, host, parsed.database),
      type: kind.type,
      host,
      port,
      user,
      ...(parsed.database ? { database: parsed.database } : {}),
      ssl: parsed.ssl ?? kind.defaultSsl ?? 'off',
      ...(parsed.instance ? { instance: parsed.instance } : {}),
      ...(parsed.signIn && parsed.signIn !== 'password' ? { signIn: parsed.signIn } : {}),
    },
    password: parsed.password,
  };
}

/** An absolute path as is; a relative one against the first folder where it exists (else the last folder). */
function resolveFile(file: string, dirs: string[], opts: DetectOptions): string {
  if (path.isAbsolute(file)) return path.normalize(file);
  for (const dir of dirs) {
    const candidate = path.resolve(dir, file);
    if (opts.exists(candidate)) return candidate;
  }
  return path.resolve(dirs[dirs.length - 1], file);
}

function portOf(text: string | undefined): number | undefined {
  if (!text || !/^\d{1,5}$/.test(text.trim())) return undefined;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/** Laravel's DB_SSLMODE (libpq values). `prefer`/`allow` have no DB Deck equivalent: off. */
/**
 * Laravel's sqlsrv settings (config/database.php reads DB_ENCRYPT, default yes, and DB_TRUST_SERVER_CERTIFICATE,
 * default false). Undefined when .env sets neither, so the kind's default applies.
 */
function encryptFrom(encrypt: string | undefined, trust: string | undefined): SslMode | undefined {
  if (encrypt === undefined && trust === undefined) return undefined;
  if (/^(no|false|0|optional)$/i.test(encrypt ?? '')) return 'off';
  if (/^(true|yes|1)$/i.test(trust ?? '')) return 'no-verify';
  return 'require';
}

function sslFrom(mode: string | undefined): SslMode | undefined {
  switch (mode?.toLowerCase()) {
    case 'require':
      return 'no-verify';
    case 'verify-ca':
    case 'verify-full':
      return 'require';
    case undefined:
      return undefined;
    default:
      return 'off';
  }
}

function sameTarget(a: Omit<ConnectionConfig, 'id'>, b: Omit<ConnectionConfig, 'id'>): boolean {
  return (
    a.type === b.type &&
    a.filePath === b.filePath &&
    a.host === b.host &&
    a.port === b.port &&
    a.user === b.user &&
    (a.database ?? '') === (b.database ?? '')
  );
}
