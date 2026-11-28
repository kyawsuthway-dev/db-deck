import type { ConnectionConfig, DbType, Driver, OraclePrivilege, SignIn, SslMode, StreamOpener } from '../types';
import { MysqlDriver } from './mysql';
import { OracleDriver } from './oracle';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';
import { SqlServerDriver } from './sqlserver';

/** To add a database: write a Driver in this folder, add its DbType, and add it here, to DB_KINDS, SQL_DIALECTS, DATABASE_SCOPE and USES_NETWORK. */
/**
 * `opener` is set when the connection goes through an SSH tunnel (server databases only); `accessToken` gives a
 * Microsoft Entra ID token for SQL Server's VS Code account sign-in.
 */
export function createDriver(
  config: ConnectionConfig,
  password: string | undefined,
  opener?: StreamOpener,
  accessToken?: () => Promise<string>,
): Driver {
  switch (config.type) {
    case 'sqlite':
      if (!config.filePath) throw new Error('No SQLite file chosen for this connection.');
      return new SqliteDriver(config.filePath, config.readOnly);
    case 'postgres':
      return new PostgresDriver(config, password, opener);
    case 'mysql':
      return new MysqlDriver(config, password, opener);
    case 'sqlserver':
      return new SqlServerDriver(config, password, opener, accessToken);
    case 'oracle':
      return new OracleDriver(config, password, opener);
  }
}

/** SQL Server has no read-only session setting, so DB Deck checks statements itself (SqlServerDriver.query). */
const SQL_SERVER_READ_ONLY =
  'SQL Server has no read-only session, so DB Deck checks each statement and only runs reading ones (SELECT, WITH, DECLARE, SET, PRINT); table editing is off. A guard against mistakes, not a security boundary: for a real guarantee, connect as a user that can’t write.';

/** Oracle's read-only transaction ends at the first commit and still lets DDL through, so DB Deck checks statements. */
const ORACLE_READ_ONLY =
  'Oracle’s read-only transactions still allow schema changes, so DB Deck checks each statement and only runs reading ones (SELECT, WITH); PL/SQL blocks and CALL are refused, since a procedure can write. Table editing is off. A guard against mistakes, not a security boundary: for a real guarantee, connect as a user that can’t write.';

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
  /** The form's SSL setting for a new connection of this kind (default: off). */
  defaultSsl?: SslMode;
  /** The database must be set (Azure SQL Database: one database per connection), even if the type's is optional. */
  databaseRequired?: boolean;
  /** Has named instances (SQL Server): the form shows an Instance field. */
  instances?: boolean;
  /** Ways to sign in the form offers (default: only a user and password). */
  signIns?: SignIn[];
  /** What the read-only switch does, when it isn't the database's own read-only session (the form's default text). */
  readOnlyNote?: string;
  /** The connection string example the form shows. */
  urlExample?: string;
  /** Encryption settings the form offers (default: all three). Oracle's Thin mode can't skip certificate checks. */
  sslModes?: SslMode[];
  /** The Database field's label when it isn't "Database" (Oracle: Service name). */
  databaseLabel?: string;
  /** The Database field can hold a SID instead of a service name (Oracle): the form shows the choice. */
  sid?: boolean;
  /** "Connect as" choices for administrative sessions (Oracle SYSDBA…); none: no such field. */
  privileges?: OraclePrivilege[];
  /**
   * Through SSH the driver listens on a 127.0.0.1 port for its own sockets (its library can't take a stream), so the
   * form says so instead of "no local port opened".
   */
  sshLocalPort?: boolean;
  /**
   * Not offered yet (connection form, .env and compose detection) while it's being built; shown only in the
   * Extension Development Host (F5). Used for SQL Server and Azure SQL during phase 14a, Oracle during phase 14b.
   */
  hidden?: boolean;
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
  /** The SSL setting for the local container (default off): SQL Server's encrypts with a self-signed certificate. */
  ssl?: SslMode;
  /** The database when none is set, by image (Oracle images each have their own default service). */
  databaseByImage?: Record<string, string>;
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
    urlExample: 'postgres://user@host:5432/database',
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
    urlExample: 'mysql://user@host:3306/database',
    laravel: ['mysql'],
    docker: { images: ['mysql', 'mysql/mysql-server', 'percona', 'percona/percona-server'], logins: MYSQL_LOGINS, databaseVars: ['MYSQL_DATABASE'] },
  },
  {
    label: 'MariaDB',
    type: 'mysql',
    defaultPort: 3306,
    defaultUser: 'root',
    logo: 'mariadb',
    urlExample: 'mariadb://user@host:3306/database',
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
  {
    label: 'SQL Server',
    type: 'sqlserver',
    defaultPort: 1433,
    defaultUser: 'sa',
    logo: 'sqlserver',
    laravel: ['sqlsrv'],
    instances: true,
    readOnlyNote: SQL_SERVER_READ_ONLY,
    urlExample: 'Server=host,1433;Database=…;User ID=…  or  sqlserver://user@host:1433/database',
    // Encrypted and verified by default, as Microsoft's own drivers do; a local server offers Trust Server Certificate.
    defaultSsl: 'require',
    docker: {
      // mcr.microsoft.com/mssql/server: the registry part is dropped before matching (env/compose.ts).
      images: ['mssql/server'],
      logins: [{ user: 'sa', passwordVar: 'MSSQL_SA_PASSWORD' }, { user: 'sa', passwordVar: 'SA_PASSWORD' }],
      databaseVars: [],
      ssl: 'no-verify',
    },
  },
  {
    label: 'Azure SQL',
    type: 'sqlserver',
    defaultPort: 1433,
    logo: 'azuresql',
    defaultSsl: 'require',
    databaseRequired: true,
    signIns: ['password', 'entra-account', 'entra-default'],
    readOnlyNote: SQL_SERVER_READ_ONLY,
    urlExample: 'Server=tcp:name.database.windows.net,1433;Database=…  (from the Azure portal)',
  },
  {
    label: 'Oracle',
    type: 'oracle',
    defaultPort: 1521,
    defaultDatabase: 'FREEPDB1',
    logo: 'oracle',
    // yajra/laravel-oci8, the usual Oracle driver for Laravel.
    laravel: ['oracle'],
    databaseLabel: 'Service name',
    sid: true,
    privileges: ['SYSDBA', 'SYSOPER', 'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC'],
    sslModes: ['off', 'require'],
    sshLocalPort: true,
    readOnlyNote: ORACLE_READ_ONLY,
    urlExample: 'host:1521/FREEPDB1  or  oracle://user@host:1521/service',
    hidden: true,
    docker: {
      // gvenzl/oracle-free and -xe (APP_USER, or SYSTEM with ORACLE_PASSWORD), container-registry.oracle.com/database/*.
      images: ['gvenzl/oracle-free', 'gvenzl/oracle-xe', 'database/free', 'database/express', 'database/enterprise'],
      logins: [
        { userVar: 'APP_USER', passwordVar: 'APP_USER_PASSWORD' },
        { user: 'system', passwordVar: 'ORACLE_PASSWORD' },
        { user: 'system', passwordVar: 'ORACLE_PWD' },
      ],
      databaseVars: ['ORACLE_DATABASE'],
      databaseByImage: {
        'gvenzl/oracle-free': 'FREEPDB1',
        'gvenzl/oracle-xe': 'XEPDB1',
        'database/free': 'FREEPDB1',
        'database/express': 'XEPDB1',
        'database/enterprise': 'ORCLPDB1',
      },
    },
  },
];

let showHidden = false;

/** Lets the Extension Development Host (F5) offer kinds that are still being built (`DbKind.hidden`). */
export function offerHiddenKinds(on: boolean): void {
  showHidden = on;
}

/** The kinds the connection form and .env / compose detection offer. */
export function offeredKinds(): DbKind[] {
  return DB_KINDS.filter((k) => showHidden || !k.hidden);
}

export function typeLabel(type: DbType): string {
  return DB_KINDS.find((k) => k.type === type)?.label ?? type;
}

/** sql-formatter languages DB Deck uses (see query/formatSql.ts). */
export type FormatLanguage = 'postgresql' | 'mysql' | 'sqlite' | 'transactsql' | 'plsql';

/** How the SQL editor treats each database's SQL: the formatter language and keywords beyond the common ones. */
export interface SqlDialect {
  format: FormatLanguage;
  keywords: string[];
  /** How a SELECT asks for its first rows (Generate SQL): `LIMIT n`, SQL Server's `TOP (n)`, or `FETCH FIRST n ROWS ONLY`. */
  rowLimit: RowLimit;
}

export type RowLimit = 'limit' | 'top' | 'fetch';

export const SQL_DIALECTS: Record<DbType, SqlDialect> = {
  postgres: {
    format: 'postgresql',
    keywords: ['ILIKE', 'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE', 'IS DISTINCT FROM', 'FETCH FIRST', 'SERIAL', 'JSONB'],
    rowLimit: 'limit',
  },
  mysql: {
    format: 'mysql',
    keywords: ['REPLACE INTO', 'ON DUPLICATE KEY UPDATE', 'AUTO_INCREMENT', 'ENGINE', 'DUAL', 'SHOW TABLES', 'DESCRIBE', 'REGEXP'],
    rowLimit: 'limit',
  },
  sqlite: {
    format: 'sqlite',
    keywords: ['INSERT OR REPLACE', 'INSERT OR IGNORE', 'AUTOINCREMENT', 'WITHOUT ROWID', 'PRAGMA', 'GLOB', 'VACUUM'],
    rowLimit: 'limit',
  },
  sqlserver: {
    format: 'transactsql',
    keywords: ['TOP', 'OFFSET', 'FETCH NEXT', 'ROWS ONLY', 'IDENTITY', 'NVARCHAR', 'DECLARE', 'PRINT', 'GO', 'EXEC', 'MERGE', 'OUTPUT', 'WITH (NOLOCK)', 'BEGIN TRY', 'BEGIN CATCH', 'RAISERROR', 'THROW'],
    rowLimit: 'top',
  },
  oracle: {
    format: 'plsql',
    keywords: ['DUAL', 'ROWNUM', 'ROWID', 'SYSDATE', 'SYSTIMESTAMP', 'NVL', 'DECODE', 'VARCHAR2', 'NUMBER', 'FETCH FIRST', 'ROWS ONLY', 'CONNECT BY', 'START WITH', 'MERGE', 'DECLARE', 'EXCEPTION', 'DBMS_OUTPUT.PUT_LINE', 'CREATE OR REPLACE'],
    rowLimit: 'fetch',
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
  // Empty: the login's default database.
  sqlserver: 'optional',
  // The service name (or SID) the connection goes to.
  oracle: 'required',
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
  sqlserver: 'database',
  oracle: 'database',
};

/** Whether the database is reached over the network, so it can go through an SSH tunnel (SQLite is a local file). */
export const USES_NETWORK: Record<DbType, boolean> = {
  sqlite: false,
  postgres: true,
  mysql: true,
  sqlserver: true,
  oracle: true,
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
  sqlserver: true,
  // Every CREATE / ALTER / DROP commits, with what ran before it.
  oracle: false,
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
  /**
   * NULLs never clash in a UNIQUE key (PostgreSQL, MySQL, SQLite). SQL Server treats NULL as a value there: a
   * nullable unique column holds one NULL at most, which Generate Mock Data has to respect.
   */
  uniqueNullsDistinct: boolean;
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
    uniqueNullsDistinct: true,
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
    uniqueNullsDistinct: true,
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
    uniqueNullsDistinct: true,
  },
  // Table design for SQL Server comes in phase 14a-2; these are the designer's suggestions and notes.
  sqlserver: {
    types: ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal(10,2)', 'money', 'float', 'real', 'nvarchar(255)', 'nvarchar(max)', 'varchar(255)', 'nchar(1)', 'date', 'time', 'datetime2', 'datetimeoffset', 'uniqueidentifier', 'varbinary(max)', 'xml'],
    comments: false,
    autoIncrement: 'IDENTITY(1, 1)',
    autoIncrementNeedsIntegerKey: false,
    referentialActions: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
    reorder: 'none',
    truncateNote: 'SQL Server refuses TRUNCATE while other tables reference this one through foreign keys (DB Deck never adds CASCADE). It runs in a transaction.',
    dropNote: 'SQL Server refuses to drop a table other tables reference through foreign keys. Indexes and triggers on it are dropped with it. It runs in a transaction.',
    uniqueNullsDistinct: false,
  },
  // Table design for Oracle comes in phase 14b-2; these are the designer's suggestions and notes.
  oracle: {
    types: ['NUMBER', 'NUMBER(10)', 'NUMBER(10,2)', 'INTEGER', 'BINARY_DOUBLE', 'VARCHAR2(255)', 'VARCHAR2(255 CHAR)', 'NVARCHAR2(255)', 'CHAR(1)', 'CLOB', 'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'INTERVAL DAY TO SECOND', 'RAW(16)', 'BLOB', 'BOOLEAN', 'JSON'],
    comments: true,
    autoIncrement: 'GENERATED BY DEFAULT AS IDENTITY',
    autoIncrementNeedsIntegerKey: false,
    referentialActions: ['NO ACTION', 'CASCADE', 'SET NULL'],
    reorder: 'none',
    truncateNote: 'Oracle commits TRUNCATE immediately, so it can’t be rolled back, and refuses it while enabled foreign keys reference this table (DB Deck never adds CASCADE).',
    dropNote: 'Oracle commits DROP TABLE immediately. The table goes to the recycle bin where that’s on (FLASHBACK TABLE … TO BEFORE DROP brings it back). DB Deck never adds CASCADE CONSTRAINTS.',
    uniqueNullsDistinct: true,
  },
};

/**
 * Which Server panel and Explain features a database has. `cancelQuery`: another session's running statement can be
 * cancelled while the session stays open (SQL Server can only end the session, with KILL).
 */
export const SERVER_TOOLS: Record<DbType, { processes: boolean; explainAnalyze: boolean; cancelQuery: boolean }> = {
  postgres: { processes: true, explainAnalyze: true, cancelQuery: true },
  // MariaDB has neither EXPLAIN ANALYZE nor FORMAT=TREE; the driver detects it and says so.
  mysql: { processes: true, explainAnalyze: true, cancelQuery: true },
  sqlite: { processes: false, explainAnalyze: false, cancelQuery: false },
  // No Explain Analyze: SQL Server has no read-only transaction to run a statement in safely.
  sqlserver: { processes: true, explainAnalyze: false, cancelQuery: false },
  // Phase 14b-3: no Explain Analyze (decision 8); ALTER SYSTEM CANCEL SQL (18c and later) cancels a statement.
  oracle: { processes: true, explainAnalyze: false, cancelQuery: true },
};
