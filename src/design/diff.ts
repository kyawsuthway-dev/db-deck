// What changed between a table as read from the database and as edited: the input to each driver's
// alterTableSql. No `vscode`, no I/O. Columns are matched by `key`, so a renamed column is a rename.
import type { CheckDesign, ColumnDesign, ForeignKeyDesign, IndexDesign, TableDesign } from './model';

export type DesignChange =
  | { kind: 'addColumn'; column: ColumnDesign }
  | { kind: 'dropColumn'; column: ColumnDesign }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'alterColumn'; before: ColumnDesign; after: ColumnDesign; type: boolean; nullable: boolean; default: boolean; comment: boolean; autoIncrement: boolean }
  /** The order of the columns that stay changed (new columns aren't counted). */
  | { kind: 'reorder' }
  | { kind: 'primaryKey'; before: string[]; after: string[] }
  | { kind: 'dropIndex'; index: IndexDesign }
  | { kind: 'addIndex'; index: IndexDesign }
  | { kind: 'dropForeignKey'; foreignKey: ForeignKeyDesign }
  | { kind: 'addForeignKey'; foreignKey: ForeignKeyDesign }
  | { kind: 'dropCheck'; check: CheckDesign }
  | { kind: 'addCheck'; check: CheckDesign }
  | { kind: 'tableComment'; comment: string };

const trim = (s: string) => s.trim();

export function diffDesign(before: TableDesign, after: TableDesign): DesignChange[] {
  const changes: DesignChange[] = [];
  const editable = (cols: ColumnDesign[]) => cols.filter((c) => !c.generated);
  const was = new Map(editable(before.columns).map((c) => [c.key, c]));
  const now = new Map(editable(after.columns).map((c) => [c.key, c]));
  // Old name → new name, so indexes and keys on a renamed column aren't seen as changed.
  const renamed = new Map<string, string>();

  for (const [key, b] of was) {
    const a = now.get(key);
    if (!a) {
      changes.push({ kind: 'dropColumn', column: b });
      continue;
    }
    if (trim(a.name) !== trim(b.name)) {
      changes.push({ kind: 'renameColumn', from: trim(b.name), to: trim(a.name) });
      renamed.set(trim(b.name), trim(a.name));
    }
    const diff = {
      type: trim(a.type).toLowerCase() !== trim(b.type).toLowerCase(),
      nullable: a.nullable !== b.nullable,
      default: trim(a.default) !== trim(b.default),
      comment: trim(a.comment) !== trim(b.comment),
      autoIncrement: a.autoIncrement !== b.autoIncrement,
    };
    if (Object.values(diff).some(Boolean)) changes.push({ kind: 'alterColumn', before: b, after: a, ...diff });
  }
  for (const [key, a] of now) if (!was.has(key)) changes.push({ kind: 'addColumn', column: a });

  const keptBefore = [...was.keys()].filter((k) => now.has(k));
  const keptAfter = [...now.keys()].filter((k) => was.has(k));
  if (keptBefore.join('\u0000') !== keptAfter.join('\u0000')) changes.push({ kind: 'reorder' });

  const rename = (cols: string[]) => cols.map((c) => renamed.get(trim(c)) ?? trim(c));
  const pkBefore = rename(editable(before.columns).filter((c) => c.primaryKey).map((c) => c.name));
  const pkAfter = editable(after.columns).filter((c) => c.primaryKey).map((c) => trim(c.name));
  if (pkBefore.join('\u0000') !== pkAfter.join('\u0000')) changes.push({ kind: 'primaryKey', before: pkBefore, after: pkAfter });

  // Indexes, foreign keys and checks: an item that changed is dropped and added again.
  const sig = {
    index: (x: IndexDesign, map = (c: string[]) => c) => JSON.stringify([trim(x.name), map(x.columns), x.unique]),
    fk: (f: ForeignKeyDesign, map = (c: string[]) => c) =>
      JSON.stringify([trim(f.name), map(f.columns), f.refSchema ?? '', trim(f.refTable), f.refColumns.map(trim), f.onDelete, f.onUpdate]),
    check: (c: CheckDesign) => JSON.stringify([trim(c.name), trim(c.expression)]),
  };
  const pairs = <T>(b: T[], a: T[], key: (x: T, before: boolean) => string, drop: (x: T) => DesignChange, add: (x: T) => DesignChange) => {
    const afterKeys = new Set(a.map((x) => key(x, false)));
    const beforeKeys = new Set(b.map((x) => key(x, true)));
    for (const x of b) if (!afterKeys.has(key(x, true))) changes.push(drop(x));
    for (const x of a) if (!beforeKeys.has(key(x, false))) changes.push(add(x));
  };
  pairs(before.indexes, after.indexes, (x, old) => sig.index(x, old ? rename : (c) => c.map(trim)), (index) => ({ kind: 'dropIndex', index }), (index) => ({ kind: 'addIndex', index }));
  pairs(before.foreignKeys, after.foreignKeys, (f, old) => sig.fk(f, old ? rename : (c) => c.map(trim)), (foreignKey) => ({ kind: 'dropForeignKey', foreignKey }), (foreignKey) => ({ kind: 'addForeignKey', foreignKey }));
  pairs(before.checks, after.checks, (c) => sig.check(c), (check) => ({ kind: 'dropCheck', check }), (check) => ({ kind: 'addCheck', check }));

  if (trim(before.comment) !== trim(after.comment)) changes.push({ kind: 'tableComment', comment: trim(after.comment) });
  return changes;
}

/** One line per change, for the form's summary ("Rename column a to b"). */
export function describeChange(c: DesignChange): string {
  switch (c.kind) {
    case 'addColumn':
      return `Add column ${trim(c.column.name)}`;
    case 'dropColumn':
      return `Drop column ${trim(c.column.name)}`;
    case 'renameColumn':
      return `Rename column ${c.from} to ${c.to}`;
    case 'alterColumn': {
      const what = [c.type && 'type', c.nullable && 'nullable', c.default && 'default', c.autoIncrement && 'auto-increment', c.comment && 'comment'].filter(Boolean);
      return `Change ${what.join(', ')} of ${trim(c.after.name)}`;
    }
    case 'reorder':
      return 'Reorder columns';
    case 'primaryKey':
      return c.after.length ? `Primary key (${c.after.join(', ')})` : 'Remove the primary key';
    case 'dropIndex':
      return `Drop index ${trim(c.index.name)}`;
    case 'addIndex':
      return `Add ${c.index.unique ? 'unique ' : ''}index ${trim(c.index.name)}`;
    case 'dropForeignKey':
      return `Drop foreign key ${trim(c.foreignKey.name) || `(${c.foreignKey.columns.join(', ')})`}`;
    case 'addForeignKey':
      return `Add foreign key ${trim(c.foreignKey.name) || `(${c.foreignKey.columns.join(', ')})`}`;
    case 'dropCheck':
      return `Drop check ${trim(c.check.name) || trim(c.check.expression)}`;
    case 'addCheck':
      return `Add check ${trim(c.check.name) || trim(c.check.expression)}`;
    case 'tableComment':
      return 'Change the table comment';
  }
}
