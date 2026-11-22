import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { TableDesign } from '../design/model';
import { splitSql, stripLeadingComments } from '../query/splitSql';
import { createTableStatements } from './ddl';
import type {
  Cell,
  ChangeStatement,
  ColumnInfo,
  DbObject,
  Driver,
  DumpCell,
  DumpPlan,
  DumpTable,
  FilterOperator,
  ImportOptions,
  ImportResult,
  ImportRow,
  IndexInfo,
  RowChange,
  ScriptOptions,
  ScriptResult,
  StatementResult,
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
  FILTER_OPERATORS,
  filterCondition,
  identifierFor,
  importBatchRows,
  importRowsWith,
  insertStatements,
  MAX_ROWS,
  quoteIdent,
  runEach,
  runScriptStatements,
  ScriptCancelled,
  standardLiteral,
  toDumpCell,
  type WriteDialect,
} from './common';

const WRITE_DIALECT: WriteDialect = {
  quote: '"',
  placeholder: () => '?',
  nullSafeEquals: 'IS',
  allDefaults: 'DEFAULT VALUES',
  literal: standardLiteral,
  // SQLite stores JSON as text already.
  asText: (column) => column,
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

  constructor(
    private readonly filePath: string,
    /** Read-only connection: `PRAGMA query_only` on every copy, and the file is never written. */
    private readonly readOnly = false,
  ) {}

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
    // Columns: cid, name, type, notnull, dflt_value, pk (table_info leaves generated columns out).
    const [result] = db.exec(`PRAGMA table_info(${quoteIdent(table.name, '"')})`);
    const rows = result?.values ?? [];
    const keys = rows.filter((r) => Number(r[5]) > 0);
    return rows.map(([, name, type, notnull, dflt, pk]) => ({
      name: String(name),
      type: String(type ?? ''),
      nullable: notnull === 0,
      primaryKey: Number(pk) > 0,
      // A lone INTEGER PRIMARY KEY is the rowid: SQLite fills it in.
      hasDefault: dflt !== null || (Number(pk) > 0 && keys.length === 1 && /^integer$/i.test(String(type ?? '').trim())),
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
    if (results.some((r) => !r.error && mightWrite(r.sql))) {
      if (!this.readOnly) this.save(db);
      // Read-only: something may have changed the in-memory copy (e.g. after PRAGMA query_only = OFF).
      // Drop it, so the next run shows the file again.
      else this.dropCopy();
    }
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
  createTableSql(design: TableDesign): string[] {
    return createTableStatements(design, {
      quote: '"',
      table: (_schema, name) => quoteIdent(name, '"'),
      literal: standardLiteral,
      autoIncrement: { clause: 'AUTOINCREMENT', position: 'afterType', primaryKeyInline: true },
      comments: 'none',
    });
  }

  renameTableSql(table: TableInfo, newName: string): string {
    return `ALTER TABLE ${quoteIdent(table.name, '"')} RENAME TO ${quoteIdent(newName, '"')};`;
  }

  /** SQLite has no TRUNCATE; an unqualified DELETE is optimized the same way. */
  truncateTableSql(table: TableInfo): string {
    return `DELETE FROM ${quoteIdent(table.name, '"')};`;
  }

  dropSql(object: TableInfo): string {
    return `DROP ${object.kind === 'view' ? 'VIEW' : 'TABLE'} ${quoteIdent(object.name, '"')};`;
  }

  async referencingTables(table: TableInfo): Promise<string[]> {
    const db = await this.database();
    const stmt = db.prepare(
      `SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = ? COLLATE NOCASE AND m.name <> ? COLLATE NOCASE ORDER BY 1`,
    );
    try {
      stmt.bind([table.name, table.name]);
      const names: string[] = [];
      while (stmt.step()) names.push(String(stmt.get()[0]));
      return names;
    } finally {
      stmt.free();
    }
  }

  async applyChanges(statements: ChangeStatement[]): Promise<void> {
    if (this.readOnly) throw new Error('This connection is read-only.');
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
    this.dropCopy();
  }

  async dumpPlan(tables: TableInfo[], views: TableInfo[]): Promise<DumpPlan> {
    const db = await this.database();
    const one = (sql: string, params: string[]) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows: unknown[][] = [];
        while (stmt.step()) rows.push(stmt.get());
        return rows;
      } finally {
        stmt.free();
      }
    };
    const planned: DumpTable[] = [];
    let afterData = '';
    for (const table of tables) {
      const [created] = one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table.name]);
      if (typeof created?.[0] !== 'string') continue;
      const name = quoteIdent(table.name, '"');
      // table_xinfo: hidden 0 = normal column, 2/3 = generated (can't be given values).
      const info = one(`SELECT name, hidden, pk FROM pragma_table_xinfo(?)`, [table.name]);
      const columns = info.filter((c) => Number(c[1]) === 0).map((c) => String(c[0]));
      const keys = info.filter((c) => Number(c[2]) > 0).sort((a, b) => Number(a[2]) - Number(b[2]));
      afterData += one("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", [table.name])
        .map((r) => `${String(r[0]).trim().replace(/;$/, '')};\n`)
        .join('');
      planned.push({
        table,
        create: `${created[0].trim().replace(/;$/, '')};\n`,
        columns,
        orderBy: keys.map((k) => ({ column: String(k[0]), direction: 'asc' as const })),
        insert: (rows) => dumpInserts(name, '"', columns, rows, standardLiteral, (h) => `X'${h}'`),
      });
    }
    const viewSql = views
      .map((v) => one("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?", [v.name])[0]?.[0])
      .filter((sql): sql is string => typeof sql === 'string')
      .map((sql) => `${sql.trim().replace(/;$/, '')};\n`)
      .join('');
    // Foreign keys are checked at COMMIT, not per statement, so tables can load in any order.
    return { start: 'PRAGMA defer_foreign_keys = ON;\n', structure: '', tables: planned, afterData, sequenceValues: '', views: viewSql, end: '' };
  }

  /** On a separate in-memory copy, written to the file once after COMMIT. */
  async importRows(table: TableInfo, columns: string[], rows: AsyncIterable<ImportRow>, options: ImportOptions): Promise<ImportResult> {
    if (this.readOnly) throw new Error('This connection is read-only.');
    const name = quoteIdent(table.name, '"');
    const SQL = await loadSqlJs();
    const db = new SQL.Database(fs.readFileSync(this.filePath));
    try {
      const result = await importRowsWith(rows, options, {
        begin: async () => void db.exec('BEGIN'),
        commit: async () => void db.exec('COMMIT'),
        rollback: async () => void db.exec('ROLLBACK'),
        savepoint: async () => void db.exec('SAVEPOINT dbdeck_batch'),
        rollbackToSavepoint: async () => void db.exec('ROLLBACK TO SAVEPOINT dbdeck_batch'),
        releaseSavepoint: async () => void db.exec('RELEASE SAVEPOINT dbdeck_batch'),
        deleteAll: async () => {
          db.run(`DELETE FROM ${name}`);
          return db.getRowsModified();
        },
        insert: async (batch) => void db.run(buildInsertBatch(name, '"', columns, batch.length, () => '?'), batch.flatMap((r) => r.values)),
        // SQLite's default limit on parameters per statement.
        batchRows: importBatchRows(32_766, columns.length),
      });
      fs.writeFileSync(this.filePath, db.export());
      return result;
    } finally {
      db.close();
      this.dropCopy();
    }
  }

  async dumpRows(table: TableInfo, columns: string[], page: TablePage): Promise<DumpCell[][]> {
    const db = await this.database();
    const { rows } = readStatement(db, buildDumpQuery(quoteIdent(table.name, '"'), '"', columns, page));
    return rows.map((row) => row.map(toDumpCell));
  }

  /**
   * On a separate in-memory copy, written to the file once at the end: once per script, not per statement.
   * Without a transaction, statements before an error (or a cancel) are kept, so the copy is written then too.
   */
  async runScript(statements: string[], options: ScriptOptions): Promise<ScriptResult> {
    if (this.readOnly) throw new Error('This connection is read-only.');
    const SQL = await loadSqlJs();
    const db = new SQL.Database(fs.readFileSync(this.filePath));
    let ran = false;
    try {
      const result = await runScriptStatements(
        statements,
        { ...options, onProgress: (n) => ((ran = n > 0), options.onProgress?.(n)) },
        async (sql) => {
          db.run(sql);
          return /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stripLeadingComments(sql)) ? db.getRowsModified() : undefined;
        },
        {
          begin: async () => void db.exec('BEGIN'),
          commit: async () => void db.exec('COMMIT'),
          rollback: async () => void db.exec('ROLLBACK'),
        },
      );
      fs.writeFileSync(this.filePath, db.export());
      return result;
    } catch (err) {
      if (!options.transaction && (ran || err instanceof ScriptCancelled)) fs.writeFileSync(this.filePath, db.export());
      throw err;
    } finally {
      db.close();
      this.dropCopy();
    }
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
      if (this.readOnly) db.exec('PRAGMA query_only = ON');
    } catch (err) {
      db.close();
      throw err;
    }
    this.db?.close();
    this.db = db;
    this.loadedMtimeMs = mtimeMs;
    return db;
  }

  private dropCopy(): void {
    this.db?.close();
    this.db = undefined;
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
