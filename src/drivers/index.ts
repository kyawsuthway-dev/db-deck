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

/** Database kinds the connection form offers. Several kinds can share one driver. */
export interface DbKind {
  label: string;
  type: DbType;
  defaultPort?: number;
  defaultUser?: string;
  defaultDatabase?: string;
  /** Logo files `media/logos/<logo>-*.svg` (see src/logos.ts); a missing logo gets a generic icon. */
  logo: string;
  /** Laravel's `DB_CONNECTION` values for this kind, for .env connections (src/env/detect.ts). */
  laravel?: string[];
  /** Docker images of this kind and where they take credentials, for compose connections (src/env/compose.ts). */
  docker?: DockerImage;
}

/** How an official database image is configured through `environment` in a compose file. */
export interface DockerImage {
  /** Image names without registry or tag, e.g. `postgres`, `pgvector/pgvector`. */
  images: string[];
  /**
   * Ways to log in, in order. One applies when its `userVar` is set or, for a fixed `user`, when its
   * `passwordVar` is set; if none applies, the last one is used with its fixed user.
   */
  logins: { userVar?: string; user?: string; passwordVar: string }[];
  /** Variables naming the database, first set wins. */
  databaseVars: string[];
  /** The database when none is set: the login user (PostgreSQL), or none (MySQL shows all databases). */
  defaultDatabase?: 'user';
}

const MYSQL_LOGINS = [
  { userVar: 'MYSQL_USER', passwordVar: 'MYSQL_PASSWORD' },
  { user: 'root', passwordVar: 'MYSQL_ROOT_PASSWORD' },
];

export const DB_KINDS: DbKind[] = [
  { label: 'SQLite', type: 'sqlite', logo: 'sqlite', laravel: ['sqlite'] },
  {
    label: 'PostgreSQL',
    type: 'postgres',
    defaultPort: 5432,
    defaultUser: 'postgres',
    defaultDatabase: 'postgres',
    logo: 'postgresql',
    laravel: ['pgsql'],
    docker: {
      images: ['postgres', 'postgis/postgis', 'pgvector/pgvector', 'timescale/timescaledb', 'timescale/timescaledb-ha'],
      logins: [{ userVar: 'POSTGRES_USER', user: 'postgres', passwordVar: 'POSTGRES_PASSWORD' }],
      databaseVars: ['POSTGRES_DB'],
      defaultDatabase: 'user',
    },
  },
  {
    label: 'MySQL',
    type: 'mysql',
    defaultPort: 3306,
    defaultUser: 'root',
    logo: 'mysql',
    laravel: ['mysql'],
    docker: { images: ['mysql', 'mysql/mysql-server', 'percona', 'percona/percona-server'], logins: MYSQL_LOGINS, databaseVars: ['MYSQL_DATABASE'] },
  },
  {
    label: 'MariaDB',
    type: 'mysql',
    defaultPort: 3306,
    defaultUser: 'root',
    logo: 'mariadb',
    laravel: ['mariadb'],
    docker: {
      images: ['mariadb'],
      // The MariaDB image accepts both its own MARIADB_* names and the MYSQL_* ones.
      logins: [
        { userVar: 'MARIADB_USER', passwordVar: 'MARIADB_PASSWORD' },
        { userVar: 'MYSQL_USER', passwordVar: 'MYSQL_PASSWORD' },
        { user: 'root', passwordVar: 'MARIADB_ROOT_PASSWORD' },
        { user: 'root', passwordVar: 'MYSQL_ROOT_PASSWORD' },
      ],
      databaseVars: ['MARIADB_DATABASE', 'MYSQL_DATABASE'],
    },
  },
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

/**
 * What the Connections tree shows under a connection: `objects` the object folders directly (SQLite),
 * `schemas` the schema list (MySQL: each database is a schema), `database` the connection's database, then a
 * Schemas folder with the schema list (PostgreSQL).
 */
export const TREE_LAYOUT: Record<DbType, 'objects' | 'schemas' | 'database'> = {
  sqlite: 'objects',
  postgres: 'database',
  mysql: 'schemas',
};

/** Whether the database is reached over the network, so it can go through an SSH tunnel (SQLite is a local file). */
export const USES_NETWORK: Record<DbType, boolean> = {
  sqlite: false,
  postgres: true,
  mysql: true,
};

/**
 * Whether the database can roll back schema changes (CREATE / ALTER / DROP) in a transaction. MySQL commits
 * at each of them, including the statements before it, so Run SQL File warns that a failing script there
 * keeps everything up to its last schema change.
 */
export const TRANSACTIONAL_DDL: Record<DbType, boolean> = {
  sqlite: true,
  postgres: true,
  mysql: false,
};

/** What the Table Designer offers for a database, so the form never branches on the type. */
export interface TableFeatures {
  /** Suggestions for the type field (any type can be typed). */
  types: string[];
  /** Table and column comments. */
  comments: boolean;
  /** How auto-increment is written, for the designer's hint; undefined when the database has none to offer. */
  autoIncrement: string;
  /** Only an INTEGER single-column primary key can auto-increment (SQLite's rowid). */
  autoIncrementNeedsIntegerKey: boolean;
  /** Foreign key ON DELETE / ON UPDATE choices. */
  referentialActions: string[];
  /**
   * Reordering columns of an existing table: `alter` (MySQL MODIFY … AFTER), `rebuild` (SQLite), or `none`
   * (PostgreSQL appends new columns and can't move existing ones).
   */
  reorder: 'alter' | 'rebuild' | 'none';
  /** Database-specific notes for the Truncate / Drop forms. */
  truncateNote: string;
  dropNote: string;
}

export const TABLE_FEATURES: Record<DbType, TableFeatures> = {
  postgres: {
    types: ['integer', 'bigint', 'smallint', 'numeric(10,2)', 'real', 'double precision', 'text', 'varchar(255)', 'char(1)', 'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'bytea', 'inet', 'integer[]', 'text[]'],
    comments: true,
    autoIncrement: 'GENERATED BY DEFAULT AS IDENTITY',
    autoIncrementNeedsIntegerKey: false,
    referentialActions: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
    reorder: 'none',
    truncateNote: 'PostgreSQL refuses TRUNCATE while other tables reference this one through foreign keys (DB Deck never adds CASCADE). It runs in a transaction.',
    dropNote: 'PostgreSQL refuses to drop it while views or foreign keys depend on it (DB Deck never adds CASCADE). It runs in a transaction.',
  },
  mysql: {
    types: ['int', 'bigint', 'smallint', 'tinyint', 'decimal(10,2)', 'float', 'double', 'varchar(255)', 'char(1)', 'text', 'mediumtext', 'longtext', 'boolean', 'date', 'time', 'datetime', 'timestamp', 'year', 'json', 'blob', 'varbinary(255)', "enum('a','b')"],
    comments: true,
    autoIncrement: 'AUTO_INCREMENT (the column must be a key)',
    autoIncrementNeedsIntegerKey: false,
    referentialActions: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'],
    reorder: 'alter',
    truncateNote: 'MySQL commits TRUNCATE immediately, so it can’t be rolled back, and refuses it while other tables reference this one through foreign keys.',
    dropNote: 'MySQL commits DROP TABLE immediately, so it can’t be rolled back.',
  },
  sqlite: {
    types: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN', 'DATE', 'DATETIME', 'VARCHAR(255)'],
    comments: false,
    autoIncrement: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    autoIncrementNeedsIntegerKey: true,
    referentialActions: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
    reorder: 'rebuild',
    truncateNote: 'SQLite has no TRUNCATE: DB Deck runs DELETE FROM, which also fires ON DELETE CASCADE in tables that reference this one. It runs in a transaction.',
    dropNote: 'Indexes and triggers on the table are dropped with it. It runs in a transaction.',
  },
};

/** Which Server panel and Explain features a database has. */
export const SERVER_TOOLS: Record<DbType, { processes: boolean; explainAnalyze: boolean }> = {
  postgres: { processes: true, explainAnalyze: true },
  // MariaDB has neither EXPLAIN ANALYZE nor FORMAT=TREE; the driver detects it and says so.
  mysql: { processes: true, explainAnalyze: true },
  sqlite: { processes: false, explainAnalyze: false },
};
