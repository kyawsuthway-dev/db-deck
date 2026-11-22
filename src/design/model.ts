// What the Table Designer edits, and the checks before any SQL is built. No `vscode`, no I/O.
import { splitSql } from '../query/splitSql';
import type { DbType } from '../types';
import type { TableFeatures } from '../drivers';

export interface ColumnDesign {
  /** Stable while editing, so renaming a column (12b) isn't a drop and an add. */
  key: string;
  name: string;
  type: string;
  nullable: boolean;
  /** A SQL expression typed by the user (0, 'pending', now()); '' for none. */
  default: string;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment: string;
}

export interface IndexDesign {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeyDesign {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface CheckDesign {
  name: string;
  /** A SQL condition typed by the user. */
  expression: string;
}

export interface TableDesign {
  schema?: string;
  name: string;
  comment: string;
  columns: ColumnDesign[];
  indexes: IndexDesign[];
  foreignKeys: ForeignKeyDesign[];
  checks: CheckDesign[];
}

/** Problems by field path (`name`, `columns.2.type`, `indexes.0.columns`…), so the form can mark them. */
export type DesignErrors = Record<string, string>;

const MAX_NAME = 63; // PostgreSQL's limit, and within MySQL's 64

/** True when `text` is one SQL fragment: no `;` outside quotes and comments, so it can't add a statement. */
export function singleFragment(text: string, dialect: DbType): boolean {
  const parts = splitSql(text, dialect);
  return parts.length <= 1 && !/;\s*$/.test(parts[0] ?? '');
}

export function checkDesign(d: TableDesign, features: TableFeatures, dialect: DbType): DesignErrors {
  const errors: DesignErrors = {};
  const name = (path: string, value: string, what: string) => {
    if (!value.trim()) errors[path] = `${what} is required.`;
    else if (value.length > MAX_NAME) errors[path] = `Use at most ${MAX_NAME} characters.`;
  };
  name('name', d.name, 'A table name');
  if (!d.columns.length) errors.columns = 'Add at least one column.';
  const seen = new Map<string, number>();
  d.columns.forEach((c, i) => {
    name(`columns.${i}.name`, c.name, 'A column name');
    const lower = c.name.trim().toLowerCase();
    if (lower && seen.has(lower)) errors[`columns.${i}.name`] = `Another column is already called ${c.name.trim()}.`;
    seen.set(lower, i);
    if (!c.type.trim()) errors[`columns.${i}.type`] = 'A type is required.';
    else if (!singleFragment(c.type, dialect)) errors[`columns.${i}.type`] = 'A type can’t contain ;.';
    if (c.default.trim() && !singleFragment(c.default, dialect)) errors[`columns.${i}.default`] = 'A default can’t contain ;.';
    if (c.autoIncrement && c.default.trim()) errors[`columns.${i}.default`] = 'An auto-increment column can’t also have a default.';
    if (c.autoIncrement) {
      const keys = d.columns.filter((x) => x.primaryKey);
      if (features.autoIncrementNeedsIntegerKey && (!c.primaryKey || keys.length !== 1 || !/^integer$/i.test(c.type.trim()))) {
        errors[`columns.${i}.autoIncrement`] = `Only a single INTEGER primary key can auto-increment here (${features.autoIncrement}).`;
      }
    }
  });
  const columnNames = new Set(d.columns.map((c) => c.name.trim().toLowerCase()));
  const known = (cols: string[], path: string, what: string) => {
    if (!cols.length) errors[path] = `Choose the ${what}.`;
    else if (cols.some((c) => !columnNames.has(c.trim().toLowerCase()))) errors[path] = `A ${what.replace(/s$/, '')} isn’t in this table.`;
  };
  d.indexes.forEach((x, i) => {
    name(`indexes.${i}.name`, x.name, 'An index name');
    known(x.columns, `indexes.${i}.columns`, 'columns');
  });
  d.foreignKeys.forEach((f, i) => {
    known(f.columns, `foreignKeys.${i}.columns`, 'columns');
    if (!f.refTable.trim()) errors[`foreignKeys.${i}.refTable`] = 'Choose the referenced table.';
    if (f.refColumns.length !== f.columns.length) errors[`foreignKeys.${i}.refColumns`] = 'Choose as many referenced columns as columns.';
    for (const [k, v] of [['onDelete', f.onDelete], ['onUpdate', f.onUpdate]] as const) {
      if (!features.referentialActions.includes(v)) errors[`foreignKeys.${i}.${k}`] = 'Choose an action.';
    }
  });
  d.checks.forEach((c, i) => {
    if (!c.expression.trim()) errors[`checks.${i}.expression`] = 'Type a condition.';
    else if (!singleFragment(c.expression, dialect)) errors[`checks.${i}.expression`] = 'A condition can’t contain ;.';
  });
  return errors;
}

const MAX_TEXT = 4096;
const MAX_ITEMS = 500;

const str = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT;
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_ITEMS && v.every(str);
const list = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length <= MAX_ITEMS && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));

/** A design from an untrusted message, or undefined if it isn't shaped like one. Extra fields are dropped. */
export function parseDesign(raw: unknown): TableDesign | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!str(r.name) || !str(r.comment) || (r.schema !== undefined && !str(r.schema))) return undefined;
  if (!list(r.columns) || !list(r.indexes) || !list(r.foreignKeys) || !list(r.checks)) return undefined;
  const columns: ColumnDesign[] = [];
  for (const c of r.columns) {
    if (!str(c.key) || !str(c.name) || !str(c.type) || !str(c.default) || !str(c.comment)) return undefined;
    if (typeof c.nullable !== 'boolean' || typeof c.primaryKey !== 'boolean' || typeof c.autoIncrement !== 'boolean') return undefined;
    columns.push({ key: c.key, name: c.name, type: c.type, nullable: c.nullable, default: c.default, primaryKey: c.primaryKey, autoIncrement: c.autoIncrement, comment: c.comment });
  }
  const indexes: IndexDesign[] = [];
  for (const x of r.indexes) {
    if (!str(x.name) || !strs(x.columns) || typeof x.unique !== 'boolean') return undefined;
    indexes.push({ name: x.name, columns: x.columns, unique: x.unique });
  }
  const foreignKeys: ForeignKeyDesign[] = [];
  for (const f of r.foreignKeys) {
    if (!str(f.name) || !strs(f.columns) || !str(f.refTable) || !strs(f.refColumns) || !str(f.onDelete) || !str(f.onUpdate)) return undefined;
    if (f.refSchema !== undefined && !str(f.refSchema)) return undefined;
    foreignKeys.push({ name: f.name, columns: f.columns, refSchema: f.refSchema as string | undefined, refTable: f.refTable, refColumns: f.refColumns, onDelete: f.onDelete, onUpdate: f.onUpdate });
  }
  const checks: CheckDesign[] = [];
  for (const c of r.checks) {
    if (!str(c.name) || !str(c.expression)) return undefined;
    checks.push({ name: c.name, expression: c.expression });
  }
  return { schema: r.schema as string | undefined, name: r.name, comment: r.comment, columns, indexes, foreignKeys, checks };
}
