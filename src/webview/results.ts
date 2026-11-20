// Runs inside the Results webview (a browser context), bundled separately to dist/webview/results.js.
// Values are only ever inserted with textContent, never as HTML.
import type { Cell, SortKey, StatementResult } from '../types';
import type { ResultsMessage, ResultsRequest, TableViewState } from '../views/ResultsPanel';
import './results.css';

declare function acquireVsCodeApi(): { postMessage(message: ResultsRequest): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** In-memory sort of query results, per result index. Reset whenever new results arrive. */
let localSorts = new Map<number, SortKey>();
let current: Extract<ResultsMessage, { type: 'results' }> | undefined;

window.addEventListener('message', (event: MessageEvent<ResultsMessage>) => {
  localSorts = new Map();
  render(event.data);
});
vscode.postMessage({ type: 'ready' });

function render(msg: ResultsMessage): void {
  if (msg.type === 'loading') {
    current = undefined;
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
}

function renderResult(result: StatementResult, index: number, table: TableViewState | undefined): HTMLElement {
  const section = el('section', 'result');
  const header = el('header');
  header.append(el('span', 'index', `#${index + 1}`), el('span', result.error ? 'summary error-text' : 'summary', summary(result)));
  const sql = el('div', 'sql-line', result.sql.replace(/\s+/g, ' '));
  sql.title = result.sql;
  header.append(sql);
  section.append(header);
  if (table) section.append(renderPager(result, table));

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

/** Previous / Next for a table view. The total isn't known: the extension only knows whether another page exists. */
function renderPager(result: StatementResult, table: TableViewState): HTMLElement {
  const pager = el('nav', 'pager');
  pager.setAttribute('aria-label', 'Pages');
  const prev = button('Previous', table.offset === 0, () => requestPage(Math.max(0, table.offset - table.pageSize)));
  const next = button('Next', !table.hasMore, () => requestPage(table.offset + table.pageSize));
  const shown = result.rows.length;
  const range = el(
    'span',
    'range',
    shown ? `Rows ${(table.offset + 1).toLocaleString()}–${(table.offset + shown).toLocaleString()}` : table.offset ? 'No rows on this page' : 'No rows',
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
  return wrap;
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
