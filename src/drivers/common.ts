import { splitSql } from '../query/splitSql';
import type { Cell, ChangeStatement, ColumnInfo, ColumnValue, DbType, DumpCell, FilterOperator, RowChange, ScriptOptions, ScriptResult, StatementResult, TablePage } from '../types';

/** Rows kept per statement; the grid shows a "truncated" note beyond this. */
export const MAX_ROWS = 10_000;

/** What a driver returns for one statement, before values are turned into display text. */
export interface RawResult {
  columns: string[];
  rows: unknown[][];
  affectedRows?: number;
}

/** Runs statements one by one, timing each and stopping at the first error. */
export async function runEach(
  statements: string[],
  exec: (sql: string) => Promise<RawResult>,
): Promise<StatementResult[]> {
  const results: StatementResult[] = [];
  for (const sql of statements) {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const raw = await exec(sql);
      results.push({
        sql,
        columns: raw.columns,
        rows: raw.rows.slice(0, MAX_ROWS).map((row) => row.map(toCell)),
        affectedRows: raw.affectedRows,
        truncated: raw.rows.length > MAX_ROWS,
        durationMs: elapsed(),
      });
    } catch (err) {
      results.push({ sql, columns: [], rows: [], durationMs: elapsed(), error: errorMessage(err) });
      break;
    }
  }
  return results;
}

export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  const shown = 64;
  const hex = Array.from(bytes.subarray(0, shown), (b) => b.toString(16).padStart(2, '0')).join('');
  return bytes.length > shown ? `0x${hex}… (${bytes.length} bytes)` : `0x${hex}`;
}

/** Readable message for driver errors, including Node's empty-message network errors. */
export function errorMessage(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length) {
    return [...new Set(err.errors.map(errorMessage))].join('; ');
  }
  if (err instanceof Error) {
    const { code, detail, hint } = err as Error & { code?: string; detail?: string; hint?: string };
    const parts = [err.message || code || err.name];
    if (detail) parts.push(`Detail: ${detail}`);
    if (hint) parts.push(`Hint: ${hint}`);
    return parts.join('\n');
  }
  return String(err);
}

export function quoteIdent(name: string, quote: '"' | '`'): string {
  return quote + name.split(quote).join(quote + quote) + quote;
}


/**
 * `SELECT * … WHERE (…) ORDER BY … LIMIT … OFFSET …` for a table view. `from` is the already-quoted table name;
 * `condition` comes from `filterCondition()`. LIMIT/OFFSET is the same in every supported database;
 * a database that differs would build its own.
 */
export function buildPageQuery(from: string, quote: '"' | '`', page: TablePage, condition?: string): string {
  const limit = Math.max(0, Math.trunc(page.limit));
  const offset = Math.max(0, Math.trunc(page.offset));
  // On its own lines, so a trailing `-- comment` in the condition ends before ORDER BY / LIMIT.
  const where = condition ? ` WHERE (\n${condition}\n)` : '';
  const orderBy = page.orderBy.length
    ? ` ORDER BY ${page.orderBy.map((k) => `${quoteIdent(k.column, quote)} ${k.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
    : '';
  return `SELECT * FROM ${from}${where}${orderBy} LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''};`;
}

/** `SELECT COUNT(*)` for a table view's Count button, with the filter wrapped exactly as buildPageQuery does. */
export function buildCountQuery(from: string, condition?: string): string {
  const where = condition ? ` WHERE (\n${condition}\n)` : '';
  return `SELECT COUNT(*) FROM ${from}${where};`;
}

/** The count from a COUNT(*) result, as text (very large counts stay exact). Throws the statement's error. */
export function countFrom(result: StatementResult | undefined): string {
  if (!result) throw new Error('The count returned nothing.');
  if (result.error) throw new Error(result.error);
  const value = result.rows[0]?.[0];
  if (value === null || value === undefined) throw new Error('The count returned nothing.');
  return value;
}

/**
 * The filter box's condition, checked to be a single statement so `1=1; DROP TABLE t` never runs.
 * A trailing `;` is dropped. Returns undefined when nothing but whitespace or comments was typed.
 */
export function filterCondition(where: string | undefined, dialect: DbType): string | undefined {
  if (!where?.trim()) return undefined;
  const parts = splitSql(where, dialect);
  if (parts.length > 1) throw new Error('The filter must be a single condition. Remove the ";" that ends it early.');
  return parts[0];
}

/** Operators the WHERE box suggests in every database. A driver may add its own (PostgreSQL: ILIKE). */
export const FILTER_OPERATORS: FilterOperator[] = [
  { label: '=', insert: '= ' },
  { label: '<>', insert: '<> ' },
  { label: '<', insert: '< ' },
  { label: '<=', insert: '<= ' },
  { label: '>', insert: '> ' },
  { label: '>=', insert: '>= ' },
  { label: 'LIKE', insert: 'LIKE ' },
  { label: 'NOT LIKE', insert: 'NOT LIKE ' },
  { label: 'IN (…)', insert: 'IN ()', caret: 4 },
  { label: 'NOT IN (…)', insert: 'NOT IN ()', caret: 8 },
  { label: 'IS NULL', insert: 'IS NULL ' },
  { label: 'IS NOT NULL', insert: 'IS NOT NULL ' },
  { label: 'BETWEEN … AND …', insert: 'BETWEEN  AND ', caret: 8 },
];

/**
 * Reserved words that are also common column names. A column with one of these names is quoted when
 * suggested, so `order = 1` doesn't become a syntax error. Not exhaustive: anything missing is still
 * valid SQL once the user quotes it.
 */
const RESERVED = new Set(
  ('all and any as asc between by case cast check collate column constraint create cross current_date ' +
    'current_time current_timestamp current_user default desc distinct do else end except false fetch for ' +
    'foreign from full grant group having in index inner insert intersect interval into is join key left ' +
    'like limit natural not null offset on or order outer primary range rank references right row rows ' +
    'select session_user set some table then to true union unique update user using values when where window with')
    .split(' '),
);

/** `name` bare when it matches `safe` and isn't a reserved word, otherwise quoted. */
export function identifierFor(name: string, quote: '"' | '`', safe: RegExp): string {
  return safe.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoteIdent(name, quote);
}

/**
 * `INSERT INTO … (…) VALUES (…);` per row, for export. Every value is a string literal, which each
 * database converts to the column's type; NULL stays NULL. `literal` quotes a value for the database.
 */
export function insertStatements(from: string, quote: '"' | '`', columns: string[], rows: Cell[][], literal: (value: string) => string): string {
  const cols = columns.map((c) => quoteIdent(c, quote)).join(', ');
  return rows
    .map((row) => `INSERT INTO ${from} (${cols}) VALUES (${row.map((v) => (v === null ? 'NULL' : literal(v))).join(', ')});\n`)
    .join('');
}

/** A standard SQL string literal: quotes doubled. Right for PostgreSQL (standard_conforming_strings) and SQLite. */
export function standardLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

/** What `buildChangeStatements` needs to know about a database's SQL. Each driver defines one. */
export interface WriteDialect {
  quote: '"' | '`';
  /** Placeholder for the n-th parameter (1-based): `$1` or `?`. */
  placeholder(n: number): string;
  /** NULL-safe equality: `IS NOT DISTINCT FROM`, `<=>` or `IS`. A plain `=` never matches NULL. */
  nullSafeEquals: string;
  /** An INSERT with every column at its default: `DEFAULT VALUES` or `() VALUES ()`. */
  allDefaults: string;
  /** A value as a SQL literal, for the review text only. */
  literal(value: string): string;
  /** A column's value as text, for conflict checks on types with no equality against text (json). */
  asText(column: string): string;
}

/**
 * UPDATE / INSERT / DELETE for pending table edits, with values as parameters.
 * UPDATE and DELETE match the primary key with `=` (so indexes are used), and UPDATE also checks the
 * original value of each edited cell with NULL-safe equality, so a row changed by someone else matches nothing.
 */
export function buildChangeStatements(from: string, dialect: WriteDialect, changes: RowChange[]): ChangeStatement[] {
  return changes.map((change) => {
    const params: Cell[] = [];
    const shown: string[] = [];
    const q = (column: string) => quoteIdent(column, dialect.quote);
    // Each value goes in twice: as a parameter for running, as a literal for review.
    const sql: string[] = [];
    const add = (text: string, display = text) => {
      sql.push(text);
      shown.push(display);
    };
    const value = (v: Cell) => {
      add(dialect.placeholder(params.push(v)), v === null ? 'NULL' : dialect.literal(v));
    };
    const keyMatch = (key: ColumnValue[]) =>
      key.forEach((k, i) => {
        add(`${i ? ' AND ' : ''}${q(k.column)} = `);
        value(k.value);
      });

    switch (change.kind) {
      case 'update':
        add(`UPDATE ${from} SET `);
        change.set.forEach((s, i) => {
          add(`${i ? ', ' : ''}${q(s.column)} = `);
          value(s.value);
        });
        add(' WHERE ');
        keyMatch(change.key);
        for (const s of change.set.filter((s) => s.check)) {
          add(` AND ${s.asText ? dialect.asText(q(s.column)) : q(s.column)} ${dialect.nullSafeEquals} `);
          value(s.original);
        }
        break;
      case 'insert':
        if (!change.values.length) {
          add(`INSERT INTO ${from} ${dialect.allDefaults}`);
          break;
        }
        add(`INSERT INTO ${from} (${change.values.map((v) => q(v.column)).join(', ')}) VALUES (`);
        change.values.forEach((v, i) => {
          if (i) add(', ');
          value(v.value);
        });
        add(')');
        break;
      case 'delete':
        add(`DELETE FROM ${from} WHERE `);
        keyMatch(change.key);
        break;
    }
    return { kind: change.kind, sql: sql.join(''), params, display: `${shown.join('')};` };
  });
}

/** Thrown by `applyChanges` when a statement doesn't affect exactly one row; the transaction was rolled back. */
export class ChangeConflict extends Error {
  constructor(
    readonly index: number,
    readonly affected: number,
  ) {
    super(
      affected === 0
        ? `Change ${index + 1} matched no row: it was changed or deleted since the page was loaded. Nothing was saved.`
        : `Change ${index + 1} matched ${affected} rows instead of one. Nothing was saved.`,
    );
    this.name = 'ChangeConflict';
  }
}

export type TemplateKind = 'select' | 'insert' | 'update' | 'delete';

/**
 * Starting SQL for a table (Generate SQL). It's opened in an editor, never run by DB Deck. Run unedited,
 * INSERT inserts NULLs and UPDATE / DELETE match no row (`WHERE <key> = NULL`, or `WHERE 1 = 0` without a
 * key), so a forgotten edit can't change existing rows. `name` is the table as it should be written;
 * `ident` writes a column name (quoted only when needed).
 */
export function buildTemplate(kind: TemplateKind, name: string, columns: ColumnInfo[], ident: (name: string) => string): string {
  // Column names and types go into `--` comments; a line break in a quoted name must not end the comment.
  const note = (c: ColumnInfo) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`.replace(/[\r\n]+/g, ' ');
  const key = columns.filter((c) => c.primaryKey);
  const where = key.length
    ? `WHERE ${key.map((c) => `${ident(c.name)} = NULL`).join(' AND ')}; -- matches no row until you fill in the key`
    : 'WHERE 1 = 0; -- no primary key: replace with a condition';
  const list = (items: string[], comments: string[]) =>
    items.map((item, i) => `  ${item}${i < items.length - 1 ? ',' : ''} -- ${comments[i]}`).join('\n');
  switch (kind) {
    case 'select':
      return `SELECT\n${columns.map((c, i) => `  ${ident(c.name)}${i < columns.length - 1 ? ',' : ''}`).join('\n')}\nFROM ${name}\nLIMIT 100;\n`;
    case 'insert':
      return `INSERT INTO ${name} (\n${columns.map((c, i) => `  ${ident(c.name)}${i < columns.length - 1 ? ',' : ''}`).join('\n')}\n) VALUES (\n${list(
        columns.map(() => 'NULL'),
        columns.map(note),
      )}\n);\n`;
    case 'update': {
      const set = columns.filter((c) => !c.primaryKey);
      const targets = set.length ? set : columns;
      return `UPDATE ${name}\nSET\n${list(
        targets.map((c) => `${ident(c.name)} = NULL`),
        targets.map(note),
      )}\n${where}\n`;
    }
    case 'delete':
      return `DELETE FROM ${name}\n${where}\n`;
  }
}

/** Rows per INSERT statement in dumps; small enough for every database's statement limits. */
export const DUMP_INSERT_ROWS = 250;

/** Like toCell, but binary values stay complete (as hex): a dump must restore every byte. */
export function toDumpCell(value: unknown): DumpCell {
  if (value instanceof Uint8Array) return { hex: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex') };
  return toCell(value);
}

/** SELECT of some columns, one page, for dumps. Identifiers are quoted; nothing comes from the user. */
export function buildDumpQuery(from: string, quote: '"' | '`', columns: string[], page: TablePage): string {
  const cols = columns.map((c) => quoteIdent(c, quote)).join(', ');
  return buildPageQuery(from, quote, page).replace(/^SELECT \* FROM /, `SELECT ${cols} FROM `);
}

/**
 * Multi-row INSERTs (DUMP_INSERT_ROWS rows each) for dumps. `literal` writes a text value; `hex` a binary one.
 * `between` goes between the column list and VALUES (PostgreSQL's OVERRIDING SYSTEM VALUE).
 */
export function dumpInserts(
  from: string,
  quote: '"' | '`',
  columns: string[],
  rows: DumpCell[][],
  literal: (value: string) => string,
  hex: (hex: string) => string,
  between = '',
): string {
  if (!rows.length) return '';
  const head = `INSERT INTO ${from} (${columns.map((c) => quoteIdent(c, quote)).join(', ')})${between ? ` ${between}` : ''} VALUES\n`;
  const value = (v: DumpCell) => (v === null ? 'NULL' : typeof v === 'object' ? hex(v.hex) : literal(v));
  let out = '';
  for (let i = 0; i < rows.length; i += DUMP_INSERT_ROWS) {
    const chunk = rows.slice(i, i + DUMP_INSERT_ROWS);
    out += head + chunk.map((row) => `(${row.map(value).join(', ')})`).join(',\n') + ';\n';
  }
  return out;
}

/** A script statement failed. `index` is the statement's position (0-based) in the script. */
export class ScriptError extends Error {
  constructor(
    readonly index: number,
    readonly failure: unknown,
  ) {
    super(errorMessage(failure));
  }
}

/** The user cancelled a running script. */
export class ScriptCancelled extends Error {
  constructor(readonly done: number) {
    super('Cancelled.');
  }
}

/**
 * The shared loop of `Driver.runScript`: runs statements one by one through `exec` (returning rows affected
 * by DML, or undefined), inside `tx` when asked, and rolls back on error or cancel. The driver opens and
 * closes its own connection around this.
 */
export async function runScriptStatements(
  statements: string[],
  options: ScriptOptions,
  exec: (sql: string) => Promise<number | undefined>,
  tx: { begin(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void> },
): Promise<ScriptResult> {
  let affectedRows = 0;
  if (options.transaction) await tx.begin();
  try {
    for (const [i, sql] of statements.entries()) {
      if (options.cancelled?.()) throw new ScriptCancelled(i);
      try {
        affectedRows += (await exec(sql)) ?? 0;
      } catch (err) {
        throw new ScriptError(i, err);
      }
      options.onProgress?.(i + 1);
    }
    if (options.transaction) await tx.commit();
  } catch (err) {
    if (options.transaction) await tx.rollback().catch(() => {});
    throw err;
  }
  return { statements: statements.length, affectedRows };
}
