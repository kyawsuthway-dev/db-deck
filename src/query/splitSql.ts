import type { DbType } from '../types';

/**
 * Splits a script into statements at top-level `;`, skipping semicolons inside
 * strings, quoted identifiers, comments, PostgreSQL dollar quotes and SQLite trigger bodies.
 * Statements that are empty or only comments are dropped.
 */
export function splitSql(sql: string, dialect: DbType): string[] {
  const statements: string[] = [];
  const n = sql.length;
  let start = 0;
  let hasCode = false;
  let i = 0;

  const push = (end: number) => {
    if (hasCode) statements.push(sql.slice(start, end).trim());
    start = end + 1;
    hasCode = false;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if ((c === '-' && next === '-') || (c === '#' && dialect === 'mysql')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      hasCode = true;
      i = skipQuoted(sql, i, dialect === 'mysql' && c !== '`');
      continue;
    }
    if (c === '$' && dialect === 'postgres' && !/\w/.test(sql[i - 1] ?? '')) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag) {
        hasCode = true;
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      if (!(dialect === 'sqlite' && insideTriggerBody(sql.slice(start, i)))) push(i);
    } else if (!/\s/.test(c)) {
      hasCode = true;
    }
    i++;
  }
  push(n);
  return statements;
}

const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;

/** Returns the index just past the closing quote. */
function skipQuoted(sql: string, open: number, backslashEscapes: boolean): number {
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
  return sql.length;
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
