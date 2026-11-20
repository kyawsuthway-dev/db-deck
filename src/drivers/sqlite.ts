import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { splitSql, stripLeadingComments } from '../query/splitSql';
import type { Cell, ColumnInfo, Driver, FilterOperator, StatementResult, TableInfo, TablePage } from '../types';
import {
  buildPageQuery,
  FILTER_OPERATORS,
  filterCondition,
  identifierFor,
  insertStatements,
  MAX_ROWS,
  quoteIdent,
  runEach,
  standardLiteral,
} from './common';

let sqlJs: Promise<SqlJsStatic> | undefined;

/** sql.js is SQLite compiled to WebAssembly; esbuild.mjs copies sql-wasm.wasm next to the bundle. */
function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJs ??= initSqlJs({
    locateFile: (file) => path.join(__dirname, file),
    useOldExtensionFunctions: true, // sql.js's default; @types/sql.js wrongly marks it required
  });
  return sqlJs;
}

/**
 * sql.js works on an in-memory copy of the file. We reload it when the file changes on disk,
 * and write it back after any statement that might have changed it.
 * Limitation: a transaction left open at the end of a run is committed by the write-back.
 */
export class SqliteDriver implements Driver {
  private db?: Database;
  private loadedMtimeMs = 0;

  constructor(private readonly filePath: string) {}

  async connect(): Promise<void> {
    await this.load();
  }

  async listTables(): Promise<TableInfo[]> {
    const db = await this.database();
    const [result] = db.exec(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    );
    return (result?.values ?? []).map(([name, type]) => ({
      name: String(name),
      kind: type === 'view' ? 'view' : 'table',
    }));
  }

  async listColumns(table: TableInfo): Promise<ColumnInfo[]> {
    const db = await this.database();
    // Columns: cid, name, type, notnull, dflt_value, pk
    const [result] = db.exec(`PRAGMA table_info(${quoteIdent(table.name, '"')})`);
    return (result?.values ?? []).map(([, name, type, notnull, , pk]) => ({
      name: String(name),
      type: String(type ?? ''),
      nullable: notnull === 0,
      primaryKey: Number(pk) > 0,
    }));
  }

  async query(sql: string): Promise<StatementResult[]> {
    const db = await this.database();
    const results = await runEach(splitSql(sql, 'sqlite'), async (statement) => {
      const { columns, rows } = readStatement(db, statement);
      // SQLite's change counter keeps the last DML count through DDL, so only report it for DML.
      const isDml = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stripLeadingComments(statement));
      return { columns, rows, affectedRows: columns.length === 0 && isDml ? db.getRowsModified() : undefined };
    });
    if (results.some((r) => !r.error && mightWrite(r.sql))) this.save(db);
    return results;
  }

  previewSql(table: TableInfo, page: TablePage): string {
    return buildPageQuery(quoteIdent(table.name, '"'), '"', page);
  }

  /** A single SELECT, so the file is never written back. */
  async selectPage(table: TableInfo, page: TablePage, where?: string): Promise<StatementResult> {
    const sql = buildPageQuery(quoteIdent(table.name, '"'), '"', page, filterCondition(where, 'sqlite'));
    const db = await this.database();
    const [result] = await runEach([sql], async (statement) => readStatement(db, statement));
    return result;
  }

  /** Column names aren't case-sensitive in SQLite, so only odd characters and reserved words need quotes. */
  filterIdentifier(name: string): string {
    return identifierFor(name, '"', /^[A-Za-z_][A-Za-z0-9_]*$/);
  }

  filterOperators(): FilterOperator[] {
    return FILTER_OPERATORS;
  }

  insertSql(table: TableInfo, columns: string[], rows: Cell[][]): string {
    return insertStatements(quoteIdent(table.name, '"'), '"', columns, rows, standardLiteral);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  private async database(): Promise<Database> {
    if (this.db && fs.statSync(this.filePath).mtimeMs === this.loadedMtimeMs) return this.db;
    return this.load();
  }

  private async load(): Promise<Database> {
    const SQL = await loadSqlJs();
    const mtimeMs = fs.statSync(this.filePath).mtimeMs;
    const db = new SQL.Database(fs.readFileSync(this.filePath));
    try {
      db.exec('SELECT count(*) FROM sqlite_master'); // fails here if it isn't a SQLite file
    } catch (err) {
      db.close();
      throw err;
    }
    this.db?.close();
    this.db = db;
    this.loadedMtimeMs = mtimeMs;
    return db;
  }

  private save(db: Database): void {
    fs.writeFileSync(this.filePath, db.export());
    this.loadedMtimeMs = fs.statSync(this.filePath).mtimeMs;
  }
}

function mightWrite(sql: string): boolean {
  return !/^(SELECT|EXPLAIN)\b/i.test(stripLeadingComments(sql));
}

function readStatement(db: Database, statement: string): { columns: string[]; rows: unknown[][] } {
  const stmt = db.prepare(statement);
  try {
    const columns = stmt.getColumnNames();
    const rows: unknown[][] = [];
    // Read one extra row so runEach can tell the result was truncated.
    while (rows.length <= MAX_ROWS && stmt.step()) rows.push(stmt.get());
    return { columns, rows };
  } finally {
    stmt.free();
  }
}
