// The Server panel, in a webview: status cards, the sessions with Cancel Query / End Session, and settings
// with a filter. Built from the shared form kit and tabs. Everything shown is database text: textContent only.
import type { ServerItem, ServerProcess } from '../types';
import type { ServerMessage, ServerRequest, ServerTab } from '../views/ServerPanel';
import { icon } from './icons';
import { button, el, header, inputControl, logo, note, switchRow, tabs as kitTabs, vscodeApi } from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<ServerRequest>();
const root = document.getElementById('root')!;
/** How often Auto-refresh reloads the sessions. */
const AUTO_MS = 5000;

type Init = Extract<ServerMessage, { type: 'init' }>;
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<ServerMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    ui?.stopAuto();
    ui = build(msg);
    return;
  }
  if (!ui) return;
  switch (msg.type) {
    case 'loading':
      ui.busy(msg.tab, true);
      break;
    case 'error':
      ui.busy(msg.tab, false);
      ui.bodies[msg.tab].replaceChildren(note('alert', msg.text, 'error'));
      break;
    case 'status':
      ui.busy('status', false);
      ui.bodies.status.replaceChildren(cards(msg.items));
      break;
    case 'settings':
      ui.busy('settings', false);
      ui.showSettings(msg.items);
      break;
    case 'processes':
      ui.busy('processes', false);
      ui.showProcesses(msg.items);
      break;
    case 'notice':
      ui.notice.replaceChildren(note(msg.tone === 'error' ? 'alert' : 'checkCircle', msg.text, msg.tone));
      break;
  }
});
vscode.postMessage({ type: 'ready' });

function build(init: Init) {
  const page = el('div', 'page');
  page.append(header(init.logo ? logo(init.logo) : icon('database'), init.title, init.detail));
  const tabs = kitTabs<ServerTab>('server', [
    { id: 'status', label: 'Status', icon: 'info' },
    { id: 'processes', label: 'Processes', icon: 'rows' },
    { id: 'settings', label: 'Settings', icon: 'structure' },
  ]);
  tabs.setHidden('processes', !init.processes);
  const bodies = {} as Record<ServerTab, HTMLElement>;
  const refreshers = {} as Record<ServerTab, HTMLButtonElement>;
  const toolbars = {} as Record<ServerTab, HTMLElement>;
  for (const tab of ['status', 'processes', 'settings'] as ServerTab[]) {
    const toolbar = el('div', 'tab-toolbar server-toolbar');
    const refresh = button('Refresh', 'spinner', () => vscode.postMessage({ type: 'refresh', tab }));
    toolbar.append(refresh);
    const body = el('div', 'server-body');
    body.append(note('spinner', 'Loading…'));
    tabs.panels[tab].append(toolbar, body);
    bodies[tab] = body;
    refreshers[tab] = refresh;
    toolbars[tab] = toolbar;
  }

  // Processes: Auto-refresh (off by default), and a line for Cancel / End results.
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopAuto = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const auto = switchRow('server-auto', 'Auto-refresh', 'Every 5 seconds', false, (on) => {
    stopAuto();
    if (on) timer = setInterval(() => vscode.postMessage({ type: 'refresh', tab: 'processes' }), AUTO_MS);
  });
  toolbars.processes.prepend(auto.row);
  const notice = el('div', 'server-notice');
  tabs.panels.processes.insertBefore(notice, bodies.processes);
  if (!init.canEnd && init.processes) {
    tabs.panels.processes.insertBefore(note('lock', 'Cancel Query and End Session are off: this connection is read-only.'), bodies.processes);
  }

  // Settings: filter by name, value or description, as you type.
  const filter = inputControl('server-filter', { placeholder: 'Filter settings', icon: 'search' });
  toolbars.settings.prepend(filter.control);
  let settings: ServerItem[] = [];
  const paintSettings = () => {
    const words = filter.input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = settings.filter((s) => words.every((w) => `${s.label} ${s.value} ${s.detail ?? ''}`.toLowerCase().includes(w)));
    tabs.counts.settings.textContent = String(settings.length);
    tabs.counts.settings.hidden = false;
    bodies.settings.replaceChildren(
      shown.length
        ? table(['Name', 'Value', 'Description'], shown.map((s) => [s.label, s.value, s.detail ?? '']), 'settings-table')
        : note('info', settings.length ? 'No setting matches the filter.' : 'No settings to show.'),
    );
  };
  filter.input.addEventListener('input', paintSettings);

  page.append(tabs.list, tabs.panels.status, tabs.panels.processes, tabs.panels.settings);
  root.replaceChildren(page);

  return {
    bodies,
    notice,
    stopAuto,
    busy(tab: ServerTab, on: boolean) {
      refreshers[tab].disabled = on;
      refreshers[tab].classList.toggle('busy', on);
    },
    showSettings(items: ServerItem[]) {
      settings = items;
      paintSettings();
    },
    showProcesses(items: ServerProcess[]) {
      tabs.counts.processes.textContent = String(items.length);
      tabs.counts.processes.hidden = false;
      bodies.processes.replaceChildren(items.length ? processTable(items, init.canEnd, init.canCancel) : note('info', 'No sessions.'));
    },
  };
}

function cards(items: ServerItem[]): HTMLElement {
  const grid = el('div', 'server-cards');
  for (const item of items) {
    const card = el('div', 'server-card');
    card.append(el('div', 'server-card-label', item.label), el('div', 'server-card-value', item.value));
    if (item.detail) card.append(el('div', 'server-card-detail', item.detail));
    card.title = [item.label, item.value, item.detail].filter(Boolean).join('\n');
    grid.append(card);
  }
  return grid;
}

function table(headers: string[], rows: string[][], className: string): HTMLElement {
  const wrap = el('div', 'preview-wrap');
  const t = el('table', `preview server-table ${className}`);
  const head = el('thead');
  const hr = el('tr');
  for (const h of headers) hr.append(el('th', undefined, h));
  head.append(hr);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const v of row) {
      const td = el('td', undefined, v);
      td.title = v;
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(head, body);
  wrap.append(t);
  return wrap;
}

function processTable(items: ServerProcess[], canEnd: boolean, canCancel: boolean): HTMLElement {
  const rows = items.map((p) => [p.id, p.user, p.database, p.client, p.state, p.seconds !== undefined ? duration(p.seconds) : '', p.query]);
  const wrap = table(['Id', 'User', 'Database', 'Client', 'State', 'Running', 'Query', ...(canEnd ? [''] : [])], rows, 'process-table');
  const trs = wrap.querySelectorAll('tbody tr');
  items.forEach((p, i) => {
    const tr = trs[i] as HTMLTableRowElement;
    if (p.own) {
      tr.classList.add('own');
      const badge = el('span', 'own-badge', 'DB Deck');
      badge.title = 'One of DB Deck’s own connections';
      tr.cells[0].append(' ', badge);
    }
    tr.cells[6].classList.add('query-cell');
    if (!canEnd) return;
    const actions = el('td', 'row-actions');
    const cancel = el('button', 'link-button', 'Cancel Query');
    cancel.type = 'button';
    cancel.disabled = !p.query;
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'end', id: p.id, how: 'cancel' }));
    const end = el('button', 'link-button danger-link', 'End Session');
    end.type = 'button';
    end.addEventListener('click', () => vscode.postMessage({ type: 'end', id: p.id, how: 'terminate' }));
    // SQL Server can't cancel another session's statement, only end the session (SERVER_TOOLS.cancelQuery).
    if (canCancel) actions.append(cancel);
    actions.append(end);
    tr.append(actions);
  });
  return wrap;
}

/** Same wording as the extension's formatDuration (forms don't import extension code at runtime). */
function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : m ? `${m}m ${Math.floor(seconds % 60)}s` : `${Math.floor(seconds)}s`;
}
