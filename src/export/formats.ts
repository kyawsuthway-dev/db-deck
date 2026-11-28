// Pure formatting for export and copy: no vscode, no I/O, so it can be smoke-tested in plain Node.
// Values are written exactly as the drivers returned them (core.md rule 5).
import type { Cell } from '../types';

export type Delimiter = ',' | '\t';

/** Excel only reads a CSV file as UTF-8 (Burmese, Thai, accents…) when it starts with this. Files only, never the clipboard. */
export const UTF8_BOM = '﻿';

/**
 * One CSV/TSV line (RFC 4180), without the line break. NULL is an empty field; an empty string is
 * written as "" so a careful reader can tell them apart. Fields containing the delimiter, a quote or a
 * line break are quoted.
 */
export function delimitedLine(values: Cell[], delimiter: Delimiter): string {
  return values
    .map((v) => {
      if (v === null) return '';
      if (v === '' || v.includes(delimiter) || v.includes('"') || v.includes('\n') || v.includes('\r')) {
        return `"${v.split('"').join('""')}"`;
      }
      return v;
    })
    .join(delimiter);
}

/** A whole grid as CSV/TSV. Lines end with CRLF, as RFC 4180 and Excel expect. */
export function toDelimited(columns: string[], rows: Cell[][], delimiter: Delimiter, header: boolean): string {
  const lines = header ? [delimitedLine(columns, delimiter)] : [];
  for (const row of rows) lines.push(delimitedLine(row, delimiter));
  return lines.join('\r\n');
}

/** JSON object keys for the columns. Query results can repeat a name, so repeats get `_2`, `_3`… */
export function uniqueKeys(columns: string[]): string[] {
  const used = new Set<string>();
  return columns.map((name) => {
    let key = name;
    for (let n = 2; used.has(key); n++) key = `${name}_${n}`;
    used.add(key);
    return key;
  });
}

/** One row as a JSON object. Values stay strings (big numbers stay exact); NULL becomes null. */
export function jsonObject(keys: string[], row: Cell[]): string {
  const obj: Record<string, Cell> = {};
  keys.forEach((key, i) => (obj[key] = row[i] ?? null));
  return JSON.stringify(obj);
}

/** A whole grid as a JSON array of objects, two-space indented one object per line. */
export function toJson(columns: string[], rows: Cell[][]): string {
  const keys = uniqueKeys(columns);
  return rows.length ? `[\n  ${rows.map((row) => jsonObject(keys, row)).join(',\n  ')}\n]` : '[]';
}

/** Column types whose values reach the grid as truncated hex, so they can't be exported faithfully. */
export function isBinaryType(type: string): boolean {
  // Oracle: RAW and LONG RAW (bytes), BFILE (a file's bytes); BLOB is matched above.
  return /\b(bytea|(tiny|medium|long)?blob|(var)?binary|raw|bfile)\b/i.test(type);
}

export type ExportFormat = 'csv' | 'json' | 'sql';

/**
 * A file format written in pieces, so "all matching rows" can stream batch by batch:
 * `start(columns)`, then `rows(batch)` any number of times, then `end()`. Each returns text to append.
 */
export interface StreamFormat {
  start(columns: string[]): string;
  rows(rows: Cell[][]): string;
  end(): string;
}

/** `insert` builds the SQL for one batch (the driver's insertSql); only the `sql` format uses it. */
export function streamFormat(format: ExportFormat, insert?: (columns: string[], rows: Cell[][]) => string): StreamFormat {
  let columns: string[] = [];
  switch (format) {
    case 'csv':
      return {
        start: (cols) => `${UTF8_BOM}${delimitedLine(cols, ',')}\r\n`,
        rows: (rows) => rows.map((row) => `${delimitedLine(row, ',')}\r\n`).join(''),
        end: () => '',
      };
    case 'json': {
      let keys: string[] = [];
      let first = true;
      return {
        start: (cols) => {
          keys = uniqueKeys(cols);
          return '[';
        },
        rows: (rows) =>
          rows
            .map((row) => {
              const prefix = first ? '\n  ' : ',\n  ';
              first = false;
              return prefix + jsonObject(keys, row);
            })
            .join(''),
        end: () => (first ? ']\n' : '\n]\n'),
      };
    }
    case 'sql':
      if (!insert) throw new Error('SQL export needs a table to insert into.');
      return {
        start: (cols) => {
          columns = cols;
          return '';
        },
        rows: (rows) => (rows.length ? insert(columns, rows) : ''),
        end: () => '',
      };
  }
}

/**
 * Original column indexes sent by the webview (untrusted): a non-empty list of distinct, valid indexes, or
 * undefined. Copy and export use it to leave hidden columns out, in the order the grid shows them.
 */
export function columnIndexes(value: unknown, count: number): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > count) return undefined;
  const seen = new Set<number>();
  for (const i of value) {
    if (!Number.isSafeInteger(i) || i < 0 || i >= count || seen.has(i)) return undefined;
    seen.add(i);
  }
  return value as number[];
}

/** Keeps only the given columns of each row, in that order. */
export function pickColumns(rows: Cell[][], indexes: number[]): Cell[][] {
  return rows.map((row) => indexes.map((i) => row[i]));
}
