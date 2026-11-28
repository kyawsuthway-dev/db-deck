// Query plans from each database's EXPLAIN output, as one tree the Explain panel draws, plus the check that
// a statement is read-only (Explain Analyze runs it). No `vscode`, no I/O, so it's smoke-tested in plain Node.
import type { DbType } from '../types';

export interface PlanNode {
  /** The operation: "Hash Join", "Table scan on o", "SEARCH c USING …". */
  label: string;
  /** Conditions, keys and other details, as "Name: value". */
  details: string[];
  /** Estimated total cost (the database's own units). */
  cost?: number;
  /** Estimated rows. */
  rows?: number;
  /** Explain Analyze: time spent, rows produced (per loop) and loops. */
  actualMs?: number;
  actualRows?: number;
  loops?: number;
  /** A gentle hint ("may help"); the panel shows it on the step. */
  hint?: string;
  children: PlanNode[];
}

/** Estimated rows above which a full scan gets a hint. */
const LARGE = 1000;

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** PostgreSQL `EXPLAIN (FORMAT JSON …)`: `[{ "Plan": {…} }]`. */
export function parsePostgresPlan(json: string): PlanNode {
  const doc = JSON.parse(json) as { Plan: Record<string, unknown> }[];
  const walk = (p: Record<string, unknown>): PlanNode => {
    const type = String(p['Node Type'] ?? 'Step');
    const join = p['Join Type'] ? ` (${String(p['Join Type'])})` : '';
    const on = p['Relation Name'] ? ` on ${String(p['Relation Name'])}${p.Alias && p.Alias !== p['Relation Name'] ? ` ${String(p.Alias)}` : ''}` : '';
    const using = p['Index Name'] ? ` using ${String(p['Index Name'])}` : '';
    const details: string[] = [];
    for (const key of ['Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Filter', 'Recheck Cond', 'Sort Key', 'Group Key', 'Strategy', 'Rows Removed by Filter', 'Shared Hit Blocks', 'Shared Read Blocks']) {
      const v = p[key];
      if (v !== undefined && v !== null && v !== '') details.push(`${key}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
    }
    return {
      label: `${type}${join}${on}${using}`,
      details,
      cost: num(p['Total Cost']),
      rows: num(p['Plan Rows']),
      actualMs: num(p['Actual Total Time']),
      actualRows: num(p['Actual Rows']),
      loops: num(p['Actual Loops']),
      children: Array.isArray(p.Plans) ? (p.Plans as Record<string, unknown>[]).map(walk) : [],
    };
  };
  const root = walk(doc[0].Plan);
  return hint(root, (n) => (/^Seq Scan on /.test(n.label) && (n.rows ?? 0) > LARGE ? 'Reads the whole table; an index on the filtered or joined columns may help.' : undefined));
}

/** MySQL 8 `EXPLAIN FORMAT=TREE` / `EXPLAIN ANALYZE`: indented `-> step  (cost=… rows=…) (actual time=a..b rows=… loops=…)`. */
export function parseMysqlTree(text: string): PlanNode {
  const root: PlanNode = { label: 'Query', details: [], children: [] };
  const stack: { depth: number; node: PlanNode }[] = [{ depth: -1, node: root }];
  for (const line of text.split('\n')) {
    const m = /^(\s*)-> (.*)$/.exec(line);
    if (!m) continue;
    let rest = m[2];
    const node: PlanNode = { label: '', details: [], children: [] };
    const actual = /\s*\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=(\d+)\)\s*$/.exec(rest);
    if (actual) {
      node.actualMs = num(actual[2]);
      node.actualRows = num(actual[3]);
      node.loops = num(actual[4]);
      rest = rest.slice(0, actual.index);
    }
    const cost = /\s*\(cost=([\d.e+-]+) rows=([\d.e+-]+)\)\s*$/.exec(rest);
    if (cost) {
      node.cost = num(cost[1]);
      node.rows = num(cost[2]);
      rest = rest.slice(0, cost.index);
    }
    // "Filter: (cond)" → a label and a detail.
    const colon = /^(Filter|Sort|Group aggregate|Covering index lookup|Index lookup)\b(.*?): (.+)$/.exec(rest);
    if (colon && colon[1] === 'Filter') {
      node.label = 'Filter';
      node.details.push(`Condition: ${colon[3]}`);
    } else {
      node.label = rest.trim();
    }
    const depth = m[1].length;
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth, node });
  }
  const top = root.children.length === 1 ? root.children[0] : root;
  return hint(top, (n) =>
    /^Table scan on (?!<)/.test(n.label) && (n.rows ?? 0) > LARGE ? 'Reads the whole table; an index on the filtered or joined columns may help.' : undefined,
  );
}

/** Tabular `EXPLAIN` (MariaDB, older MySQL): one step per row, in join order. */
export function parseMysqlTable(columns: string[], rows: (string | null)[][]): PlanNode {
  const col = (row: (string | null)[], name: string) => row[columns.findIndex((c) => c.toLowerCase() === name)] ?? null;
  const children = rows.map((row): PlanNode => {
    const type = col(row, 'type') ?? '';
    const details = ['key', 'possible_keys', 'ref', 'filtered', 'extra']
      .map((k) => [k, col(row, k)] as const)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => `${k === 'extra' ? 'Extra' : k.replace('_', ' ')}: ${v}`);
    return { label: `${col(row, 'table') ?? '?'}: ${type || 'access'}${type === 'ALL' ? ' (full table scan)' : ''}`, details, rows: num(col(row, 'rows')), children: [] };
  });
  const root: PlanNode = { label: 'Query', details: [], children };
  return hint(root, (n) => (/\(full table scan\)$/.test(n.label) && (n.rows ?? 0) > LARGE ? 'Reads the whole table; an index on the filtered or joined columns may help.' : undefined));
}

/** SQLite `EXPLAIN QUERY PLAN` rows: id, parent, notused, detail. */
export function parseSqlitePlan(rows: (string | null)[][]): PlanNode {
  const root: PlanNode = { label: 'Query', details: [], children: [] };
  const byId = new Map<string, PlanNode>([['0', root]]);
  for (const [id, parent, , detail] of rows) {
    const node: PlanNode = { label: String(detail ?? ''), details: [], children: [] };
    byId.set(String(id), node);
    (byId.get(String(parent)) ?? root).children.push(node);
  }
  const top = root.children.length === 1 ? root.children[0] : root;
  // SQLite gives no row estimates: a SCAN (not SEARCH) of a table may be fine for small tables.
  return hint(top, (n) => (/^SCAN (?!CONSTANT|SUBQUERY)/.test(n.label) && !/COVERING INDEX|USING INDEX/.test(n.label) ? 'Reads the whole table; if it’s large, an index on the filtered or joined columns may help.' : undefined));
}

/**
 * SQL Server's `SET SHOWPLAN_ALL ON` rows: a statement row (`Type` SELECT, UPDATE…) and its operators under it
 * through `NodeId` / `Parent`. Several statements become children of one Query. Hints for a scan over many rows
 * and for SQL Server's own warnings (missing statistics, a join without a predicate, implicit conversions).
 */
export function parseSqlServerPlan(columns: string[], rows: (string | null)[][]): PlanNode {
  const at = (row: (string | null)[], name: string) => row[columns.indexOf(name)] ?? null;
  const root: PlanNode = { label: 'Query', details: [], children: [] };
  const byId = new Map<string, PlanNode>();
  for (const row of rows) {
    const type = at(row, 'Type');
    const warnings = at(row, 'Warnings');
    let node: PlanNode;
    if (type !== 'PLAN_ROW') {
      const text = (at(row, 'StmtText') ?? '').trim().replace(/\s+/g, ' ');
      node = { label: `${type ?? 'Statement'}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`, details: [], cost: num(at(row, 'TotalSubtreeCost')), rows: num(at(row, 'EstimateRows')), children: [] };
    } else {
      const physical = at(row, 'PhysicalOp') ?? '';
      const logical = at(row, 'LogicalOp') ?? '';
      const details: string[] = [];
      const argument = at(row, 'Argument');
      if (argument) details.push(argument);
      const output = at(row, 'OutputList');
      if (output) details.push(`Output: ${output}`);
      node = {
        label: logical && logical !== physical ? `${physical} (${logical})` : physical,
        details,
        cost: num(at(row, 'TotalSubtreeCost')),
        rows: num(at(row, 'EstimateRows')),
        children: [],
      };
    }
    if (warnings) node.details.push(`Warnings: ${warnings}`);
    byId.set(String(at(row, 'NodeId')), node);
    const parent = at(row, 'Parent');
    ((parent && parent !== '0' && byId.get(parent)) || root).children.push(node);
  }
  const top = root.children.length === 1 ? root.children[0] : root;
  return hint(top, (n) => {
    const warning = n.details.find((d) => d.startsWith('Warnings: '));
    if (warning) return `SQL Server warns about this step (${warning.slice('Warnings: '.length)}): check statistics, join conditions and column types.`;
    return /^(Table Scan|Clustered Index Scan|Index Scan)\b/.test(n.label) && (n.rows ?? 0) > LARGE
      ? 'Reads the whole table; an index on the filtered or joined columns may help.'
      : undefined;
  });
}

/** Adds `make`'s hint to each step, and (Explain Analyze) a hint where estimates were far from actual rows. */
function hint(root: PlanNode, make: (n: PlanNode) => string | undefined): PlanNode {
  const visit = (n: PlanNode) => {
    const estimate = n.rows;
    const actual = n.actualRows !== undefined ? n.actualRows * (n.loops ?? 1) : undefined;
    n.hint = make(n);
    if (!n.hint && estimate !== undefined && actual !== undefined && Math.max(estimate, actual) >= 10 && Math.max(estimate, actual) > 10 * Math.max(1, Math.min(estimate, actual))) {
      n.hint = `The estimate (${estimate.toLocaleString()} rows) was far from the actual ${actual.toLocaleString()}: the table’s statistics may be out of date.`;
    }
    n.children.forEach(visit);
  };
  visit(root);
  return root;
}

/** The statement without strings, quoted names and comments, so keywords inside them don't count. */
/** The statement with strings, quoted names and comments blanked out, so keywords can be searched for. */
export function codeOnly(sql: string, dialect: DbType): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--' || (c === '#' && dialect === 'mysql')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`' || (c === '[' && dialect === 'sqlserver')) {
      // SQL Server's [name] closes with ] (]] is an escaped one).
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < sql.length && !(sql[j] === close && sql[j + 1] !== close)) j += sql[j] === close || (sql[j] === '\\' && dialect === 'mysql') ? 2 : 1;
      i = j + 1;
      out += ' ';
    } else if (c === '$' && dialect === 'postgres' && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Whether Explain Analyze may run a statement: it executes it. Only SELECT / VALUES / TABLE, or a WITH that
 * changes nothing; SELECT … INTO (creates a table) isn't. Returns the reason when not.
 */
export function readOnlyStatement(sql: string, dialect: DbType): { ok: true } | { ok: false; reason: string } {
  const problem = writes(sql, dialect, ['SELECT', 'VALUES', 'TABLE', 'WITH']);
  if (!problem) return { ok: true };
  const reason = {
    first: `Explain Analyze runs the statement, so it’s only offered for reading statements (SELECT, WITH, VALUES, TABLE), not ${problem.word ?? 'this'}.`,
    keyword: 'Explain Analyze runs the statement, and this one changes data (it contains INSERT, UPDATE, DELETE or similar).',
    into: 'Explain Analyze runs the statement, and SELECT … INTO writes.',
  }[problem.kind];
  return { ok: false, reason };
}

/**
 * Whether a read-only SQL Server connection may run a statement: SQL Server has no read-only session setting, so
 * DB Deck checks each statement itself, like the one above. T-SQL's DECLARE, SET, PRINT and IF / WHILE / BEGIN
 * blocks are allowed as long as nothing in them writes; EXEC isn't (a procedure can write).
 */
export function readingStatement(sql: string, dialect: DbType): { ok: true } | { ok: false; reason: string } {
  const problem = writes(sql, dialect, ['SELECT', 'WITH', 'DECLARE', 'SET', 'PRINT', 'IF', 'WHILE', 'BEGIN']);
  if (!problem) return { ok: true };
  const what = problem.word ? ` (${problem.word})` : '';
  return { ok: false, reason: `This connection is read-only, so DB Deck only runs reading statements on it (SELECT, WITH, DECLARE, SET, PRINT), and this one may change something${what}.` };
}

/** Why a statement may write: its first word isn't one of `allowed`, it contains a writing keyword, or SELECT … INTO. */
function writes(sql: string, dialect: DbType, allowed: string[]): { kind: 'first' | 'keyword' | 'into'; word?: string } | undefined {
  const code = codeOnly(sql, dialect).trim().replace(/;\s*$/, '');
  const first = /^\(*\s*([A-Za-z]+)/.exec(code)?.[1]?.toUpperCase();
  if (!first || !allowed.includes(first)) return { kind: 'first', word: first };
  const keyword = WRITING.exec(code)?.[1]?.toUpperCase();
  if (keyword) return { kind: 'keyword', word: keyword };
  if (first !== 'WITH' && /\bINTO\b/i.test(code)) return { kind: 'into', word: 'INTO' };
  return undefined;
}

/** Keywords that change data, schema, permissions or the server, anywhere in a statement (strings and comments excluded). */
const WRITING =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|DROP|ALTER|EXEC|EXECUTE|GRANT|DENY|REVOKE|BACKUP|RESTORE|DBCC|BULK|KILL|SHUTDOWN|RECONFIGURE|USE|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i;
