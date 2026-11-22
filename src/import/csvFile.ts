// Reads a CSV file for Import CSV: once to check it (rows, columns, preview, problems), then again as a
// stream while importing. No `vscode`, so it can be smoke-tested in plain Node.
import * as fs from 'fs';
import type { Cell, ImportRow } from '../types';
import { CsvError, CsvParser, detectDelimiter, type CsvRecord } from './csv';

export const PREVIEW_ROWS = 20;

export interface CsvReadOptions {
  /** A delimiter, or 'auto' to detect it from the start of the file. */
  delimiter: string;
  header: boolean;
  nullEmpty: boolean;
}

export interface CsvSummary {
  delimiter: string;
  /** Field count of every record (the first one sets it). */
  columns: number;
  headers?: string[];
  /** Data rows (without the header). */
  rows: number;
  preview: Cell[][];
  /** Something that blocks the import (ragged row, unclosed quote, not UTF-8, no rows). */
  problem?: { line?: number; message: string };
  /** To notice the file changing between the check and the import. */
  size: number;
  mtimeMs: number;
}

/** Records of a file in order, decoded as strict UTF-8 (invalid bytes are an error, not replaced). */
async function* records(file: string, delimiter: string, nullEmpty: boolean): AsyncGenerator<CsvRecord> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); // also drops a BOM
  const parser = new CsvParser({ delimiter, nullEmpty });
  let line = 1;
  for await (const chunk of fs.createReadStream(file)) {
    let text: string;
    try {
      text = decoder.decode(chunk as Buffer, { stream: true });
    } catch {
      throw new CsvError(line, `The file isn’t UTF-8 text (near line ${line}). Save it as UTF-8 and choose it again.`);
    }
    for (const r of parser.push(text)) {
      line = r.line;
      yield r;
    }
  }
  try {
    decoder.decode();
  } catch {
    throw new CsvError(line, 'The file isn’t UTF-8 text (it ends in the middle of a character).');
  }
  yield* parser.end();
}

async function sample(file: string): Promise<string> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // Not fatal here: the 64 KB may end mid-character; the full read checks the encoding.
    return new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function summarizeCsv(file: string, options: CsvReadOptions): Promise<CsvSummary> {
  const stat = await fs.promises.stat(file);
  const delimiter = options.delimiter === 'auto' ? detectDelimiter(await sample(file)) : options.delimiter;
  const summary: CsvSummary = { delimiter, columns: 0, rows: 0, preview: [], size: stat.size, mtimeMs: stat.mtimeMs };
  try {
    let first = true;
    for await (const r of records(file, delimiter, options.nullEmpty)) {
      if (first) {
        first = false;
        summary.columns = r.fields.length;
        if (options.header) {
          summary.headers = r.fields.map((f, i) => (f ?? '').trim() || `Column ${i + 1}`);
          continue;
        }
      }
      if (r.fields.length !== summary.columns) {
        summary.problem = {
          line: r.line,
          message: `Line ${r.line} has ${r.fields.length} field${r.fields.length === 1 ? '' : 's'}; ${options.header ? 'the header has' : 'the first row has'} ${summary.columns}. Fix the file (or the delimiter) and check it again.`,
        };
        return summary;
      }
      summary.rows++;
      if (summary.preview.length < PREVIEW_ROWS) summary.preview.push(r.fields);
    }
  } catch (err) {
    summary.problem = err instanceof CsvError ? { line: err.line, message: err.message } : { message: (err as Error).message };
    return summary;
  }
  if (!summary.rows) summary.problem = { message: options.header ? 'The file has a header but no rows.' : 'The file has no rows.' };
  return summary;
}

/**
 * The data rows as import rows: only the mapped CSV columns (`pick`, in the import's column order).
 * Throws CsvError if the file changed since `summary` (size or time) or turns out to be broken.
 */
export async function* importRowsOf(file: string, options: CsvReadOptions, summary: CsvSummary, pick: number[]): AsyncGenerator<ImportRow> {
  const stat = await fs.promises.stat(file);
  if (stat.size !== summary.size || stat.mtimeMs !== summary.mtimeMs) {
    throw new CsvError(0, 'The file changed after it was checked. Check it again before importing.');
  }
  let first = true;
  for await (const r of records(file, summary.delimiter, options.nullEmpty)) {
    if (first) {
      first = false;
      if (options.header) continue;
    }
    if (r.fields.length !== summary.columns) throw new CsvError(r.line, `Line ${r.line} has ${r.fields.length} fields; expected ${summary.columns}.`);
    yield { line: r.line, values: pick.map((i) => r.fields[i] ?? null) };
  }
}
