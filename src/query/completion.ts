// What the SQL editor suggests at the cursor. Pure: no vscode, no I/O, so it can be tested in plain Node.
// It reads just enough SQL to find table references and aliases; anything it doesn't understand simply gives
// fewer suggestions.
import type { DbType } from '../types';

/** A table named in a statement (`FROM s.orders AS o`). Names are unquoted. */
export interface TableRef {
  schema?: string;
  name: string;
  alias?: string;
}

/** What the word at the cursor is: after `a.` or `a.b.` (`member`), or a plain word (`word`). */
export type CursorContext = { kind: 'member'; qualifier: string[] } | { kind: 'word' };

/** Keywords suggested for every database; drivers add their own (`SQL_DIALECTS` in drivers/index.ts). */
export const SQL_KEYWORDS = [
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS',
  'AS', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'GROUP BY', 'HAVING', 'ORDER BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'CREATE VIEW', 'CREATE INDEX',
  'ALTER TABLE', 'ADD COLUMN', 'DROP TABLE', 'DROP VIEW', 'DROP INDEX', 'TRUNCATE', 'PRIMARY KEY', 'FOREIGN KEY',
  'REFERENCES', 'DEFAULT', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
];

/** Words that end a table reference, so they're never taken for an alias. */
const NOT_ALIAS = new Set(
  (
    'where join inner left right full cross outer natural on using group order limit offset set values select ' +
    'union intersect except having window returning lateral for straight_join use force ignore partition ' +
    'tablesample default from into as with when then else end and or not'
  ).split(' '),
);

/** Keywords after which a table name follows. */
const TABLE_KEYWORDS = new Set(['from', 'join', 'update', 'into', 'table']);

interface Token {
  kind: 'word' | 'quoted' | 'punct' | 'string';
  /** Unquoted name for words and quoted identifiers; the character for punctuation. */
  value: string;
}

/** Splits a statement into names, quoted identifiers, strings and punctuation. Comments are skipped. */
function tokenize(sql: string, dialect: DbType): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if ((c === '-' && sql[i + 1] === '-') || (c === '#' && dialect === 'mysql')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === '`' || c === '[' || c === "'") {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      let value = '';
      while (j < n) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            value += close;
            j += 2;
            continue;
          }
          break;
        }
        value += sql[j++];
      }
      tokens.push({ kind: c === "'" ? 'string' : 'quoted', value });
      i = j + 1;
    } else if (/[\p{L}\p{N}_$]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$]/u.test(sql[j])) j++;
      tokens.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: 'punct', value: c });
      i++;
    }
  }
  return tokens;
}

const isName = (t: Token | undefined) => !!t && (t.kind === 'quoted' || (t.kind === 'word' && !NOT_ALIAS.has(t.value.toLowerCase())));

/** Tables named after FROM / JOIN / UPDATE / INTO (and comma lists after FROM), with their aliases. */
export function tableReferences(statement: string, dialect: DbType): TableRef[] {
  const tokens = tokenize(statement, dialect);
  const refs: TableRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word' || !TABLE_KEYWORDS.has(t.value.toLowerCase())) continue;
    let j = i + 1;
    for (;;) {
      // A qualified name: a(.b)*
      if (!isName(tokens[j])) break;
      const parts = [tokens[j].value];
      j++;
      while (tokens[j]?.value === '.' && tokens[j].kind === 'punct' && isName(tokens[j + 1])) {
        parts.push(tokens[j + 1].value);
        j += 2;
      }
      const ref: TableRef = { name: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : undefined };
      if (tokens[j]?.kind === 'word' && tokens[j].value.toLowerCase() === 'as') j++;
      if (isName(tokens[j]) && tokens[j + 1]?.value !== '.') {
        ref.alias = tokens[j].value;
        j++;
      }
      refs.push(ref);
      // FROM a, b c, d
      if (t.value.toLowerCase() === 'from' && tokens[j]?.kind === 'punct' && tokens[j].value === ',') {
        j++;
        continue;
      }
      break;
    }
    i = j - 1;
  }
  return refs;
}

/** Looks at the text just before the cursor: `x.` / `x.y.` followed by a partly typed word, or a plain word. */
export function cursorContext(beforeCursor: string): CursorContext {
  const name = String.raw`(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[[^\]]*\]|[\p{L}\p{N}_$]+)`;
  const match = new RegExp(String.raw`((?:${name}\s*\.\s*)+)[\p{L}\p{N}_$]*$`, 'u').exec(beforeCursor);
  if (!match) return { kind: 'word' };
  const qualifier = [...match[1].matchAll(new RegExp(name, 'gu'))].map((m) => unquote(m[0]));
  return { kind: 'member', qualifier };
}

function unquote(name: string): string {
  const open = name[0];
  if (open === '"' || open === '`') return name.slice(1, -1).split(open + open).join(open);
  if (open === '[') return name.slice(1, -1);
  return name;
}

/**
 * The table a one- or two-part qualifier points to, given the statement's references:
 * an alias first, then a referenced table by name, then any table name (for `orders.` before FROM is typed).
 */
export function resolveQualifier(
  qualifier: string[],
  refs: TableRef[],
  tables: { name: string; schema?: string }[],
): { name: string; schema?: string } | undefined {
  const same = (a: string | undefined, b: string | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
  if (qualifier.length === 1) {
    const [q] = qualifier;
    const byAlias = refs.find((r) => r.alias !== undefined && same(r.alias, q));
    if (byAlias) return findTable(tables, byAlias) ?? byAlias;
    const byRef = refs.find((r) => same(r.name, q));
    if (byRef) return findTable(tables, byRef) ?? byRef;
    return tables.find((t) => same(t.name, q));
  }
  if (qualifier.length === 2) {
    const [schema, name] = qualifier;
    return tables.find((t) => same(t.name, name) && same(t.schema, schema)) ?? tables.find((t) => same(t.name, name));
  }
  return undefined;
}

/** The listed table a reference means: same name, and same schema when the reference has one. */
export function findTable<T extends { name: string; schema?: string }>(tables: T[], ref: { name: string; schema?: string }): T | undefined {
  const lower = (s: string | undefined) => s?.toLowerCase();
  const named = tables.filter((t) => lower(t.name) === lower(ref.name));
  if (ref.schema === undefined) return named.find((t) => t.schema === undefined) ?? named[0];
  return named.find((t) => lower(t.schema) === lower(ref.schema));
}
