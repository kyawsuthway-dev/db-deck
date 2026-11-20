import type { Cell, StatementResult } from '../types';

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
