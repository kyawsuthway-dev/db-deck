import { splitSql } from '../query/splitSql';
import type { Cell, DbType, FilterOperator, StatementResult, TablePage } from '../types';

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
