// Runs inside the Results webview (a browser context), bundled separately to dist/webview/results.js.
// Values are only ever inserted with textContent, never as HTML.
import type { Cell, SortKey, StatementResult } from '../types';
import type { CopyFormat, EditCommand, ResultsCommand, ResultsMessage, ResultsRequest, TableViewState } from '../views/ResultsPanel';
import { attachAutocomplete } from './autocomplete';
import { hiddenFromNames, hideColumn, setColumnVisible, visibleColumns } from './columns';
import {
  addRow,
  deserialize,
  emptyPending,
  isEdited,
  pendingCount,
  serialize,
  setCell,
  setInsertedCell,
  shownValue,
  toggleDelete,
  toPendingChanges,
  type Pending,
} from './edits';
import { indentJson, isJsonContainer } from './jsonText';
import { copyRequestOf, inRange, rangeOf, selectAll, selectCell, type CellRange, type GridSelection } from './selection';
import './results.css';

declare function acquireVsCodeApi(): {
  postMessage(message: ResultsRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
};

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
/** Selected cells (one grid at a time). Cleared when new results arrive. */
let selection: GridSelection | undefined;
/** Per result section: original row index for each displayed row (differs after an in-grid sort). */
let orders = new Map<number, number[]>();
let dragging = false;
/** Unsaved edits of the table view, and which page they belong to (kept in webview state across hide/show). */
let pending: Pending = emptyPending();
let pendingKey: string | undefined;
/** Closes the open cell editor, keeping its value. Set while a cell is being edited. */
let finishEditing: (() => void) | undefined;
/**
 * The save confirmation, while it's open. Editing is locked meanwhile, so what the user confirms is what's
 * saved. Not kept in webview state: if the panel reloads, the user clicks Save… again.
 */
let confirm: { token: string; title: string; detail: string; statements: string[]; showSql: boolean; saving: boolean; focus: boolean } | undefined;
/** Hidden columns of query results, per result index (original indexes); until the next run. Table views use table.hidden. */
let hiddenByResult = new Map<number, Set<number>>();
/** The header last right-clicked, for VS Code's "Hide Column" menu item. */
let lastHeader: { index: number; col: number } | undefined;
/** Which result's Columns… checklist is open. */
let columnsMenu: number | undefined;
/** Waiting for a COUNT(*) (the Count button). */
let counting = false;
/** The value detail pane: open or closed, JSON or Raw. Kept in webview state. */
let detail: { open: boolean; mode: 'json' | 'raw' } = { open: false, mode: 'json' };
/** Text typed in the pane's editor but not applied yet, for the cell it belongs to (`row:col`). */
let detailDraft: { key: string; value: string } | undefined;

window.addEventListener('message', (event: MessageEvent<ResultsMessage | ResultsCommand>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'copyRequest':
      copySelection(msg.format);
      return;
    case 'edit':
      runEditCommand(msg.command);
      return;
    case 'clearPending':
      confirm = undefined;
      pending = emptyPending();
      pendingChanged();
      return;
    case 'confirmSave':
      finishEditing?.();
      confirm = { token: msg.token, title: msg.title, detail: msg.detail, statements: msg.statements, showSql: false, saving: false, focus: true };
      rerender();
      return;
    case 'closeConfirm':
      if (confirm) {
        confirm = undefined;
        rerender();
      }
      return;
    case 'hideColumn':
      finishEditing?.();
      if (lastHeader) setHidden(lastHeader.index, hideColumn(columnCount(lastHeader.index), hiddenOf(lastHeader.index), lastHeader.col));
      return;
    case 'tableState':
      counting = false;
      if (current?.table) {
        finishEditing?.();
        current = { ...current, table: msg.table };
        rerender();
      }
      return;
    default:
      confirm = undefined;
      localSorts = new Map();
      selection = undefined;
      hiddenByResult = new Map();
      columnsMenu = undefined;
      counting = false;
      detailDraft = undefined;
      restorePending(msg);
      render(msg);
  }
});
window.addEventListener('mouseup', () => (dragging = false));
// Escape anywhere in the panel cancels the save confirmation, or closes the Columns… checklist. F4 toggles the detail pane.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && confirm && !confirm.saving) {
    event.preventDefault();
    cancelConfirm();
  } else if (event.key === 'Escape' && columnsMenu !== undefined) {
    event.preventDefault();
    columnsMenu = undefined;
    rerender();
  } else if (event.key === 'F4' && current) {
    event.preventDefault();
    toggleDetail();
  }
});
// Ctrl/Cmd+C (and Edit > Copy) arrive as a copy event. Formatting happens in the extension.
document.addEventListener('copy', (event) => {
  if (!selection || !(document.activeElement instanceof HTMLElement) || !document.activeElement.classList.contains('table-wrap')) return;
  event.preventDefault();
  copySelection('tsv');
});
restoreDetailSettings();
vscode.postMessage({ type: 'ready' });

function render(msg: ResultsMessage): void {
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
  root.className = `${msg.results.length === 1 ? 'single' : ''}${detail.open ? ' with-detail' : ''}`;
  // Results on the left, the detail pane (when open) on the right, or below on a narrow panel.
  const main = el('div', 'results-main');
  main.append(...msg.results.map((result, i) => renderResult(result, i, msg.table)));
  root.replaceChildren(main);
  if (detail.open) root.append(renderDetail());
  restoreFocus();
  if (confirm?.focus) {
    confirm.focus = false;
    root.querySelector<HTMLElement>('.confirm')?.focus();
  }
}

/** Re-renders the current results in place (after an edit), keeping scroll position and selection. */
function rerender(): void {
  if (!current) return;
  const wrap = root.querySelector<HTMLElement>('.table-wrap');
  const scroll = wrap && { top: wrap.scrollTop, left: wrap.scrollLeft };
  render(current);
  const again = root.querySelector<HTMLElement>('.table-wrap');
  if (again && scroll) {
    again.scrollTop = scroll.top;
    again.scrollLeft = scroll.left;
  }
  if (selection) setSelection(selection);
}

function renderResult(result: StatementResult, index: number, table: TableViewState | undefined): HTMLElement {
  const section = el('section', 'result');
  const header = el('header');
  header.append(el('span', 'index', `#${index + 1}`), el('span', result.error ? 'summary error-text' : 'summary', summary(result)));
  const sql = el('div', 'sql-line', result.sql.replace(/\s+/g, ' '));
  sql.title = result.sql;
  header.append(sql);
  if (!result.error && result.columns.length) {
    const hidden = hiddenOf(index);
    if (hidden.size) {
      header.append(
        el('span', 'hidden-count', `${hidden.size} hidden`),
        button('Show All', false, () => setHidden(index, new Set())),
      );
    }
    const columnsButton = button('Columns…', false, () => {
      columnsMenu = columnsMenu === index ? undefined : index;
      rerender();
    });
    columnsButton.setAttribute('aria-expanded', String(columnsMenu === index));
    const details = button('Details', false, toggleDetail);
    details.setAttribute('aria-pressed', String(detail.open));
    details.title = 'Show the selected cell’s full value (F4)';
    // The extension asks for format, scope and file; it already has the rows. Hidden columns are left out.
    const exportButton = button('Export…', false, () => {
      const order = !table && localSorts.has(index) ? orders.get(index) : undefined;
      const columns = hidden.size ? visibleOf(index) : undefined;
      vscode.postMessage({ type: 'export', index, order, columns });
    });
    header.append(columnsButton, details, exportButton);
  }
  section.append(header);
  if (columnsMenu === index && !result.error) section.append(renderColumnsMenu(result, index));
  // The filter bar stays above an error too, so a bad condition can be fixed in place.
  if (table) section.append(renderFilterBar(table), renderPager(result, table));
  if (table && !result.error) section.append(renderEditBar(table));
  if (table && !result.error && confirm) section.append(renderConfirm(confirm));

  // Server messages (SQL Server PRINT and informational messages), as text.
  if (result.messages?.length) section.append(el('pre', 'messages', result.messages.join('\n')));
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
  if (r.messages?.length) return `Messages · ${time}`;
  return `Done · ${time}`;
}

/** Paging, sorting and filtering reload the page, which would lose unsaved edits, so they wait. */
const DIRTY_HINT = 'Save or discard your changes first.';
const dirty = () => pendingCount(pending) > 0;

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
  if (dirty()) {
    input.readOnly = true;
    input.title = DIRTY_HINT;
    clear.disabled = true;
  }

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
    if (input.readOnly) return;
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
  const prev = button('Previous', table.offset === 0 || dirty(), () => requestPage(Math.max(0, table.offset - table.pageSize)));
  const next = button('Next', !table.hasMore || dirty(), () => requestPage(table.offset + table.pageSize));
  if (dirty()) prev.title = next.title = DIRTY_HINT;
  const shown = result.rows.length;
  const empty = table.offset ? 'No rows on this page' : table.where ? 'No matching rows' : 'No rows';
  // The total is text from the database, so huge counts stay exact; it's shown as the database sent it.
  const of = table.total !== undefined ? ` of ${table.total}` : '';
  const range = el(
    'span',
    'range',
    shown ? `Rows ${(table.offset + 1).toLocaleString()}–${(table.offset + shown).toLocaleString()}${of}` : `${empty}${of}`,
  );
  const count = button(counting ? 'Counting…' : table.total !== undefined ? 'Recount' : 'Count', counting || !!result.error, () => {
    counting = true;
    rerender();
    vscode.postMessage({ type: 'count' });
  });
  count.title = table.where ? 'Count the rows matching the WHERE filter (SELECT COUNT(*))' : 'Count all rows (SELECT COUNT(*))';
  pager.append(prev, range, next, count);
  if (!table.sort && !table.orderedByKey) {
    pager.append(el('span', 'note', 'No primary key: rows may move between pages. Sort by a column for a stable order.'));
  }
  return pager;
}

/** Add Row / Delete Rows, and once there are edits: the count, Save… and Discard. Read-only tables say why. */
function renderEditBar(table: TableViewState): HTMLElement {
  const bar = el('div', 'edit-bar');
  if ('reason' in table.edit) {
    bar.append(el('span', 'note', table.edit.reason));
    return bar;
  }
  // These buttons keep focus where it is (mousedown), so an open cell editor isn't closed by the press and
  // redrawn away before the click lands; each one finishes that edit first instead.
  const editButton = (label: string, onClick: () => void) => {
    const b = button(label, !!confirm, () => {
      finishEditing?.();
      onClick();
    });
    b.addEventListener('mousedown', (event) => event.preventDefault());
    return b;
  };
  bar.append(editButton('Add Row', () => runEditCommand('addRow')), editButton('Delete Rows', () => runEditCommand('deleteRows')));
  const count = pendingCount(pending);
  if (count) {
    const save = editButton('Save…', () => vscode.postMessage({ type: 'save', changes: toPendingChanges(pending) }));
    save.classList.add('primary');
    bar.append(
      el('span', 'pending-count', `● ${count} pending change${count === 1 ? '' : 's'}`),
      save,
      editButton('Discard', () => {
        pending = emptyPending();
        pendingChanged();
      }),
      el('span', 'note', 'Paging, sorting and filtering wait until you save or discard.'),
    );
  } else {
    bar.append(el('span', 'note', 'Double-click a cell to edit. Changes are saved only when you click Save.'));
  }
  return bar;
}

/**
 * The save confirmation, shown between the edit bar and the grid. Apply sends the extension's token back;
 * Review SQL shows the statements as text (for reading only, they run with parameters). Escape cancels
 * (document listener).
 */
function renderConfirm(c: NonNullable<typeof confirm>): HTMLElement {
  const box = el('div', 'confirm');
  box.tabIndex = -1;
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-labelledby', 'confirm-title');
  box.setAttribute('aria-describedby', 'confirm-detail');
  const title = el('div', 'confirm-title', c.title);
  title.id = 'confirm-title';
  const detail = el('div', 'confirm-detail', c.detail);
  detail.id = 'confirm-detail';
  const text = el('div', 'confirm-text');
  text.append(title, detail);
  const head = el('div', 'confirm-head');
  head.append(el('span', 'confirm-icon', '⚠'), text);

  const apply = button(c.saving ? 'Saving…' : 'Apply', c.saving, () => {
    c.saving = true;
    rerender();
    vscode.postMessage({ type: 'applySave', token: c.token });
  });
  apply.classList.add('primary');
  const review = button(c.showSql ? 'Hide SQL' : 'Review SQL', c.saving, () => {
    c.showSql = !c.showSql;
    c.focus = true;
    rerender();
  });
  review.setAttribute('aria-expanded', String(c.showSql));
  const cancel = button('Cancel', c.saving, cancelConfirm);
  const actions = el('div', 'confirm-actions');
  actions.append(apply, review, cancel);
  box.append(head, actions);

  if (c.showSql) {
    box.append(
      el('div', 'confirm-note', 'For review only. DB Deck runs these with parameters, in one transaction, with the conflict check. Running this text yourself skips those checks.'),
      el('pre', 'confirm-sql', c.statements.join('\n')),
    );
  }
  return box;
}

function cancelConfirm(): void {
  if (!confirm || confirm.saving) return;
  vscode.postMessage({ type: 'cancelSave', token: confirm.token });
  confirm = undefined;
  rerender();
  root.querySelector<HTMLElement>('.table-wrap')?.focus({ preventScroll: true });
}

/** Editing applies to table views of tables with a primary key, on the first (only) result. */
function editTarget(): { result: StatementResult; readOnly: Set<number>; key: Set<number> } | undefined {
  const table = current?.table;
  const result = current?.results[0];
  if (!table || !result || result.error || 'reason' in table.edit) return undefined;
  const index = (names: string[]) => new Set(names.map((n) => result.columns.indexOf(n)).filter((i) => i >= 0));
  return { result, readOnly: index(table.edit.readOnly), key: index(table.edit.key) };
}

function renderTable(result: StatementResult, index: number, table: TableViewState | undefined): HTMLElement {
  // Table views sort in the database; query results sort here, over the rows already loaded.
  const sort = table ? table.sort : localSorts.get(index);
  const editing = table ? editTarget() : undefined;
  const visible = visibleOf(index);
  const wrap = el('div', 'table-wrap');
  const grid = el('table');
  const headRow = el('tr');
  headRow.append(el('th', 'rownum', '#'));
  visible.forEach((col) => {
    const name = result.columns[col];
    // Query results can repeat a column name, so they sort by position; table views sort by name in the database.
    const active = sort && sort.column === (table ? name : String(col)) ? sort.direction : undefined;
    headRow.append(renderHeader(name, index, col, active, !!table && dirty(), () => {
      const next = nextSort(active);
      if (table) {
        requestSort(next && { column: name, direction: next });
      } else {
        if (next) localSorts.set(index, { column: String(col), direction: next });
        else localSorts.delete(index);
        selection = undefined;
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
    if (editing && pending.deleted.has(i)) tr.classList.add('deleted');
    visible.forEach((col) => {
      const original = result.rows[i][col];
      const td = valueCell(editing ? shownValue(pending, i, col, original) : original);
      if (editing && isEdited(pending, i, col)) td.classList.add('edited');
      if (editing?.readOnly.has(col)) td.classList.add('readonly');
      tr.append(td);
    });
    body.append(tr);
  }
  // New rows go after the page's rows; untouched cells show DEFAULT (the database fills them in).
  if (editing) {
    pending.inserted.forEach((cells) => {
      const tr = el('tr', 'inserted');
      tr.append(el('td', 'rownum', '+'));
      visible.forEach((col) => {
        const td = cells.has(col) ? valueCell(cells.get(col)!) : el('td', undefined, '');
        if (cells.has(col)) td.classList.add('edited');
        else td.append(el('span', 'default', 'DEFAULT'));
        if (editing.readOnly.has(col)) td.classList.add('readonly');
        tr.append(td);
      });
      body.append(tr);
    });
  }
  grid.append(body);
  wrap.append(grid);
  orders.set(index, order);
  attachSelection(wrap, body, index, visible.length, !!editing);
  return wrap;
}

function valueCell(value: Cell): HTMLTableCellElement {
  const td = el('td');
  if (value === null) {
    td.append(el('span', 'null', 'NULL'));
  } else {
    td.textContent = value;
    if (value.length > 40) td.title = value;
  }
  return td;
}

/**
 * Click a cell, Shift+click or drag for a range, click row numbers for whole rows, Ctrl/Cmd+A for all.
 * The grid takes focus so Ctrl+C copies it (see the document 'copy' listener). Right-click opens
 * VS Code's own menu (package.json webview/context) for the grid section.
 * In an editable table: double-click, Enter or F2 edits a cell; Ctrl/Cmd+0 sets the selection to NULL.
 */
function attachSelection(wrap: HTMLElement, body: HTMLTableSectionElement, index: number, columnCount: number, editable: boolean): void {
  wrap.tabIndex = 0;
  wrap.dataset.index = String(index);
  wrap.dataset.vscodeContext = JSON.stringify({ webviewSection: 'grid', dbDeckEditable: editable, preventDefaultContextMenuItems: true });
  wrap.setAttribute(
    'aria-label',
    editable ? 'Results grid. Enter or F2 edits a cell, Ctrl+A selects all, Ctrl+C copies.' : 'Results grid. Ctrl+A selects all, Ctrl+C copies.',
  );

  const cellAt = (target: EventTarget | null) => {
    if (target instanceof HTMLTextAreaElement) return undefined; // clicks inside the cell editor
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
    setSelection(selectCell(selection, index, { row: at.row, col: at.col }, event.shiftKey, at.rowHeader));
    dragging = event.button === 0;
  });
  wrap.addEventListener('mouseover', (event) => {
    if (!dragging || selection?.index !== index) return;
    const at = cellAt(event.target);
    if (at) setSelection({ ...selection, focus: { row: at.row, col: at.col } });
  });
  wrap.addEventListener('dblclick', (event) => {
    const at = cellAt(event.target);
    if (editable && at && !at.rowHeader) openEditor(at.row, at.col);
  });
  wrap.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(selectAll(index, body.rows.length, columnCount));
    } else if (editable && mod && event.key === '0') {
      event.preventDefault();
      runEditCommand('setNull');
    } else if (editable && !mod && (event.key === 'Enter' || event.key === 'F2') && selection?.index === index) {
      event.preventDefault();
      openEditor(selection.focus.row, selection.focus.col);
    }
  });
}

/**
 * Edits one cell in place. Enter keeps the value as a pending change, Shift+Enter adds a line,
 * Escape cancels, Tab / Shift+Tab move to the next / previous editable cell. Leaving the cell keeps
 * the value too. Opening and closing without typing changes nothing (so a NULL stays NULL).
 */
function openEditor(rowPos: number, screenCol: number): void {
  const target = editTarget();
  const body = root.querySelector<HTMLTableSectionElement>('.table-wrap[data-index="0"] tbody');
  if (confirm) return;
  // Pending edits use original column indexes; the grid works in screen positions (hidden columns skipped).
  const visible = visibleOf(0);
  const col = visible[screenCol];
  const td = body?.rows[rowPos]?.cells[screenCol + 1];
  if (!target || !td || col === undefined || target.readOnly.has(col)) return;
  const existing = rowPos < target.result.rows.length;
  const insertIndex = rowPos - target.result.rows.length;
  if (existing && pending.deleted.has(rowPos)) return;
  const shown = existing ? shownValue(pending, rowPos, col, target.result.rows[rowPos][col]) : pending.inserted[insertIndex]?.get(col) ?? null;

  const editor = el('textarea', 'cell-editor');
  editor.value = shown ?? '';
  editor.rows = 1;
  editor.spellcheck = false;
  editor.setAttribute('aria-label', `Edit ${target.result.columns[col]}`);
  const initial = editor.value;
  td.classList.add('editing');
  td.replaceChildren(editor);
  editor.focus();
  editor.select();

  const owner = current;
  let closed = false;
  const close = (keep: boolean, move?: 1 | -1) => {
    if (closed) return;
    closed = true;
    finishEditing = undefined;
    // New results replaced the page while editing: this edit belongs to a page that's gone.
    if (current !== owner) return;
    if (keep && editor.value !== initial) {
      if (existing) setCell(pending, rowPos, col, editor.value, target.result.rows[rowPos][col]);
      else setInsertedCell(pending, insertIndex, col, editor.value);
      pendingChanged();
    } else {
      rerender();
    }
    const next = move && nextEditableColumn(screenCol, move, target.readOnly, visible);
    if (next !== undefined) openEditor(rowPos, next);
    else root.querySelector<HTMLElement>('.table-wrap')?.focus({ preventScroll: true });
  };
  editor.addEventListener('keydown', (event) => {
    event.stopPropagation(); // the grid's own shortcuts (Ctrl+A, Enter, Ctrl+0) don't apply while typing
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      close(true, event.shiftKey ? -1 : 1);
    }
  });
  editor.addEventListener('blur', () => close(true));
  finishEditing = () => close(true);
}

/** The next screen column (from `screenCol`, in `step` direction) whose original column can be edited. */
function nextEditableColumn(screenCol: number, step: 1 | -1, readOnly: Set<number>, visible: number[]): number | undefined {
  for (let c = screenCol + step; c >= 0 && c < visible.length; c += step) if (!readOnly.has(visible[c])) return c;
  return undefined;
}

/** Set to NULL / Delete Rows / Add Row, from the buttons, keys or VS Code's context menu. */
function runEditCommand(command: EditCommand): void {
  finishEditing?.();
  const target = editTarget();
  if (!target || confirm) return;
  const rowCount = target.result.rows.length;
  const visible = visibleOf(0);
  const range = selection?.index === 0 ? rangeOf(selection, visible.length) : undefined;

  if (command === 'addRow') {
    const i = addRow(pending);
    pendingChanged();
    // Start typing in the first visible column that isn't the key (usually generated) and isn't read-only.
    const preferred = visible.findIndex((c) => !target.key.has(c) && !target.readOnly.has(c));
    const first = preferred >= 0 ? preferred : nextEditableColumn(-1, 1, target.readOnly, visible);
    if (first !== undefined) openEditor(rowCount + i, first);
    return;
  }
  if (!range) return;
  if (command === 'deleteRows') {
    const rows = [...Array(range.bottom - range.top + 1).keys()].map((k) => range.top + k);
    toggleDelete(pending, rows.filter((r) => r < rowCount), rows.filter((r) => r >= rowCount).map((r) => r - rowCount));
    selection = undefined;
  } else {
    for (let r = range.top; r <= range.bottom; r++) {
      for (const c of visible.slice(range.left, range.right + 1)) {
        if (target.readOnly.has(c)) continue;
        if (r < rowCount) {
          if (!pending.deleted.has(r)) setCell(pending, r, c, null, target.result.rows[r][c]);
        } else {
          setInsertedCell(pending, r - rowCount, c, null);
        }
      }
    }
  }
  pendingChanged();
}

/** Webview state: pending edits (for one page) and the detail pane's settings. */
function saveState(): void {
  vscode.setState({ key: pendingKey, pending: serialize(pending), detail });
}

/** Saves pending edits in webview state, tells the extension the count, and redraws. */
function pendingChanged(): void {
  saveState();
  vscode.postMessage({ type: 'pending', count: pendingCount(pending) });
  rerender();
}

/**
 * Pending edits belong to one page of one table. When that page is shown again (the panel was hidden
 * and reloaded), they come back from webview state; any other results start clean.
 */
function restorePending(msg: ResultsMessage): void {
  const key = msg.type === 'results' && msg.table ? `${msg.title}\n${msg.results[0]?.sql ?? ''}` : undefined;
  const saved = vscode.getState() as { key?: string; pending?: unknown } | undefined;
  pending = key && saved?.key === key ? deserialize(saved.pending) : emptyPending();
  pendingKey = key;
  if (msg.type === 'results') {
    saveState();
    vscode.postMessage({ type: 'pending', count: pendingCount(pending) });
  }
}

/** Repaints only the rows the old or new selection touches, and points the detail pane at the new cell. */
function setSelection(next: GridSelection | undefined): void {
  const previous = selection;
  selection = next;
  for (const sel of [previous, next]) {
    if (!sel) continue;
    const body = root.querySelector<HTMLElement>(`.table-wrap[data-index="${sel.index}"] tbody`);
    if (!(body instanceof HTMLTableSectionElement)) continue;
    const columnCount = visibleOf(sel.index).length;
    const old = previous && previous.index === sel.index ? rangeOf(previous, columnCount) : undefined;
    const now = next && next.index === sel.index ? rangeOf(next, columnCount) : undefined;
    paintRows(body, old, now);
  }
  if (detail.open) updateDetail();
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
  if (!sel || !order || !current?.results[sel.index]) return;
  vscode.postMessage({ type: 'copy', index: sel.index, format, ...copyRequestOf(sel, order, visibleOf(sel.index)) });
}

function renderHeader(name: string, index: number, col: number, active: SortKey['direction'] | undefined, disabled: boolean, onSort: () => void): HTMLElement {
  const th = el('th');
  // Right-click opens VS Code's menu for headers (Hide Column); it acts on the header remembered here.
  th.dataset.vscodeContext = JSON.stringify({ webviewSection: 'header', preventDefaultContextMenuItems: true });
  th.addEventListener('contextmenu', () => (lastHeader = { index, col }));
  th.setAttribute('aria-sort', active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none');
  const sortButton = el('button', 'sort');
  sortButton.type = 'button';
  sortButton.disabled = disabled;
  sortButton.title = disabled
    ? DIRTY_HINT
    : active === 'asc'
      ? 'Sorted ascending. Click to sort descending.'
      : active === 'desc'
        ? 'Sorted descending. Click to clear.'
        : 'Click to sort ascending.';
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

/** Original indexes of a result's hidden columns. Table views remember names (per table); query results, indexes. */
function hiddenOf(index: number): Set<number> {
  const result = current?.results[index];
  if (!result) return new Set();
  if (current?.table && index === 0) return hiddenFromNames(result.columns, current.table.hidden);
  return hiddenByResult.get(index) ?? new Set();
}

/** Screen position → original column index for a result. */
function visibleOf(index: number): number[] {
  return visibleColumns(columnCount(index), hiddenOf(index));
}

function columnCount(index: number): number {
  return current?.results[index]?.columns.length ?? 0;
}

/** Applies a new set of hidden columns; table views also tell the extension, which remembers it per table. */
function setHidden(index: number, hidden: Set<number>): void {
  const result = current?.results[index];
  if (!current || !result) return;
  finishEditing?.();
  if (current.table && index === 0) {
    const names = result.columns.filter((_, i) => hidden.has(i));
    current = { ...current, table: { ...current.table, hidden: names } };
    vscode.postMessage({ type: 'hideColumns', names });
  } else {
    hiddenByResult.set(index, hidden);
  }
  // Screen positions changed, so the selection would point at other cells.
  if (selection?.index === index) selection = undefined;
  rerender();
}

/** The Columns… checklist. The last visible column can't be unchecked. */
function renderColumnsMenu(result: StatementResult, index: number): HTMLElement {
  const menu = el('div', 'columns-menu');
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Visible columns');
  const hidden = hiddenOf(index);
  const visibleCount = result.columns.length - hidden.size;
  result.columns.forEach((name, col) => {
    const item = el('label', 'columns-item');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !hidden.has(col);
    box.disabled = box.checked && visibleCount <= 1;
    box.addEventListener('change', () => setHidden(index, setColumnVisible(result.columns.length, hiddenOf(index), col, box.checked)));
    item.append(box, el('span', undefined, name));
    menu.append(item);
  });
  const actions = el('div', 'columns-actions');
  actions.append(
    button('Show All', hidden.size === 0, () => setHidden(index, new Set())),
    button('Close', false, () => {
      columnsMenu = undefined;
      rerender();
    }),
  );
  menu.append(actions);
  return menu;
}

/** The cell the detail pane shows: the selection's focus cell, with its pending value in editable table views. */
interface DetailTarget {
  index: number;
  /** Original column index. */
  col: number;
  name: string;
  /** undefined: a new row's untouched cell, which gets the column's DEFAULT. */
  value: Cell | undefined;
  editable: boolean;
  binary: boolean;
  /** Original row index of an existing row, or which new row. */
  existingRow?: number;
  insertIndex?: number;
  key: string;
  rowLabel: string;
}

function detailTarget(): DetailTarget | undefined {
  const sel = selection;
  const result = sel && current?.results[sel.index];
  if (!sel || !current || !result || result.error) return undefined;
  const col = visibleOf(sel.index)[sel.focus.col];
  if (col === undefined) return undefined;
  const order = orders.get(sel.index) ?? [];
  const editing = current.table && sel.index === 0 ? editTarget() : undefined;
  const name = result.columns[col];
  const binary = !!editing?.readOnly.has(col);
  if (sel.focus.row < order.length) {
    const row = order[sel.focus.row];
    const original = result.rows[row]?.[col];
    if (original === undefined) return undefined;
    const deleted = !!editing && pending.deleted.has(row);
    return {
      index: sel.index,
      col,
      name,
      value: editing ? shownValue(pending, row, col, original) : original,
      editable: !!editing && !binary && !deleted && !confirm,
      binary,
      existingRow: row,
      key: `${row}:${col}`,
      rowLabel: `Row ${((current.table?.offset ?? 0) + row + 1).toLocaleString()}${deleted ? ' (deleted)' : ''}`,
    };
  }
  const insertIndex = sel.focus.row - order.length;
  const cells = editing ? pending.inserted[insertIndex] : undefined;
  if (!cells) return undefined;
  return {
    index: sel.index,
    col,
    name,
    value: cells.has(col) ? cells.get(col)! : undefined,
    editable: !binary && !confirm,
    binary,
    insertIndex,
    key: `+${insertIndex}:${col}`,
    rowLabel: 'New row',
  };
}

function toggleDetail(): void {
  applyDetailDraft();
  detail = { ...detail, open: !detail.open };
  saveState();
  rerender();
}

function restoreDetailSettings(): void {
  const saved = vscode.getState() as { detail?: { open?: unknown; mode?: unknown } } | undefined;
  detail = { open: saved?.detail?.open === true, mode: saved?.detail?.mode === 'raw' ? 'raw' : 'json' };
}

function renderDetail(): HTMLElement {
  const pane = el('aside', 'detail-pane');
  pane.setAttribute('aria-label', 'Value details');
  fillDetail(pane, detailTarget());
  return pane;
}

/** The selection moved: an unapplied edit in the pane is kept as a pending change (like leaving a cell editor). */
function updateDetail(): void {
  const pane = root.querySelector<HTMLElement>('.detail-pane');
  if (!pane) return;
  const target = detailTarget();
  if (detailDraft && detailDraft.key !== target?.key) {
    if (applyDetailDraft()) return; // pendingChanged() redrew everything, the pane included
  }
  fillDetail(pane, target);
}

/** Edits typed in the pane, kept as the user types; applied with Apply, Ctrl/Cmd+Enter, or by moving on. */
let draftTarget: { target: DetailTarget; owner: typeof current } | undefined;

/** Applies the pane's unapplied edit, if any. Returns true when that changed the pending edits. */
function applyDetailDraft(): boolean {
  const draft = detailDraft;
  const owner = draftTarget;
  detailDraft = undefined;
  draftTarget = undefined;
  if (!draft || !owner || owner.owner !== current) return false;
  return setDetailValue(owner.target, draft.value);
}

/** Same rules as the cell editor: unchanged text is no edit (a NULL stays NULL unless something is typed). */
function setDetailValue(target: DetailTarget, value: Cell): boolean {
  if (value !== null && value === (target.value ?? '')) return false;
  if (value === null && target.value === null) return false;
  if (target.existingRow !== undefined) {
    const original = current?.results[0]?.rows[target.existingRow]?.[target.col];
    if (original === undefined) return false;
    setCell(pending, target.existingRow, target.col, value, original);
  } else if (target.insertIndex !== undefined) {
    setInsertedCell(pending, target.insertIndex, target.col, value);
  }
  pendingChanged();
  return true;
}

function fillDetail(pane: HTMLElement, target: DetailTarget | undefined): void {
  const head = el('div', 'detail-head');
  const close = button('✕', false, toggleDetail);
  close.classList.add('detail-close');
  close.title = 'Close (F4)';
  close.setAttribute('aria-label', 'Close details');
  if (!target) {
    head.append(el('span', 'detail-title', 'Value'), close);
    pane.replaceChildren(head, el('div', 'detail-empty', 'Select a cell to see its full value.'));
    return;
  }
  const value = target.value;
  const status =
    value === undefined ? 'DEFAULT' : value === null ? 'NULL' : value === '' ? 'empty string' : `${value.length.toLocaleString()} character${value.length === 1 ? '' : 's'}`;
  const type = current?.table && target.index === 0 ? current.table.types[target.name] : undefined;
  head.append(el('span', 'detail-title', target.name), close);
  const meta = el('div', 'detail-meta', [type, target.rowLabel, status].filter(Boolean).join(' · '));

  const json = typeof value === 'string' && isJsonContainer(value);
  const showJson = json && detail.mode === 'json';
  const modes = el('div', 'detail-modes');
  const mode = (label: string, which: 'json' | 'raw', enabled: boolean) => {
    const b = button(label, !enabled, () => {
      applyDetailDraft();
      detail = { ...detail, mode: which };
      saveState();
      updateDetail();
    });
    b.setAttribute('aria-pressed', String(enabled && (which === 'json' ? showJson : !showJson)));
    return b;
  };
  const copy = button('Copy', typeof value !== 'string', () => {
    if (typeof value === 'string') vscode.postMessage({ type: 'copyValue', text: value });
  });
  copy.title = 'Copy the value as stored (not indented)';
  modes.append(mode('JSON', 'json', json), mode('Raw', 'raw', true), copy);

  const body = el('div', 'detail-body');
  if (target.editable && !showJson) {
    const editor = el('textarea', 'detail-editor');
    editor.spellcheck = false;
    editor.value = detailDraft?.key === target.key ? detailDraft.value : (value ?? '');
    editor.placeholder = value === null ? 'NULL' : value === undefined ? 'DEFAULT' : '';
    editor.setAttribute('aria-label', `Edit ${target.name}`);
    editor.addEventListener('input', () => {
      detailDraft = { key: target.key, value: editor.value };
      draftTarget = { target, owner: current };
    });
    const apply = () => {
      const text = editor.value;
      detailDraft = undefined;
      draftTarget = undefined;
      if (!setDetailValue(target, text)) updateDetail();
    };
    const revert = () => {
      detailDraft = undefined;
      draftTarget = undefined;
      updateDetail();
    };
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation(); // the grid's and the panel's shortcuts don't apply while typing
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        apply();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        revert();
      }
    });
    const applyButton = button('Apply', false, apply);
    applyButton.classList.add('primary');
    applyButton.title = 'Keep as a pending change (Ctrl+Enter). Saved with Save….';
    const setNull = button('Set to NULL', value === null, () => {
      detailDraft = undefined;
      draftTarget = undefined;
      if (!setDetailValue(target, null)) updateDetail();
    });
    const format = button('Format JSON', false, () => {
      // Only on request: indenting changes the text that would be saved.
      if (!isJsonContainer(editor.value)) return;
      editor.value = indentJson(editor.value);
      detailDraft = { key: target.key, value: editor.value };
      draftTarget = { target, owner: current };
    });
    format.title = 'Indent the JSON in the editor (changes the saved text)';
    const actions = el('div', 'detail-actions');
    actions.append(applyButton, el('span', 'detail-hint', 'Ctrl+Enter'), button('Revert', false, revert), setNull, format);
    body.append(editor, actions);
  } else {
    if (value === undefined) body.append(el('div', 'detail-placeholder', 'DEFAULT — the database fills this in.'));
    else if (value === null) body.append(el('div', 'detail-placeholder null', 'NULL'));
    else body.append(el('pre', 'detail-value', showJson ? indentJson(value) : value));
    if (json && showJson && target.editable) body.append(el('div', 'detail-note', 'Switch to Raw to edit.'));
  }
  if (target.binary) body.append(el('div', 'detail-note', 'Binary column: the grid only has the shortened hex, so it can’t be edited here.'));
  pane.replaceChildren(head, meta, modes, body);
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
