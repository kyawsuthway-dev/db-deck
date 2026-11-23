import type { Duplex } from 'stream';
import type { DesignChange } from './design/diff';
import type { TableDesign } from './design/model';
import type { PlanNode } from './tools/plan';

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
  /** Reach the database through an SSH host (servers only). Its password or key passphrase is in SecretStorage. */
  ssh?: SshConfig;
  /** One level of grouping in the Connections view. */
  folder?: string;
  /** The database session is read-only, and DB Deck doesn't offer edits (a guard against mistakes, not a security boundary). */
  readOnly?: boolean;
  /**
   * Where the connection lives, set by ConnectionManager when listing (never stored): undefined = all
   * workspaces (globalState), `workspace` = this workspace only (workspaceState), `env` = read from a .env file.
   */
  source?: 'workspace' | 'env';
}

/** Where a saved connection is stored; .env connections aren't saved. */
export type ConnectionScope = 'global' | 'workspace';

/** The SSH host in front of a database. `host`/`port` on the connection are then as seen from this host. */
export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  /** Private key file (auth `key`). Read when connecting, never stored. */
  keyPath?: string;
}


/** Opens a socket-like stream to host:port (through an SSH tunnel). Drivers use it instead of a TCP connection. */
export type StreamOpener = (host: string, port: number) => Promise<Duplex>;

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
  /** Has a default, identity or auto-increment, so an INSERT may leave it out. */
  hasDefault?: boolean;
  /** A generated (computed) column: it can't be given a value. */
  generated?: boolean;
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
      /**
       * `original` is what the grid showed; when `check` is set it must still match (conflict detection).
       * `asText`: compare the column's text, for types with no equality against text (json).
       */
      set: { column: string; value: Cell; original: Cell; check: boolean; asText?: boolean }[];
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

/** A value in a dump: text as the database sends it, or binary as complete hex (never shortened). */
export type DumpCell = Cell | { hex: string };

/** One table in a dump. Built by the driver, which knows which columns can be inserted and how. */
export interface DumpTable {
  table: TableInfo;
  /** CREATE statements for the table, ending in a newline (no foreign keys when `afterData` adds them). */
  create: string;
  /** The columns the dump reads and inserts, in order (generated columns are left out). */
  columns: string[];
  /** The primary key, to read pages in a stable order; empty when there is none. */
  orderBy: SortKey[];
  /** INSERT statements for these rows (values in `columns` order), ending in a newline. */
  insert(rows: DumpCell[][]): string;
}

/**
 * A dump in a restorable order, for one database. DB Deck writes: `start`; with structure `structure` and
 * each table's `create`; with data each table's rows; with structure `afterData`; with data `sequenceValues`;
 * with structure `views`; then `end`. Each part is SQL text ending in a newline, or ''.
 */
export interface DumpPlan {
  /** Session settings for the whole script (written for every dump). */
  start: string;
  /** Schemas and sequences the tables need. */
  structure: string;
  tables: DumpTable[];
  /** Foreign keys and indexes added once the data is in. */
  afterData: string;
  /** Sequences set past the restored rows. */
  sequenceValues: string;
  views: string;
  /** Restores what `start` changed. */
  end: string;
}

/** Options for running a script file (`Driver.runScript`). */
export interface ScriptOptions {
  /** Wrap everything in one transaction, rolled back on any error or on cancel. */
  transaction: boolean;
  /** Called after each statement with how many have run. */
  onProgress?: (done: number) => void;
  /** Checked between statements; true stops (and rolls back). */
  cancelled?: () => boolean;
}

export interface ScriptResult {
  statements: number;
  /** Rows reported by INSERT/UPDATE/DELETE statements. */
  affectedRows: number;
}

/** A CSV row for `Driver.importRows`: values in the import's column order (text or NULL), and its file line. */
export interface ImportRow {
  line: number;
  values: Cell[];
}

export interface ImportOptions {
  /** DELETE every row of the table first, in the same transaction (never TRUNCATE: MySQL would commit it). */
  deleteFirst: boolean;
  /** Called after each batch with the rows inserted so far. */
  onProgress?: (rows: number) => void;
  /** Checked between batches; true stops and rolls back. */
  cancelled?: () => boolean;
}

export interface ImportResult {
  inserted: number;
  /** Rows removed by `deleteFirst`. */
  deleted: number;
}

/** A query plan for the Explain panel. */
export interface ExplainResult {
  plan: PlanNode;
  /** The database's own output, for the Raw tab. */
  raw: string;
  /** Something the panel should say (e.g. a fallback format was used). */
  note?: string;
}

/** A line of the Server panel's Status or Settings tab. */
export interface ServerItem {
  label: string;
  value: string;
  detail?: string;
}

/** A session in the Server panel's Processes tab. */
export interface ServerProcess {
  id: string;
  user: string;
  database: string;
  client: string;
  state: string;
  /** How long the current query (or state) has lasted; undefined when unknown. */
  seconds?: number;
  query: string;
  /** One of DB Deck's own connections. */
  own: boolean;
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
  /** How to dump these tables and views, in an order that restores cleanly. Read-only. */
  dumpPlan(tables: TableInfo[], views: TableInfo[]): Promise<DumpPlan>;
  /** One page of a table for a dump: only `columns`, with full values (binary as complete hex). Read-only. */
  dumpRows(table: TableInfo, columns: string[], page: TablePage): Promise<DumpCell[][]>;
  /**
   * Runs a script's statements in order on a separate, short-lived connection (SQLite: a separate copy,
   * written to the file once at the end), so the editor's session is never touched. Stops at the first
   * error with `ScriptError`; with `transaction`, everything is rolled back (except what the database
   * commits on its own, like MySQL DDL). Cancelling throws `ScriptCancelled`.
   */
  runScript(statements: string[], options: ScriptOptions): Promise<ScriptResult>;
  /**
   * Inserts rows into `columns` of a table in one transaction on a separate, short-lived connection (SQLite:
   * a separate copy, written once). Values are parameters, never SQL text. Any failing row rolls everything
   * back with `ImportError` (its file line); cancelling throws `ImportCancelled`.
   */
  importRows(table: TableInfo, columns: string[], rows: AsyncIterable<ImportRow>, options: ImportOptions): Promise<ImportResult>;
  /** CREATE TABLE, then its indexes and comments, for a design (checked with checkDesign). Builds SQL only. */
  createTableSql(design: TableDesign): string[];
  /** Builds SQL only. `newName` is a plain name (same schema). */
  renameTableSql(table: TableInfo, newName: string): string;
  /** Empties a table: TRUNCATE, or DELETE FROM where there is no TRUNCATE (SQLite). Builds SQL only. */
  truncateTableSql(table: TableInfo): string;
  /** DROP TABLE or DROP VIEW, never with CASCADE. Builds SQL only. */
  dropSql(object: TableInfo): string;
  /** An existing table as a design (columns, keys, indexes, foreign keys, checks, comments). Read-only. */
  readDesign(table: TableInfo): Promise<TableDesign>;
  /**
   * SQL for the changes from `before` (as read) to `after`. Builds SQL only; `rebuild` says a SQLite table is
   * recreated. Throws a readable error for a change the database can't make.
   */
  alterTableSql(before: TableDesign, after: TableDesign, changes: DesignChange[]): { statements: string[]; rebuild: boolean };
  /**
   * The plan of one statement. Plain: estimates only, on the long-lived connection (session settings apply).
   * `analyze`: runs it, on a short-lived connection inside a read-only transaction that is rolled back;
   * callers check `readOnlyStatement` first. Throws a readable error where the database can't.
   */
  explain(sql: string, analyze: boolean): Promise<ExplainResult>;
  /** Version, uptime, sizes, connections… (read-only). */
  serverStatus(): Promise<ServerItem[]>;
  /** The server's settings (read-only). */
  serverSettings(): Promise<ServerItem[]>;
  /** Sessions on the server (read-only); empty where there are none (SQLite). */
  listProcesses(): Promise<ServerProcess[]>;
  /** Cancels a session's running query, or ends the session. Only after the user confirmed. */
  endProcess(id: string, how: 'cancel' | 'terminate'): Promise<void>;
  /** Tables whose foreign keys reference this one (labels like `schema.name`), for the Truncate / Drop forms. Read-only. */
  referencingTables(table: TableInfo): Promise<string[]>;
  close(): Promise<void>;
}
