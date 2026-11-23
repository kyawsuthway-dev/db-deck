// What a table change may do to the data, as notes for the forms that change tables (Design Table, Compare
// Structure), so both word it the same way. No `vscode`, no I/O.
import type { DesignChange } from './diff';

export type DesignNoteTone = 'info' | 'warning' | 'error';
export interface DesignNote {
  tone: DesignNoteTone;
  text: string;
}

/**
 * Notes for each change that can lose data or fail. `nulls` gives the NULL count of a column that becomes NOT
 * NULL (undefined while unknown: no note yet). `table`: prefix column names with it (Compare lists many tables).
 */
export function changeNotes(changes: DesignChange[], nulls: (change: Extract<DesignChange, { kind: 'alterColumn' }>) => number | undefined, table?: string): DesignNote[] {
  const name = (column: string) => (table ? `${table}.${column}` : column);
  const notes: DesignNote[] = [];
  for (const c of changes) {
    if (c.kind === 'dropColumn') notes.push({ tone: 'warning', text: `Dropping ${name(c.column.name)} deletes its data.` });
    if (c.kind === 'alterColumn' && c.type) {
      notes.push({
        tone: 'warning',
        text: `Changing the type of ${name(c.after.name)}: if values can’t be converted, or the database refuses it (PostgreSQL does while a view uses the column), the whole change fails and nothing is kept.`,
      });
    }
    if (c.kind === 'alterColumn' && c.nullable && !c.after.nullable) {
      const count = nulls(c);
      if (count !== undefined && count > 0) {
        notes.push({ tone: 'warning', text: `${name(c.after.name)} has ${count.toLocaleString()} NULL value${count === 1 ? '' : 's'}: NOT NULL will fail until they’re filled in.` });
      }
    }
    if ((c.kind === 'addIndex' && c.index.unique) || (c.kind === 'primaryKey' && c.after.length)) {
      notes.push({ tone: 'info', text: 'A new unique index or primary key fails if the columns have duplicate values; nothing is changed then.' });
    }
  }
  // The duplicate-values note once is enough.
  return notes.filter((n, i) => notes.findIndex((m) => m.text === n.text) === i);
}
