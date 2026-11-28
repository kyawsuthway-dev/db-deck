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
 * body doesn't split (see `TSQL_BODY`). Oracle: a PL/SQL unit (anonymous block, procedure, function, package,
 * trigger, type body) ends at a `/` alone on a line, or else at the `;` after the `END` that closes it, and keeps that
 * `;` (PL/SQL needs it); `q'[…]'` strings are skipped. Statements that are empty or only comments are dropped.
 */
export function splitSql(sql: string, dialect: DbType): string[] {
  return splitSqlRanges(sql, dialect).map((r) => r.text);
}

/** One SQL Server batch: its text, how many times `GO n` runs it (1 for a plain `GO` or none), and where its code starts. */
export interface Batch {
  sql: string;
  repeat: number;
  /** Offset of the batch's first code in the script (for "the batch at line N"). */
  start: number;
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
      out.push({ sql: sql.slice(s.start, s.stop).trim(), repeat: repeats.get(batches[k]) ?? 1, start: s.codeStart });
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
  const ora = dialect === 'oracle';
  // Oracle only: the PL/SQL unit the current statement is, if it is one.
  let unit: PlsqlUnit | undefined;
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
  const push = (end: number, keepEnd = false) => {
    if (codeStart >= 0) {
      const raw = sql.slice(start, keepEnd ? end + 1 : end);
      const lead = raw.length - raw.trimStart().length;
      statements.push({ start: start + lead, codeStart, stop: Math.min(end + 1, n), text: raw.trim() });
      batches.push(batch);
      ends.push(end);
    }
    start = end + 1;
    codeStart = -1;
    unit = undefined;
    depth = 0;
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
    if (ora && /[nNqQ]/.test(c) && !/[\w$#]/.test(sql[i - 1] ?? '')) {
      const q = /^[nN]?[qQ]'(.)/.exec(sql.slice(i, i + 4));
      if (q) {
        // q'[it's]': the text runs to the closing delimiter followed by a quote.
        code(i);
        const close = Q_CLOSE[q[1]] ?? q[1];
        const body = i + q[0].length;
        const end = sql.indexOf(`${close}'`, body);
        literals.push([i, end === -1 ? n + 1 : end + 2]);
        i = end === -1 ? n : end + 2;
        continue;
      }
    }
    if (ora && c === '/' && next !== '*') {
      const lineStart = sql.lastIndexOf('\n', i - 1) + 1;
      const lineEnd = sql.indexOf('\n', i);
      if (!sql.slice(lineStart, i).trim() && !sql.slice(i + 1, lineEnd === -1 ? n : lineEnd).trim()) {
        // SQL*Plus's `/` line: ends the statement or PL/SQL unit above it, and isn't part of it.
        push(lineStart > 0 ? lineStart - 1 : 0);
        start = lineEnd === -1 ? n : lineEnd + 1;
        i = start;
        continue;
      }
    }
    if (ora && /[A-Za-z]/.test(c) && !/[\w$#]/.test(sql[i - 1] ?? '')) {
      ORA_WORD.lastIndex = i;
      const word = ORA_WORD.exec(sql)![0];
      const upper = word.toUpperCase();
      if (codeStart < 0) {
        const head = PLSQL_UNIT.exec(sql.slice(i, i + 200));
        if (head) unit = new PlsqlUnit(!!head[1], !!head[2]);
      }
      code(i);
      if (unit) {
        const skip = unit.word(upper, sql.slice(i + word.length, i + word.length + 40));
        i += word.length + skip;
        continue;
      }
      i += word.length;
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
    if (c === ';' && ora && unit) {
      // Inside a PL/SQL unit until its outermost block has closed; then this `;` ends it and stays with it.
      if (unit.semicolon()) push(i, true);
    } else if (c === ';') {
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

/** An Oracle word: keywords and names (`$` and `#` are name characters). */
const ORA_WORD = /[A-Za-z][\w$#]*/y;

/** Oracle `q'<delimiter>…<delimiter>'`: brackets close with their pair, any other character with itself. */
const Q_CLOSE: Record<string, string> = { '[': ']', '{': '}', '<': '>', '(': ')' };

/**
 * The start of an Oracle PL/SQL unit, whose body has `;` inside. Group 1 is set for units whose members sit in an outer
 * `AS … END name;` without a BEGIN (package specs and bodies, type bodies). Group 2: a query with inline PL/SQL
 * (`WITH FUNCTION …`), which ends only at `/` (as in SQL*Plus). A type spec (`CREATE TYPE t AS OBJECT (…);`) is plain
 * DDL ending at its `;`.
 */
const PLSQL_UNIT =
  /^(?:DECLARE|BEGIN|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+|EDITIONING\s+)?(?:(PACKAGE(?:\s+BODY)?|TYPE\s+BODY)|PROCEDURE|FUNCTION|TRIGGER)|(WITH\s+(?:FUNCTION|PROCEDURE)))\b/i;

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

/**
 * The blocks of one Oracle PL/SQL unit, to find the `;` that ends it. A declaration block is opened by DECLARE, by a
 * subprogram's IS / AS (after FUNCTION / PROCEDURE, or a compound trigger's BEFORE / AFTER / INSTEAD OF section), or
 * by a package or type body's own AS; its BEGIN starts its body. A BEGIN with no declaration block waiting opens a
 * block of its own, as does CASE; END closes the innermost (END IF / END LOOP close nothing counted here).
 */
class PlsqlUnit {
  /** Open blocks, innermost last: `decl` still waits for its BEGIN. */
  private readonly blocks: ('decl' | 'body')[] = [];
  private opened = false;
  /** FUNCTION / PROCEDURE / a timing point seen: its IS or AS opens a declaration block. */
  private signature = false;
  private compound = false;

  constructor(
    /** A package, package body or type body: members sit in an outer `AS … END name;`. */
    outer: boolean,
    /** `WITH FUNCTION … SELECT …`: the query after the inline PL/SQL has no end of its own, so only `/` ends it. */
    private readonly slashOnly: boolean,
  ) {
    if (outer) this.open('decl');
  }

  /** Takes one word; returns how many characters after it were consumed too (`END CASE`'s CASE). */
  word(upper: string, after: string): number {
    if (upper === 'FUNCTION' || upper === 'PROCEDURE' || (this.compound && /^(BEFORE|AFTER|INSTEAD)$/.test(upper))) {
      this.signature = true;
    } else if ((upper === 'IS' || upper === 'AS') && this.signature && !IS_PREDICATE.test(after)) {
      this.signature = false;
      this.open('decl');
    } else if (upper === 'DECLARE') {
      this.open('decl');
    } else if (upper === 'BEGIN') {
      const top = this.blocks.length - 1;
      if (this.blocks[top] === 'decl') this.blocks[top] = 'body';
      else this.open('body');
    } else if (upper === 'CASE') {
      this.open('body');
    } else if (upper === 'COMPOUND' && /^\s+TRIGGER\b/i.test(after) && !this.opened) {
      this.compound = true;
      this.open('decl');
    } else if (upper === 'END') {
      const closes = /^\s+(IF|LOOP|CASE)\b/i.exec(after);
      if (!closes || closes[1].toUpperCase() === 'CASE') this.blocks.pop();
      return closes ? closes[0].length : 0;
    }
    return 0;
  }

  /** Takes a `;` outside quotes and comments; true when it ends the unit. */
  semicolon(): boolean {
    // `PROCEDURE p;` (a forward declaration, or a package spec's member) has no IS: nothing was opened.
    this.signature = false;
    return this.opened && !this.blocks.length && !this.slashOnly;
  }

  private open(kind: 'decl' | 'body'): void {
    this.blocks.push(kind);
    this.opened = true;
  }
}

/** `x IS NULL`, `IS NOT …`, `IS JSON`… in a trigger's WHEN clause or a default: a predicate, not a block. */
const IS_PREDICATE = /^\s+(NULL|NOT|A\s+SET|EMPTY|OF|JSON|DANGLING|PRESENT|INFINITE|NAN)\b/i;

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
