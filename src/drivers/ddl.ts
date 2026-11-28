// CREATE TABLE and friends from a TableDesign, for all databases: each driver passes its DdlDialect. No I/O,
// so it's smoke-tested in plain Node. Identifiers are always quoted; defaults, types and CHECK conditions are
// SQL the user typed (checked to be one fragment by checkDesign) and go in as written.
import type { CheckDesign, ColumnDesign, ForeignKeyDesign, IndexDesign, TableDesign } from '../design/model';
import { quoteIdent, type IdentQuote } from './common';

export interface DdlDialect {
  quote: IdentQuote;
  /** The table's name in SQL (schema-qualified when needed). */
  table(schema: string | undefined, name: string): string;
  literal(value: string): string;
  /** Text after the type for an auto-increment column; `primaryKeyInline`: SQLite's rowid form. */
  autoIncrement: { clause: string; position: 'afterType' | 'afterNotNull'; primaryKeyInline?: boolean };
  /** MySQL writes comments inside CREATE TABLE; PostgreSQL with COMMENT ON; SQLite has none. */
  comments: 'inline' | 'statements' | 'none';
}

/** A column's definition as in CREATE TABLE (also ADD COLUMN, MySQL CHANGE / MODIFY). `inlineKey`: SQLite rowid form. */
export function columnDefinition(c: ColumnDesign, dialect: DdlDialect, inlineKey = false): string {
  const q = (n: string) => quoteIdent(n.trim(), dialect.quote);
  let line = `${q(c.name)} ${c.type.trim()}`;
  if (c.autoIncrement && inlineKey) line += ` PRIMARY KEY ${dialect.autoIncrement.clause}`;
  else if (c.autoIncrement && dialect.autoIncrement.position === 'afterType') line += ` ${dialect.autoIncrement.clause}`;
  if (!c.nullable && !(c.autoIncrement && inlineKey)) line += ' NOT NULL';
  if (c.default.trim() && !c.autoIncrement) line += ` DEFAULT ${c.default.trim()}`;
  if (c.autoIncrement && !inlineKey && dialect.autoIncrement.position === 'afterNotNull') line += ` ${dialect.autoIncrement.clause}`;
  if (dialect.comments === 'inline' && c.comment.trim()) line += ` COMMENT ${dialect.literal(c.comment.trim())}`;
  return line;
}

/** `FOREIGN KEY … REFERENCES …` with its optional constraint name, as in CREATE TABLE and ADD CONSTRAINT. */
export function foreignKeyClause(f: ForeignKeyDesign, dialect: DdlDialect): string {
  const q = (n: string) => quoteIdent(n.trim(), dialect.quote);
  return `${f.name.trim() ? `CONSTRAINT ${q(f.name)} ` : ''}FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${dialect.table(f.refSchema, f.refTable.trim())} (${f.refColumns.map(q).join(', ')}) ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`;
}

export function checkClause(c: CheckDesign, dialect: DdlDialect): string {
  return `${c.name.trim() ? `CONSTRAINT ${quoteIdent(c.name.trim(), dialect.quote)} ` : ''}CHECK (${c.expression.trim()})`;
}

export function createIndexStatement(x: IndexDesign, table: string, dialect: DdlDialect): string {
  const q = (n: string) => quoteIdent(n.trim(), dialect.quote);
  return `CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${q(x.name)} ON ${table} (${x.columns.map(q).join(', ')});`;
}

/** `options.indexes: false` leaves indexes out (a SQLite rebuild adds them after copying the rows). */
export function createTableStatements(d: TableDesign, dialect: DdlDialect, options: { indexes?: boolean } = {}): string[] {
  const q = (n: string) => quoteIdent(n.trim(), dialect.quote);
  const table = dialect.table(d.schema, d.name.trim());
  const keys = d.columns.filter((c) => c.primaryKey);
  const inlineKey = !!dialect.autoIncrement.primaryKeyInline && keys.length === 1 && keys[0].autoIncrement;

  const lines = d.columns.map((c) => `  ${columnDefinition(c, dialect, inlineKey && c.primaryKey)}`);
  if (keys.length && !inlineKey) lines.push(`  PRIMARY KEY (${keys.map((k) => q(k.name)).join(', ')})`);
  for (const f of d.foreignKeys) lines.push(`  ${foreignKeyClause(f, dialect)}`);
  for (const c of d.checks) lines.push(`  ${checkClause(c, dialect)}`);

  const options_ = dialect.comments === 'inline' && d.comment.trim() ? ` COMMENT=${dialect.literal(d.comment.trim())}` : '';
  const statements = [`CREATE TABLE ${table} (\n${lines.join(',\n')}\n)${options_};`];
  if (options.indexes !== false) for (const x of d.indexes) statements.push(createIndexStatement(x, table, dialect));
  if (dialect.comments === 'statements') {
    if (d.comment.trim()) statements.push(`COMMENT ON TABLE ${table} IS ${dialect.literal(d.comment.trim())};`);
    for (const c of d.columns) {
      if (c.comment.trim()) statements.push(`COMMENT ON COLUMN ${table}.${q(c.name)} IS ${dialect.literal(c.comment.trim())};`);
    }
  }
  return statements;
}
