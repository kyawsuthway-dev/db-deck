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

export interface SortKey {
  column: string;
  direction: 'asc' | 'desc';
}

/** One page of a table view. An empty `orderBy` leaves the order to the database. */
export interface TablePage {
  limit: number;
  offset: number;
  orderBy: SortKey[];
}

/** An operator offered by the WHERE box's autocomplete. */
export interface FilterOperator {
  label: string;
  /** Text inserted in place of the partial word. */
  insert: string;
  /** Where the caret goes within `insert`; the end when absent. */
  caret?: number;
}

/** What the WHERE box's autocomplete offers for the open table. */
export interface FilterHints {
  /** `insert` is the name as it should be typed in this database (quoted only when needed). */
  columns: { name: string; type: string; insert: string }[];
  operators: FilterOperator[];
}

export interface Driver {
  /** Opens the connection. Throws with a readable message when it can't. */
  connect(): Promise<void>;
  listTables(): Promise<TableInfo[]>;
  listColumns(table: TableInfo): Promise<ColumnInfo[]>;
  /** Runs one or more `;`-separated statements in order, stopping at the first error. */
  query(sql: string): Promise<StatementResult[]>;
  /** SQL text that selects one page of a table, for opening in an editor. Read-only. */
  previewSql(table: TableInfo, page: TablePage): string;
  /**
   * Runs one page of a table view as a single statement. `where` is a SQL condition the user typed
   * (the filter box); it's checked to be one statement and can't comment out the page limits.
   */
  selectPage(table: TableInfo, page: TablePage, where?: string): Promise<StatementResult>;
  /** A column name as it should be typed in a condition: bare when that's safe, quoted otherwise. */
  filterIdentifier(name: string): string;
  /** Operators the WHERE box suggests for this database. */
  filterOperators(): FilterOperator[];
  close(): Promise<void>;
}
