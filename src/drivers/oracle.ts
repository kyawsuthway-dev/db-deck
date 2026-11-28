import type * as net from 'net';
import type oracledbType from 'oracledb';
import { execAsBlock, splitSql, sqlPlusCommand } from '../query/splitSql';
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
  DumpTable,
  ExplainResult,
  FilterOperator,
  ImportOptions,
  ImportResult,
  ImportRow,
  IndexInfo,
  ObjectKind,
  RowChange,
  SchemaDiagram,
  SchemaEntry,
  ScriptOptions,
  ScriptResult,
  ServerItem,
  ServerProcess,
  StatementResult,
  StreamOpener,
  TableInfo,
  TablePage,
} from '../types';
import type { ForeignKeyDesign, IndexDesign, TableDesign } from '../design/model';
import type { DesignChange } from '../design/diff';
import { checkClause, columnDefinition, createIndexStatement, createTableStatements, foreignKeyClause, type DdlDialect } from './ddl';
import {
  buildChangeStatements,
  ChangeConflict,
  countFrom,
  FILTER_OPERATORS,
  filterCondition,
  identifierFor,
  importRowsWith,
  insertStatements,
  MAX_ROWS,
  PartialResults,
  quoteIdent,
  RowCollector,
  runEach,
  runScriptStatements,
  standardLiteral,
  toDumpCell,
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
    const owner = await this.ownerOf(table.schema);
    const rows = await this.rows(
      `SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale, c.nullable,
              CASE WHEN c.data_default IS NULL THEN 0 ELSE 1 END, c.identity_column, c.virtual_column, i.generation_type,
              CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
                                 WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'P' AND kc.column_name = c.column_name)
                   THEN 1 ELSE 0 END
         FROM all_tab_cols c
         LEFT JOIN all_tab_identity_cols i ON i.owner = c.owner AND i.table_name = c.table_name AND i.column_name = c.column_name
        WHERE c.owner = :1 AND c.table_name = :2 AND c.hidden_column = 'NO'
        ORDER BY c.column_id`,
      [owner, table.name],
    );
    return rows.map(([name, type, length, charLength, charUsed, precision, scale, nullable, hasDefault, identity, virtual, generation, pk]) => {
      const t = typeText(String(type), num(length), num(charLength), charUsed === 'C', numOrNull(precision), numOrNull(scale));
      return {
        name: String(name),
        type: t,
        nullable: nullable === 'Y',
        primaryKey: num(pk) === 1,
        hasDefault: identity === 'YES' || num(hasDefault) === 1,
        identity: identity === 'YES',
        // A GENERATED ALWAYS identity column refuses values, like a virtual one (Import CSV and mock data skip it).
        generated: isComputed(virtual, type) || generation === 'ALWAYS',
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
      [await this.ownerOf(table.schema), table.name],
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
      [await this.ownerOf(table.schema), table.name],
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
    const owner = await this.ownerOf(object.schema);
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
      // SQL*Plus commands aren't sent (below); EXEC is a PL/SQL block and is checked like one.
      for (const statement of statements.filter((st) => !sqlPlusCommand(st) || /^EXEC/.test(sqlPlusCommand(st)!))) {
        const check = readingStatement(statement, 'oracle', READING_STATEMENTS);
        if (!check.ok) return [{ sql: statement, columns: [], rows: [], durationMs: 0, error: check.reason }];
      }
    }
    return runEach(statements, (statement) => {
      const command = sqlPlusCommand(statement);
      const block = command === 'EXEC' || command === 'EXECUTE' ? execAsBlock(statement) : undefined;
      if (command && !block) {
        const output = command === 'SET' && /\bSERVEROUT/i.test(statement) ? ' DB Deck shows DBMS_OUTPUT lines anyway.' : '';
        return Promise.resolve<RawResult>({ columns: [], rows: [], messages: [`Skipped: ${command} is a SQL*Plus command, which Oracle doesn’t run.${output}`] });
      }
      return this.run((conn) => this.execute(conn, block ?? statement));
    });
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

  /**
   * A script DB Deck's Run SQL File and SQL*Plus both run (`;` after SQL, `/` after PL/SQL): tables, comments,
   * indexes, foreign keys, sequences and views as Oracle writes them (DBMS_METADATA, without schema names or storage
   * clauses, decisions B and C), and rows as one INSERT each with literals by column type. Values too long for a SQL
   * literal are written in pieces. GENERATED ALWAYS identity columns take the rows as BY DEFAULT and go back after,
   * continuing past the restored rows (decision D). Read-only.
   */
  async dumpPlan(tables: TableInfo[], views: TableInfo[]): Promise<DumpPlan> {
    const planned: DumpTable[] = [];
    let afterData = '';
    let sequenceValues = '';
    const sequences = new Map<string, { owner: string; name: string }>();
    for (const table of tables) {
      const owner = await this.ownerOf(table.schema);
      const columns = await this.dumpColumns(owner, table.name);
      if (!columns.length) continue;
      // Decision B: no schema names, so the dump restores into the user who runs it.
      const target = quoteIdent(table.name, '"');
      const create = [await this.metadata('TABLE', { SCHEMA: owner, NAME: table.name }), await this.metadata('COMMENT', { BASE_OBJECT_SCHEMA: owner, BASE_OBJECT_NAME: table.name })]
        .filter(Boolean)
        .join('');
      const indexNames = await this.rows(
        `SELECT i.owner, i.index_name FROM all_indexes i
          WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type NOT IN ('LOB', 'IOT - TOP') AND i.generated = 'N'
            AND NOT EXISTS (SELECT 1 FROM all_constraints k WHERE k.owner = i.table_owner AND k.table_name = i.table_name AND k.index_name = i.index_name)
          ORDER BY i.index_name`,
        [owner, table.name],
      );
      for (const [ixOwner, ixName] of indexNames) afterData += await this.metadata('INDEX', { SCHEMA: String(ixOwner), NAME: String(ixName) });
      afterData += await this.metadata('REF_CONSTRAINT', { BASE_OBJECT_SCHEMA: owner, BASE_OBJECT_NAME: table.name });
      const writable = columns.filter((c) => c.writable);
      const always = columns.filter((c) => c.identity === 'ALWAYS');
      for (const c of columns.filter((x) => x.identity)) {
        const kind = c.identity === 'ALWAYS' ? 'ALWAYS' : c.onNull ? 'BY DEFAULT ON NULL' : 'BY DEFAULT';
        sequenceValues += `ALTER TABLE ${target} MODIFY (${quoteIdent(c.name, '"')} GENERATED ${kind} AS IDENTITY (START WITH LIMIT VALUE));\n`;
      }
      for (const c of columns) for (const seq of c.sequences) sequences.set(`${seq.owner}.${seq.name}`, seq);
      const keys = (await this.listColumns(table)).filter((c) => c.primaryKey).map((c) => ({ column: c.name, direction: 'asc' as const }));
      const unlock = always.map((c) => `ALTER TABLE ${target} MODIFY (${quoteIdent(c.name, '"')} GENERATED BY DEFAULT AS IDENTITY);\n`).join('');
      planned.push({
        table,
        create,
        columns: writable.map((c) => c.name),
        orderBy: keys,
        insert: (rows) => (rows.length ? unlock + rows.map((row) => insertRow(target, writable, row)).join('') : ''),
      });
    }
    let structure = '';
    for (const seq of sequences.values()) structure += await this.metadata('SEQUENCE', { SCHEMA: seq.owner, NAME: seq.name });
    return {
      // SQL*Plus would read & in the data as a substitution variable; DB Deck's Run SQL File skips the line (decision A).
      start: 'SET DEFINE OFF\n',
      structure,
      tables: planned,
      afterData,
      sequenceValues,
      views: await this.viewsInOrder(views),
      end: '',
    };
  }

  /**
   * One page of a table for a dump: whole values (no 1 MB cap), JSON as Oracle's own text (JSON_SERIALIZE keeps every
   * digit), LOCAL TIME ZONE values in UTC with their offset written, binary as complete hex. Read-only.
   */
  async dumpRows(table: TableInfo, columns: string[], page: TablePage): Promise<DumpCell[][]> {
    const types = new Map((await this.dumpColumns(await this.ownerOf(table.schema), table.name)).map((c) => [c.name, c.type]));
    const list = columns
      .map((c) => {
        const q = quoteIdent(c, '"');
        return types.get(c) === 'JSON' ? `JSON_SERIALIZE(${q} RETURNING CLOB) ${q}` : q;
      })
      .join(', ');
    const sql = pageQuery(this.qualified(table), page).replace(/^SELECT \* FROM /, `SELECT ${list} FROM `);
    return this.run(async (conn) => {
      const { oracledb } = oracleLib();
      let result: oracledbType.Result;
      try {
        result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler: (m) => fetchAs(oracledb, m) });
      } catch (err) {
        throw oracleError(err, sql);
      }
      const meta = result.metaData ?? [];
      return (result.rows ?? []).map((row) => row.map((v, i) => toDumpCell(this.dumpValue(v, meta[i]))));
    });
  }

  /**
   * Run SQL File's statements on their own connection, with autocommit off: everything since the last schema change
   * is rolled back on an error or Cancel (Oracle commits at every CREATE / ALTER / DROP, which the form says). A
   * script with its own COMMIT / ROLLBACK runs the same way, and what it leaves open is committed at the end, as
   * SQL*Plus does when it exits. SQL*Plus commands were left out by `analyzeScript` (decision A).
   */
  async runScript(statements: string[], options: ScriptOptions): Promise<ScriptResult> {
    if (this.config.readOnly) throw new Error('This connection is read-only, so DB Deck doesn’t run SQL files on it.');
    const conn = await this.createConnection();
    try {
      return await runScriptStatements(
        statements,
        { ...options, transaction: true },
        async (sql) => {
          try {
            return (await conn.execute(sql, [], { autoCommit: false })).rowsAffected;
          } catch (err) {
            throw oracleError(err, sql);
          }
        },
        { begin: async () => undefined, commit: () => conn.commit(), rollback: () => conn.rollback() },
      );
    } finally {
      await conn.close().catch(() => {});
    }
  }

  /**
   * Import CSV through `importRowsWith` on its own connection: array binds per batch (`executeMany`; INSERT ALL would
   * give every row the same identity value), a SAVEPOINT per batch (Oracle has no RELEASE). Values go in as text and
   * convert with the session formats; long text binds as CLOB.
   */
  async importRows(table: TableInfo, columns: string[], rows: AsyncIterable<ImportRow>, options: ImportOptions): Promise<ImportResult> {
    if (this.config.readOnly) throw new Error('This connection is read-only, so DB Deck doesn’t import into it.');
    const name = this.qualified(table);
    const types = new Map((await this.listColumns(table)).map((c) => [c.name, c.type]));
    const { oracledb } = oracleLib();
    const lob = columns.map((c) => /^(N?CLOB|LONG|XMLTYPE|JSON)$/.test(types.get(c) ?? ''));
    const sql = `INSERT INTO ${name} (${columns.map((c) => quoteIdent(c, '"')).join(', ')}) VALUES (${columns.map((_, i) => `:${i + 1}`).join(', ')})`;
    const conn = await this.createConnection();
    const exec = async (text: string) => {
      try {
        return await conn.execute(text, [], { autoCommit: false });
      } catch (err) {
        throw oracleError(err, text);
      }
    };
    try {
      return await importRowsWith(rows, options, {
        begin: async () => undefined,
        commit: () => conn.commit(),
        rollback: () => conn.rollback(),
        savepoint: async () => void (await exec('SAVEPOINT dbdeck_batch')),
        rollbackToSavepoint: async () => void (await exec('ROLLBACK TO SAVEPOINT dbdeck_batch')),
        // Oracle has no RELEASE SAVEPOINT: a savepoint simply ends with the transaction.
        releaseSavepoint: async () => undefined,
        deleteAll: async () => (await exec(`DELETE FROM ${name}`)).rowsAffected ?? 0,
        insert: async (batch) => {
          const bindDefs = columns.map((_, i) =>
            lob[i]
              ? { type: oracledb.DB_TYPE_CLOB }
              : { type: oracledb.STRING, maxSize: Math.max(1, ...batch.map((r) => Buffer.byteLength(r.values[i] ?? ''))) },
          );
          try {
            await conn.executeMany(sql, batch.map((r) => r.values), { autoCommit: false, bindDefs });
          } catch (err) {
            throw oracleError(err);
          }
        },
        batchRows: 500,
      });
    } finally {
      await conn.close().catch(() => {});
    }
  }

  createTableSql(design: TableDesign): string[] {
    return createTableStatements(design, DDL);
  }

  renameTableSql(table: TableInfo, newName: string): string {
    return `ALTER TABLE ${qualifiedName(table)} RENAME TO ${quoteIdent(newName.trim(), '"')};`;
  }

  /** Oracle commits TRUNCATE and refuses it while enabled foreign keys reference the table; never CASCADE. */
  truncateTableSql(table: TableInfo): string {
    return `TRUNCATE TABLE ${qualifiedName(table)};`;
  }

  /** DROP TABLE goes to the recycle bin where that's on; never CASCADE CONSTRAINTS or PURGE. */
  dropSql(object: TableInfo): string {
    return `DROP ${object.materialized ? 'MATERIALIZED VIEW' : object.kind === 'view' ? 'VIEW' : 'TABLE'} ${qualifiedName(object)};`;
  }

  async referencingTables(table: TableInfo): Promise<string[]> {
    const rows = await this.rows(
      `SELECT DISTINCT c.owner, c.table_name
         FROM all_constraints c JOIN all_constraints p ON p.owner = c.r_owner AND p.constraint_name = c.r_constraint_name
        WHERE c.constraint_type = 'R' AND p.owner = :1 AND p.table_name = :2 AND NOT (c.owner = p.owner AND c.table_name = p.table_name)
        ORDER BY 1, 2`,
      [await this.ownerOf(table.schema), table.name],
    );
    return rows.map(([owner, name]) => (String(owner) === this.currentSchema ? String(name) : `${String(owner)}.${String(name)}`));
  }

  /**
   * The table as the designer edits it, read the same way every time (Apply compares two reads). Defaults lose the
   * whitespace Oracle keeps around them, and a default of NULL reads as none (Oracle can't remove a default, only set
   * it to NULL). Oracle's own NOT NULL checks aren't checks here. Indexes the designer can't show (function-based,
   * bitmap, descending) are left out, so a design change never touches them.
   */
  async readDesign(table: TableInfo): Promise<TableDesign> {
    const owner = await this.ownerOf(table.schema);
    const cols = await this.rows(
      `SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale, c.nullable,
              c.data_default, c.identity_column, c.virtual_column, cc.comments
         FROM all_tab_cols c
         LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
        WHERE c.owner = :1 AND c.table_name = :2 AND c.hidden_column = 'NO'
        ORDER BY c.column_id`,
      [owner, table.name],
    );
    if (!cols.length) throw new Error(`Table ${tableText(table)} wasn't found.`);
    const constraints = await this.rows(
      `SELECT k.constraint_name, k.constraint_type, k.search_condition, k.generated, k.delete_rule, r.owner, r.table_name, kc.column_name, rc.column_name
         FROM all_constraints k
         LEFT JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
         LEFT JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name
         LEFT JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = kc.position
        WHERE k.owner = :1 AND k.table_name = :2 AND k.constraint_type IN ('P', 'U', 'R', 'C')
        ORDER BY k.constraint_name, kc.position`,
      [owner, table.name],
    );
    const pkColumns = new Set<string>();
    let primaryKeyName: string | undefined;
    const uniques = new Map<string, IndexDesign>();
    const fks = new Map<string, ForeignKeyDesign>();
    const checks = new Map<string, string>();
    for (const [name, type, condition, generated, deleteRule, refOwner, refTable, column, refColumn] of constraints) {
      const key = String(name);
      if (type === 'P') {
        primaryKeyName = key;
        if (column) pkColumns.add(String(column));
      } else if (type === 'U') {
        const ix = uniques.get(key) ?? { name: key, columns: [], unique: true, constraint: true };
        if (column) ix.columns.push(String(column));
        uniques.set(key, ix);
      } else if (type === 'R') {
        const fk = fks.get(key) ?? {
          name: key,
          columns: [],
          // Left out only for the connection's own schema (drivers.md).
          ...(String(refOwner) === this.currentSchema ? {} : { refSchema: String(refOwner) }),
          refTable: String(refTable),
          refColumns: [],
          onDelete: deleteRule === 'CASCADE' || deleteRule === 'SET NULL' ? String(deleteRule) : 'NO ACTION',
          onUpdate: 'NO ACTION',
        };
        if (column) fk.columns.push(String(column));
        if (refColumn) fk.refColumns.push(String(refColumn));
        fks.set(key, fk);
      } else if (type === 'C') {
        const text = String(condition ?? '').trim();
        // NOT NULL columns are also checks in Oracle's catalog; the designer shows them as Not null.
        if (generated === 'GENERATED NAME' && /^"[^"]+" IS NOT NULL$/.test(text)) continue;
        checks.set(key, text);
      }
    }
    const indexRows = await this.rows(
      `SELECT i.index_name, i.uniqueness, ic.column_name
         FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
        WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type = 'NORMAL' AND i.generated = 'N'
          AND NOT EXISTS (SELECT 1 FROM all_constraints k WHERE k.owner = i.table_owner AND k.table_name = i.table_name AND k.index_name = i.index_name)
          AND NOT EXISTS (SELECT 1 FROM all_ind_columns d WHERE d.index_owner = i.owner AND d.index_name = i.index_name AND d.descend = 'DESC')
        ORDER BY i.index_name, ic.column_position`,
      [owner, table.name],
    );
    const indexes = new Map<string, IndexDesign>();
    for (const [name, uniqueness, column] of indexRows) {
      const ix = indexes.get(String(name)) ?? { name: String(name), columns: [], unique: uniqueness === 'UNIQUE' };
      ix.columns.push(String(column));
      indexes.set(String(name), ix);
    }
    const [[tableComment] = []] = await this.rows('SELECT comments FROM all_tab_comments WHERE owner = :1 AND table_name = :2', [owner, table.name]);
    return {
      ...(table.schema ? { schema: table.schema } : {}),
      name: table.name,
      comment: tableComment ? String(tableComment) : '',
      columns: cols.map(([name, type, length, charLength, charUsed, precision, scale, nullable, dataDefault, identity, virtual, comment], i) => ({
        key: `c${i}`,
        name: String(name),
        type: typeText(String(type), num(length), num(charLength), charUsed === 'C', numOrNull(precision), numOrNull(scale)),
        nullable: nullable === 'Y',
        default: identity === 'YES' || isComputed(virtual, type) ? '' : designDefault(dataDefault),
        primaryKey: pkColumns.has(String(name)),
        autoIncrement: identity === 'YES',
        comment: comment ? String(comment) : '',
        ...(isComputed(virtual, type) ? { generated: true } : {}),
      })),
      indexes: [...[...uniques.values()].sort((a, b) => a.name.localeCompare(b.name)), ...indexes.values()],
      foreignKeys: [...fks.values()],
      checks: [...checks].map(([name, expression]) => ({ name, expression })),
      ...(primaryKeyName ? { primaryKeyName } : {}),
    };
  }

  /**
   * One statement per change, in an order Oracle accepts: column renames, then drops (indexes, constraints, the primary
   * key, columns), column changes (`MODIFY`, with only what changed: Oracle refuses a nullability it already has),
   * new columns, the new primary key, foreign keys, checks, indexes and comments. IDENTITY can be turned off
   * (`DROP IDENTITY`) but not on for an existing column, so that's refused with the reason. Pure: the designer calls
   * it on an unconnected driver.
   */
  alterTableSql(before: TableDesign, _after: TableDesign, changes: DesignChange[]): { statements: string[]; rebuild: boolean } {
    const table = qualifiedName({ schema: before.schema, name: before.name });
    const q = (n: string) => quoteIdent(n.trim(), '"');
    const out: string[] = [];
    const alter = (action: string) => out.push(`ALTER TABLE ${table} ${action};`);
    const comment = (target: string, text: string) => out.push(`COMMENT ON ${target} IS ${standardLiteral(text.trim())};`);
    const turnedOn = changes.find((c) => c.kind === 'alterColumn' && c.autoIncrement && c.after.autoIncrement);
    if (turnedOn?.kind === 'alterColumn') {
      throw new Error(
        `Oracle can’t make an existing column an identity column (${turnedOn.after.name.trim()}). Add a new column with Auto-increment, or create a new table and copy the rows over.`,
      );
    }
    for (const c of changes) if (c.kind === 'renameColumn') alter(`RENAME COLUMN ${q(c.from)} TO ${q(c.to)}`);
    for (const c of changes) {
      if (c.kind === 'dropIndex') {
        if (c.index.constraint) alter(`DROP CONSTRAINT ${q(c.index.name)}`);
        else out.push(`DROP INDEX ${before.schema ? `${q(before.schema)}.` : ''}${q(c.index.name)};`);
      } else if (c.kind === 'dropForeignKey') alter(`DROP CONSTRAINT ${q(c.foreignKey.name)}`);
      else if (c.kind === 'dropCheck') alter(`DROP CONSTRAINT ${q(c.check.name)}`);
    }
    const pkChange = changes.find((c) => c.kind === 'primaryKey');
    if (pkChange && before.primaryKeyName) alter(`DROP CONSTRAINT ${q(before.primaryKeyName)}`);
    for (const c of changes) if (c.kind === 'dropColumn') alter(`DROP COLUMN ${q(c.column.name)}`);
    for (const c of changes) {
      if (c.kind !== 'alterColumn') continue;
      const col = q(c.after.name);
      if (c.autoIncrement && !c.after.autoIncrement) alter(`MODIFY (${col} DROP IDENTITY)`);
      const parts = [
        c.type ? c.after.type.trim() : '',
        c.default ? `DEFAULT ${c.after.default.trim() || 'NULL'}` : '',
        c.nullable ? (c.after.nullable ? 'NULL' : 'NOT NULL') : '',
      ].filter(Boolean);
      if (parts.length) alter(`MODIFY (${col} ${parts.join(' ')})`);
    }
    for (const c of changes) if (c.kind === 'addColumn') alter(`ADD (${columnDefinition({ ...c.column, primaryKey: false }, DDL)})`);
    if (pkChange?.after.length) alter(`ADD PRIMARY KEY (${pkChange.after.map(q).join(', ')})`);
    for (const c of changes) {
      if (c.kind === 'addForeignKey') alter(`ADD ${foreignKeyClause(c.foreignKey, DDL)}`);
      else if (c.kind === 'addCheck') alter(`ADD ${checkClause(c.check, DDL)}`);
    }
    for (const c of changes) if (c.kind === 'addIndex') out.push(createIndexStatement(c.index, table, DDL));
    for (const c of changes) {
      if (c.kind === 'tableComment') comment(`TABLE ${table}`, c.comment);
      else if (c.kind === 'alterColumn' && c.comment) comment(`COLUMN ${table}.${q(c.after.name)}`, c.after.comment);
      else if (c.kind === 'addColumn' && c.column.comment.trim()) comment(`COLUMN ${table}.${q(c.column.name)}`, c.column.comment);
    }
    return { statements: out, rebuild: false };
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

  /** The owner of an object without `schema`: the connected user's schema, known once connected. */
  private async ownerOf(schema: string | undefined): Promise<string> {
    if (schema) return schema;
    if (!this.currentSchema) await this.connect();
    return this.currentSchema ?? '';
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

  /**
   * DDL from DBMS_METADATA through its handle API, so the transforms (no schema names or storage clauses, `;` and `/`)
   * apply to this call only, not the session. Several objects (an object's foreign keys or comments) come back one
   * after another. '' when there's none.
   */
  private async metadata(type: string, filters: Record<string, string>): Promise<string> {
    const { oracledb } = oracleLib();
    const params = [
      ['SQLTERMINATOR', 'TRUE'],
      ['PRETTY', 'TRUE'],
      ['EMIT_SCHEMA', 'FALSE'],
      ...(type === 'TABLE' || type === 'INDEX' ? [['SEGMENT_ATTRIBUTES', 'FALSE']] : []),
      ...(type === 'TABLE' ? [['REF_CONSTRAINTS', 'FALSE']] : []),
    ];
    const names = Object.keys(filters);
    const plsql = `DECLARE
  h NUMBER; t NUMBER; doc CLOB; result CLOB;
BEGIN
  DBMS_LOB.CREATETEMPORARY(result, TRUE);
  h := DBMS_METADATA.OPEN(:type);
  ${names.map((_, i) => `DBMS_METADATA.SET_FILTER(h, :f${i}, :v${i});`).join('\n  ')}
  t := DBMS_METADATA.ADD_TRANSFORM(h, 'DDL');
  ${params.map(([p, v]) => `DBMS_METADATA.SET_TRANSFORM_PARAM(t, '${p}', ${v});`).join('\n  ')}
  LOOP
    doc := DBMS_METADATA.FETCH_CLOB(h);
    EXIT WHEN doc IS NULL;
    DBMS_LOB.APPEND(result, doc);
  END LOOP;
  DBMS_METADATA.CLOSE(h);
  :ddl := result;
END;`;
    const binds: Record<string, unknown> = { type, ddl: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB } };
    names.forEach((n, i) => {
      binds[`f${i}`] = n;
      binds[`v${i}`] = filters[n];
    });
    return this.run(async (conn) => {
      let result: oracledbType.Result;
      try {
        result = await conn.execute(plsql, binds);
      } catch (err) {
        throw oracleError(err);
      }
      const lob = result.outBinds?.ddl as oracledbType.Lob | null | undefined;
      const text = lob ? String((await lob.getData()) ?? '') : '';
      lob?.destroy();
      // Each object comes with leading blank lines (PRETTY); one blank line between them.
      return text
        .split(/\n\s*\n(?=\s*(?:CREATE|ALTER|COMMENT)\b)/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => `${part}\n`)
        .join('\n');
    });
  }

  /** A table's columns for a dump: type, whether rows can include it, identity kind, sequences its default uses. */
  private async dumpColumns(owner: string, table: string): Promise<DumpColumn[]> {
    const rows = await this.rows(
      `SELECT c.column_name, c.data_type, c.data_type_owner, c.virtual_column, i.generation_type, c.default_on_null, c.data_default
         FROM all_tab_cols c
         LEFT JOIN all_tab_identity_cols i ON i.owner = c.owner AND i.table_name = c.table_name AND i.column_name = c.column_name
        WHERE c.owner = :1 AND c.table_name = :2 AND c.hidden_column = 'NO'
        ORDER BY c.column_id`,
      [owner, table],
    );
    return rows.map(([name, type, typeOwner, virtual, generation, onNull, dataDefault]) => {
      const t = String(type);
      const sequences: { owner: string; name: string }[] = [];
      for (const m of String(dataDefault ?? '').matchAll(/"([^"]+)"\."([^"]+)"\."?NEXTVAL"?/gi)) {
        if (!m[2].startsWith('ISEQ$$')) sequences.push({ owner: m[1], name: m[2] });
      }
      return {
        name: String(name),
        type: t,
        // Virtual columns can't take values; BFILE (a file pointer) and object types Thin can't read are left out.
        writable: !isComputed(virtual, t) && t !== 'BFILE' && (typeOwner === null || typeOwner === undefined || t === 'XMLTYPE'),
        identity: generation === 'ALWAYS' ? 'ALWAYS' : generation ? 'BY DEFAULT' : undefined,
        onNull: onNull === 'YES',
        sequences,
      };
    });
  }

  /** View DDL in an order that restores: a view after the views it reads (ALL_DEPENDENCIES). */
  private async viewsInOrder(views: TableInfo[]): Promise<string> {
    if (!views.length) return '';
    const key = (owner: string, name: string) => `${owner}\u0000${name}`;
    const wanted = new Map<string, TableInfo>();
    for (const v of views) wanted.set(key(await this.ownerOf(v.schema), v.name), v);
    const deps = await this.rows(
      `SELECT owner, name, referenced_owner, referenced_name FROM all_dependencies
        WHERE type IN ('VIEW', 'MATERIALIZED VIEW') AND referenced_type IN ('VIEW', 'MATERIALIZED VIEW')`,
    );
    const needs = new Map<string, string[]>();
    for (const [owner, name, refOwner, refName] of deps) {
      const from = key(String(owner), String(name));
      const to = key(String(refOwner), String(refName));
      if (wanted.has(from) && wanted.has(to)) needs.set(from, [...(needs.get(from) ?? []), to]);
    }
    const done = new Set<string>();
    const order: TableInfo[] = [];
    const visit = (k: string, path: Set<string>) => {
      if (done.has(k) || path.has(k)) return;
      path.add(k);
      for (const dep of needs.get(k) ?? []) visit(dep, path);
      done.add(k);
      order.push(wanted.get(k)!);
    };
    for (const k of wanted.keys()) visit(k, new Set());
    let out = '';
    for (const v of order) out += await this.metadata(v.materialized ? 'MATERIALIZED_VIEW' : 'VIEW', { SCHEMA: await this.ownerOf(v.schema), NAME: v.name });
    return out;
  }

  /** A value for a dump: as `cellValue`, but whole, and LOCAL TIME ZONE as UTC with its offset written. */
  private dumpValue(value: unknown, meta: Metadata): unknown {
    if (value === null || value === undefined) return null;
    const { oracledb } = oracleLib();
    if (isOracleDateTime(value) && meta.dbType === oracledb.DB_TYPE_TIMESTAMP_LTZ) return `${dateTimeText(value, 'ltz', 9, () => 0)} +00:00`;
    if (typeof value === 'string' && value.length > MAX_TEXT) return value;
    return this.cellValue(value, meta);
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

/**
 * A virtual (computed) column. An XMLTYPE column stored as binary XML is reported as virtual too (its data sits in a
 * hidden column), but it takes values like any other.
 */
function isComputed(virtual: unknown, type: unknown): boolean {
  return virtual === 'YES' && type !== 'XMLTYPE';
}

function qualifiedName(table: { name: string; schema?: string }): string {
  const name = quoteIdent(table.name, '"');
  return table.schema ? `${quoteIdent(table.schema, '"')}.${name}` : name;
}

function tableText(table: { name: string; schema?: string }): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/** A default as the designer shows it: Oracle keeps the typed whitespace, and `DEFAULT NULL` is how a default is removed. */
function designDefault(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return /^null$/i.test(text) ? '' : text;
}

/** How Oracle writes table DDL (drivers/ddl.ts): DEFAULT before NOT NULL, no ON UPDATE, comments as COMMENT ON. */
const DDL: DdlDialect = {
  quote: '"',
  table: (schema, name) => qualifiedName({ schema, name }),
  literal: standardLiteral,
  autoIncrement: { clause: 'GENERATED BY DEFAULT AS IDENTITY', position: 'afterType' },
  comments: 'statements',
  defaultFirst: true,
  referentialActions: (onDelete) => (onDelete === 'CASCADE' || onDelete === 'SET NULL' ? ` ON DELETE ${onDelete}` : ''),
};

/** A column in a dump (`dumpColumns`). */
interface DumpColumn {
  name: string;
  /** ALL_TAB_COLS.DATA_TYPE: `NUMBER`, `TIMESTAMP(6) WITH TIME ZONE`, `INTERVAL DAY(2) TO SECOND(6)`… */
  type: string;
  writable: boolean;
  identity?: 'ALWAYS' | 'BY DEFAULT';
  onNull: boolean;
  sequences: { owner: string; name: string }[];
}

/** Longest piece of text or hex on one line: SQL*Plus refuses lines over 2,499 characters. */
const PIECE = 1000;

/**
 * One row as an INSERT, values one per line. A BLOB over 2,000 bytes or a CLOB over 32,767 characters is too long for
 * a literal: the row is inserted with an empty LOB, which a PL/SQL block then fills in pieces (`DBMS_LOB.WRITEAPPEND`).
 */
function insertRow(table: string, columns: DumpColumn[], row: DumpCell[]): string {
  const big = columns.map((c, i) => {
    const v = row[i];
    if (v === null || v === undefined) return false;
    if (typeof v === 'object') return c.type === 'BLOB' && v.hex.length > 4000;
    return /^N?CLOB$/.test(c.type) && v.length > 32767;
  });
  const names = columns.map((c) => quoteIdent(c.name, '"')).join(', ');
  const values = columns.map((c, i) => (big[i] ? (c.type === 'BLOB' ? 'EMPTY_BLOB()' : 'EMPTY_CLOB()') : dumpLiteral(c.type, row[i])));
  const insert = `INSERT INTO ${table} (${names}) VALUES (\n  ${values.join(',\n  ')}\n)`;
  if (!big.some(Boolean)) return `${insert};\n`;
  const lobs = columns.map((c, i) => ({ c, i })).filter(({ i }) => big[i]);
  const vars = lobs.map((_, k) => `l${k + 1}`);
  const lines = [`DECLARE`, ...lobs.map(({ c }, k) => `  ${vars[k]} ${c.type};`), 'BEGIN', `${insert}\n  RETURNING ${lobs.map(({ c }) => quoteIdent(c.name, '"')).join(', ')} INTO ${vars.join(', ')};`];
  lobs.forEach(({ c, i }, k) => {
    const v = row[i]!;
    if (typeof v === 'object') {
      for (let at = 0; at < v.hex.length; at += PIECE * 2) {
        const hex = v.hex.slice(at, at + PIECE * 2);
        lines.push(`  DBMS_LOB.WRITEAPPEND(${vars[k]}, ${hex.length / 2}, HEXTORAW('${hex}'));`);
      }
    } else {
      for (const piece of pieces(v)) lines.push(`  DBMS_LOB.WRITEAPPEND(${vars[k]}, ${piece.length}, ${c.type === 'NCLOB' ? 'N' : ''}${quote(piece)});`);
    }
  });
  lines.push('END;', '/');
  return `${lines.join('\n')}\n`;
}

/** A value as an Oracle literal of its column's type, independent of the session's NLS settings. */
function dumpLiteral(type: string, v: DumpCell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'object') {
    if (!v.hex) return type === 'BLOB' ? 'EMPTY_BLOB()' : 'NULL';
    const hex = [];
    for (let at = 0; at < v.hex.length; at += PIECE * 2) hex.push(`'${v.hex.slice(at, at + PIECE * 2)}'`);
    return `HEXTORAW(${hex.join('\n    || ')})`;
  }
  const base = type.replace(/\(.*?\)/g, '').trim();
  switch (base) {
    case 'NUMBER':
    case 'FLOAT':
      return /^-?\d*\.?\d+(E[+-]?\d+)?$/i.test(v) ? v : quote(v);
    case 'BINARY_FLOAT':
    case 'BINARY_DOUBLE': {
      const prefix = base === 'BINARY_FLOAT' ? 'BINARY_FLOAT' : 'BINARY_DOUBLE';
      if (v === 'NaN') return `${prefix}_NAN`;
      if (v === 'Infinity') return `${prefix}_INFINITY`;
      if (v === '-Infinity') return `-${prefix}_INFINITY`;
      return `${v}${base === 'BINARY_FLOAT' ? 'f' : 'd'}`;
    }
    case 'DATE':
      return `TO_DATE(${quote(v)}, 'SYYYY-MM-DD HH24:MI:SS')`;
    case 'TIMESTAMP':
      return `TO_TIMESTAMP(${quote(v)}, ${v.includes('.') ? "'SYYYY-MM-DD HH24:MI:SS.FF9'" : "'SYYYY-MM-DD HH24:MI:SS'"})`;
    case 'TIMESTAMP WITH TIME ZONE':
    case 'TIMESTAMP WITH LOCAL TIME ZONE': {
      // Region-named values were shown as UTC (decision 11): restored in the UTC region, the same instant.
      const zone = v.endsWith(' UTC') ? 'TZR' : 'TZH:TZM';
      return `TO_TIMESTAMP_TZ(${quote(v)}, ${v.includes('.') ? `'SYYYY-MM-DD HH24:MI:SS.FF9 ${zone}'` : `'SYYYY-MM-DD HH24:MI:SS ${zone}'`})`;
    }
    case 'INTERVAL DAY TO SECOND':
      return `TO_DSINTERVAL(${quote(v)})`;
    case 'INTERVAL YEAR TO MONTH':
      return `TO_YMINTERVAL(${quote(v)})`;
    case 'BOOLEAN':
      return v === 'true' ? 'TRUE' : 'FALSE';
    case 'NCHAR':
    case 'NVARCHAR2':
    case 'NCLOB':
      return textLiteral(v, true, base === 'NCLOB');
    case 'XMLTYPE':
      return `XMLTYPE(${textLiteral(v, false, true)})`;
    default:
      return textLiteral(v, false, base === 'CLOB' || base === 'JSON' || base === 'LONG');
  }
}

/** A string literal, in pieces of at most 1,000 characters joined with `||` (TO_CLOB for LOBs, so it can grow past 4,000 bytes). */
function textLiteral(v: string, national: boolean, lob: boolean): string {
  const parts = pieces(v).map((p) => `${national ? 'N' : ''}${quote(p)}`);
  if (parts.length <= 1) return parts[0] ?? "''";
  return (lob ? parts.map((p) => `${national ? 'TO_NCLOB' : 'TO_CLOB'}(${p})`) : parts).join('\n    || ');
}

function quote(v: string): string {
  return `'${v.split("'").join("''")}'`;
}

/** Text in pieces of at most PIECE characters, never splitting a surrogate pair. */
function pieces(v: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < v.length; ) {
    let end = Math.min(v.length, at + PIECE);
    if (end < v.length && /[\uD800-\uDBFF]/.test(v[end - 1])) end--;
    out.push(v.slice(at, end));
    at = end;
  }
  return out.length ? out : [''];
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
