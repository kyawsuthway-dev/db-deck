import type { ConnectionConfig, DbType, Driver, StreamOpener } from '../types';
import { MysqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';

/** To add a database: write a Driver in this folder, add its DbType, and add it here, to DB_KINDS, SQL_DIALECTS, DATABASE_SCOPE and USES_NETWORK. */
/** `opener` is set when the connection goes through an SSH tunnel (server databases only). */
export function createDriver(config: ConnectionConfig, password: string | undefined, opener?: StreamOpener): Driver {
  switch (config.type) {
    case 'sqlite':
      if (!config.filePath) throw new Error('No SQLite file chosen for this connection.');
      return new SqliteDriver(config.filePath, config.readOnly);
    case 'postgres':
      return new PostgresDriver(config, password, opener);
    case 'mysql':
      return new MysqlDriver(config, password, opener);
  }
}

/** Choices shown in the add-connection wizard. Several kinds can share one driver. */
export interface DbKind {
  label: string;
  type: DbType;
  defaultPort?: number;
  defaultUser?: string;
  defaultDatabase?: string;
  /** The logo in the connection form (`logo()` in src/webview/icons.ts); unknown names get a generic icon. */
  logo: string;
}

export const DB_KINDS: DbKind[] = [
  { label: 'SQLite', type: 'sqlite', logo: 'sqlite' },
  { label: 'PostgreSQL', type: 'postgres', defaultPort: 5432, defaultUser: 'postgres', defaultDatabase: 'postgres', logo: 'postgresql' },
  { label: 'MySQL', type: 'mysql', defaultPort: 3306, defaultUser: 'root', logo: 'mysql' },
  { label: 'MariaDB', type: 'mysql', defaultPort: 3306, defaultUser: 'root', logo: 'mariadb' },
];

export function typeLabel(type: DbType): string {
  return DB_KINDS.find((k) => k.type === type)?.label ?? type;
}

/** sql-formatter languages DB Deck uses (see query/formatSql.ts). */
export type FormatLanguage = 'postgresql' | 'mysql' | 'sqlite';

/** How the SQL editor treats each database's SQL: the formatter language and keywords beyond the common ones. */
export interface SqlDialect {
  format: FormatLanguage;
  keywords: string[];
}

export const SQL_DIALECTS: Record<DbType, SqlDialect> = {
  postgres: {
    format: 'postgresql',
    keywords: ['ILIKE', 'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE', 'IS DISTINCT FROM', 'FETCH FIRST', 'SERIAL', 'JSONB'],
  },
  mysql: {
    format: 'mysql',
    keywords: ['REPLACE INTO', 'ON DUPLICATE KEY UPDATE', 'AUTO_INCREMENT', 'ENGINE', 'DUAL', 'SHOW TABLES', 'DESCRIBE', 'REGEXP'],
  },
  sqlite: {
    format: 'sqlite',
    keywords: ['INSERT OR REPLACE', 'INSERT OR IGNORE', 'AUTOINCREMENT', 'WITHOUT ROWID', 'PRAGMA', 'GLOB', 'VACUUM'],
  },
};

/**
 * Whether a connection has a database setting: none (SQLite, a file), required (PostgreSQL connects to one),
 * or optional (MySQL: empty shows all databases). Used by Switch Database….
 */
export const DATABASE_SCOPE: Record<DbType, 'none' | 'required' | 'optional'> = {
  sqlite: 'none',
  postgres: 'required',
  mysql: 'optional',
};

/** Whether the database is reached over the network, so it can go through an SSH tunnel (SQLite is a local file). */
export const USES_NETWORK: Record<DbType, boolean> = {
  sqlite: false,
  postgres: true,
  mysql: true,
};
