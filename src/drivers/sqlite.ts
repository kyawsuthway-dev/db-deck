import * as fs from 'fs';
import * as path from 'path';
import type { Database, SqlJsStatic } from 'sql.js';
import type { TableDesign } from '../design/model';
import { splitSql, stripLeadingComments } from '../query/splitSql';
import type { DesignChange } from '../design/diff';
import { parseSqlitePlan } from '../tools/plan';
import { columnDefinition, createIndexStatement, createTableStatements, type DdlDialect } from './ddl';
import type {
  Cell,
  ChangeStatement,
  ColumnInfo,
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
  assembleDiagram,
} from './common';

/** How SQLite writes table DDL (drivers/ddl.ts). */
const DDL: DdlDialect = {
  quote: '"',
  table: (_schema, name) => quoteIdent(name, '"'),
  literal: standardLiteral,
  autoIncrement: { clause: 'AUTOINCREMENT', position: 'afterType', primaryKeyInline: true },
  comments: 'none',
};

/**
 * CHECK constraints from a CREATE TABLE text (SQLite has no catalog for them): `[CONSTRAINT name] CHECK (…)`,
 * with balanced parentheses and quotes respected. Column-level checks come back as table checks.
 */
export function checkConstraints(sql: string): { name: string; expression: string }[] {
  const found: { name: string; expression: string }[] = [];
  const re = /(?:\bCONSTRAINT\s+("(?:[^"]|"")+"|`(?:[^`]|``)+`|\[[^\]]+\]|\w+)\s+)?\bCHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = re.lastIndex;
    let quote: string | undefined;
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i];
      if (quote) {
        if (ch === quote) quote = sql[i + 1] === quote ? (i++, quote) : undefined;
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const rawName = m[1] ?? '';
    const name = rawName.replace(/^["`[]|["`\]]$/g, '').replace(/""/g, '"');
    found.push({ name, expression: sql.slice(re.lastIndex, i - 1).trim() });
    re.lastIndex = i;
  }
  return found;
}

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
  // Loaded on first use, like every database library (faster activation).
  sqlJs ??= import('sql.js').then(({ default: initSqlJs }) =>
    initSqlJs({
      locateFile: (file) => path.join(__dirname, file),
      useOldExtensionFunctions: true, // sql.js's default; @types/sql.js wrongly marks it required
    }),
  );
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

  /** One file, one unnamed schema: the tree shows the object folders directly (TREE_LAYOUT). */
  async listTreeSchemas(): Promise<SchemaEntry[]> {
    return [];
  }

  async listSchemaObjects(): Promise<DbObject[]> {
    return this.listTables();
  }

  isSystemSchema(): boolean {
    return false;
  }

  async objectKinds(): Promise<ObjectKind[]> {
    return ['table', 'view'];
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
    return createTableStatements(design, DDL);
  }

  async readDesign(table: TableInfo): Promise<TableDesign> {
    const db = await this.database();
    const rows = (sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params as never[]);
        const out: unknown[][] = [];
        while (stmt.step()) out.push(stmt.get());
        return out;
      } finally {
        stmt.free();
      }
    };
    const created = rows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table.name])[0]?.[0];
    if (typeof created !== 'string') throw new Error(`Table ${table.name} wasn’t found.`);
    // table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden (2/3 = generated).
    const cols = rows('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)', [table.name]);
    const keyCols = cols.filter((c) => Number(c[4]) > 0);
    const autoIncrement = /\bAUTOINCREMENT\b/i.test(created) && keyCols.length === 1;
    // index_list: seq, name, unique, origin (c = CREATE INDEX, u = UNIQUE constraint, pk), partial.
    const indexes: TableDesign['indexes'] = [];
    const preservedIndexes: string[] = [];
    for (const [, name, unique, origin, partial] of rows('SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?)', [table.name])) {
      if (origin === 'pk') continue;
      const info = rows('SELECT cid, name FROM pragma_index_info(?) ORDER BY seqno', [String(name)]);
      const plain = info.every((r) => Number(r[0]) >= 0) && Number(partial) === 0;
      if (plain) indexes.push({ name: String(name), columns: info.map((r) => String(r[1])), unique: Number(unique) === 1, ...(origin === 'u' ? { constraint: true } : {}) });
      else {
        const sql = rows("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [String(name)])[0]?.[0];
        if (typeof sql === 'string') preservedIndexes.push(`${sql.trim().replace(/;$/, '')};`);
      }
    }
    // foreign_key_list: id, seq, table, from, to, on_update, on_delete.
    const fkRows = rows('SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq', [table.name]);
    const fks = new Map<number, TableDesign['foreignKeys'][number]>();
    for (const [id, , ref, from, to, upd, del] of fkRows) {
      const f = fks.get(Number(id)) ?? { name: '', columns: [], refTable: String(ref), refColumns: [], onDelete: String(del), onUpdate: String(upd) };
      f.columns.push(String(from));
      f.refColumns.push(String(to ?? ''));
      fks.set(Number(id), f);
    }
    const triggers = rows("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL", [table.name]).map(
      (r) => `${String(r[0]).trim().replace(/;$/, '')};`,
    );
    return {
      name: table.name,
      comment: '',
      columns: cols.map((c, i) => ({
        key: `c${i}`,
        name: String(c[0]),
        type: String(c[1] ?? ''),
        nullable: Number(c[2]) === 0 && Number(c[4]) === 0,
        default: c[3] === null || c[3] === undefined ? '' : String(c[3]),
        primaryKey: Number(c[4]) > 0,
        autoIncrement: autoIncrement && Number(c[4]) > 0,
        comment: '',
        ...(Number(c[5]) === 2 || Number(c[5]) === 3 ? { generated: true } : {}),
      })),
      indexes,
      foreignKeys: [...fks.values()],
      checks: checkConstraints(created),
      preserved: { triggers, indexes: preservedIndexes },
    };
  }

  /**
   * ADD / RENAME / DROP COLUMN and index changes run directly. Anything else rebuilds the table, SQLite's
   * documented way: a new table with the new design, the rows copied, the old one dropped, the new one renamed,
   * then its indexes and triggers recreated, all in the script's transaction.
   */
  alterTableSql(before: TableDesign, after: TableDesign, changes: DesignChange[]): { statements: string[]; rebuild: boolean } {
    const table = quoteIdent(before.name, '"');
    const q = (n: string) => quoteIdent(n.trim(), '"');
    const used = new Set([...before.indexes.flatMap((x) => x.columns), ...before.foreignKeys.flatMap((f) => f.columns)]);
    const direct = changes.every((c) => {
      switch (c.kind) {
        case 'renameColumn':
        case 'addIndex':
          return true;
        case 'dropIndex':
          return !c.index.constraint;
        case 'addColumn':
          // ADD COLUMN can't add a key, or NOT NULL without a default, or a default that's an expression.
          return !c.column.primaryKey && !c.column.autoIncrement && (c.column.nullable || !!c.column.default.trim()) && !/^\s*\(|CURRENT_/i.test(c.column.default);
        case 'dropColumn':
          return !c.column.primaryKey && !used.has(c.column.name) && before.checks.length === 0;
        default:
          return false;
      }
    });
    if (direct) {
      const statements: string[] = [];
      for (const c of changes) if (c.kind === 'dropIndex') statements.push(`DROP INDEX ${q(c.index.name)};`);
      for (const c of changes) if (c.kind === 'renameColumn') statements.push(`ALTER TABLE ${table} RENAME COLUMN ${q(c.from)} TO ${q(c.to)};`);
      for (const c of changes) if (c.kind === 'dropColumn') statements.push(`ALTER TABLE ${table} DROP COLUMN ${q(c.column.name)};`);
      for (const c of changes) if (c.kind === 'addColumn') statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition(c.column, DDL)};`);
      for (const c of changes) if (c.kind === 'addIndex') statements.push(createIndexStatement(c.index, table, DDL));
      return { statements, rebuild: false };
    }
    if (before.columns.some((c) => c.generated)) {
      throw new Error('This change needs SQLite to rebuild the table, and DB Deck can’t rebuild a table with generated columns yet.');
    }
    const temp = `_dbdeck_new_${before.name}`;
    const beforeByKey = new Map(before.columns.map((c) => [c.key, c]));
    const kept = after.columns.filter((c) => beforeByKey.has(c.key));
    const statements = [
      createTableStatements({ ...after, name: temp }, DDL, { indexes: false })[0],
      `INSERT INTO ${q(temp)} (${kept.map((c) => q(c.name)).join(', ')}) SELECT ${kept.map((c) => q(beforeByKey.get(c.key)!.name)).join(', ')} FROM ${table};`,
      `DROP TABLE ${table};`,
      // Renaming checks the whole schema; legacy mode keeps a view or trigger elsewhere from blocking it.
      'PRAGMA legacy_alter_table = ON;',
      `ALTER TABLE ${q(temp)} RENAME TO ${table};`,
      'PRAGMA legacy_alter_table = OFF;',
      ...after.indexes.map((x) => createIndexStatement(x, table, DDL)),
      ...(before.preserved?.indexes ?? []),
      ...(before.preserved?.triggers ?? []),
    ];
    return { statements, rebuild: true };
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

  async explain(sql: string, analyze: boolean): Promise<ExplainResult> {
    if (analyze) throw new Error('SQLite has no EXPLAIN ANALYZE. Use Explain to see the plan.');
    const db = await this.database();
    const { rows } = readStatement(db, `EXPLAIN QUERY PLAN ${sql.trim().replace(/;\s*$/, '')}`);
    const cells = rows.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v))));
    const raw = cells.map((r) => `${r[0]}\t${r[1]}\t${r[3]}`).join('\n');
    return { plan: parseSqlitePlan(cells), raw: `id\tparent\tdetail\n${raw}` };
  }

  async serverStatus(): Promise<ServerItem[]> {
    const db = await this.database();
    const one = (sql: string) => {
      const { rows } = readStatement(db, sql);
      return rows[0]?.[0] === null || rows[0]?.[0] === undefined ? '' : String(rows[0][0]);
    };
    const pages = Number(one('PRAGMA page_count'));
    const pageSize = Number(one('PRAGMA page_size'));
    const stat = fs.statSync(this.filePath);
    return [
      { label: 'SQLite version', value: one('SELECT sqlite_version()'), detail: 'sql.js (WebAssembly)' },
      { label: 'File size', value: formatBytes(stat.size), detail: this.filePath },
      { label: 'Pages', value: `${pages.toLocaleString()} × ${pageSize.toLocaleString()} bytes`, detail: `${Number(one('PRAGMA freelist_count')).toLocaleString()} free` },
      { label: 'Journal mode', value: one('PRAGMA journal_mode') },
      { label: 'Encoding', value: one('PRAGMA encoding') },
      { label: 'Foreign keys enforced', value: one('PRAGMA foreign_keys') === '1' ? 'Yes' : 'No', detail: 'In DB Deck’s copy of the file' },
      { label: 'Auto-vacuum', value: ['None', 'Full', 'Incremental'][Number(one('PRAGMA auto_vacuum'))] ?? one('PRAGMA auto_vacuum') },
      { label: 'User version', value: one('PRAGMA user_version') },
    ];
  }

  async serverSettings(): Promise<ServerItem[]> {
    const db = await this.database();
    const names = ['application_id', 'auto_vacuum', 'automatic_index', 'cache_size', 'case_sensitive_like', 'encoding', 'foreign_keys', 'journal_mode', 'locking_mode', 'page_size', 'recursive_triggers', 'secure_delete', 'synchronous', 'temp_store', 'user_version'];
    return names.map((name) => {
      const { rows } = readStatement(db, `PRAGMA ${name}`);
      return { label: name, value: rows[0]?.[0] === null || rows[0]?.[0] === undefined ? '' : String(rows[0][0]) };
    });
  }

  async listProcesses(): Promise<ServerProcess[]> {
    return []; // a file, not a server: no other sessions to see
  }

  async endProcess(): Promise<void> {
    throw new Error('SQLite has no server sessions.');
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  /** SQLite has no enum types; CHECK … IN lists are read by Generate Mock Data itself. */
  async columnChoices(): Promise<Record<string, string[]>> {
    return {};
  }

  async schemaDiagram(): Promise<SchemaDiagram> {
    const db = await this.database();
    const all = (sql: string) => db.exec(sql)[0]?.values ?? [];
    const tables = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
    const cols = all(`SELECT m.name, p.name, p.type, p."notnull", p.pk FROM (${tables}) m JOIN pragma_table_info(m.name) p ORDER BY m.name, p.cid`);
    // The primary key from table_info (in pk order); unique indexes on plain columns from index_list / index_info.
    const pk = cols.filter((c) => Number(c[4]) > 0).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[4]) - Number(b[4]));
    const uniques = all(
      `SELECT m.name, l.name, i.name FROM (${tables}) m JOIN pragma_index_list(m.name) l JOIN pragma_index_info(l.name) i
        WHERE l."unique" = 1 AND l.partial = 0 AND l.origin <> 'pk'
          AND NOT EXISTS (SELECT 1 FROM pragma_index_info(l.name) x WHERE x.cid < 0)
        ORDER BY m.name, l.name, i.seqno`,
    );
    const fks = all(`SELECT m.name, f.id, f."from", f."table", f."to" FROM (${tables}) m JOIN pragma_foreign_key_list(m.name) f ORDER BY m.name, f.id, f.seq`);
    // REFERENCES parent without columns means the parent's primary key.
    const pkOf = (table: string) => pk.filter((c) => String(c[0]).toLowerCase() === table.toLowerCase()).map((c) => String(c[1]));
    const seen = new Map<string, number>();
    return assembleDiagram(
      cols.map((c) => ({ table: String(c[0]), name: String(c[1]), type: String(c[2] ?? ''), nullable: Number(c[3]) === 0 && Number(c[4]) === 0 })),
      [
        ...pk.map((c) => ({ table: String(c[0]), key: '', primary: true, column: String(c[1]) })),
        ...uniques.map((u) => ({ table: String(u[0]), key: String(u[1]), primary: false, column: String(u[2]) })),
      ],
      fks.map((f) => {
        const id = `${String(f[0])}\u0000${String(f[1])}`;
        const index = seen.get(id) ?? 0;
        seen.set(id, index + 1);
        return {
          table: String(f[0]),
          // SQLite foreign keys have no names: number them per table.
          name: `fk_${String(f[0])}_${Number(f[1]) + 1}`,
          column: String(f[2]),
          refTable: String(f[3]),
          refColumn: f[4] === null || f[4] === undefined ? (pkOf(String(f[3]))[index] ?? '') : String(f[4]),
        };
      }),
    );
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
