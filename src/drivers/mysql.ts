import mysql from 'mysql2/promise';
import { splitSql, stripLeadingComments } from '../query/splitSql';
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
  FilterOperator,
  IndexInfo,
  RowChange,
  ScriptOptions,
  ScriptResult,
  StatementResult,
  StreamOpener,
  TableInfo,
  TablePage,
} from '../types';
import {
  buildChangeStatements,
  buildCountQuery,
  buildDumpQuery,
  buildPageQuery,
  ChangeConflict,
  countFrom,
  dumpInserts,
  FILTER_OPERATORS,
  filterCondition,
  identifierFor,
  insertStatements,
  quoteIdent,
  runEach,
  runScriptStatements,
  toDumpCell,
  type WriteDialect,
} from './common';

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

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
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS k
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table.schema ?? null, table.name],
    );
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: String(r.nullable) === 'YES',
      primaryKey: String(r.k) === 'PRI',
    }));
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
