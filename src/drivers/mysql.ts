import mysql from 'mysql2/promise';
import type { TableDesign } from '../design/model';
import { splitSql, stripLeadingComments } from '../query/splitSql';
import type { DesignChange } from '../design/diff';
import { parseMysqlTable, parseMysqlTree } from '../tools/plan';
import { checkClause, columnDefinition, createTableStatements, foreignKeyClause, type DdlDialect } from './ddl';
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
  RowChange,
  ScriptOptions,
  ScriptResult,
  ServerItem,
  ServerProcess,
  StatementResult,
  StreamOpener,
  TableInfo,
  TablePage,
} from '../types';
import {
  buildChangeStatements,
  buildCountQuery,
  buildDumpQuery,
  buildInsertBatch,
  buildPageQuery,
  ChangeConflict,
  countFrom,
  dumpInserts,
  formatBytes,
  formatDuration,
  FILTER_OPERATORS,
  filterCondition,
  identifierFor,
  importBatchRows,
  importRowsWith,
  insertStatements,
  quoteIdent,
  runEach,
  runScriptStatements,
  toDumpCell,
  type WriteDialect,
} from './common';

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

/** How MySQL writes table DDL (drivers/ddl.ts). */
const DDL: DdlDialect = {
  quote: '`',
  table: (schema, name) => qualifiedName({ schema, name }),
  literal: (value) => mysqlLiteral(value),
  autoIncrement: { clause: 'AUTO_INCREMENT', position: 'afterNotNull' },
  comments: 'inline',
};

/** MySQL and MariaDB. */
export class MysqlDriver implements Driver {
  private conn?: mysql.Connection;
  private connecting?: Promise<mysql.Connection>;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly password: string | undefined,
    /** Set when the connection goes through an SSH tunnel. */
    private readonly opener?: StreamOpener,
  ) {}

  async connect(): Promise<void> {
    await this.getConnection();
  }

  async listTables(): Promise<TableInfo[]> {
    const conn = await this.getConnection();
    const db = this.config.database;
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS t
         FROM information_schema.TABLES
        WHERE ${db ? 'TABLE_SCHEMA = ?' : 'TABLE_SCHEMA NOT IN (?)'}
        ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      [db ? db : SYSTEM_SCHEMAS],
    );
    return rows.map((r) => ({
      name: String(r.n),
      schema: db ? undefined : String(r.s),
      kind: r.t === 'VIEW' ? 'view' : 'table',
    }));
  }

  async listColumns(table: TableInfo): Promise<ColumnInfo[]> {
    const conn = await this.getConnection();
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS k,
              COLUMN_DEFAULT IS NOT NULL AS def, EXTRA AS extra
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table.schema ?? null, table.name],
    );
    return rows.map((r) => {
      const extra = String(r.extra ?? '');
      return {
        name: String(r.name),
        type: String(r.type),
        nullable: String(r.nullable) === 'YES',
        primaryKey: String(r.k) === 'PRI',
        hasDefault: String(r.def) === '1' || /auto_increment/i.test(extra),
        // Not DEFAULT_GENERATED (a CURRENT_TIMESTAMP default): that column takes values.
        generated: /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra),
      };
    });
  }

  async listObjects(): Promise<DbObject[]> {
    const conn = await this.getConnection();
    const db = this.config.database;
    const where = (column: string) => (db ? `${column} = ?` : `${column} NOT IN (?)`);
    const param = db ? db : SYSTEM_SCHEMAS;
    const schemaOf = (s: unknown) => (db ? undefined : String(s));
    const [relations] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.TABLES
        WHERE ${where('TABLE_SCHEMA')} ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      [param],
    );
    const [routines] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT ROUTINE_SCHEMA AS s, ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES
        WHERE ${where('ROUTINE_SCHEMA')} ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`,
      [param],
    );
    return [
      ...relations.map((r): DbObject => ({
        // MariaDB lists sequences as tables of type SEQUENCE.
        kind: r.t === 'VIEW' ? 'view' : r.t === 'SEQUENCE' ? 'sequence' : 'table',
        name: String(r.n),
        schema: schemaOf(r.s),
      })),
      ...routines.map((r): DbObject => ({
        kind: r.t === 'PROCEDURE' ? 'procedure' : 'function',
        name: String(r.n),
        schema: schemaOf(r.s),
      })),
    ];
  }

  async listIndexes(table: TableInfo): Promise<IndexInfo[]> {
    const rows = await this.indexRows(table);
    const byName = new Map<string, IndexInfo>();
    for (const r of rows) {
      const name = String(r.name);
      const column = r.col === null ? '(expression)' : String(r.col);
      const index = byName.get(name);
      if (index) index.columns += `, ${column}`;
      else byName.set(name, { name, columns: column, unique: String(r.nonUnique) === '0', primary: name === 'PRIMARY' });
    }
    return [...byName.values()];
  }

  async listTriggers(table: TableInfo): Promise<DbObject[]> {
    const conn = await this.getConnection();
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT TRIGGER_NAME AS n, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event FROM information_schema.TRIGGERS
        WHERE EVENT_OBJECT_SCHEMA = COALESCE(?, DATABASE()) AND EVENT_OBJECT_TABLE = ?
        ORDER BY TRIGGER_NAME`,
      [table.schema ?? null, table.name],
    );
    return rows.map((r) => ({
      kind: 'trigger',
      name: String(r.n),
      schema: table.schema,
      table: table.name,
      detail: `${String(r.timing)} ${String(r.event)}`,
    }));
  }

  /** SHOW CREATE … for everything but indexes, which are rebuilt from information_schema.STATISTICS. */
  async objectDdl(object: DbObject): Promise<string> {
    const name = qualifiedName(object);
    if (object.kind === 'index') {
      const rows = (await this.indexRows({ name: object.table ?? '', schema: object.schema, kind: 'table' })).filter((r) => String(r.name) === object.name);
      if (!rows.length) return `-- No definition found for ${object.name}.
`;
      const columns = rows.map((r) => (r.col === null ? '/* expression */' : quoteIdent(String(r.col), '`'))).join(', ');
      const on = qualifiedName({ name: object.table ?? '', schema: object.schema });
      if (object.name === 'PRIMARY') return `ALTER TABLE ${on} ADD PRIMARY KEY (${columns});\n`;
      const unique = String(rows[0].nonUnique) === '0' ? 'UNIQUE ' : '';
      return `CREATE ${unique}INDEX ${quoteIdent(object.name, '`')} ON ${on} (${columns});\n`;
    }
    const what = { table: 'TABLE', view: 'VIEW', function: 'FUNCTION', procedure: 'PROCEDURE', trigger: 'TRIGGER', sequence: 'SEQUENCE' }[object.kind];
    const conn = await this.getConnection();
    const [rows] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE ${what} ${name}`);
    const row = rows[0] ?? {};
    const key = Object.keys(row).find((k) => /^Create (Table|View|Function|Procedure|Sequence)$|^SQL Original Statement$/.test(k));
    const sql = key ? row[key] : null;
    if (sql === null || sql === undefined) {
      return `-- The server didn't return a definition for ${object.name} (it may need more privileges).\n`;
    }
    const body = `${String(sql).trim().replace(/;$/, '')};\n`;
    // Routine and trigger bodies contain ';', which DB Deck's runner would split on (no DELIMITER support).
    const note = object.kind === 'function' || object.kind === 'procedure' || object.kind === 'trigger'
      ? '-- For reading. Running this needs a client that supports DELIMITER: DB Deck splits statements at ";".\n'
      : '';
    return note + body;
  }

  async listDatabases(): Promise<string[]> {
    const conn = await this.getConnection();
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SHOW DATABASES');
    return rows.map((r) => String(Object.values(r)[0])).filter((d) => !SYSTEM_SCHEMAS.includes(d.toLowerCase()));
  }

  defaultSchemaLabel(): string | undefined {
    return this.config.database || undefined;
  }

  private async indexRows(table: TableInfo): Promise<mysql.RowDataPacket[]> {
    const conn = await this.getConnection();
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
        ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
      [table.schema ?? null, table.name],
    );
    return rows;
  }

  async query(sql: string): Promise<StatementResult[]> {
    const conn = await this.getConnection();
    return runEach(splitSql(sql, 'mysql'), async (statement) => {
      const [result, fields] = await conn.query({ sql: statement, rowsAsArray: true });
      if (!Array.isArray(result)) {
        return { columns: [], rows: [], affectedRows: (result as mysql.ResultSetHeader).affectedRows };
      }
      // CALL returns several result sets; show the first.
      if (Array.isArray(fields?.[0])) {
        const sets = fields as unknown as mysql.FieldPacket[][];
        return { columns: sets[0].map((f) => f.name), rows: result[0] as unknown[][] };
      }
      return { columns: (fields ?? []).map((f) => f.name), rows: result as unknown[][] };
    });
  }

  previewSql(table: TableInfo, page: TablePage): string {
    return buildPageQuery(qualifiedName(table), '`', page);
  }

  async selectPage(table: TableInfo, page: TablePage, where?: string): Promise<StatementResult> {
    const sql = buildPageQuery(qualifiedName(table), '`', page, filterCondition(where, 'mysql'));
    const conn = await this.getConnection();
    const [result] = await runEach([sql], async (statement) => {
      // A prepared statement refuses a second statement, a backstop to filterCondition's check.
      const [rows, fields] = await conn.execute({ sql: statement, rowsAsArray: true });
      return { columns: (fields ?? []).map((f) => f.name), rows: rows as unknown[][] };
    });
    return result;
  }

  async countRows(table: TableInfo, where?: string): Promise<string> {
    const sql = buildCountQuery(qualifiedName(table), filterCondition(where, 'mysql'));
    const conn = await this.getConnection();
    const [result] = await runEach([sql], async (statement) => {
      // A prepared statement refuses a second statement, a backstop to filterCondition's check.
      const [rows, fields] = await conn.execute({ sql: statement, rowsAsArray: true });
      return { columns: (fields ?? []).map((f) => f.name), rows: rows as unknown[][] };
    });
    return countFrom(result);
  }

  /** Column names aren't case-sensitive in MySQL, so only odd characters and reserved words need backticks. */
  filterIdentifier(name: string): string {
    return identifierFor(name, '`', /^[A-Za-z_][A-Za-z0-9_]*$/);
  }

  filterOperators(): FilterOperator[] {
    return FILTER_OPERATORS;
  }

  insertSql(table: TableInfo, columns: string[], rows: Cell[][]): string {
    return insertStatements(qualifiedName(table), '`', columns, rows, mysqlLiteral);
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = undefined;
    await conn?.end();
  }

  /** One long-lived connection, so session state carries across runs. Reopened if it drops. */
  private getConnection(): Promise<mysql.Connection> {
    if (this.conn) return Promise.resolve(this.conn);
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  changeStatements(table: TableInfo, changes: RowChange[]): ChangeStatement[] {
    return buildChangeStatements(qualifiedName(table), WRITE_DIALECT, changes);
  }

  /**
   * On its own connection, so the editor's session (and any open transaction) is never touched.
   * FOUND_ROWS makes affectedRows count rows matched, not rows changed: setting a cell to the value it
   * already has must not look like a conflict. MyISAM tables ignore the transaction (README).
   */
  async dumpPlan(tables: TableInfo[], views: TableInfo[]): Promise<DumpPlan> {
    const conn = await this.getConnection();
    const planned: DumpTable[] = [];
    let schema: string | undefined;
    // Tables outside the connection's database (an "all databases" connection) are created after a USE.
    const use = (t: TableInfo) => {
      if (!t.schema || t.schema === schema) return '';
      schema = t.schema;
      return `USE ${quoteIdent(t.schema, '`')};\n`;
    };
    for (const table of tables) {
      const name = qualifiedName(table);
      const [created] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE ${name}`);
      const sql = created[0]?.['Create Table'];
      if (typeof sql !== 'string') continue;
      // Generated columns can't be given values, so they're left out of the INSERTs. (EXTRA is also
      // DEFAULT_GENERATED for `DEFAULT CURRENT_TIMESTAMP`, which must stay in.)
      const [cols] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name, COLUMN_KEY AS k, EXTRA AS extra
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [table.schema ?? null, table.name],
      );
      const columns = cols.filter((c) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(String(c.extra ?? ''))).map((c) => String(c.name));
      planned.push({
        table,
        create: `${use(table)}${sql.trim().replace(/;$/, '')};\n`,
        columns,
        orderBy: cols.filter((c) => c.k === 'PRI').map((c) => ({ column: String(c.name), direction: 'asc' as const })),
        insert: (rows) => dumpInserts(name, '`', columns, rows, mysqlLiteral, (h) => `X'${h}'`),
      });
    }
    let viewSql = '';
    for (const view of views) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE VIEW ${qualifiedName(view)}`);
      const sql = rows[0]?.['Create View'];
      if (typeof sql !== 'string') continue;
      const db = view.schema ?? this.config.database;
      // Portable: no DEFINER (the user may not exist elsewhere), no source-database prefix on names.
      let body = sql.replace(/\s+DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`/, '');
      if (db) body = body.split(`${quoteIdent(db, '`')}.`).join('');
      viewSql += `${body.trim().replace(/;$/, '')};\n`;
    }
    return {
      // Like mysqldump: no foreign-key checks while loading, and an id of 0 stays 0 instead of a new AUTO_INCREMENT.
      start:
        "SET NAMES utf8mb4;\nSET @DBDECK_OLD_FK = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;\nSET @DBDECK_OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = CONCAT(@@SQL_MODE, ',NO_AUTO_VALUE_ON_ZERO');\n",
      structure: '',
      tables: planned,
      afterData: '',
      sequenceValues: '',
      views: viewSql,
      end: 'SET FOREIGN_KEY_CHECKS = @DBDECK_OLD_FK, SQL_MODE = @DBDECK_OLD_SQL_MODE;\n',
    };
  }

  async importRows(table: TableInfo, columns: string[], rows: AsyncIterable<ImportRow>, options: ImportOptions): Promise<ImportResult> {
    const name = qualifiedName(table);
    const conn = await this.createConnection();
    conn.on('error', () => {}); // a dropped connection fails the running statement instead of crashing
    const run = (sql: string) => conn.query(sql);
    try {
      return await importRowsWith(rows, options, {
        begin: async () => void (await run('START TRANSACTION')),
        commit: async () => void (await run('COMMIT')),
        rollback: async () => void (await run('ROLLBACK')),
        savepoint: async () => void (await run('SAVEPOINT dbdeck_batch')),
        rollbackToSavepoint: async () => void (await run('ROLLBACK TO SAVEPOINT dbdeck_batch')),
        releaseSavepoint: async () => void (await run('RELEASE SAVEPOINT dbdeck_batch')),
        deleteAll: async () => ((await conn.query(`DELETE FROM ${name}`))[0] as mysql.ResultSetHeader).affectedRows,
        // conn.execute, not conn.query: real server-side parameters (drivers.md).
        insert: async (batch) => {
          try {
            await conn.execute(buildInsertBatch(name, '`', columns, batch.length, () => '?'), batch.flatMap((r) => r.values));
          } catch (err) {
            // MySQL counts rows within the statement ("at row 1"); the import reports the file's line instead.
            if (err instanceof Error) err.message = err.message.replace(/ at row \d+$/, '');
            throw err;
          }
        },
        batchRows: importBatchRows(65_535, columns.length),
      });
    } finally {
      await conn.end().catch(() => {});
    }
  }

  async dumpRows(table: TableInfo, columns: string[], page: TablePage): Promise<DumpCell[][]> {
    const conn = await this.getConnection();
    const [rows] = await conn.query({ sql: buildDumpQuery(qualifiedName(table), '`', columns, page), rowsAsArray: true });
    return (rows as unknown[][]).map((row) => row.map(toDumpCell));
  }

  /** On its own connection, so the editor's session (and any open transaction) is never touched. */
  async runScript(statements: string[], options: ScriptOptions): Promise<ScriptResult> {
    const conn = await this.createConnection();
    conn.on('error', () => {}); // a dropped connection fails the running statement instead of crashing
    try {
      return await runScriptStatements(
        statements,
        options,
        async (sql) => {
          const [result] = await conn.query(sql);
          // DML returns a ResultSetHeader; SELECTs return rows (not counted).
          return !Array.isArray(result) && /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stripLeadingComments(sql)) ? (result as mysql.ResultSetHeader).affectedRows : undefined;
        },
        {
          begin: async () => void (await conn.query('START TRANSACTION')),
          commit: async () => void (await conn.query('COMMIT')),
          rollback: async () => void (await conn.query('ROLLBACK')),
        },
      );
    } finally {
      await conn.end().catch(() => {});
    }
  }

  createTableSql(design: TableDesign): string[] {
    return createTableStatements(design, DDL);
  }

  async readDesign(table: TableInfo): Promise<TableDesign> {
    const conn = await this.getConnection();
    const where = [table.schema ?? null, table.name];
    const [[info]] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_COMMENT AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?',
      where,
    );
    if (!info) throw new Error(`Table ${table.name} wasn’t found.`);
    const [cols] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra,
              COLUMN_COMMENT AS comment, DATA_TYPE AS dt
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      where,
    );
    const [stats] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nu, COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      where,
    );
    const [fkRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rs, k.REFERENCED_TABLE_NAME AS rt,
              k.REFERENCED_COLUMN_NAME AS rc, r.DELETE_RULE AS del, r.UPDATE_RULE AS upd
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      where,
    );
    const [checkRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT t.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS expr FROM information_schema.TABLE_CONSTRAINTS t
         JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
        WHERE t.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND t.TABLE_NAME = ? AND t.CONSTRAINT_TYPE = 'CHECK' ORDER BY 1`,
      where,
    );
    const group = <T>(rows: mysql.RowDataPacket[], make: (first: mysql.RowDataPacket, all: mysql.RowDataPacket[]) => T) => {
      const by = new Map<string, mysql.RowDataPacket[]>();
      for (const r of rows) by.set(String(r.name), [...(by.get(String(r.name)) ?? []), r]);
      return [...by.values()].map((all) => make(all[0], all));
    };
    const pk = stats.filter((r) => r.name === 'PRIMARY').map((r) => String(r.col));
    const here = table.schema ?? this.config.database;
    const numeric = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/i;
    return {
      schema: table.schema,
      name: table.name,
      comment: String(info.c ?? ''),
      columns: cols.map((c, i) => {
        const extra = String(c.extra ?? '');
        const def = c.def === null || c.def === undefined ? '' : String(c.def);
        // COLUMN_DEFAULT is the bare value for literals, an expression for DEFAULT_GENERATED (CURRENT_TIMESTAMP, (expr)).
        const expression = /DEFAULT_GENERATED/i.test(extra) || (numeric.test(String(c.dt)) && /^-?[\d.]+$/.test(def)) || /^NULL$/i.test(def);
        return {
          key: `c${i}`,
          name: String(c.name),
          type: String(c.type),
          nullable: String(c.nullable) === 'YES',
          default: !def || /^NULL$/i.test(def) ? '' : expression ? (/DEFAULT_GENERATED/i.test(extra) && !/^\(.*\)$/.test(def) && !/^CURRENT_TIMESTAMP/i.test(def) ? `(${def})` : def) : mysqlLiteral(def),
          primaryKey: pk.includes(String(c.name)),
          autoIncrement: /auto_increment/i.test(extra),
          comment: String(c.comment ?? ''),
          ...(/\b(VIRTUAL|STORED) GENERATED\b/i.test(extra) ? { generated: true } : {}),
        };
      }),
      // Indexes on columns; ones on expressions (COLUMN_NAME null) aren't shown and are left alone.
      indexes: group(stats.filter((r) => r.name !== 'PRIMARY'), (first, all) => ({ first, all }))
        .filter(({ all }) => all.every((r) => r.col !== null))
        .map(({ first, all }) => ({ name: String(first.name), columns: all.map((r) => String(r.col)), unique: String(first.nu) === '0' })),
      foreignKeys: group(fkRows, (first, all) => ({
        name: String(first.name),
        columns: all.map((r) => String(r.col)),
        refSchema: String(first.rs) === here ? undefined : String(first.rs),
        refTable: String(first.rt),
        refColumns: all.map((r) => String(r.rc)),
        onDelete: String(first.del),
        onUpdate: String(first.upd),
      })),
      checks: checkRows.map((c) => ({ name: String(c.name), expression: String(c.expr).replace(/^\(([\s\S]*)\)$/, '$1') })),
    };
  }

  /** Everything in one ALTER TABLE: MySQL commits DDL statement by statement, so one statement is all or nothing. */
  alterTableSql(before: TableDesign, after: TableDesign, changes: DesignChange[]): { statements: string[]; rebuild: boolean } {
    const table = qualifiedName({ schema: before.schema, name: before.name });
    const q = (n: string) => quoteIdent(n.trim(), '`');
    const specs: string[] = [];
    const pkChange = changes.find((c) => c.kind === 'primaryKey');
    const reorder = changes.some((c) => c.kind === 'reorder');
    const beforeByKey = new Map(before.columns.map((c) => [c.key, c]));
    for (const c of changes) {
      if (c.kind === 'dropForeignKey') specs.push(`DROP FOREIGN KEY ${q(c.foreignKey.name)}`);
      else if (c.kind === 'dropCheck') specs.push(`DROP CHECK ${q(c.check.name)}`);
      else if (c.kind === 'dropIndex') specs.push(`DROP INDEX ${q(c.index.name)}`);
    }
    if (pkChange && pkChange.before.length) specs.push('DROP PRIMARY KEY');
    for (const c of changes) if (c.kind === 'dropColumn') specs.push(`DROP COLUMN ${q(c.column.name)}`);
    // Columns in their new order: new ones are added at their place; changed, renamed or moved ones are
    // redefined in full (CHANGE COLUMN) with their place.
    const touched = new Set(changes.flatMap((c) => (c.kind === 'alterColumn' ? [c.after.key] : [])));
    const renamedFrom = new Map<string, string>();
    for (const col of after.columns) {
      const old = beforeByKey.get(col.key);
      if (old && old.name.trim() !== col.name.trim()) renamedFrom.set(col.key, old.name.trim());
    }
    after.columns.forEach((col, i) => {
      if (col.generated) return;
      const place = i === 0 ? ' FIRST' : ` AFTER ${q(after.columns[i - 1].name)}`;
      const definition = columnDefinition({ ...col, primaryKey: false }, DDL);
      const old = beforeByKey.get(col.key);
      if (!old) specs.push(`ADD COLUMN ${definition}${place}`);
      else if (touched.has(col.key) || renamedFrom.has(col.key) || reorder) specs.push(`CHANGE COLUMN ${q(old.name)} ${definition}${reorder ? place : ''}`);
    });
    if (pkChange?.after.length) specs.push(`ADD PRIMARY KEY (${pkChange.after.map(q).join(', ')})`);
    for (const c of changes) {
      if (c.kind === 'addIndex') specs.push(`ADD ${c.index.unique ? 'UNIQUE ' : ''}INDEX ${q(c.index.name)} (${c.index.columns.map(q).join(', ')})`);
      else if (c.kind === 'addForeignKey') specs.push(`ADD ${foreignKeyClause(c.foreignKey, DDL)}`);
      else if (c.kind === 'addCheck') specs.push(`ADD ${checkClause(c.check, DDL)}`);
      else if (c.kind === 'tableComment') specs.push(`COMMENT = ${mysqlLiteral(c.comment)}`);
    }
    return { statements: specs.length ? [`ALTER TABLE ${table}\n  ${specs.join(',\n  ')};`] : [], rebuild: false };
  }

  renameTableSql(table: TableInfo, newName: string): string {
    return `RENAME TABLE ${qualifiedName(table)} TO ${qualifiedName({ schema: table.schema, name: newName })};`;
  }

  truncateTableSql(table: TableInfo): string {
    return `TRUNCATE TABLE ${qualifiedName(table)};`;
  }

  dropSql(object: TableInfo): string {
    return `DROP ${object.kind === 'view' ? 'VIEW' : 'TABLE'} ${qualifiedName(object)};`;
  }

  /** MariaDB answers VERSION() with "…-MariaDB…"; it has no FORMAT=TREE or EXPLAIN ANALYZE. */
  private async isMariaDb(conn: mysql.Connection): Promise<boolean> {
    const [[row]] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
    return /mariadb/i.test(String(row?.v ?? ''));
  }

  async explain(sql: string, analyze: boolean): Promise<ExplainResult> {
    const statement = sql.trim().replace(/;\s*$/, '');
    const conn = await this.getConnection();
    const maria = await this.isMariaDb(conn);
    const tabular = async (note?: string): Promise<ExplainResult> => {
      const [rows, fields] = await conn.query({ sql: `EXPLAIN ${statement}`, rowsAsArray: true });
      const columns = (fields ?? []).map((f) => f.name);
      const cells = (rows as unknown[][]).map((r) => r.map((v) => (v === null || v === undefined ? null : String(v))));
      const raw = [columns.join('\t'), ...cells.map((r) => r.map((v) => v ?? 'NULL').join('\t'))].join('\n');
      return { plan: parseMysqlTable(columns, cells), raw, note };
    };
    if (analyze) {
      if (maria) throw new Error('MariaDB has no EXPLAIN ANALYZE (it uses ANALYZE <statement>, which DB Deck doesn’t support yet). Use Explain.');
      // Runs the statement: a read-only transaction rejects writes, and it's always rolled back, on its own connection.
      const own = await this.createConnection();
      own.on('error', () => {});
      try {
        await own.query('START TRANSACTION READ ONLY');
        const [rows] = await own.query({ sql: `EXPLAIN ANALYZE ${statement}`, rowsAsArray: true });
        const raw = String((rows as unknown[][])[0]?.[0] ?? '');
        return { plan: parseMysqlTree(raw), raw };
      } finally {
        await own.query('ROLLBACK').catch(() => {});
        await own.end().catch(() => {});
      }
    }
    if (maria) return tabular('MariaDB shows the plan as a table (no tree format).');
    try {
      const [rows] = await conn.query({ sql: `EXPLAIN FORMAT=TREE ${statement}`, rowsAsArray: true });
      const raw = String((rows as unknown[][])[0]?.[0] ?? '');
      return { plan: parseMysqlTree(raw), raw };
    } catch {
      // MySQL before 8.0.16 has no tree format.
      return tabular('This server shows the plan as a table (no tree format).');
    }
  }

  async serverStatus(): Promise<ServerItem[]> {
    const conn = await this.getConnection();
    const [[v]] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v, DATABASE() AS db, @@max_connections AS maxc');
    const [statusRows] = await conn.query<mysql.RowDataPacket[]>(
      `SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Questions', 'Slow_queries',
        'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads')`,
    );
    const st = new Map(statusRows.map((r) => [String(r.Variable_name), Number(r.Value)]));
    const [[size]] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT SUM(DATA_LENGTH + INDEX_LENGTH) AS b FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    );
    const uptime = st.get('Uptime') ?? 0;
    const requests = st.get('Innodb_buffer_pool_read_requests') ?? 0;
    const reads = st.get('Innodb_buffer_pool_reads') ?? 0;
    return [
      { label: 'Version', value: String(v.v) },
      { label: 'Uptime', value: formatDuration(uptime) },
      { label: 'Database size', value: v.db ? formatBytes(Number(size?.b ?? 0)) : 'n/a', detail: v.db ? String(v.db) : 'No database selected' },
      { label: 'Connections', value: `${st.get('Threads_connected') ?? '?'} of ${v.maxc}` },
      { label: 'Queries per second', value: uptime ? ((st.get('Questions') ?? 0) / uptime).toFixed(1) : 'n/a', detail: 'Average since the server started' },
      { label: 'Buffer pool hit ratio', value: requests ? `${(100 * (1 - reads / requests)).toFixed(2)}%` : 'n/a', detail: 'InnoDB reads served from memory' },
      { label: 'Slow queries', value: (st.get('Slow_queries') ?? 0).toLocaleString() },
    ];
  }

  async serverSettings(): Promise<ServerItem[]> {
    const [rows] = await (await this.getConnection()).query<mysql.RowDataPacket[]>('SHOW GLOBAL VARIABLES');
    return rows.map((r) => ({ label: String(r.Variable_name), value: String(r.Value ?? '') }));
  }

  async listProcesses(): Promise<ServerProcess[]> {
    const conn = await this.getConnection();
    const [[me]] = await conn.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SHOW FULL PROCESSLIST');
    return rows
      .filter((r) => String(r.Command) !== 'Daemon')
      .map((r) => ({
        id: String(r.Id),
        user: String(r.User ?? ''),
        database: String(r.db ?? ''),
        client: String(r.Host ?? ''),
        state: [r.Command, r.State].filter((x) => x !== null && x !== undefined && x !== '').join(' · '),
        seconds: r.Time === null || r.Time === undefined ? undefined : Number(r.Time),
        query: String(r.Info ?? ''),
        // MySQL has no application name in the process list: DB Deck's long-lived connection is this one.
        own: String(r.Id) === String(me?.id),
      }));
  }

  async endProcess(id: string, how: 'cancel' | 'terminate'): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error('Not a session id.');
    // KILL takes no parameters; the id is checked to be digits above.
    await (await this.getConnection()).query(how === 'cancel' ? `KILL QUERY ${id}` : `KILL ${id}`);
  }

  async referencingTables(table: TableInfo): Promise<string[]> {
    const conn = await this.getConnection();
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT DISTINCT TABLE_SCHEMA AS s, TABLE_NAME AS n FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = COALESCE(?, DATABASE()) AND REFERENCED_TABLE_NAME = ?
          AND NOT (TABLE_SCHEMA = REFERENCED_TABLE_SCHEMA AND TABLE_NAME = REFERENCED_TABLE_NAME)
        ORDER BY 1, 2`,
      [table.schema ?? null, table.name],
    );
    const here = table.schema ?? this.config.database;
    return rows.map((r) => (String(r.s) === here ? String(r.n) : `${String(r.s)}.${String(r.n)}`));
  }

  async applyChanges(statements: ChangeStatement[]): Promise<void> {
    const conn = await this.createConnection(['FOUND_ROWS']);
    conn.on('error', () => {}); // a dropped connection fails the pending query instead of crashing
    try {
      await conn.query('START TRANSACTION');
      for (const [i, s] of statements.entries()) {
        const [result] = await conn.execute(s.sql, s.params);
        const affected = (result as mysql.ResultSetHeader).affectedRows;
        if (affected !== 1) throw new ChangeConflict(i, affected);
      }
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await conn.end().catch(() => {});
    }
  }

  /** A new connection: through the tunnel if there is one, and read-only when the connection is. */
  private async createConnection(flags?: string[]): Promise<mysql.Connection> {
    const c = this.config;
    // Through a tunnel, mysql2 still gets the real host: TLS checks the certificate against it.
    const stream = this.opener ? await this.opener(c.host ?? 'localhost', c.port ?? 3306) : undefined;
    const conn = await mysql.createConnection({ ...this.options(), stream, flags });
    if (c.readOnly) {
      // Before anything else runs, on every connection (also the edit one). Not a security boundary:
      // the session can turn it off again (README).
      try {
        await conn.query('SET SESSION TRANSACTION READ ONLY');
      } catch (err) {
        await conn.end().catch(() => {});
        throw err;
      }
    }
    return conn;
  }

  private options(): mysql.ConnectionOptions {
    const c = this.config;
    return {
      host: c.host,
      port: c.port,
      user: c.user,
      password: this.password,
      database: c.database || undefined,
      ssl: c.ssl === 'require' ? {} : c.ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10_000,
      // Show values as the server sends them, without lossy conversion to JS numbers/dates.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      // JSON columns as the server's text. Parsed, 1.10 became 1.1 and big integers lost digits (core.md rule 5).
      jsonStrings: true,
    };
  }

  private async open(): Promise<mysql.Connection> {
    const conn = await this.createConnection();
    conn.on('error', () => {
      if (this.conn === conn) this.conn = undefined;
    });
    this.conn = conn;
    return conn;
  }
}

function qualifiedName(table: { name: string; schema?: string }): string {
  const name = quoteIdent(table.name, '`');
  return table.schema ? `${quoteIdent(table.schema, '`')}.${name}` : name;
}

/**
 * MySQL treats a backslash in a string literal as an escape (unless the server runs with
 * NO_BACKSLASH_ESCAPES, documented in the README), so backslashes are doubled as well as quotes.
 */
function mysqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const WRITE_DIALECT: WriteDialect = {
  quote: '`',
  placeholder: () => '?',
  nullSafeEquals: '<=>',
  allDefaults: '() VALUES ()',
  literal: mysqlLiteral,
  asText: (column) => `CAST(${column} AS CHAR)`,
};
