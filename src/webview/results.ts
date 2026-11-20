// Runs inside the Results webview (a browser context), bundled separately to dist/webview/results.js.
// Values are only ever inserted with textContent, never as HTML.
import type { StatementResult } from '../types';
import type { ResultsMessage } from '../views/ResultsPanel';
import './results.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

window.addEventListener('message', (event: MessageEvent<ResultsMessage>) => render(event.data));
vscode.postMessage({ type: 'ready' });

function render(msg: ResultsMessage): void {
  if (msg.type === 'loading') {
    root.className = '';
    root.replaceChildren(el('div', 'status', 'Running…'), el('pre', 'sql', msg.sql));
    return;
  }
  if (msg.results.length === 0) {
    root.className = '';
    root.replaceChildren(el('div', 'status', 'Nothing to run.'));
    return;
  }
  root.className = msg.results.length === 1 ? 'single' : '';
  root.replaceChildren(...msg.results.map(renderResult));
}

function renderResult(result: StatementResult, index: number): HTMLElement {
  const section = el('section', 'result');
  const header = el('header');
  header.append(el('span', 'index', `#${index + 1}`), el('span', result.error ? 'summary error-text' : 'summary', summary(result)));
  const sql = el('div', 'sql-line', result.sql.replace(/\s+/g, ' '));
  sql.title = result.sql;
  header.append(sql);
  section.append(header);

  if (result.error) {
    section.append(el('pre', 'error', result.error));
  } else if (result.columns.length) {
    section.append(renderTable(result));
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

function renderTable(result: StatementResult): HTMLElement {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const headRow = el('tr');
  headRow.append(el('th', 'rownum', '#'), ...result.columns.map((name) => el('th', undefined, name)));
  table.append(el('thead'));
  table.tHead!.append(headRow);

  const body = el('tbody');
  result.rows.forEach((row, i) => {
    const tr = el('tr');
    tr.append(el('td', 'rownum', String(i + 1)));
    for (const value of row) {
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
  });
  table.append(body);
  wrap.append(table);
  return wrap;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
