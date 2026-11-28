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
 * SQL Server: `GO` lines end a batch (DB Deck's job: the server doesn't know `GO`), `[names]` and nested
 * comments are skipped, and `;` inside `BEGIN … END` / `CASE … END` or a procedure, function, trigger or view
 * body doesn't split (see `TSQL_BODY`). Statements that are empty or only comments are dropped.
 */
export function splitSql(sql: string, dialect: DbType): string[] {
  return splitSqlRanges(sql, dialect).map((r) => r.text);
}

/** One SQL Server batch: its text, and how many times `GO n` runs it (1 for a plain `GO` or none). */
export interface Batch {
  sql: string;
  repeat: number;
}

/**
 * SQL Server: the script's `GO` batches, each to send as one request. Variables (`DECLARE @x`) and some
 * statements live for one batch, so the statements of a batch must not be sent apart.
 */
export function splitBatches(sql: string): Batch[] {
  const { statements, batches, repeats } = scanWithBatches(sql, 'sqlserver');
  const out: Batch[] = [];
  statements.forEach((s, k) => {
    if (k > 0 && batches[k] === batches[k - 1]) {
      const first = statements.findIndex((_, j) => batches[j] === batches[k]);
      out[out.length - 1].sql = sql.slice(statements[first].start, s.stop).trim();
    } else {
      out.push({ sql: sql.slice(s.start, s.stop).trim(), repeat: repeats.get(batches[k]) ?? 1 });
    }
  });
  return out;
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
  const { statements, literals } = scanWithBatches(sql, dialect);
  return { statements, literals };
}

/** `scan`, plus each statement's `GO` batch number and the `GO n` counts (SQL Server; always batch 0 elsewhere). */
function scanWithBatches(
  sql: string,
  dialect: DbType,
): { statements: StatementRange[]; literals: [number, number][]; batches: number[]; repeats: Map<number, number> } {
  const statements: StatementRange[] = [];
  const literals: [number, number][] = [];
  const n = sql.length;
  const tsql = dialect === 'sqlserver';
  let start = 0;
  let codeStart = -1;
  let i = 0;
  // SQL Server only: open BEGIN / CASE blocks, the GO batch each statement is in, and where its text ends.
  let depth = 0;
  let batch = 0;
  const batches: number[] = [];
  const ends: number[] = [];
  const repeats = new Map<number, number>();

  const code = (at: number) => {
    if (codeStart < 0) codeStart = at;
  };
  const push = (end: number) => {
    if (codeStart >= 0) {
      const raw = sql.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      statements.push({ start: start + lead, codeStart, stop: Math.min(end + 1, n), text: raw.trim() });
      batches.push(batch);
      ends.push(end);
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
      // SQL Server comments nest: /* a /* b */ c */ is one comment.
      const end = tsql ? nestedCommentEnd(sql, i) : sql.indexOf('*/', i + 2);
      literals.push([i, end === -1 ? n + 1 : end + 2]);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '[' && tsql)) {
      code(i);
      const end = skipQuoted(sql, i, dialect === 'mysql' && c !== '`');
      literals.push([i, end ?? n + 1]);
      i = end ?? n;
      continue;
    }
    if (tsql && /[A-Za-z_]/.test(c) && !/[\w@#$.]/.test(sql[i - 1] ?? '')) {
      WORD.lastIndex = i;
      const word = WORD.exec(sql)![0];
      const upper = word.toUpperCase();
      if (upper === 'GO') {
        const lineStart = sql.lastIndexOf('\n', i - 1) + 1;
        const lineEnd = sql.indexOf('\n', i);
        const rest = sql.slice(i + 2, lineEnd === -1 ? n : lineEnd);
        const go = sql.slice(lineStart, i).trim() ? null : GO_REST.exec(rest);
        if (go) {
          push(lineStart > 0 ? lineStart - 1 : 0);
          if (go[1]) repeats.set(batch, Math.max(1, Number(go[1])));
          start = lineEnd === -1 ? n : lineEnd + 1;
          depth = 0;
          batch++;
          i = start;
          continue;
        }
      }
      code(i);
      if (upper === 'CASE') depth++;
      else if (upper === 'BEGIN' && !NOT_A_BLOCK.test(sql.slice(i + 5))) depth++;
      else if (upper === 'END' && !/^\s+CONVERSATION\b/i.test(sql.slice(i + 3)) && depth > 0) depth--;
      i += word.length;
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
      const keep = tsql
        ? depth > 0 || (codeStart >= 0 && TSQL_BODY.test(sql.slice(codeStart, i)))
        : dialect === 'sqlite' && insideTriggerBody(sql.slice(start, i));
      if (!keep) push(i);
    } else if (!/\s/.test(c)) {
      code(i);
    }
    i++;
  }
  push(n);
  if (!tsql) return { statements, literals, batches, repeats };
  const joined = joinContinuations(sql, statements, batches, ends);
  return { statements: joined.statements, literals, batches: joined.batches, repeats };
}

const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;

/** A T-SQL word: keywords, names, `@variables` and `#temp` tables. */
const WORD = /[A-Za-z_][\w@#$]*/y;

/** What may follow `GO` on its line: a repeat count (`GO 5` runs the batch above it five times) and a comment. */
const GO_REST = /^[ \t]*(\d+)?[ \t]*(--.*)?\r?$/;

/** `BEGIN TRAN` and friends start no block (no `END` follows). */
const NOT_A_BLOCK = /^\s+(TRAN|TRANSACTION|DISTRIBUTED|DIALOG|CONVERSATION)\b/i;

/**
 * Statements whose body runs to the next `GO` (or the end): T-SQL has no end marker for them, and the body
 * often has `;` without `BEGIN … END`.
 */
const TSQL_BODY = /^(CREATE|ALTER)(\s+OR\s+ALTER)?\s+(PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\b/i;

/** Where a SQL Server comment opened at `open` closes (comments nest), or -1. */
function nestedCommentEnd(sql: string, open: number): number {
  let level = 0;
  for (let j = open; j < sql.length - 1; j++) {
    if (sql[j] === '/' && sql[j + 1] === '*') {
      level++;
      j++;
    } else if (sql[j] === '*' && sql[j + 1] === '/') {
      level--;
      if (level === 0) return j;
      j++;
    }
  }
  return -1;
}

/**
 * Joins a statement that can't stand alone to the one before it in the same batch: `IF … ;` followed by
 * `ELSE …`, and `END TRY;` followed by `BEGIN CATCH`.
 */
function joinContinuations(
  sql: string,
  statements: StatementRange[],
  batches: number[],
  ends: number[],
): { statements: StatementRange[]; batches: number[] } {
  const out: StatementRange[] = [];
  const outEnds: number[] = [];
  const outBatches: number[] = [];
  statements.forEach((s, k) => {
    const last = out.length - 1;
    if (last >= 0 && outBatches[last] === batches[k] && /^(ELSE|BEGIN\s+CATCH)\b/i.test(s.text)) {
      const prev = out[last];
      out[last] = { ...prev, stop: s.stop, text: sql.slice(prev.start, ends[k]).trim() };
      outEnds[last] = ends[k];
      return;
    }
    out.push(s);
    outEnds.push(ends[k]);
    outBatches.push(batches[k]);
  });
  return { statements: out, batches: outBatches };
}

/** Returns the index just past the closing quote, or undefined when the quote isn't closed. */
function skipQuoted(sql: string, open: number, backslashEscapes: boolean): number | undefined {
  // SQL Server's [name] closes with ], and ]] is an escaped ].
  const quote = sql[open] === '[' ? ']' : sql[open];
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
