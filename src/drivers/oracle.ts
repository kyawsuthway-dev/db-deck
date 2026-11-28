import type * as net from 'net';
import type oracledbType from 'oracledb';
import { splitSql } from '../query/splitSql';
import { readingStatement } from '../tools/plan';
import type {
  Cell,
  ChangeStatement,
  ColumnInfo,
  ConnectionConfig,
  DbObject,
  Driver,
  DumpCell,
  DumpPlan,
  ExplainResult,
  FilterOperator,
  ImportResult,
  IndexInfo,
  ObjectKind,
  RowChange,
  SchemaDiagram,
  SchemaEntry,
  ScriptResult,
  ServerItem,
  ServerProcess,
  StatementResult,
  StreamOpener,
  TableInfo,
  TablePage,
} from '../types';
import type { TableDesign } from '../design/model';
import {
  buildChangeStatements,
  ChangeConflict,
  countFrom,
  FILTER_OPERATORS,
  filterCondition,
  identifierFor,
  insertStatements,
  MAX_ROWS,
  PartialResults,
  quoteIdent,
  RowCollector,
  runEach,
  standardLiteral,
  treeSchemas,
  type RawResult,
  type WriteDialect,
} from './common';
import { dateTimeText, float32Text, intervalDsText, intervalYmText, isOracleDateTime, numberText, sessionOffsetFor, type DateKind } from './oracleValues';

const NOT_YET = 'This isn’t available for Oracle yet.';

/** Oracle's own statements only read on a read-only connection: a PL/SQL block can call a procedure that writes. */
const READING_STATEMENTS = ['SELECT', 'WITH'];

/** Longest LOB / XML / JSON text the grid keeps per value (decision 3); dumps will read the whole value. */
const MAX_TEXT = 1_000_000;

/** Rows fetched per round trip from a result set. */
const FETCH_ROWS = 500;

/**
 * Session formats DB Deck shows and accepts: dates and timestamps as `YYYY-MM-DD HH24:MI:SS[.FF]` (what the grid
 * shows, so an edited value or an exported INSERT converts back), `.` as the decimal point. Set on every connection.
 */
const SESSION_FORMATS =
  "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' " +
  "NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM' NLS_NUMERIC_CHARACTERS = '.,'";

type OracleDb = typeof oracledbType;
type Connection = oracledbType.Connection;
type Metadata = oracledbType.Metadata;

/** Oracle Database 12.1 and later, through node-oracledb's Thin mode (loaded on first use from `oracleLib.ts`). */
export class OracleDriver implements Driver {
  private conn?: Connection;
  private connecting?: Promise<Connection>;
  /** One call at a time on the shared connection; the tree, the editor and table views take turns. */
  private queue: Promise<unknown> = Promise.resolve();
  /** From the server after connecting. */
  private container?: string;
  private currentSchema?: string;
  private sessionZone = '+00:00';
  /** Oracle-maintained users (ALL_USERS.ORACLE_MAINTAINED), known after connecting: the system schemas. */
  private maintained = new Set<string>();
  /** Through an SSH tunnel: a 127.0.0.1 listener whose sockets go to the database through the tunnel. */
  private forward?: Promise<{ server: net.Server; port: number }>;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly password: string | undefined,
    /** Set when the connection goes through an SSH tunnel. */
    private readonly opener?: StreamOpener,
  ) {}

  async connect(): Promise<void> {
    await this.run(async () => undefined);
  }

  async listTables(): Promise<TableInfo[]> {
    const objects = await this.readObjects();
    return objects.filter((o) => o.kind === 'table' || o.kind === 'view').map((o) => ({ name: o.name, schema: o.schema, kind: o.kind === 'view' ? 'view' : 'table' }));
  }

  async listColumns(table: TableInfo): Promise<ColumnInfo[]> {
    const owner = this.ownerOf(table.schema);
    const rows = await this.rows(
      `SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale, c.nullable,
              CASE WHEN c.data_default IS NULL THEN 0 ELSE 1 END, c.identity_column, c.virtual_column,
              CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
                                 WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'P' AND kc.column_name = c.column_name)
                   THEN 1 ELSE 0 END
         FROM all_tab_cols c
        WHERE c.owner = :1 AND c.table_name = :2 AND c.hidden_column = 'NO'
        ORDER BY c.column_id`,
      [owner, table.name],
    );
    return rows.map(([name, type, length, charLength, charUsed, precision, scale, nullable, hasDefault, identity, virtual, pk]) => {
      const t = typeText(String(type), num(length), num(charLength), charUsed === 'C', numOrNull(precision), numOrNull(scale));
      return {
        name: String(name),
        type: t,
        nullable: nullable === 'Y',
        primaryKey: num(pk) === 1,
        hasDefault: identity === 'YES' || num(hasDefault) === 1,
        identity: identity === 'YES',
        generated: virtual === 'YES',
        shortened: isShortenedType(String(type)),
      };
    });
  }

  async listObjects(): Promise<DbObject[]> {
    return this.readObjects();
  }

  async listSchemaObjects(schema: string): Promise<DbObject[]> {
    return this.readObjects(schema);
  }

  /**
   * One schema's objects (Oracle-maintained ones too), or (no `only`) those of every schema that isn't Oracle's own.
   * A materialized view also has a table of the same name holding its rows; only the view is listed, as a view
   * ("materialized", as PostgreSQL's are). Dropped tables waiting in the recycle bin (`BIN$…`) are left out.
   */
  private async readObjects(only?: string): Promise<DbObject[]> {
    const rows = await this.rows(
      `SELECT o.owner, o.object_name, o.object_type, o.status
         FROM all_objects o
        WHERE o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'FUNCTION', 'PROCEDURE', 'PACKAGE', 'SEQUENCE')
          AND o.generated = 'N' AND o.secondary = 'N' AND o.object_name NOT LIKE 'BIN$%'
          AND (o.owner = :1 OR (:1 IS NULL AND o.owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')))
          AND NOT (o.object_type = 'TABLE' AND EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = o.owner AND m.mview_name = o.object_name))
        ORDER BY o.owner, o.object_name`,
      [only ?? null, only ?? null],
    );
    return rows.map(([owner, name, type, status]): DbObject => {
      const t = String(type);
      const kind: ObjectKind =
        t === 'TABLE' ? 'table' : t === 'VIEW' || t === 'MATERIALIZED VIEW' ? 'view' : t === 'SEQUENCE' ? 'sequence' : t === 'PACKAGE' ? 'package' : t === 'PROCEDURE' ? 'procedure' : 'function';
      const notes = [t === 'MATERIALIZED VIEW' ? 'materialized' : '', status === 'INVALID' ? 'invalid' : ''].filter(Boolean).join(', ');
      return { kind, name: String(name), schema: this.schemaOf(String(owner)), detail: notes || undefined };
    });
  }

  /**
   * Schemas are users. The connected one first; then users owning objects this user can see (a server often has many
   * empty application accounts, decision 4); Oracle-maintained users last, as system schemas.
   */
  async listTreeSchemas(): Promise<SchemaEntry[]> {
    const rows = await this.rows(
      `SELECT u.username FROM all_users u
        WHERE u.username = :1 OR EXISTS (SELECT 1 FROM all_objects o WHERE o.owner = u.username)`,
      [this.currentSchema ?? null],
    );
    return treeSchemas(rows.map(([name]) => String(name)), this.currentSchema, (name) => this.isSystemSchema(name));
  }

  isSystemSchema(schema: string | undefined): boolean {
    return this.maintained.has(schema ?? this.currentSchema ?? '');
  }

  async objectKinds(): Promise<ObjectKind[]> {
    return ['table', 'view', 'function', 'procedure', 'package', 'sequence'];
  }

  async listIndexes(table: TableInfo): Promise<IndexInfo[]> {
    const rows = await this.rows(
      `SELECT i.index_name, i.uniqueness, ic.column_name, ie.column_expression,
              CASE WHEN EXISTS (SELECT 1 FROM all_constraints k WHERE k.owner = i.table_owner AND k.table_name = i.table_name
                                   AND k.constraint_type = 'P' AND k.index_name = i.index_name) THEN 1 ELSE 0 END
         FROM all_indexes i
         JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
         LEFT JOIN all_ind_expressions ie ON ie.index_owner = ic.index_owner AND ie.index_name = ic.index_name AND ie.column_position = ic.column_position
        WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type <> 'LOB'
        ORDER BY i.index_name, ic.column_position`,
      [this.ownerOf(table.schema), table.name],
    );
    const byName = new Map<string, IndexInfo & { parts: string[] }>();
    for (const [name, uniqueness, column, expression, primary] of rows) {
      const key = String(name);
      const entry = byName.get(key) ?? { name: key, columns: '', unique: uniqueness === 'UNIQUE', primary: num(primary) === 1, parts: [] };
      // A function-based index lists a hidden SYS_NC… column; its expression is what was indexed.
      entry.parts.push(expression !== null && expression !== undefined ? String(expression).trim() : String(column));
      byName.set(key, entry);
    }
    return [...byName.values()].map(({ parts, ...ix }) => ({ ...ix, columns: parts.join(', ') }));
  }

  async listTriggers(table: TableInfo): Promise<DbObject[]> {
    const rows = await this.rows(
      `SELECT trigger_name, trigger_type, triggering_event, status FROM all_triggers
        WHERE table_owner = :1 AND table_name = :2 ORDER BY trigger_name`,
      [this.ownerOf(table.schema), table.name],
    );
    return rows.map(([name, type, event, status]) => ({
      kind: 'trigger',
      name: String(name),
      schema: table.schema,
      table: table.name,
      detail: [String(type ?? ''), String(event ?? ''), status === 'DISABLED' ? 'disabled' : ''].filter(Boolean).join(' · '),
    }));
  }

  /**
   * DDL as Oracle itself writes it (DBMS_METADATA.GET_DDL), with `;` after SQL and `/` after PL/SQL (the session's
   * SQLTERMINATOR transform, set when connecting), so it can be run in SQL*Plus or DB Deck as shown. A package shows
   * its specification and then its body. Never run by DB Deck.
   */
  async objectDdl(object: DbObject): Promise<string> {
    const owner = this.ownerOf(object.schema);
    const types: string[] =
      object.kind === 'package'
        ? ['PACKAGE_SPEC', 'PACKAGE_BODY']
        : object.kind === 'view' && object.detail?.includes('materialized')
          ? ['MATERIALIZED_VIEW']
          : [object.kind.toUpperCase()];
    const parts: string[] = [];
    for (const type of types) {
      try {
        const [[ddl] = []] = await this.rows('SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM dual', [type, object.name, owner]);
        if (ddl !== null && ddl !== undefined) parts.push(String(ddl).trim());
      } catch (err) {
        // A package without a body: ORA-31608 (object not found) for PACKAGE_BODY.
        if (type === 'PACKAGE_BODY' && /ORA-31608/.test(String((err as Error).message))) continue;
        throw err;
      }
    }
    return parts.length ? `${parts.join('\n\n')}\n` : `-- Oracle returned no definition for ${object.name}.\n`;
  }

  /** The pluggable database (or the database, outside a container database) the service leads to. */
  databaseName(): string {
    return this.container ?? this.config.database ?? '';
  }

  /** A connection is to one service; another database is another connection. */
  async listDatabases(): Promise<string[]> {
    return [];
  }

  defaultSchemaLabel(): string | undefined {
    return this.currentSchema;
  }

  /**
   * Runs each statement or PL/SQL unit in order (`splitSql`), each committed on its own as in the other databases.
   * Result sets are read in pages up to `MAX_ROWS + 1`; cursors returned with DBMS_SQL.RETURN_RESULT are shown as extra
   * results, and DBMS_OUTPUT lines as messages. On a read-only connection, every statement is checked first and nothing
   * runs if one may write (Oracle's read-only transaction still allows DDL).
   */
  async query(sql: string): Promise<StatementResult[]> {
    const statements = splitSql(sql, 'oracle');
    if (this.config.readOnly) {
      for (const statement of statements) {
        const check = readingStatement(statement, 'oracle', READING_STATEMENTS);
        if (!check.ok) return [{ sql: statement, columns: [], rows: [], durationMs: 0, error: check.reason }];
      }
    }
    return runEach(statements, (statement) => this.run((conn) => this.execute(conn, statement)));
  }

  previewSql(table: TableInfo, page: TablePage): string {
    return pageQuery(this.qualified(table), page);
  }

  async selectPage(table: TableInfo, page: TablePage, where?: string): Promise<StatementResult> {
    const sql = pageQuery(this.qualified(table), page, filterCondition(where, 'oracle'));
    const [result] = await runEach([sql], (statement) => this.run((conn) => this.execute(conn, statement, false)));
    return result;
  }

  async countRows(table: TableInfo, where?: string): Promise<string> {
    const condition = filterCondition(where, 'oracle');
    const sql = `SELECT COUNT(*) FROM ${this.qualified(table)}${condition ? ` WHERE (\n${condition}\n)` : ''}`;
    const [result] = await runEach([sql], (statement) => this.run((conn) => this.execute(conn, statement, false)));
    return countFrom(result);
  }

  /** Unquoted names are upper case in Oracle, so only upper-case names without odd characters stay bare. */
  filterIdentifier(name: string): string {
    return identifierFor(name, '"', /^[A-Z][A-Z0-9_$#]*$/);
  }

  filterOperators(): FilterOperator[] {
    return FILTER_OPERATORS;
  }

  insertSql(table: TableInfo, columns: string[], rows: Cell[][]): string {
    return insertStatements(this.qualified(table), '"', columns, rows, standardLiteral);
  }

  changeStatements(table: TableInfo, changes: RowChange[]): ChangeStatement[] {
    return buildChangeStatements(this.qualified(table), WRITE_DIALECT, changes);
  }

  /**
   * On its own connection in one transaction, so the editor's session (and any open transaction) is never touched.
   * Any statement not affecting exactly one row rolls everything back. A read-only connection refuses here.
   */
  async applyChanges(statements: ChangeStatement[]): Promise<void> {
    if (this.config.readOnly) throw new Error('This connection is read-only, so its tables can’t be edited.');
    const conn = await this.createConnection();
    try {
      for (const [i, s] of statements.entries()) {
        const binds = Object.fromEntries(s.params.map((v, k) => [`p${k + 1}`, v]));
        const result = await conn.execute(s.sql, binds, { autoCommit: false });
        if (result.rowsAffected !== 1) throw new ChangeConflict(i, result.rowsAffected ?? 0);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw oracleError(err);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  /** Users that aren't Oracle's own, empty ones too. */
  async listSchemas(): Promise<string[]> {
    const rows = await this.rows("SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username");
    return rows.map(([name]) => String(name));
  }

  /** Oracle has no enum types; CHECK … IN lists are read by Generate Mock Data itself. */
  async columnChoices(): Promise<Record<string, string[]>> {
    return {};
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = undefined;
    await conn?.close().catch(() => {});
    const forward = this.forward;
    this.forward = undefined;
    if (forward) (await forward.catch(() => undefined))?.server.close();
  }

  // Phase 14b-2 (transfer and design) and 14b-3 (tools). Oracle isn't offered outside development until then.
  async dumpPlan(): Promise<DumpPlan> {
    throw new Error(NOT_YET);
  }
  async dumpRows(): Promise<DumpCell[][]> {
    throw new Error(NOT_YET);
  }
  async runScript(): Promise<ScriptResult> {
    throw new Error(NOT_YET);
  }
  async importRows(): Promise<ImportResult> {
    throw new Error(NOT_YET);
  }
  createTableSql(): string[] {
    throw new Error(NOT_YET);
  }
  renameTableSql(): string {
    throw new Error(NOT_YET);
  }
  truncateTableSql(): string {
    throw new Error(NOT_YET);
  }
  dropSql(): string {
    throw new Error(NOT_YET);
  }
  async readDesign(): Promise<TableDesign> {
    throw new Error(NOT_YET);
  }
  alterTableSql(): { statements: string[]; rebuild: boolean } {
    throw new Error(NOT_YET);
  }
  async referencingTables(): Promise<string[]> {
    throw new Error(NOT_YET);
  }
  async explain(): Promise<ExplainResult> {
    throw new Error(NOT_YET);
  }
  async serverStatus(): Promise<ServerItem[]> {
    throw new Error(NOT_YET);
  }
  async serverSettings(): Promise<ServerItem[]> {
    throw new Error(NOT_YET);
  }
  async listProcesses(): Promise<ServerProcess[]> {
    throw new Error(NOT_YET);
  }
  async endProcess(): Promise<void> {
    throw new Error(NOT_YET);
  }
  async schemaDiagram(): Promise<SchemaDiagram> {
    throw new Error(NOT_YET);
  }

  /** Objects in the connected user's schema have no `schema` (the DbObject convention). */
  private schemaOf(owner: string): string | undefined {
    return owner === this.currentSchema ? undefined : owner;
  }

  private ownerOf(schema: string | undefined): string {
    return schema ?? this.currentSchema ?? '';
  }

  private qualified(table: { name: string; schema?: string }): string {
    const name = quoteIdent(table.name, '"');
    return table.schema ? `${quoteIdent(table.schema, '"')}.${name}` : name;
  }

  /**
   * One statement (or PL/SQL unit) and what came back: its result set (read in pages, at most `MAX_ROWS + 1` rows
   * kept), rows affected by DML, implicit results, DBMS_OUTPUT lines and compilation errors. `userSql` false: generated
   * SQL (table views), no DBMS_OUTPUT round trip.
   */
  private async execute(conn: Connection, sql: string, userSql = true): Promise<RawResult[]> {
    const { oracledb } = oracleLib();
    const results: RawResult[] = [];
    let result: oracledbType.Result;
    try {
      result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, resultSet: true, autoCommit: true, fetchTypeHandler: (m) => fetchAs(oracledb, m) });
      if (result.resultSet) results.push(await this.readResultSet(result.resultSet));
      for (const implicit of result.implicitResults ?? []) {
        if (Array.isArray(implicit)) results.push({ columns: [], rows: implicit.slice(0, MAX_ROWS + 1) });
        else results.push(await this.readResultSet(implicit));
      }
      if (!results.length) results.push({ columns: [], rows: [], affectedRows: result.rowsAffected });
    } catch (err) {
      throw results.length ? new PartialResults(results, oracleError(err, sql)) : oracleError(err, sql);
    }
    const messages = userSql ? await this.serverMessages(conn, sql, result) : [];
    if (messages.length) results[results.length - 1].messages = messages;
    return results;
  }

  private async readResultSet(rs: oracledbType.ResultSet): Promise<RawResult> {
    const meta = rs.metaData;
    const collector = new RowCollector();
    try {
      for (;;) {
        const rows = await rs.getRows(FETCH_ROWS);
        for (const row of rows) collector.add(row.map((v, i) => this.cellValue(v, meta[i])));
        if (rows.length < FETCH_ROWS || collector.rows.length > MAX_ROWS) break;
      }
    } finally {
      await rs.close().catch(() => {});
    }
    return { columns: meta.map((m) => m.name), rows: collector.rows };
  }

  /** A value as Oracle's own text (oracleValues.ts); the rest is `toCell`'s. */
  private cellValue(value: unknown, meta: Metadata): unknown {
    if (value === null || value === undefined) return null;
    const { oracledb } = oracleLib();
    const type = meta.dbType;
    if (isOracleDateTime(value)) {
      const kind: DateKind =
        type === oracledb.DB_TYPE_DATE ? 'date' : type === oracledb.DB_TYPE_TIMESTAMP_TZ ? 'tz' : type === oracledb.DB_TYPE_TIMESTAMP_LTZ ? 'ltz' : 'timestamp';
      return dateTimeText(value, kind, meta.precision, sessionOffsetFor(this.sessionZone));
    }
    if (type === oracledb.DB_TYPE_INTERVAL_DS && typeof value === 'object') return intervalDsText(value as Record<string, number>);
    if (type === oracledb.DB_TYPE_INTERVAL_YM && typeof value === 'object') return intervalYmText(value as Record<string, number>);
    if (type === oracledb.DB_TYPE_NUMBER && typeof value === 'string') return numberText(value);
    if (type === oracledb.DB_TYPE_BINARY_FLOAT && typeof value === 'number') return float32Text(value);
    if (typeof value === 'string' && value.length > MAX_TEXT) return `${value.slice(0, MAX_TEXT)}… (shortened: ${value.length.toLocaleString('en-US')} characters)`;
    if (type === oracledb.DB_TYPE_JSON && typeof value === 'object' && !Buffer.isBuffer(value)) {
      const text = JSON.stringify(value);
      return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (shortened: ${text.length.toLocaleString('en-US')} characters)` : text;
    }
    return value;
  }

  /**
   * What Oracle said besides the result: DBMS_OUTPUT lines (after PL/SQL and CALL, the statements that usually print),
   * and a unit's compilation errors, which Oracle reports as success with a warning.
   */
  private async serverMessages(conn: Connection, sql: string, result: oracledbType.Result): Promise<string[]> {
    const messages: string[] = [];
    const head = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(\w+)/.exec(sql)?.[1]?.toUpperCase();
    if (head === 'BEGIN' || head === 'DECLARE' || head === 'CALL') messages.push(...(await this.readOutput(conn)));
    const warning = (result as { warning?: Error }).warning;
    if (warning) {
      messages.push(warning.message.split('\n')[0]);
      messages.push(...(await this.compileErrors(conn, sql)));
    }
    return messages;
  }

  /** DBMS_OUTPUT lines waiting in this session (enabled when connecting), 1,000 at a time. */
  private async readOutput(conn: Connection): Promise<string[]> {
    const { oracledb } = oracleLib();
    const lines: string[] = [];
    for (;;) {
      const out = await conn.execute('BEGIN DBMS_OUTPUT.GET_LINES(:lines, :count); END;', {
        lines: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767, maxArraySize: 1000 },
        count: { dir: oracledb.BIND_INOUT, type: oracledb.NUMBER, val: 1000 },
      });
      const got = (out.outBinds?.lines as (string | null)[] | undefined) ?? [];
      const count = Number(out.outBinds?.count ?? 0);
      lines.push(...got.slice(0, count).map((l) => l ?? ''));
      if (count < 1000) return lines;
    }
  }

  /** ALL_ERRORS for the unit a CREATE statement made, as `LINE/COL: text`. */
  private async compileErrors(conn: Connection, sql: string): Promise<string[]> {
    const m = CREATED_UNIT.exec(sql);
    if (!m) return [];
    const ident = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toUpperCase());
    const type = m[1].toUpperCase().replace(/\s+/g, ' ');
    const owner = m[2] ? ident(m[2]) : this.currentSchema ?? '';
    const result = await conn.execute(
      'SELECT line, position, text FROM all_errors WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY sequence',
      [owner, ident(m[3]), type],
      { outFormat: oracleLib().oracledb.OUT_FORMAT_ARRAY },
    );
    return (result.rows ?? []).map(([line, position, text]) => `${type} ${ident(m[3])} line ${String(line)}, column ${String(position)}: ${String(text).trim()}`);
  }

  /** Catalog rows, values as the library gives them (NUMBER as a JavaScript number). */
  private async rows(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return this.run(async (conn) => {
      try {
        const result = await conn.execute(sql, params, { outFormat: oracleLib().oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler: (m) => catalogFetch(oracleLib().oracledb, m) });
        return result.rows ?? [];
      } catch (err) {
        throw oracleError(err);
      }
    });
  }

  /** Runs `work` on the shared connection when it's this caller's turn. */
  private run<T>(work: (conn: Connection) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => work(await this.getConnection()));
    this.queue = next.catch(() => {});
    return next;
  }

  /** One long-lived connection, so session state (ALTER SESSION, an open transaction in PL/SQL, packages) carries over. */
  private getConnection(): Promise<Connection> {
    if (this.conn?.isHealthy()) return Promise.resolve(this.conn);
    this.conn = undefined;
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(): Promise<Connection> {
    const conn = await this.createConnection();
    try {
      // The DDL Show DDL opens ends with `;` / `/`, ready to run. A session setting of DBMS_METADATA, not a write.
      await conn.execute("BEGIN DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE); DBMS_OUTPUT.ENABLE(NULL); END;");
      const info = await conn.execute(
        "SELECT SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), SESSIONTIMEZONE FROM dual",
        [],
        { outFormat: oracleLib().oracledb.OUT_FORMAT_ARRAY },
      );
      const [container, schema, zone] = info.rows?.[0] ?? [];
      this.container = container ? String(container) : undefined;
      this.currentSchema = schema ? String(schema) : undefined;
      this.sessionZone = zone ? String(zone) : '+00:00';
      const users = await conn.execute("SELECT username FROM all_users WHERE oracle_maintained = 'Y'", [], { outFormat: oracleLib().oracledb.OUT_FORMAT_ARRAY });
      this.maintained = new Set((users.rows ?? []).map(([name]) => String(name)));
    } catch (err) {
      await conn.close().catch(() => {});
      throw oracleError(err);
    }
    this.conn = conn;
    return conn;
  }

  /** A new connection: through the tunnel if there is one, with DB Deck's session formats. */
  private async createConnection(): Promise<Connection> {
    const c = this.config;
    const { oracledb } = oracleLib();
    const target = this.opener ? { host: '127.0.0.1', port: await this.forwardPort() } : { host: c.host ?? 'localhost', port: c.port ?? 1521 };
    let conn: Connection;
    try {
      conn = await oracledb.getConnection({
        user: c.user,
        password: this.password ?? '',
        connectString: connectDescriptor(target.host, target.port, c),
        ...(c.privilege ? { privilege: oracledb[c.privilege] } : {}),
        connectTimeout: 10,
        // Through a tunnel the client sees 127.0.0.1, so the certificate can't name it: the certificate itself is
        // still verified, only the host name match is off (the SSH host was checked by its key).
        ...(this.opener ? { sslServerDNMatch: false } : {}),
      });
    } catch (err) {
      throw connectError(err, c);
    }
    try {
      await conn.execute(SESSION_FORMATS);
    } catch (err) {
      await conn.close().catch(() => {});
      throw oracleError(err);
    }
    return conn;
  }

  /**
   * node-oracledb opens its own sockets and has no way to take a stream, so an Oracle connection through SSH listens
   * on 127.0.0.1 (a random port, this process only) and sends each socket through the tunnel. Closed with the driver.
   */
  private forwardPort(): Promise<number> {
    const opener = this.opener!;
    const host = this.config.host ?? 'localhost';
    const port = this.config.port ?? 1521;
    this.forward ??= new Promise((resolve, reject) => {
      const netModule = require('net') as typeof net;
      const server = netModule.createServer((socket) => {
        opener(host, port).then(
          (stream) => {
            socket.pipe(stream).pipe(socket);
            const end = () => {
              socket.destroy();
              stream.destroy();
            };
            socket.on('close', end).on('error', end);
            stream.on('close', end).on('error', end);
          },
          () => socket.destroy(),
        );
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
    });
    return this.forward.then((f) => f.port);
  }
}

/**
 * node-oracledb, loaded on first use. In the extension this is dist/oracle.js, its own bundle (esbuild.mjs
 * LIBRARY_BUNDLES), so VS Code never reads it unless an Oracle connection opens; a plain require inside a function
 * keeps it lazy.
 */
function oracleLib(): { oracledb: OracleDb } {
  return require('./oracleLib') as { oracledb: OracleDb };
}

/**
 * What Thin should hand back per column: NUMBER as its exact text (Thin decodes the digits straight to a string), LOBs
 * whole as text / bytes. Dates arrive as `OracleDateTime` (oracleLib.ts), intervals as Thin's exact objects.
 */
function fetchAs(oracledb: OracleDb, m: Metadata): oracledbType.FetchTypeResult | undefined {
  switch (m.dbType) {
    case oracledb.DB_TYPE_NUMBER:
    case oracledb.DB_TYPE_BINARY_INTEGER:
    case oracledb.DB_TYPE_CLOB:
    case oracledb.DB_TYPE_NCLOB:
      return { type: oracledb.STRING };
    case oracledb.DB_TYPE_BLOB:
      return { type: oracledb.BUFFER };
    default:
      return undefined;
  }
}

/** Catalog queries: DBMS_METADATA's CLOBs as text; numbers stay numbers. */
function catalogFetch(oracledb: OracleDb, m: Metadata): oracledbType.FetchTypeResult | undefined {
  return m.dbType === oracledb.DB_TYPE_CLOB ? { type: oracledb.STRING } : undefined;
}

/**
 * The connect descriptor for the form's settings: TCP or TCPS (Encryption), and the service name or SID. Built rather
 * than an Easy Connect string so a SID works too; host, service and SID are checked by the form (no parentheses).
 */
export function connectDescriptor(host: string, port: number, c: ConnectionConfig): string {
  const protocol = c.ssl && c.ssl !== 'off' ? 'TCPS' : 'TCP';
  const target = c.sid ? `(SID=${c.database ?? ''})` : `(SERVICE_NAME=${c.database ?? ''})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${host})(PORT=${port}))(CONNECT_DATA=${target}))`;
}

/** `SELECT * … OFFSET … FETCH NEXT … ROWS ONLY` (Oracle 12c and later). */
function pageQuery(from: string, page: TablePage, condition?: string): string {
  const limit = Math.max(0, Math.trunc(page.limit));
  const offset = Math.max(0, Math.trunc(page.offset));
  // On its own lines, so a trailing `-- comment` in the condition ends before ORDER BY.
  const where = condition ? ` WHERE (\n${condition}\n)` : '';
  const order = page.orderBy.length
    ? ` ORDER BY ${page.orderBy.map((k) => `${quoteIdent(k.column, '"')} ${k.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
    : '';
  return `SELECT * FROM ${from}${where}${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

/** A column type as Oracle writes it: VARCHAR2(100), VARCHAR2(20 CHAR), NUMBER(10,2), NUMBER, FLOAT(63), RAW(16)… */
export function typeText(type: string, length: number, charLength: number, charSemantics: boolean, precision: number | null, scale: number | null): string {
  switch (type) {
    case 'VARCHAR2':
    case 'CHAR':
      return `${type}(${charSemantics ? `${charLength} CHAR` : length})`;
    case 'NVARCHAR2':
    case 'NCHAR':
      return `${type}(${charLength})`;
    case 'RAW':
      return `RAW(${length})`;
    case 'NUMBER':
      if (precision === null) return scale === 0 ? 'NUMBER(*,0)' : 'NUMBER';
      return scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
    case 'FLOAT':
      return precision === null || precision === 126 ? 'FLOAT' : `FLOAT(${precision})`;
    default:
      return type;
  }
}

/**
 * Types the grid can't edit faithfully: large values it may shorten (LOBs, LONG), values Oracle can't compare with
 * `=` (XMLTYPE, JSON, LOBs), and bytes shown as shortened hex (RAW, LONG RAW, BFILE). Also object types, which
 * Thin can't read at all.
 */
function isShortenedType(type: string): boolean {
  return /^(CLOB|NCLOB|BLOB|BFILE|LONG|LONG RAW|RAW|XMLTYPE|JSON|VECTOR|SDO_GEOMETRY|ANYDATA)$/.test(type) || type.includes('.');
}

/** `CREATE [OR REPLACE] [EDITIONABLE] <type> [owner.]name`, for ALL_ERRORS after a compilation warning. */
const CREATED_UNIT =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PACKAGE\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\s+BODY|TYPE|VIEW)\s+(?:("(?:[^"]|"")+"|[A-Za-z][\w$#]*)\s*\.\s*)?("(?:[^"]|"")+"|[A-Za-z][\w$#]*)/i;

/** The server's error with where it happened in the statement (Oracle gives a character offset). */
function oracleError(err: unknown, sql?: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const e = err as Error & { offset?: number };
  // The "Help: https://docs.oracle.com/…" line is a link; the first line says what's wrong.
  const message = err.message.split('\nHelp:')[0].trim();
  if (!sql || !e.offset) return new Error(message);
  const before = sql.slice(0, e.offset);
  const line = before.split('\n').length;
  const column = e.offset - before.lastIndexOf('\n');
  return new Error(`${message} (line ${line}, column ${column})`);
}

/** A connection failure that says what to check (Thin mode's limits included). */
function connectError(err: unknown, c: ConnectionConfig): Error {
  const e = oracleError(err);
  const m = e.message;
  if (/NJS-138/.test(m)) return new Error(`${m} DB Deck supports Oracle Database 12.1 and later.`);
  if (/NJS-116/.test(m)) return new Error(`${m} The account’s password uses Oracle’s old 10G verifier; resetting the password on a current server creates a newer one.`);
  if (/NJS-533|NJS-534|native network encryption/i.test(m)) return new Error(`${m} Use TLS instead: set Encryption to SSL.`);
  if (/ORA-12514|ORA-12505|NJS-518|NJS-519/.test(m)) return new Error(`${m} Check the ${c.sid ? 'SID' : 'service name'} (often FREEPDB1, XEPDB1 or ORCLPDB1 for a pluggable database).`);
  if (/certificate|self.signed|NJS-505/i.test(m) && c.ssl !== 'off') {
    return new Error(`${m} DB Deck verifies the server’s certificate with your system’s trusted certificates; a self-signed one can’t be trusted from the form yet.`);
  }
  return e;
}

/** How Oracle writes table edits: named binds (`:p1`), so the NULL-safe check can use a value twice. */
const WRITE_DIALECT: WriteDialect = {
  quote: '"',
  placeholder: (n) => `:p${n}`,
  // `=` converts the text to the column's type, as the bind needs; DECODE would compare as text.
  nullSafeEquals: (column, value) => `(${column} = ${value} OR (${column} IS NULL AND ${value} IS NULL))`,
  // Oracle has no DEFAULT VALUES. This fits a one-column table; for more columns Oracle refuses it (ORA-00947) and the
  // save rolls back, so a new row needs at least one value typed.
  allDefaults: 'VALUES (DEFAULT)',
  literal: standardLiteral,
  asText: (column) => `TO_CHAR(${column})`,
};

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
