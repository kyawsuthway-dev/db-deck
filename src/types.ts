export type DbType = 'sqlite' | 'postgres' | 'mysql';

/** off: plain TCP. require: TLS with certificate checks. no-verify: TLS, accept self-signed certificates. */
export type SslMode = 'off' | 'require' | 'no-verify';

/** A saved connection. Stored in globalState, so it must never contain a password. */
export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  /** SQLite only. */
  filePath?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: SslMode;
}

export interface TableInfo {
  name: string;
  /** Set only when the table is outside the connection's default schema/database. */
  schema?: string;
  kind: 'table' | 'view';
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

/** Every value is turned into display text (or null) before it reaches the webview. */
export type Cell = string | null;

export interface StatementResult {
  sql: string;
  columns: string[];
  rows: Cell[][];
  /** For statements that return no columns (INSERT, UPDATE, DDL...). */
  affectedRows?: number;
  /** True when the statement returned more rows than we keep. */
  truncated?: boolean;
  durationMs: number;
  error?: string;
}

export interface Driver {
  /** Opens the connection. Throws with a readable message when it can't. */
  connect(): Promise<void>;
  listTables(): Promise<TableInfo[]>;
  listColumns(table: TableInfo): Promise<ColumnInfo[]>;
  /** Runs one or more `;`-separated statements in order, stopping at the first error. */
  query(sql: string): Promise<StatementResult[]>;
  /** SQL that selects the first `limit` rows of a table, quoted for this database. */
  previewSql(table: TableInfo, limit: number): string;
  close(): Promise<void>;
}
