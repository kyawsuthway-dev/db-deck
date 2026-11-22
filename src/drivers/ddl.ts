// CREATE TABLE and friends from a TableDesign, for all databases: each driver passes its DdlDialect. No I/O,
// so it's smoke-tested in plain Node. Identifiers are always quoted; defaults, types and CHECK conditions are
// SQL the user typed (checked to be one fragment by checkDesign) and go in as written.
import type { ColumnDesign, TableDesign } from '../design/model';
import { quoteIdent } from './common';

export interface DdlDialect {
  quote: '"' | '`';
  /** The table's name in SQL (schema-qualified when needed). */
  table(schema: string | undefined, name: string): string;
  literal(value: string): string;
  /** Text after the type for an auto-increment column; `primaryKeyInline`: SQLite's rowid form. */
  autoIncrement: { clause: string; position: 'afterType' | 'afterNotNull'; primaryKeyInline?: boolean };
  /** MySQL writes comments inside CREATE TABLE; PostgreSQL with COMMENT ON; SQLite has none. */
  comments: 'inline' | 'statements' | 'none';
}

export function createTableStatements(d: TableDesign, dialect: DdlDialect): string[] {
  const q = (n: string) => quoteIdent(n.trim(), dialect.quote);
  const table = dialect.table(d.schema, d.name.trim());
  const keys = d.columns.filter((c) => c.primaryKey);
  const inlineKey = dialect.autoIncrement.primaryKeyInline && keys.length === 1 && keys[0].autoIncrement;

  const column = (c: ColumnDesign) => {
    let line = `  ${q(c.name)} ${c.type.trim()}`;
    if (c.autoIncrement && inlineKey) line += ` PRIMARY KEY ${dialect.autoIncrement.clause}`;
    else if (c.autoIncrement && dialect.autoIncrement.position === 'afterType') line += ` ${dialect.autoIncrement.clause}`;
    if (!c.nullable && !(c.autoIncrement && inlineKey)) line += ' NOT NULL';
    if (c.default.trim() && !c.autoIncrement) line += ` DEFAULT ${c.default.trim()}`;
    if (c.autoIncrement && !inlineKey && dialect.autoIncrement.position === 'afterNotNull') line += ` ${dialect.autoIncrement.clause}`;
    if (dialect.comments === 'inline' && c.comment.trim()) line += ` COMMENT ${dialect.literal(c.comment.trim())}`;
    return line;
  };
  const named = (name: string) => (name.trim() ? `CONSTRAINT ${q(name)} ` : '');
  const lines = d.columns.map(column);
  if (keys.length && !inlineKey) lines.push(`  PRIMARY KEY (${keys.map((k) => q(k.name)).join(', ')})`);
  for (const f of d.foreignKeys) {
    lines.push(
      `  ${named(f.name)}FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${dialect.table(f.refSchema, f.refTable.trim())} (${f.refColumns.map(q).join(', ')}) ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`,
    );
  }
  for (const c of d.checks) lines.push(`  ${named(c.name)}CHECK (${c.expression.trim()})`);

  const options = dialect.comments === 'inline' && d.comment.trim() ? ` COMMENT=${dialect.literal(d.comment.trim())}` : '';
  const statements = [`CREATE TABLE ${table} (\n${lines.join(',\n')}\n)${options};`];
  for (const x of d.indexes) {
    statements.push(`CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${q(x.name)} ON ${table} (${x.columns.map(q).join(', ')});`);
  }
  if (dialect.comments === 'statements') {
    if (d.comment.trim()) statements.push(`COMMENT ON TABLE ${table} IS ${dialect.literal(d.comment.trim())};`);
    for (const c of d.columns) {
      if (c.comment.trim()) statements.push(`COMMENT ON COLUMN ${table}.${q(c.name)} IS ${dialect.literal(c.comment.trim())};`);
    }
  }
  return statements;
}
