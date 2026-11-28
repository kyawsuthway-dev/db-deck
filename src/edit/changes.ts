// Turns the webview's pending edits into RowChanges. Pure (no vscode, no I/O), so it can be tested in Node.
// The webview is untrusted: it only says which cells and what new values. Originals and keys come from `page`.
import type { Cell, PendingChanges, RowChange } from '../types';

/** Most changes accepted in one save. */
export const MAX_CHANGES = 1_000;
/** Longest value accepted for one cell (characters). */
const MAX_VALUE_LENGTH = 10_000_000;

export interface EditContext {
  /** The page as loaded: column names and rows, from the extension's copy. */
  columns: string[];
  rows: Cell[][];
  /** Primary key column names. */
  key: string[];
  /** Columns that can't be edited (binary: the grid only has shortened hex). */
  readOnly: Set<string>;
  /** Columns left out of the conflict check (float/double/real: their text may not compare equal). */
  approximate: Set<string>;
  /** Columns checked by their text (json: no equality against text in MySQL or PostgreSQL). */
  asText: Set<string>;
}

/** Thrown for a change set the extension won't apply; the message is shown to the user. */
export class InvalidChanges extends Error {}

/** Column types whose displayed text may not compare equal to the stored value. */
export function isApproximateType(type: string): boolean {
  return /\b(float\d*|double|real)\b/i.test(type);
}

/**
 * Column types compared by their text in the conflict check. MySQL never finds a JSON value equal to a
 * string, PostgreSQL's `json` has no equality operator, and SQL Server's `text`, `ntext` and `xml` can't be
 * compared with `=` at all; the loaded text is the server's own text, so comparing text matches an unchanged
 * row. (`jsonb` compares fine as a value; a `text` column elsewhere compares the same either way.)
 */
export function isTextComparedType(type: string): boolean {
  return /^(json|text|ntext|xml)$/i.test(type.trim());
}

export function buildRowChanges(input: unknown, page: EditContext): RowChange[] {
  const pending = input as Partial<PendingChanges> | undefined;
  const updates = arrayOf(pending?.updates);
  const deletes = arrayOf(pending?.deletes);
  const inserts = arrayOf(pending?.inserts);

  const keyIndexes = page.key.map((k) => page.columns.indexOf(k));
  if (!keyIndexes.length || keyIndexes.some((i) => i < 0)) throw new InvalidChanges('This table has no primary key in the loaded page.');
  const keyOf = (row: number) =>
    page.key.map((column, i) => {
      const value = page.rows[row][keyIndexes[i]];
      if (value === null) throw new InvalidChanges(`Row ${row + 1} has no primary key value.`);
      return { column, value };
    });

  const deleted = new Set<number>();
  for (const row of deletes) deleted.add(rowIndex(row, page));

  // Group cell edits by row; a deleted row's edits don't matter, and a value equal to the original is no change.
  const byRow = new Map<number, Map<number, Cell>>();
  for (const u of updates as Partial<PendingChanges['updates'][number]>[]) {
    const row = rowIndex(u?.row, page);
    const col = editableColumn(u?.col, page);
    const value = cellValue(u?.value);
    if (deleted.has(row)) continue;
    if (!byRow.has(row)) byRow.set(row, new Map());
    byRow.get(row)!.set(col, value);
  }

  const changes: RowChange[] = [];
  for (const [row, cells] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const set = [...cells]
      .filter(([col, value]) => value !== page.rows[row][col])
      .map(([col, value]) => {
        const column = page.columns[col];
        return {
          column,
          value,
          original: page.rows[row][col],
          check: !page.approximate.has(column),
          asText: page.asText.has(column) || undefined,
        };
      });
    if (set.length) changes.push({ kind: 'update', key: keyOf(row), set });
  }
  for (const row of [...deleted].sort((a, b) => a - b)) changes.push({ kind: 'delete', key: keyOf(row) });
  for (const cells of inserts) {
    const values = new Map<number, Cell>();
    for (const c of arrayOf(cells) as Partial<PendingChanges['inserts'][number][number]>[]) {
      values.set(editableColumn(c?.col, page), cellValue(c?.value));
    }
    changes.push({ kind: 'insert', values: [...values].map(([col, value]) => ({ column: page.columns[col], value })) });
  }

  if (changes.length > MAX_CHANGES) {
    throw new InvalidChanges(`That's ${changes.length.toLocaleString()} changes; save at most ${MAX_CHANGES.toLocaleString()} at a time.`);
  }
  return changes;
}

/** "2 updates, 1 insert, 1 delete" */
export function describeChanges(changes: RowChange[]): string {
  const count = (kind: RowChange['kind']) => changes.filter((c) => c.kind === kind).length;
  const part = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  return [part(count('update'), 'update'), part(count('insert'), 'insert'), part(count('delete'), 'delete')].filter(Boolean).join(', ');
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InvalidChanges('The pending changes are malformed.');
  return value;
}

function rowIndex(row: unknown, page: EditContext): number {
  if (!Number.isSafeInteger(row) || (row as number) < 0 || (row as number) >= page.rows.length) {
    throw new InvalidChanges('A pending change refers to a row that isn’t on this page.');
  }
  return row as number;
}

function editableColumn(col: unknown, page: EditContext): number {
  if (!Number.isSafeInteger(col) || (col as number) < 0 || (col as number) >= page.columns.length) {
    throw new InvalidChanges('A pending change refers to an unknown column.');
  }
  const name = page.columns[col as number];
  if (page.readOnly.has(name)) throw new InvalidChanges(`Column "${name}" can’t be edited.`);
  return col as number;
}

function cellValue(value: unknown): Cell {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) throw new InvalidChanges('A pending value is malformed or too long.');
  return value;
}
