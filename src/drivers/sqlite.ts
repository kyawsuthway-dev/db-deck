import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { splitSql, stripLeadingComments } from '../query/splitSql';
import type { Cell, ChangeStatement, ColumnInfo, DbObject, Driver, FilterOperator, IndexInfo, RowChange, StatementResult, TableInfo, TablePage } from '../types';
import {
  buildChangeStatements,
  buildCountQuery,
  buildPageQuery,
  ChangeConflict,
  countFrom,
  FILTER_OPERATORS,
  filterCondition,
  identifierFor,
  insertStatements,
  MAX_ROWS,
  quoteIdent,
  runEach,
  standardLiteral,
  type WriteDialect,
} from './common';

const WRITE_DIALECT: WriteDialect = {
  quote: '"',
  placeholder: () => '?',
  nullSafeEquals: 'IS',
  allDefaults: 'DEFAULT VALUES',
  literal: standardLiteral,
};

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

  async listObjects(): Promise<DbObject[]> {
    return this.listTables();
  }

  async listIndexes(table: TableInfo): Promise<IndexInfo[]> {
    const db = await this.database();
    // Columns: seq, name, unique, origin (c = CREATE INDEX, u = UNIQUE, pk = PRIMARY KEY), partial
    const [list] = db.exec(`PRAGMA index_list(${quoteIdent(table.name, '"')})`);
    return (list?.values ?? [])
      .map(([, name, unique, origin]) => {
        // Columns: seqno, cid, name (null for an expression)
        const [info] = db.exec(`PRAGMA index_info(${quoteIdent(String(name), '"')})`);
        const columns = (info?.values ?? []).map(([, , col]) => (col === null ? '(expression)' : String(col))).join(', ');
        return { name: String(name), columns, unique: Number(unique) === 1, primary: origin === 'pk' };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listTriggers(table: TableInfo): Promise<DbObject[]> {
    const db = await this.database();
    const [result] = db.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`, [table.name]);
    return (result?.values ?? []).map(([name]) => ({ kind: 'trigger', name: String(name), table: table.name }));
  }

  /** Exactly the SQL SQLite stored. Indexes SQLite made itself (for PRIMARY KEY / UNIQUE) have none. */
  async objectDdl(object: DbObject): Promise<string> {
    const db = await this.database();
    const [result] = db.exec(`SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`, [object.kind, object.name]);
    const sql = result?.values[0]?.[0];
    if (typeof sql !== 'string') {
      return object.kind === 'index'
        ? `-- ${object.name} was created by SQLite for a PRIMARY KEY or UNIQUE constraint of ${object.table ?? 'its table'}; see the table's DDL.\n`
        : `-- No definition found for ${object.name}.\n`;
    }
    return `${sql.trim().replace(/;$/, '')};\n`;
  }

  async listDatabases(): Promise<string[]> {
    return [];
  }

  defaultSchemaLabel(): string | undefined {
    return undefined;
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

  async countRows(table: TableInfo, where?: string): Promise<string> {
    const sql = buildCountQuery(quoteIdent(table.name, '"'), filterCondition(where, 'sqlite'));
    const db = await this.database();
    const [result] = await runEach([sql], async (statement) => readStatement(db, statement));
    return countFrom(result);
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

  changeStatements(table: TableInfo, changes: RowChange[]): ChangeStatement[] {
    return buildChangeStatements(quoteIdent(table.name, '"'), WRITE_DIALECT, changes);
  }

  /**
   * sql.js has no second connection, so the transaction runs on a separate in-memory copy loaded from
   * the file, which is written back only after COMMIT. The main copy is dropped so the next call reloads
   * the saved file. (A transaction left open in the editor isn't kept for SQLite anyway; see README.)
   */
  async applyChanges(statements: ChangeStatement[]): Promise<void> {
    const SQL = await loadSqlJs();
    const db = new SQL.Database(fs.readFileSync(this.filePath));
    try {
      db.exec('BEGIN');
      statements.forEach((s, i) => {
        db.run(s.sql, s.params);
        const affected = db.getRowsModified();
        if (affected !== 1) throw new ChangeConflict(i, affected);
      });
      db.exec('COMMIT');
      fs.writeFileSync(this.filePath, db.export());
    } finally {
      db.close();
    }
    this.db?.close();
    this.db = undefined;
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
