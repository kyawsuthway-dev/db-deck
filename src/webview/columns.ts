// Hidden columns in the Results grid. DOM-free, so it can be tested in plain Node.
// The grid renders only visible columns and works in screen positions; everything that crosses to the
// extension or into pending edits uses original result indexes, through the `visible` map.

/** Screen position → original column index, in result order, skipping hidden columns. */
export function visibleColumns(count: number, hidden: ReadonlySet<number>): number[] {
  const visible: number[] = [];
  for (let i = 0; i < count; i++) if (!hidden.has(i)) visible.push(i);
  // Never hide everything: a result always shows at least one column.
  return visible.length ? visible : count ? [0] : [];
}

/** Original indexes of hidden column names (table views remember names). Unknown names are ignored. */
export function hiddenFromNames(columns: string[], names: readonly string[]): Set<number> {
  const wanted = new Set(names);
  const hidden = new Set<number>();
  columns.forEach((name, i) => {
    if (wanted.has(name)) hidden.add(i);
  });
  return hidden;
}

/** Hides one column, unless it's the last visible one. Returns the new set (the old one is unchanged). */
export function hideColumn(count: number, hidden: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(hidden);
  if (index < 0 || index >= count || hidden.has(index)) return next;
  if (visibleColumns(count, hidden).length <= 1) return next;
  next.add(index);
  return next;
}

/** Shows or hides a column (the Columns… checklist); the last visible column stays visible. */
export function setColumnVisible(count: number, hidden: ReadonlySet<number>, index: number, visible: boolean): Set<number> {
  if (!visible) return hideColumn(count, hidden, index);
  const next = new Set(hidden);
  next.delete(index);
  return next;
}
