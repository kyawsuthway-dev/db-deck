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

/** Kinds of database objects the tree shows. */
export type ObjectKind = 'table' | 'view' | 'function' | 'procedure' | 'sequence' | 'index' | 'trigger';

/** A database object in the tree. Tables and views also fit `TableInfo`. */
export interface DbObject {
  kind: ObjectKind;
  name: string;
  /** Set only when the object is outside the connection's default schema/database (as `TableInfo`). */
  schema?: string;
  /** Indexes and triggers: the table they belong to (in the same schema). */
  table?: string;
  /** A database id that tells overloads apart (PostgreSQL function oid). */
  id?: string;
  /** Shown next to the name: a function's arguments, a trigger's timing, "materialized". */
  detail?: string;
}

export interface IndexInfo {
  name: string;
  /** The indexed columns or expressions, as the database shows them. */
  columns: string;
  unique: boolean;
  primary: boolean;
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

/** A column and a value. Changes use arrays of these, not objects, so any column name (even `__proto__`) is safe. */
export interface ColumnValue {
  column: string;
  value: Cell;
}

/** One pending change from the table view's grid. Values are text as typed, or null. */
export type RowChange =
  | {
      kind: 'update';
      /** The row's primary key, as loaded. */
      key: ColumnValue[];
      /** `original` is what the grid showed; when `check` is set it must still match (conflict detection). */
      set: { column: string; value: Cell; original: Cell; check: boolean }[];
    }
  | { kind: 'insert'; values: ColumnValue[] }
  | { kind: 'delete'; key: ColumnValue[] };

/**
 * Pending edits as the webview reports them: positions in the shown page and new values only.
 * Original values and primary keys come from the extension's own copy of the page, never from here.
 */
export interface PendingChanges {
  /** `row` is the row's index in the page as loaded (not its display position). */
  updates: { row: number; col: number; value: Cell }[];
  deletes: number[];
  /** New rows; columns left out get their default. */
  inserts: { col: number; value: Cell }[][];
}

/** A change as SQL: `sql` + `params` are what runs; `display` has the values written in, for review only. */
export interface ChangeStatement {
  kind: RowChange['kind'];
  sql: string;
  params: Cell[];
  display: string;
}

export interface Driver {
  /** Opens the connection. Throws with a readable message when it can't. */
  connect(): Promise<void>;
  listTables(): Promise<TableInfo[]>;
  listColumns(table: TableInfo): Promise<ColumnInfo[]>;
  /** Tables, views, functions, procedures and sequences, for the tree and Find Object. Read-only. */
  listObjects(): Promise<DbObject[]>;
  listIndexes(table: TableInfo): Promise<IndexInfo[]>;
  /** Triggers on a table or view (`kind: 'trigger'`, `table` set). */
  listTriggers(table: TableInfo): Promise<DbObject[]>;
  /** The object's definition as SQL text, for reading (Show DDL). Never run by DB Deck. */
  objectDdl(object: DbObject): Promise<string>;
  /** Other databases on the server, for Switch Database; empty when that doesn't apply (SQLite). */
  listDatabases(): Promise<string[]>;
  /** The name of the schema/database that objects without `schema` belong to (PostgreSQL `public`). */
  defaultSchemaLabel(): string | undefined;
  /** Runs one or more `;`-separated statements in order, stopping at the first error. */
  query(sql: string): Promise<StatementResult[]>;
  /** SQL text that selects one page of a table, for opening in an editor. Read-only. */
  previewSql(table: TableInfo, page: TablePage): string;
  /**
   * Runs one page of a table view as a single statement. `where` is a SQL condition the user typed
   * (the filter box); it's checked to be one statement and can't comment out the page limits.
   */
  selectPage(table: TableInfo, page: TablePage, where?: string): Promise<StatementResult>;
  /** `SELECT COUNT(*)` with the same filter rules as selectPage (Count button). Read-only; the count as text. */
  countRows(table: TableInfo, where?: string): Promise<string>;
  /** A column name as it should be typed in a condition: bare when that's safe, quoted otherwise. */
  filterIdentifier(name: string): string;
  /** Operators the WHERE box suggests for this database. */
  filterOperators(): FilterOperator[];
  /** `INSERT` statements (one per row, each ending in `;\n`) that recreate these rows in `table`. For export. */
  insertSql(table: TableInfo, columns: string[], rows: Cell[][]): string;
  /** Parameterized statements for pending table edits. Builds SQL only; nothing runs. */
  changeStatements(table: TableInfo, changes: RowChange[]): ChangeStatement[];
  /**
   * Runs the statements in one transaction on a separate, short-lived connection (SQLite: a separate
   * in-memory copy), so a transaction left open in the query editor is never touched. Each statement must
   * affect exactly one row, or everything rolls back and `ChangeConflict` is thrown.
   */
  applyChanges(statements: ChangeStatement[]): Promise<void>;
  close(): Promise<void>;
}
