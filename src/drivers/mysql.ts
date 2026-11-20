import mysql from 'mysql2/promise';
import { splitSql } from '../query/splitSql';
import type { Cell, ColumnInfo, ConnectionConfig, Driver, FilterOperator, StatementResult, TableInfo, TablePage } from '../types';
import { buildPageQuery, FILTER_OPERATORS, filterCondition, identifierFor, insertStatements, quoteIdent, runEach } from './common';

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

/** MySQL and MariaDB. */
export class MysqlDriver implements Driver {
  private conn?: mysql.Connection;
  private connecting?: Promise<mysql.Connection>;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly password: string | undefined,
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

  private async open(): Promise<mysql.Connection> {
    const c = this.config;
    const conn = await mysql.createConnection({
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
    });
    conn.on('error', () => {
      if (this.conn === conn) this.conn = undefined;
    });
    this.conn = conn;
    return conn;
  }
}

function qualifiedName(table: TableInfo): string {
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
