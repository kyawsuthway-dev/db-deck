import type { ConnectionConfig, DbType, Driver } from '../types';
import { MysqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';

/** To add a database: write a Driver in this folder, add its DbType, and add it here, to DB_KINDS and to SQL_DIALECTS. */
export function createDriver(config: ConnectionConfig, password: string | undefined): Driver {
  switch (config.type) {
    case 'sqlite':
      if (!config.filePath) throw new Error('No SQLite file chosen for this connection.');
      return new SqliteDriver(config.filePath);
    case 'postgres':
      return new PostgresDriver(config, password);
    case 'mysql':
      return new MysqlDriver(config, password);
  }
}

/** Choices shown in the add-connection wizard. Several kinds can share one driver. */
export interface DbKind {
  label: string;
  type: DbType;
  defaultPort?: number;
  defaultUser?: string;
  defaultDatabase?: string;
}

export const DB_KINDS: DbKind[] = [
  { label: 'SQLite', type: 'sqlite' },
  { label: 'PostgreSQL', type: 'postgres', defaultPort: 5432, defaultUser: 'postgres', defaultDatabase: 'postgres' },
  { label: 'MySQL', type: 'mysql', defaultPort: 3306, defaultUser: 'root' },
  { label: 'MariaDB', type: 'mysql', defaultPort: 3306, defaultUser: 'root' },
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
