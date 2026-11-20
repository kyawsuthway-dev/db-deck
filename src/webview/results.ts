// Runs inside the Results webview (a browser context), bundled separately to dist/webview/results.js.
// Values are only ever inserted with textContent, never as HTML.
import type { Cell, SortKey, StatementResult } from '../types';
import type { CopyFormat, ResultsCommand, ResultsMessage, ResultsRequest, TableViewState } from '../views/ResultsPanel';
import { attachAutocomplete } from './autocomplete';
import { copyRequestOf, inRange, rangeOf, selectAll, selectCell, type CellRange, type GridSelection } from './selection';
import './results.css';

declare function acquireVsCodeApi(): { postMessage(message: ResultsRequest): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** In-memory sort of query results, per result index. Reset whenever new results arrive. */
let localSorts = new Map<number, SortKey>();
let current: Extract<ResultsMessage, { type: 'results' }> | undefined;
/** What's typed in the WHERE box but not applied yet, so paging or sorting doesn't lose it. Reset when a table opens. */
let draftWhere: string | undefined;
/** Caret to restore in the WHERE box once the filtered page arrives. */
let pendingFocus: { start: number | null; end: number | null } | undefined;
/** Selected cells (one grid at a time). Cleared on every render. */
let selection: GridSelection | undefined;
/** Per result section: original row index for each displayed row (differs after an in-grid sort). */
let orders = new Map<number, number[]>();
let dragging = false;

window.addEventListener('message', (event: MessageEvent<ResultsMessage | ResultsCommand>) => {
  const msg = event.data;
  if (msg.type === 'copyRequest') {
    copySelection(msg.format);
    return;
  }
  localSorts = new Map();
  render(msg);
});
window.addEventListener('mouseup', () => (dragging = false));
// Ctrl/Cmd+C (and Edit > Copy) arrive as a copy event. Formatting happens in the extension.
document.addEventListener('copy', (event) => {
  if (!selection || !(document.activeElement instanceof HTMLElement) || !document.activeElement.classList.contains('table-wrap')) return;
  event.preventDefault();
  copySelection('tsv');
});
vscode.postMessage({ type: 'ready' });

function render(msg: ResultsMessage): void {
  selection = undefined;
  orders = new Map();
  if (msg.type === 'loading') {
    current = undefined;
    draftWhere = undefined;
    pendingFocus = undefined;
    root.className = '';
    root.replaceChildren(el('div', 'status', 'Running…'), el('pre', 'sql', msg.sql));
    return;
  }
  current = msg;
  if (msg.results.length === 0) {
    root.className = '';
    root.replaceChildren(el('div', 'status', 'Nothing to run.'));
    return;
  }
  root.className = msg.results.length === 1 ? 'single' : '';
  root.replaceChildren(...msg.results.map((result, i) => renderResult(result, i, msg.table)));
  restoreFocus();
}

function renderResult(result: StatementResult, index: number, table: TableViewState | undefined): HTMLElement {
  const section = el('section', 'result');
  const header = el('header');
  header.append(el('span', 'index', `#${index + 1}`), el('span', result.error ? 'summary error-text' : 'summary', summary(result)));
  const sql = el('div', 'sql-line', result.sql.replace(/\s+/g, ' '));
  sql.title = result.sql;
  header.append(sql);
  if (!result.error && result.columns.length) {
    // The extension asks for format, scope and file; it already has the rows.
    header.append(button('Export…', false, () => {
      const order = !table && localSorts.has(index) ? orders.get(index) : undefined;
      vscode.postMessage({ type: 'export', index, order });
    }));
  }
  section.append(header);
  // The filter bar stays above an error too, so a bad condition can be fixed in place.
  if (table) section.append(renderFilterBar(table), renderPager(result, table));

  if (result.error) {
    section.append(el('pre', 'error', result.error));
  } else if (result.columns.length) {
    section.append(renderTable(result, index, table));
  }
  return section;
}

function summary(r: StatementResult): string {
  const time = `${r.durationMs} ms`;
  if (r.error) return `Error · ${time}`;
  if (r.columns.length) {
    const rows = `${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'}`;
    return `${r.truncated ? `First ${rows} (more not shown)` : rows} · ${time}`;
  }
  if (r.affectedRows !== undefined) return `${r.affectedRows.toLocaleString()} row${r.affectedRows === 1 ? '' : 's'} affected · ${time}`;
  return `Done · ${time}`;
}

/**
 * One SQL condition for the whole table, like DBeaver's filter box. Enter applies it, Escape or ✕ clears it,
 * and column names and operators are suggested as you type (autocomplete.ts).
 * Nothing is queried per keystroke. The database checks the SQL; the driver makes sure it's one statement.
 */
function renderFilterBar(table: TableViewState): HTMLElement {
  const bar = el('div', 'filter-bar');
  const label = el('label', 'filter-label', 'WHERE');
  const input = el('input', 'filter-input');
  input.type = 'text';
  input.id = 'filter-where';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.maxLength = 10_000;
  input.placeholder = "e.g. id > 10 AND status = 'paid' (Enter to apply)";
  input.value = draftWhere ?? table.where ?? '';
  label.htmlFor = input.id;

  const clear = el('button', 'filter-clear', '✕');
  clear.type = 'button';
  clear.title = 'Clear filter (Escape)';
  clear.setAttribute('aria-label', 'Clear filter');

  const clearFilter = () => {
    input.value = '';
    draftWhere = undefined;
    if (table.where) applyWhere(input);
  };
  // The field wraps the input so the suggestion list can sit right under it.
  const field = el('div', 'filter-field');
  const suggestions = el('ul', 'suggestions');
  suggestions.id = 'filter-suggestions';
  field.append(input, suggestions);
  const autocomplete = attachAutocomplete(input, suggestions, table.hints, (value) => (draftWhere = value));

  input.addEventListener('input', () => (draftWhere = input.value));
  input.addEventListener('keydown', (event) => {
    // While suggestions are open, Enter / Tab / Escape / arrows belong to the list.
    if (autocomplete(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      applyWhere(input);
    } else if (event.key === 'Escape' && (input.value !== '' || table.where)) {
      event.preventDefault();
      clearFilter();
    }
  });
  clear.addEventListener('click', () => {
    clearFilter();
    input.focus();
  });

  bar.append(label, field, clear);
  return bar;
}

/** Sent on every Enter, even if unchanged, so a failed filter can simply be retried. */
function applyWhere(input: HTMLInputElement): void {
  pendingFocus = { start: input.selectionStart, end: input.selectionEnd };
  setBusy();
  vscode.postMessage({ type: 'filter', where: input.value });
}

/** The section is rebuilt for every page, so put focus and the caret back in the WHERE box. */
function restoreFocus(): void {
  const focus = pendingFocus;
  pendingFocus = undefined;
  const input = root.querySelector<HTMLInputElement>('input.filter-input');
  if (!focus || !input) return;
  input.focus();
  if (focus.start !== null) input.setSelectionRange(focus.start, focus.end);
}

/** Previous / Next for a table view. The total isn't known: the extension only knows whether another page exists. */
function renderPager(result: StatementResult, table: TableViewState): HTMLElement {
  const pager = el('nav', 'pager');
  pager.setAttribute('aria-label', 'Pages');
  const prev = button('Previous', table.offset === 0, () => requestPage(Math.max(0, table.offset - table.pageSize)));
  const next = button('Next', !table.hasMore, () => requestPage(table.offset + table.pageSize));
  const shown = result.rows.length;
  const empty = table.offset ? 'No rows on this page' : table.where ? 'No matching rows' : 'No rows';
  const range = el(
    'span',
    'range',
    shown ? `Rows ${(table.offset + 1).toLocaleString()}–${(table.offset + shown).toLocaleString()}` : empty,
  );
  pager.append(prev, range, next);
  if (!table.sort && !table.orderedByKey) {
    pager.append(el('span', 'note', 'No primary key: rows may move between pages. Sort by a column for a stable order.'));
  }
  return pager;
}

function renderTable(result: StatementResult, index: number, table: TableViewState | undefined): HTMLElement {
  // Table views sort in the database; query results sort here, over the rows already loaded.
  const sort = table ? table.sort : localSorts.get(index);
  const wrap = el('div', 'table-wrap');
  const grid = el('table');
  const headRow = el('tr');
  headRow.append(el('th', 'rownum', '#'));
  result.columns.forEach((name, col) => {
    // Query results can repeat a column name, so they sort by position; table views sort by name in the database.
    const active = sort && sort.column === (table ? name : String(col)) ? sort.direction : undefined;
    headRow.append(renderHeader(name, active, () => {
      const next = nextSort(active);
      if (table) {
        requestSort(next && { column: name, direction: next });
      } else {
        if (next) localSorts.set(index, { column: String(col), direction: next });
        else localSorts.delete(index);
        if (current) render(current);
      }
    }));
  });
  grid.append(el('thead'));
  grid.tHead!.append(headRow);

  const order = result.rows.map((_, i) => i);
  if (!table && sort) {
    const col = Number(sort.column);
    const dir = sort.direction === 'desc' ? -1 : 1;
    order.sort((a, b) => compareCells(result.rows[a][col], result.rows[b][col], dir) || a - b);
  }

  const body = el('tbody');
  for (const i of order) {
    const tr = el('tr');
    // The number is the row's position in the result, so it stays with the row when sorted here.
    tr.append(el('td', 'rownum', String((table?.offset ?? 0) + i + 1)));
    for (const value of result.rows[i]) {
      const td = el('td');
      if (value === null) {
        td.append(el('span', 'null', 'NULL'));
      } else {
        td.textContent = value;
        if (value.length > 40) td.title = value;
      }
      tr.append(td);
    }
    body.append(tr);
  }
  grid.append(body);
  wrap.append(grid);
  orders.set(index, order);
  attachSelection(wrap, body, index, result.columns.length);
  return wrap;
}

/**
 * Click a cell, Shift+click or drag for a range, click row numbers for whole rows, Ctrl/Cmd+A for all.
 * The grid takes focus so Ctrl+C copies it (see the document 'copy' listener). Right-click opens
 * VS Code's own menu (package.json webview/context) for the grid section.
 */
function attachSelection(wrap: HTMLElement, body: HTMLTableSectionElement, index: number, columnCount: number): void {
  wrap.tabIndex = 0;
  wrap.dataset.index = String(index);
  wrap.dataset.vscodeContext = JSON.stringify({ webviewSection: 'grid', preventDefaultContextMenuItems: true });
  wrap.setAttribute('aria-label', 'Results grid. Ctrl+A selects all, Ctrl+C copies.');

  const cellAt = (target: EventTarget | null) => {
    const td = target instanceof Element ? target.closest('td') : null;
    const tr = td?.parentElement;
    if (!td || !(tr instanceof HTMLTableRowElement) || tr.parentElement !== body) return undefined;
    const rowHeader = td.classList.contains('rownum');
    return { row: tr.sectionRowIndex, col: rowHeader ? 0 : td.cellIndex - 1, rowHeader };
  };

  wrap.addEventListener('mousedown', (event) => {
    const at = cellAt(event.target);
    if (!at) return;
    // Right-click inside the selection keeps it, so the context menu acts on it.
    if (event.button === 2 && selection?.index === index && inRange(rangeOf(selection, columnCount), at.row, at.col)) return;
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault(); // no text selection while dragging
    wrap.focus({ preventScroll: true });
    setSelection(selectCell(selection, index, { row: at.row, col: at.col }, event.shiftKey, at.rowHeader), columnCount);
    dragging = event.button === 0;
  });
  wrap.addEventListener('mouseover', (event) => {
    if (!dragging || selection?.index !== index) return;
    const at = cellAt(event.target);
    if (at) setSelection({ ...selection, focus: { row: at.row, col: at.col } }, columnCount);
  });
  wrap.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(selectAll(index, body.rows.length, columnCount), columnCount);
    }
  });
}

/** Repaints only the rows the old or new selection touches. */
function setSelection(next: GridSelection | undefined, columnCount: number): void {
  const previous = selection;
  selection = next;
  for (const sel of [previous, next]) {
    if (!sel) continue;
    const body = root.querySelector<HTMLElement>(`.table-wrap[data-index="${sel.index}"] tbody`);
    if (!(body instanceof HTMLTableSectionElement)) continue;
    const old = previous && previous.index === sel.index ? rangeOf(previous, columnCount) : undefined;
    const now = next && next.index === sel.index ? rangeOf(next, columnCount) : undefined;
    paintRows(body, old, now);
  }
}

function paintRows(body: HTMLTableSectionElement, old: CellRange | undefined, now: CellRange | undefined): void {
  const top = Math.min(old?.top ?? Infinity, now?.top ?? Infinity);
  const bottom = Math.max(old?.bottom ?? -1, now?.bottom ?? -1);
  for (let r = Math.max(0, top); r <= bottom && r < body.rows.length; r++) {
    const cells = body.rows[r].cells;
    for (let c = 1; c < cells.length; c++) cells[c].classList.toggle('selected', inRange(now, r, c - 1));
    cells[0].classList.toggle('selected-row', !!now && r >= now.top && r <= now.bottom);
  }
}

function copySelection(format: CopyFormat): void {
  const sel = selection;
  const order = sel && orders.get(sel.index);
  const columns = sel && current?.results[sel.index]?.columns.length;
  if (!sel || !order || !columns) return;
  vscode.postMessage({ type: 'copy', index: sel.index, format, ...copyRequestOf(sel, order, columns) });
}

function renderHeader(name: string, active: SortKey['direction'] | undefined, onSort: () => void): HTMLElement {
  const th = el('th');
  th.setAttribute('aria-sort', active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none');
  const sortButton = el('button', 'sort');
  sortButton.type = 'button';
  sortButton.title = active === 'asc' ? 'Sorted ascending. Click to sort descending.' : active === 'desc' ? 'Sorted descending. Click to clear.' : 'Click to sort ascending.';
  sortButton.append(el('span', 'name', name), el('span', 'arrow', active === 'asc' ? '▲' : active === 'desc' ? '▼' : ''));
  sortButton.addEventListener('click', onSort);
  th.append(sortButton);
  return th;
}

/** Ascending → descending → off. */
function nextSort(active: SortKey['direction'] | undefined): SortKey['direction'] | undefined {
  return active === undefined ? 'asc' : active === 'asc' ? 'desc' : undefined;
}

/**
 * Orders cells for display only; values are never changed. NULLs go last in both directions.
 * Two numbers compare numerically (very large integers may tie, but are still shown exactly).
 */
function compareCells(a: Cell, b: Cell, dir: 1 | -1): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const x = Number(a);
  const y = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) && x !== y) return (x - y) * dir;
  return collator.compare(a, b) * dir;
}

function requestPage(offset: number): void {
  setBusy();
  vscode.postMessage({ type: 'page', offset });
}

function requestSort(sort: SortKey | undefined): void {
  setBusy();
  vscode.postMessage({ type: 'sort', sort });
}

/** Until the next page arrives, controls are disabled and the grid is dimmed. The next render clears it. */
function setBusy(): void {
  root.classList.add('busy');
  root.querySelectorAll('button').forEach((b) => (b.disabled = true));
  root.querySelectorAll('input').forEach((i) => (i.readOnly = true));
}

function button(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'pager-button', label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
