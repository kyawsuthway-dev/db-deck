import type { DbType } from '../types';

/** One statement's place in a script. Offsets are UTF-16 indexes into the script. */
export interface StatementRange {
  /** Where `text` starts (it may begin with comments). */
  start: number;
  /** Where the first code (not whitespace or comment) starts. */
  codeStart: number;
  /** Just past the statement's `;`, or the end of the script for the last one. */
  stop: number;
  /** The statement exactly as `splitSql` returns it. */
  text: string;
}

/**
 * Splits a script into statements at top-level `;`, skipping semicolons inside
 * strings, quoted identifiers, comments, PostgreSQL dollar quotes and SQLite trigger bodies.
 * Statements that are empty or only comments are dropped.
 */
export function splitSql(sql: string, dialect: DbType): string[] {
  return splitSqlRanges(sql, dialect).map((r) => r.text);
}

/** `splitSql`, with where each statement is in the script (run at cursor, CodeLens). */
export function splitSqlRanges(sql: string, dialect: DbType): StatementRange[] {
  return scan(sql, dialect).statements;
}

/** False when `offset` (a cursor position) is inside a string, quoted identifier, dollar quote or comment. */
export function codeAt(sql: string, offset: number, dialect: DbType): boolean {
  return !scan(sql, dialect).literals.some(([a, b]) => a < offset && offset < b);
}

/**
 * The statement a cursor at `offset` belongs to: the one whose code (up to and including its `;`) contains
 * it; otherwise the one ending earlier on the same line; otherwise the next one, or else the last one.
 */
export function statementAt(sql: string, ranges: StatementRange[], offset: number): StatementRange | undefined {
  const inside = ranges.find((r) => r.codeStart <= offset && offset <= r.stop);
  if (inside) return inside;
  const before = ranges.filter((r) => r.stop <= offset).pop();
  if (before && !sql.slice(before.stop, offset).includes('\n')) return before;
  return ranges.find((r) => r.codeStart > offset) ?? before;
}

/**
 * One pass over the script. `literals` are the strings, quoted identifiers and comments, as open intervals
 * (a, b): a cursor strictly between them is inside. An unclosed one runs past the end of the script.
 */
function scan(sql: string, dialect: DbType): { statements: StatementRange[]; literals: [number, number][] } {
  const statements: StatementRange[] = [];
  const literals: [number, number][] = [];
  const n = sql.length;
  let start = 0;
  let codeStart = -1;
  let i = 0;

  const code = (at: number) => {
    if (codeStart < 0) codeStart = at;
  };
  const push = (end: number) => {
    if (codeStart >= 0) {
      const raw = sql.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      statements.push({ start: start + lead, codeStart, stop: Math.min(end + 1, n), text: raw.trim() });
    }
    start = end + 1;
    codeStart = -1;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if ((c === '-' && next === '-') || (c === '#' && dialect === 'mysql')) {
      const end = sql.indexOf('\n', i);
      literals.push([i, end === -1 ? n + 1 : end + 1]);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      literals.push([i, end === -1 ? n + 1 : end + 2]);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      code(i);
      const end = skipQuoted(sql, i, dialect === 'mysql' && c !== '`');
      literals.push([i, end ?? n + 1]);
      i = end ?? n;
      continue;
    }
    if (c === '$' && dialect === 'postgres' && !/\w/.test(sql[i - 1] ?? '')) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag) {
        code(i);
        const end = sql.indexOf(tag, i + tag.length);
        literals.push([i, end === -1 ? n + 1 : end + tag.length]);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      if (!(dialect === 'sqlite' && insideTriggerBody(sql.slice(start, i)))) push(i);
    } else if (!/\s/.test(c)) {
      code(i);
    }
    i++;
  }
  push(n);
  return { statements, literals };
}

const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;

/** Returns the index just past the closing quote, or undefined when the quote isn't closed. */
function skipQuoted(sql: string, open: number, backslashEscapes: boolean): number | undefined {
  const quote = sql[open];
  let j = open + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslashEscapes && ch === '\\') {
      j += 2;
    } else if (ch === quote) {
      if (sql[j + 1] !== quote) return j + 1;
      j += 2; // doubled quote is an escaped quote
    } else {
      j++;
    }
  }
  return undefined;
}

/** SQLite trigger bodies contain `;` and end with `END;`. */
function insideTriggerBody(statementSoFar: string): boolean {
  return (
    /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(statementSoFar) && !/\bEND\s*$/i.test(statementSoFar)
  );
}

/** Strips leading whitespace and comments, e.g. to look at a statement's first keyword. */
export function stripLeadingComments(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
}
