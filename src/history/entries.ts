// Query history entries: building, capping and grouping them. Pure: no vscode, no I/O.
import type { StatementResult } from '../types';

export interface HistoryEntry {
  id: string;
  connectionId: string;
  /** The connection's name when it ran, so entries of removed connections still read well. */
  connectionName: string;
  sql: string;
  /** The SQL was too long and only its start is kept; it can be read but never run again. */
  shortened: boolean;
  /** ISO time the run started. */
  at: string;
  durationMs: number;
  statements: number;
  ok: boolean;
  /** "3 rows", "2 rows affected", or the first line of the error. */
  summary: string;
}

/** Entries kept per workspace. */
export const MAX_ENTRIES = 1000;
/** Longest SQL stored per entry; longer SQL is shortened. */
export const MAX_SQL_LENGTH = 100_000;
/** Total SQL kept across entries, so the workspace state stays small; the oldest entries go first. */
export const MAX_TOTAL_SQL = 2_000_000;
const MAX_SUMMARY = 200;

export function makeEntry(input: {
  id: string;
  connectionId: string;
  connectionName: string;
  sql: string;
  at: Date;
  results: StatementResult[];
}): HistoryEntry {
  const { results } = input;
  const shortened = input.sql.length > MAX_SQL_LENGTH;
  return {
    id: input.id,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    sql: shortened ? input.sql.slice(0, MAX_SQL_LENGTH) : input.sql,
    shortened,
    at: input.at.toISOString(),
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    statements: results.length,
    ok: !results.some((r) => r.error),
    summary: summarize(results),
  };
}

function summarize(results: StatementResult[]): string {
  const failed = results.find((r) => r.error);
  const prefix = results.length > 1 ? `${results.length} statements · ` : '';
  let text: string;
  if (failed) {
    text = `Error: ${failed.error!.split('\n')[0]}`;
  } else {
    const last = results[results.length - 1];
    if (!last) text = 'Nothing to run';
    else if (last.columns.length) text = `${plural(last.rows.length, 'row')}${last.truncated ? ' (more not shown)' : ''}`;
    else if (last.affectedRows !== undefined) text = `${plural(last.affectedRows, 'row')} affected`;
    else text = 'Done';
  }
  const summary = prefix + text;
  return summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary;
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** Puts the entry first, then keeps at most MAX_ENTRIES and MAX_TOTAL_SQL characters (the newest one always stays). */
export function addEntry(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const kept = [entry];
  let total = entry.sql.length;
  for (const e of entries) {
    if (kept.length >= MAX_ENTRIES || total + e.sql.length > MAX_TOTAL_SQL) break;
    kept.push(e);
    total += e.sql.length;
  }
  return kept;
}

/** The first non-empty line, with whitespace collapsed, at most `max` characters. */
export function firstLine(sql: string, max = 80): string {
  const line = sql.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  const text = line.replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Local calendar day, e.g. "2026-11-20", used to group entries. */
export function dayKey(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Entries (newest first) grouped by local day: "Today", "Yesterday", then the date. */
export function groupByDay(entries: HistoryEntry[], now: Date): { key: string; label: string; entries: HistoryEntry[] }[] {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: { key: string; label: string; entries: HistoryEntry[] }[] = [];
  for (const entry of entries) {
    const key = dayKey(new Date(entry.at));
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : key, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/** Reads stored entries defensively: workspace state may hold anything from an older or broken version. */
export function readEntries(stored: unknown): HistoryEntry[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (e): e is HistoryEntry =>
      !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.sql === 'string' && typeof e.at === 'string' && typeof e.connectionId === 'string',
  );
}
