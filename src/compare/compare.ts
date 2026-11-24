// Structure compare: two schemas' table designs → what would make the target like the source, as items the
// user ticks, and the designs to build SQL from. No `vscode`, no I/O, so it's smoke-tested in plain Node.
// The SQL itself comes from the target driver (createTableSql / alterTableSql / dropSql), like Design Table.
import { describeChange, diffDesign, type DesignChange } from '../design/diff';
import type { CheckDesign, ColumnDesign, ForeignKeyDesign, IndexDesign, TableDesign } from '../design/model';

/** One side: its schema (as `TableInfo.schema`, undefined = the connection's default) and that default's name. */
export interface Side {
  schema?: string;
  /** `Driver.defaultSchemaLabel()`: what an FK without `refSchema` points into. */
  defaultSchema?: string;
  tables: TableDesign[];
}

export type TableStatus = 'new' | 'changed' | 'onlyTarget' | 'same';

/** Something to tick. `drop`: loses data, unticked by default. */
export interface CompareItem {
  id: string;
  label: string;
  drop: boolean;
}

export interface TableCompare {
  name: string;
  status: TableStatus;
  items: CompareItem[];
  /** Columns only in the target / only in the source, for "Rename instead" (empty unless both exist). */
  droppable: string[];
  addable: string[];
}

/** Source column name → target column name it renames (picked in the form). Per table. */
export type Renames = Record<string, Record<string, string>>;

const trim = (s: string) => s.trim();
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => trim(x) === trim(b[i]));

/** The schema an FK points into, by name (undefined: no name, e.g. SQLite). */
const refName = (fk: ForeignKeyDesign, side: Side) => fk.refSchema ?? side.defaultSchema;

/**
 * The source table as it would be in the target: target schema, FKs into the source schema pointing into the
 * target schema, columns keyed like the target's (same name, or a rename the user linked), and indexes /
 * foreign keys / checks that match a target one by content taking its name, so server-made names
 * (`orders_customer_id_fkey` vs `fk_1`) aren't differences.
 */
export function alignTable(source: TableDesign, target: TableDesign | undefined, from: Side, to: Side, renames: Record<string, string> = {}): TableDesign {
  const sourceSchema = from.schema ?? from.defaultSchema;
  const targetSchemaName = to.schema ?? to.defaultSchema;
  const mapRef = (fk: ForeignKeyDesign): string | undefined => {
    const into = refName(fk, from);
    if (into !== sourceSchema) return fk.refSchema;
    // Into the source schema itself → into the target schema (no name when that's the target's default).
    return targetSchemaName === to.defaultSchema ? undefined : targetSchemaName;
  };
  const byName = new Map((target?.columns ?? []).map((c) => [trim(c.name), c]));
  const columns: ColumnDesign[] = source.columns.map((c, i) => {
    const match = byName.get(trim(c.name)) ?? (renames[trim(c.name)] !== undefined ? byName.get(renames[trim(c.name)]) : undefined);
    return { ...c, key: match?.key ?? `s${i}` };
  });
  let foreignKeys: ForeignKeyDesign[] = source.foreignKeys.map((f) => ({ ...f, refSchema: mapRef(f) }));
  let indexes = source.indexes.map((x) => ({ ...x }));
  let checks = source.checks.map((c) => ({ ...c }));
  if (target) {
    // Column names in the target's terms (a renamed column keeps the source's new name: that's the change).
    const sig = {
      index: (x: IndexDesign) => JSON.stringify([x.columns.map(trim), x.unique]),
      fk: (f: ForeignKeyDesign, side: Side, mapped?: string) =>
        JSON.stringify([f.columns.map(trim), mapped ?? refName(f, side) ?? '', trim(f.refTable), f.refColumns.map(trim), f.onDelete.toUpperCase(), f.onUpdate.toUpperCase()]),
      check: (c: CheckDesign) => trim(c.expression).replace(/\s+/g, ' '),
    };
    const adopt = <T extends { name: string }>(items: T[], theirs: T[], key: (x: T, mine: boolean) => string): T[] => {
      const free = [...theirs];
      return items.map((x) => {
        const i = free.findIndex((t) => key(t, false) === key(x, true));
        if (i < 0) return x;
        const [match] = free.splice(i, 1);
        return { ...x, name: match.name };
      });
    };
    indexes = adopt(indexes, target.indexes, (x) => sig.index(x));
    foreignKeys = adopt(foreignKeys, target.foreignKeys, (f, mine) => (mine ? sig.fk(f, to, refName(f, to)) : sig.fk(f, to)));
    checks = adopt(checks, target.checks, (c) => sig.check(c));
    // Server-kept fields come from the target (constraint flags by the adopted names).
    const constraints = new Set(target.indexes.filter((x) => x.constraint).map((x) => x.name));
    indexes = indexes.map((x) => ({ ...x, constraint: constraints.has(x.name) || undefined }));
  } else {
    indexes = indexes.map((x) => ({ ...x, constraint: undefined }));
  }
  return {
    schema: to.schema,
    name: source.name,
    comment: source.comment,
    columns,
    indexes,
    foreignKeys,
    checks,
    ...(target?.primaryKeyName ? { primaryKeyName: target.primaryKeyName } : {}),
    ...(target?.preserved ? { preserved: target.preserved } : {}),
  };
}

/** A stable id for a change, so ticks survive recomputing (and a new id starts with its default). */
export function changeId(c: DesignChange): string {
  switch (c.kind) {
    case 'addColumn':
    case 'dropColumn':
      return `${c.kind}:${trim(c.column.name)}`;
    case 'renameColumn':
      return `rename:${c.from}>${c.to}`;
    case 'alterColumn':
      return `alter:${trim(c.before.name)}`;
    case 'reorder':
    case 'primaryKey':
    case 'tableComment':
      return c.kind;
    case 'dropIndex':
    case 'addIndex':
      return `${c.kind}:${trim(c.index.name)}:${c.index.columns.join(',')}`;
    case 'dropForeignKey':
    case 'addForeignKey':
      return `${c.kind}:${trim(c.foreignKey.name)}:${c.foreignKey.columns.join(',')}`;
    case 'dropCheck':
    case 'addCheck':
      return `${c.kind}:${trim(c.check.name)}:${trim(c.check.expression)}`;
  }
}

const isDrop = (c: DesignChange) => c.kind === 'dropColumn';

/** What differs, table by table. `reorder`: whether column order changes are offered (TABLE_FEATURES.reorder). */
export function compareSchemas(from: Side, to: Side, renames: Renames, reorder: boolean): TableCompare[] {
  const targets = new Map(to.tables.map((t) => [t.name, t]));
  const sources = new Map(from.tables.map((t) => [t.name, t]));
  const out: TableCompare[] = [];
  for (const source of from.tables) {
    const target = targets.get(source.name);
    if (!target) {
      out.push({ name: source.name, status: 'new', items: [{ id: 'create', label: `Create table ${source.name}`, drop: false }], droppable: [], addable: [] });
      continue;
    }
    const after = alignTable(source, target, from, to, renames[source.name]);
    const changes = diffDesign(target, after).filter((c) => reorder || c.kind !== 'reorder');
    const dropped = changes.flatMap((c) => (c.kind === 'dropColumn' ? [trim(c.column.name)] : []));
    const added = changes.flatMap((c) => (c.kind === 'addColumn' ? [trim(c.column.name)] : []));
    const linked = Object.keys(renames[source.name] ?? {});
    out.push({
      name: source.name,
      status: changes.length ? 'changed' : 'same',
      items: changes.map((c) => ({ id: changeId(c), label: describeChange(c), drop: isDrop(c) })),
      // Offered while both sides have a candidate; a linked pair stays listed so it can be undone.
      droppable: dropped.length && (added.length || linked.length) ? dropped : [],
      addable: (dropped.length || linked.length) ? [...added, ...linked] : [],
    });
  }
  for (const target of to.tables) {
    if (!sources.has(target.name)) out.push({ name: target.name, status: 'onlyTarget', items: [{ id: 'drop', label: `Drop table ${target.name}`, drop: true }], droppable: [], addable: [] });
  }
  const order: Record<TableStatus, number> = { new: 0, changed: 1, onlyTarget: 2, same: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
}

/**
 * The target design with only the ticked changes applied: an unticked change is never in the SQL. Index, key
 * and FK changes on columns that won't exist are left out and reported in `blocked`.
 */
export function partialDesign(target: TableDesign, after: TableDesign, changes: DesignChange[], ticked: Set<string>): { design: TableDesign; blocked: string[] } {
  const on = changes.filter((c) => ticked.has(changeId(c)));
  const columns = target.columns.map((c) => ({ ...c }));
  const byKey = (key: string) => columns.findIndex((c) => c.key === key);
  const blocked: string[] = [];
  let indexes = target.indexes.map((x) => ({ ...x }));
  let foreignKeys = target.foreignKeys.map((f) => ({ ...f }));
  let checks = target.checks.map((c) => ({ ...c }));
  let comment = target.comment;
  for (const c of on) {
    switch (c.kind) {
      case 'addColumn':
        columns.push({ ...c.column, primaryKey: false });
        break;
      case 'dropColumn': {
        const i = byKey(c.column.key);
        if (i >= 0) columns.splice(i, 1);
        break;
      }
      case 'renameColumn': {
        const i = columns.findIndex((col) => trim(col.name) === c.from);
        if (i >= 0) columns[i] = { ...columns[i], name: c.to };
        break;
      }
      case 'alterColumn': {
        const i = byKey(c.before.key);
        if (i < 0) break;
        const col = columns[i];
        columns[i] = {
          ...col,
          type: c.type ? c.after.type : col.type,
          nullable: c.nullable ? c.after.nullable : col.nullable,
          default: c.default ? c.after.default : col.default,
          comment: c.comment ? c.after.comment : col.comment,
          autoIncrement: c.autoIncrement ? c.after.autoIncrement : col.autoIncrement,
        };
        break;
      }
      case 'reorder': {
        const order = new Map(after.columns.map((col, i) => [col.key, i]));
        columns.sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
        break;
      }
      case 'dropIndex':
        indexes = indexes.filter((x) => !(x.name === c.index.name && same(x.columns, c.index.columns)));
        break;
      case 'addIndex':
        indexes.push({ ...c.index });
        break;
      case 'dropForeignKey':
        foreignKeys = foreignKeys.filter((f) => !(f.name === c.foreignKey.name && same(f.columns, c.foreignKey.columns)));
        break;
      case 'addForeignKey':
        foreignKeys.push({ ...c.foreignKey });
        break;
      case 'dropCheck':
        checks = checks.filter((x) => !(x.name === c.check.name && trim(x.expression) === trim(c.check.expression)));
        break;
      case 'addCheck':
        checks.push({ ...c.check });
        break;
      case 'tableComment':
        comment = c.comment;
        break;
      case 'primaryKey':
        break;
    }
  }
  // The primary key last: by key, from the source where ticked (the columns must all exist then).
  const pk = on.find((c): c is Extract<DesignChange, { kind: 'primaryKey' }> => c.kind === 'primaryKey');
  if (pk) {
    const wanted = new Set(after.columns.filter((c) => c.primaryKey).map((c) => c.key));
    if ([...wanted].every((k) => byKey(k) >= 0)) for (const col of columns) col.primaryKey = wanted.has(col.key);
    else blocked.push(changeId(pk));
  }
  // Index / FK changes that name a column the table won't have.
  const names = new Set(columns.map((c) => trim(c.name)));
  const missing = (cols: string[]) => cols.some((c) => !names.has(trim(c)));
  for (const c of on) {
    if (c.kind === 'addIndex' && missing(c.index.columns)) {
      blocked.push(changeId(c));
      indexes = indexes.filter((x) => x !== indexes.find((y) => y.name === c.index.name && same(y.columns, c.index.columns)));
    }
    if (c.kind === 'addForeignKey' && missing(c.foreignKey.columns)) {
      blocked.push(changeId(c));
      foreignKeys = foreignKeys.filter((f) => !(f.name === c.foreignKey.name && same(f.columns, c.foreignKey.columns)));
    }
  }
  return { design: { ...target, comment, columns, indexes, foreignKeys, checks }, blocked };
}

/** New tables in an order where each comes after the new tables it references; cycles can't be ordered. */
export function createOrder(tables: TableDesign[], to: Side): { ordered: TableDesign[]; cyclic: string[] } {
  const targetSchemaName = to.schema ?? to.defaultSchema;
  const names = new Set(tables.map((t) => t.name));
  const deps = new Map(
    tables.map((t) => [
      t.name,
      new Set(t.foreignKeys.filter((f) => (f.refSchema ?? to.defaultSchema) === targetSchemaName && names.has(f.refTable) && f.refTable !== t.name).map((f) => f.refTable)),
    ]),
  );
  const ordered: TableDesign[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t.name)) continue;
      if ([...deps.get(t.name)!].every((d) => done.has(d))) {
        ordered.push(t);
        done.add(t.name);
        progress = true;
      }
    }
  }
  return { ordered, cyclic: tables.filter((t) => !done.has(t.name)).map((t) => t.name) };
}

/** Tables to drop, each before the dropped tables it references (children first). */
export function dropOrder(tables: TableDesign[]): TableDesign[] {
  const names = new Set(tables.map((t) => t.name));
  const referencedBy = (name: string) => tables.filter((t) => t.name !== name && t.foreignKeys.some((f) => f.refTable === name && names.has(f.refTable)));
  const ordered: TableDesign[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t.name)) continue;
      if (referencedBy(t.name).every((c) => done.has(c.name))) {
        ordered.push(t);
        done.add(t.name);
        progress = true;
      }
    }
  }
  // A cycle: the rest in any order (the database then says which reference blocks it).
  return [...ordered, ...tables.filter((t) => !done.has(t.name))];
}

/** Default ticks: everything except drops. */
export function defaultTicks(tables: TableCompare[]): Record<string, string[]> {
  return Object.fromEntries(tables.map((t) => [t.name, t.items.filter((i) => !i.drop).map((i) => i.id)]));
}

/** The target driver's SQL builders (they need no connection), and Design Table's checks. */
export interface SyncBuilder {
  createTableSql(design: TableDesign): string[];
  alterTableSql(before: TableDesign, after: TableDesign, changes: DesignChange[]): { statements: string[]; rebuild: boolean };
  dropSql(table: { name: string; schema?: string; kind: 'table' }): string;
  /** First problem with a design (unsafe default / check text, bad name…), or undefined. */
  check(design: TableDesign): string | undefined;
}

export interface SyncPlan {
  statements: string[];
  /** Ticked changes per table, for notes and the summary. */
  changes: { table: string; changes: DesignChange[] }[];
  created: string[];
  dropped: string[];
  /** SQLite tables rebuilt to change them. */
  rebuilt: string[];
  /** Left out, with why. */
  skipped: { table: string; reason: string }[];
  /** Item ids whose column isn't there (unticked add / rename), by table. */
  blocked: Record<string, string[]>;
  /** Number of ticked items that made it into the SQL. */
  count: number;
}

/** The SQL for the ticked items: new tables (referenced first), then changes, then dropped tables (children first). */
export function buildSync(from: Side, to: Side, renames: Renames, ticks: Record<string, string[]>, builder: SyncBuilder, reorder: boolean): SyncPlan {
  const plan: SyncPlan = { statements: [], changes: [], created: [], dropped: [], rebuilt: [], skipped: [], blocked: {}, count: 0 };
  const targets = new Map(to.tables.map((t) => [t.name, t]));
  const sources = new Map(from.tables.map((t) => [t.name, t]));
  const ticked = (table: string) => new Set(ticks[table] ?? []);

  const creating: TableDesign[] = [];
  for (const source of from.tables) {
    if (targets.has(source.name) || !ticked(source.name).has('create')) continue;
    const design = alignTable(source, undefined, from, to);
    if (design.columns.some((c) => c.generated)) {
      plan.skipped.push({ table: source.name, reason: 'it has generated columns, which DB Deck can’t create yet' });
      continue;
    }
    const problem = builder.check(design);
    if (problem) {
      plan.skipped.push({ table: source.name, reason: problem });
      continue;
    }
    creating.push(design);
  }
  const { ordered, cyclic } = createOrder(creating, to);
  for (const name of cyclic) plan.skipped.push({ table: name, reason: 'its foreign keys form a cycle with other new tables' });
  for (const design of ordered) {
    plan.statements.push(...builder.createTableSql(design));
    plan.created.push(design.name);
    plan.count++;
  }

  for (const source of from.tables) {
    const target = targets.get(source.name);
    if (!target) continue;
    const after = alignTable(source, target, from, to, renames[source.name]);
    const changes = diffDesign(target, after).filter((c) => reorder || c.kind !== 'reorder');
    const on = ticked(source.name);
    if (!changes.some((c) => on.has(changeId(c)))) continue;
    const { design, blocked } = partialDesign(target, after, changes, on);
    if (blocked.length) plan.blocked[source.name] = blocked;
    const problem = builder.check(design);
    if (problem) {
      plan.skipped.push({ table: source.name, reason: problem });
      continue;
    }
    const partial = diffDesign(target, design).filter((c) => reorder || c.kind !== 'reorder');
    if (!partial.length) continue;
    const { statements, rebuild } = builder.alterTableSql(target, design, partial);
    plan.statements.push(...statements);
    plan.changes.push({ table: source.name, changes: partial });
    if (rebuild) plan.rebuilt.push(source.name);
    plan.count += changes.filter((c) => on.has(changeId(c)) && !blocked.includes(changeId(c))).length;
  }

  const dropping = to.tables.filter((t) => !sources.has(t.name) && ticked(t.name).has('drop'));
  for (const t of dropOrder(dropping)) {
    plan.statements.push(builder.dropSql({ name: t.name, schema: to.schema, kind: 'table' }));
    plan.dropped.push(t.name);
    plan.count++;
  }
  return plan;
}
