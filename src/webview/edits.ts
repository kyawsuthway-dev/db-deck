// Pending edits in a table view's grid. DOM-free, so it can be tested in plain Node.
// Rows are indexes into the page as loaded. Nothing here touches the database: the extension validates
// the pending set and only writes after the user confirms.
import type { Cell, PendingChanges } from '../types';

export interface Pending {
  /** New values of existing cells, keyed `row:col`. */
  cells: Map<string, Cell>;
  deleted: Set<number>;
  /** New rows: column → value. A column not in the map gets its default. */
  inserted: Map<number, Cell>[];
}

export function emptyPending(): Pending {
  return { cells: new Map(), deleted: new Set(), inserted: [] };
}

const cellKey = (row: number, col: number) => `${row}:${col}`;

/** The value to show for an existing cell: pending if edited, otherwise the original. */
export function shownValue(p: Pending, row: number, col: number, original: Cell): Cell {
  const key = cellKey(row, col);
  return p.cells.has(key) ? p.cells.get(key)! : original;
}

export function isEdited(p: Pending, row: number, col: number): boolean {
  return p.cells.has(cellKey(row, col));
}

/** Setting a cell back to its original value removes the pending edit. */
export function setCell(p: Pending, row: number, col: number, value: Cell, original: Cell): void {
  if (value === original) p.cells.delete(cellKey(row, col));
  else p.cells.set(cellKey(row, col), value);
}

export function addRow(p: Pending): number {
  p.inserted.push(new Map());
  return p.inserted.length - 1;
}

export function setInsertedCell(p: Pending, index: number, col: number, value: Cell): void {
  p.inserted[index]?.set(col, value);
}

/**
 * Deletes existing rows and drops new ones. If every existing row given is already marked deleted,
 * they're restored instead (the same action toggles).
 */
export function toggleDelete(p: Pending, existing: number[], insertedIndexes: number[]): void {
  if (existing.length && existing.every((r) => p.deleted.has(r))) {
    for (const r of existing) p.deleted.delete(r);
  } else {
    for (const r of existing) p.deleted.add(r);
  }
  for (const i of [...insertedIndexes].sort((a, b) => b - a)) p.inserted.splice(i, 1);
}

/** Changes the user would save: edited rows (not deleted) + deleted rows + new rows. */
export function pendingCount(p: Pending): number {
  const editedRows = new Set([...p.cells.keys()].map((k) => Number(k.split(':')[0])).filter((r) => !p.deleted.has(r)));
  return editedRows.size + p.deleted.size + p.inserted.length;
}

export function toPendingChanges(p: Pending): PendingChanges {
  return {
    updates: [...p.cells].map(([key, value]) => {
      const [row, col] = key.split(':').map(Number);
      return { row, col, value };
    }),
    deletes: [...p.deleted],
    inserts: p.inserted.map((cells) => [...cells].map(([col, value]) => ({ col, value }))),
  };
}

/** For the webview's saved state, so pending edits survive the panel being hidden and shown. */
export function serialize(p: Pending): unknown {
  return { cells: [...p.cells], deleted: [...p.deleted], inserted: p.inserted.map((m) => [...m]) };
}

export function deserialize(data: unknown): Pending {
  const d = data as { cells?: [string, Cell][]; deleted?: number[]; inserted?: [number, Cell][][] } | undefined;
  try {
    return {
      cells: new Map(d?.cells ?? []),
      deleted: new Set(d?.deleted ?? []),
      inserted: (d?.inserted ?? []).map((cells) => new Map(cells)),
    };
  } catch {
    return emptyPending();
  }
}
