// Cell selection in one results grid. DOM-free, so it can be tested in plain Node.
// Rows are display positions (after any in-grid sort); columns are data columns (the # column is excluded).

export interface CellPos {
  row: number;
  col: number;
}

export interface GridSelection {
  /** Which result section (one run can show several). */
  index: number;
  anchor: CellPos;
  focus: CellPos;
  /** Whole rows, from clicking row numbers: every column, whatever `col` says. */
  wholeRows: boolean;
}

export interface CellRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function rangeOf(sel: GridSelection, columnCount: number): CellRange {
  return {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: sel.wholeRows ? 0 : Math.min(sel.anchor.col, sel.focus.col),
    right: sel.wholeRows ? columnCount - 1 : Math.max(sel.anchor.col, sel.focus.col),
  };
}

export function inRange(range: CellRange | undefined, row: number, col: number): boolean {
  return !!range && row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

/** Click (or Shift+click to extend from the existing anchor in the same grid). */
export function selectCell(prev: GridSelection | undefined, index: number, at: CellPos, extend: boolean, wholeRows: boolean): GridSelection {
  if (extend && prev && prev.index === index) return { ...prev, focus: at, wholeRows: prev.wholeRows && wholeRows };
  return { index, anchor: at, focus: at, wholeRows };
}

export function selectAll(index: number, rowCount: number, columnCount: number): GridSelection | undefined {
  if (rowCount === 0 || columnCount === 0) return undefined;
  return { index, anchor: { row: 0, col: 0 }, focus: { row: rowCount - 1, col: columnCount - 1 }, wholeRows: true };
}

/**
 * What to send for a copy: original row indexes (in display order) and original column indexes (in
 * display order). `order[displayRow]` is the original row index; `visible[screenColumn]` the original column.
 */
export function copyRequestOf(sel: GridSelection, order: number[], visible: number[]): { rows: number[]; columns: number[] } {
  const r = rangeOf(sel, visible.length);
  return { rows: order.slice(r.top, r.bottom + 1), columns: visible.slice(r.left, r.right + 1) };
}
