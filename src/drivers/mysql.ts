import mysql from 'mysql2/promise';
import { splitSql } from '../query/splitSql';
import type { ColumnInfo, ConnectionConfig, Driver, StatementResult, TableInfo } from '../types';
import { quoteIdent, runEach } from './common';

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

  previewSql(table: TableInfo, limit: number): string {
    const name = quoteIdent(table.name, '`');
    return `SELECT * FROM ${table.schema ? `${quoteIdent(table.schema, '`')}.${name}` : name} LIMIT ${limit};`;
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
