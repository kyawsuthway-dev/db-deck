// Compare Structure, in a webview: pick source and target, see the differences table by table, tick what to
// sync, link renames, read the SQL, Apply. Built from the shared form kit. The extension recomputes the
// differences and SQL from its own snapshot for every change and checks everything again before applying.
import type { CompareItem, TableCompare } from '../compare/compare';
import type { CompareMessage, CompareRequest, CompareSideName, CompareSidePick } from '../views/CompareForm';
import { icon, type IconName } from './icons';
import { actionBar, button, clearStatus, el, formElement, header, note, section, showStatus, submitButton, vscodeApi } from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<CompareRequest>();
const root = document.getElementById('root')!;

type Init = Extract<CompareMessage, { type: 'init' }>;
type Result = Extract<CompareMessage, { type: 'result' }>;
type Plan = Extract<CompareMessage, { type: 'plan' }>;

let init: Init | undefined;
const picks: Record<CompareSideName, CompareSidePick> = { source: { connectionId: '', schema: '' }, target: { connectionId: '', schema: '' } };
const schemaOptions: Record<CompareSideName, { value: string; label: string }[]> = { source: [], target: [] };
let result: Result | undefined;
let plan: Plan | undefined;
let running = false;
const expanded = new Set<string>();
let showSame = false;
let filter = '';
let ui: ReturnType<typeof build> | undefined;
let changeTimer: ReturnType<typeof setTimeout> | undefined;

window.addEventListener('message', (event: MessageEvent<CompareMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init = msg;
      picks.source = { ...msg.source };
      if (msg.target) picks.target = { ...msg.target };
      ui = build(msg);
      paintSides();
      paintResult();
      break;
    case 'schemas':
      picks[msg.side] = { connectionId: msg.connectionId, schema: msg.selected };
      schemaOptions[msg.side] = msg.schemas;
      paintSides();
      break;
    case 'result':
      result = msg;
      paintResult();
      break;
    case 'plan':
      plan = msg;
      paintPlan();
      paintResult();
      break;
    case 'running':
      running = msg.running;
      paintSides();
      paintPlan();
      break;
    case 'status': {
      if (!ui) return;
      const again = msg.compareAgain ? [button('Compare Again', 'spinner', () => compare())] : [];
      showStatus(ui.status, msg.state, msg.text, ...again);
      break;
    }
  }
});
vscode.postMessage({ type: 'ready' });

function select(id: string, label: string): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = el('label', 'compare-field');
  wrap.htmlFor = id;
  const s = el('select', 'select');
  s.id = id;
  wrap.append(el('span', 'field-label', label), s);
  return { wrap, select: s };
}

function build(msg: Init) {
  const form = formElement(() => apply());
  const page = el('div', 'page');
  page.append(header(icon('structure'), msg.title, msg.detail));

  // Source and target.
  const sides = section('sides', 'Compare');
  const grid = el('div', 'compare-sides');
  const make = (side: CompareSideName, title: string, iconName: IconName) => {
    const box = el('div', `compare-side ${side}`);
    const head = el('div', 'compare-side-title');
    head.append(icon(iconName), el('span', undefined, title));
    const connection = select(`${side}-connection`, 'Connection');
    const schema = select(`${side}-schema`, 'Schema');
    connection.select.addEventListener('change', () => {
      picks[side] = { connectionId: connection.select.value, schema: '' };
      schemaOptions[side] = [];
      paintSides();
      vscode.postMessage({ type: 'pick', side, connectionId: connection.select.value });
    });
    schema.select.addEventListener('change', () => {
      picks[side].schema = schema.select.value;
    });
    box.append(head, connection.wrap, schema.wrap);
    return { box, connection: connection.select, schema: schema.select };
  };
  const source = make('source', 'Source: what it should look like', 'database');
  const target = make('target', 'Target: what gets changed', 'database');
  const swap = el('button', 'icon-button compare-swap');
  swap.type = 'button';
  swap.title = 'Swap source and target';
  swap.setAttribute('aria-label', 'Swap source and target');
  swap.append(icon('tunnel'));
  swap.addEventListener('click', () => {
    [picks.source, picks.target] = [picks.target, picks.source];
    [schemaOptions.source, schemaOptions.target] = [schemaOptions.target, schemaOptions.source];
    paintSides();
  });
  grid.append(source.box, swap, target.box);
  const compareButton = button('Compare', 'search', () => compare());
  const row = el('div', 'button-row');
  row.append(compareButton);
  sides.section.append(grid, row);
  page.append(sides.section);

  // Differences.
  const filterInput = el('input', 'input');
  filterInput.type = 'search';
  filterInput.placeholder = 'Filter tables';
  filterInput.setAttribute('aria-label', 'Filter tables');
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    paintResult();
  });
  const diff = section('differences', 'Differences', filterInput);
  const summary = el('div', 'compare-summary');
  const list = el('div', 'checklist compare-list');
  diff.section.append(summary, list);
  page.append(diff.section);

  // SQL and notes.
  const copy = el('button', 'link-button', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => vscode.postMessage({ type: 'copySql' }));
  const open = el('button', 'link-button', 'Open in Editor');
  open.type = 'button';
  open.addEventListener('click', () => vscode.postMessage({ type: 'openEditor' }));
  const sqlActions = el('span', 'section-actions');
  sqlActions.append(copy, open);
  const sqlSection = section('sql', 'SQL', sqlActions);
  const sql = el('pre', 'sql-preview');
  sqlSection.section.append(sql);
  page.append(sqlSection.section);
  const notesSection = section('notes', 'Before you apply');
  const notes = el('div', 'notes');
  notesSection.section.append(notes);
  page.append(notesSection.section);

  const close = button('Close', 'close', () => vscode.postMessage(running ? { type: 'cancel' } : { type: 'close' }));
  const submit = submitButton('Apply', 'check');
  const bar = actionBar(close, submit.button);
  form.append(page, bar.footer);
  root.replaceChildren(form);
  void msg;
  return { source, target, swap, compareButton, summary, list, sql, copy, open, notes, close, submit, status: bar.status, sqlSection: sqlSection.section, notesSection: notesSection.section, diffSection: diff.section };
}

function paintSides(): void {
  if (!ui || !init) return;
  const connections = init.connections;
  const sourceType = connections.find((c) => c.id === picks.source.connectionId)?.type;
  for (const side of ['source', 'target'] as const) {
    const s = ui[side];
    const list = side === 'target' && sourceType ? connections.filter((c) => c.type === sourceType) : connections;
    s.connection.replaceChildren(...list.map((c) => new Option(`${c.name}${c.readOnly ? ' 🔒' : ''} · ${c.detail}`, c.id)));
    s.connection.value = picks[side].connectionId;
    const options = schemaOptions[side];
    s.schema.replaceChildren(...(options.length ? options.map((o) => new Option(o.label, o.value)) : [new Option('Loading…', '')]));
    s.schema.value = picks[side].schema;
    s.schema.disabled = running || !options.length || (options.length === 1 && options[0].value === '');
    s.connection.disabled = running;
  }
  const targetType = connections.find((c) => c.id === picks.target.connectionId)?.type;
  ui.swap.disabled = running || !schemaOptions.source.length || !schemaOptions.target.length;
  ui.compareButton.disabled = running || !schemaOptions.source.length || !schemaOptions.target.length || sourceType !== targetType;
}

function compare(): void {
  if (!ui || running) return;
  clearStatus(ui.status);
  vscode.postMessage({ type: 'compare', source: { ...picks.source }, target: { ...picks.target } });
}

const STATUS: Record<TableCompare['status'], { label: string; icon: IconName }> = {
  new: { label: 'New', icon: 'plus' },
  changed: { label: 'Changed', icon: 'structure' },
  onlyTarget: { label: 'Only in target', icon: 'trash' },
  same: { label: 'Same', icon: 'check' },
};

function sendChange(): void {
  if (!result) return;
  clearTimeout(changeTimer);
  const snapshot = { ticks: result.ticks, renames: result.renames };
  changeTimer = setTimeout(() => vscode.postMessage({ type: 'change', ticks: snapshot.ticks, renames: snapshot.renames }), 120);
}

function paintResult(): void {
  if (!ui) return;
  ui.diffSection.hidden = !result;
  ui.sqlSection.hidden = !result;
  ui.notesSection.hidden = !result;
  if (!result) return;
  const r = result;
  const counts = { new: 0, changed: 0, onlyTarget: 0, same: 0 };
  for (const t of r.tables) counts[t.status]++;
  ui.summary.replaceChildren(
    el('span', 'compare-direction', `${r.source}  →  ${r.target}`),
    el('span', 'hint', `${counts.new} new · ${counts.changed} changed · ${counts.onlyTarget} only in target · ${counts.same} same`),
  );
  const shown = r.tables.filter((t) => t.status !== 'same' && (!filter || t.name.toLowerCase().includes(filter)));
  const rows: HTMLElement[] = shown.map((t) => tableRow(t));
  const same = r.tables.filter((t) => t.status === 'same' && (!filter || t.name.toLowerCase().includes(filter)));
  if (same.length) {
    const toggle = el('button', 'check-item compare-same');
    toggle.type = 'button';
    toggle.append(icon(showSame ? 'down' : 'play'), el('span', 'item-name', `${same.length} table${same.length === 1 ? '' : 's'} the same`));
    toggle.addEventListener('click', () => {
      showSame = !showSame;
      paintResult();
    });
    rows.push(toggle);
    if (showSame) for (const t of same) rows.push(sameRow(t.name));
  }
  if (!rows.length) rows.push(el('div', 'checklist-empty', r.tables.length ? 'No table matches the filter.' : 'Neither side has tables.'));
  ui.list.replaceChildren(...rows);
}

function sameRow(name: string): HTMLElement {
  const row = el('div', 'check-item compare-child');
  row.append(icon('check'), el('span', 'item-name', name));
  return row;
}

function tableRow(t: TableCompare): HTMLElement {
  const r = result!;
  const ticks = new Set(r.ticks[t.name] ?? []);
  const blocked = new Set(plan?.blocked[t.name] ?? []);
  const wrap = el('div', `compare-table status-${t.status}`);
  const row = el('div', 'check-item compare-head');
  const box = el('input');
  box.type = 'checkbox';
  box.disabled = running;
  const on = t.items.filter((i) => ticks.has(i.id)).length;
  box.checked = on > 0 && on === t.items.length;
  box.indeterminate = on > 0 && on < t.items.length;
  box.setAttribute('aria-label', `Include ${t.name}`);
  box.addEventListener('change', () => {
    r.ticks[t.name] = box.checked ? t.items.map((i) => i.id) : [];
    sendChange();
    paintResult();
  });
  const status = STATUS[t.status];
  const badge = el('span', `compare-badge ${t.status}`);
  badge.append(icon(status.icon), el('span', undefined, status.label));
  const name = el('span', 'item-name', t.name);
  name.title = t.name;
  row.append(box, badge, name);
  const expandable = t.status === 'changed';
  if (expandable) {
    row.append(el('span', 'item-kind', `${on} of ${t.items.length}`));
    const toggle = el('button', 'plan-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(expanded.has(t.name)));
    toggle.setAttribute('aria-label', `Show the changes of ${t.name}`);
    toggle.append(icon(expanded.has(t.name) ? 'down' : 'play'));
    toggle.addEventListener('click', () => {
      if (expanded.has(t.name)) expanded.delete(t.name);
      else expanded.add(t.name);
      paintResult();
    });
    row.append(toggle);
  }
  wrap.append(row);
  if (expandable && expanded.has(t.name)) {
    if (t.addable.length && t.droppable.length + Object.keys(r.renames[t.name] ?? {}).length) wrap.append(renameRow(t));
    for (const item of t.items) wrap.append(itemRow(t, item, ticks, blocked));
  }
  return wrap;
}

/** "Rename instead": pair a column only the source has with one only the target has. */
function renameRow(t: TableCompare): HTMLElement {
  const r = result!;
  const links = r.renames[t.name] ?? {};
  const box = el('div', 'compare-renames');
  box.append(el('span', 'hint', 'Renamed columns? Pair them so the data is kept:'));
  const linkedTargets = new Set(Object.values(links));
  for (const added of t.addable) {
    const line = el('label', 'compare-rename');
    const sel = el('select', 'select');
    sel.disabled = running;
    sel.setAttribute('aria-label', `${added} was renamed from`);
    sel.append(new Option('— new column', ''));
    const choices = [...t.droppable, ...(links[added] ? [links[added]] : [])];
    for (const d of [...new Set(choices)]) if (!linkedTargets.has(d) || links[added] === d) sel.append(new Option(`renamed from ${d}`, d));
    sel.value = links[added] ?? '';
    sel.addEventListener('change', () => {
      const next = { ...(r.renames[t.name] ?? {}) };
      if (sel.value) next[added] = sel.value;
      else delete next[added];
      r.renames = { ...r.renames, [t.name]: next };
      sendChange();
    });
    line.append(el('span', 'compare-rename-name', added), sel);
    box.append(line);
  }
  return box;
}

function itemRow(t: TableCompare, item: CompareItem, ticks: Set<string>, blocked: Set<string>): HTMLElement {
  const r = result!;
  const row = el('label', `check-item compare-child${item.drop ? ' drop' : ''}${blocked.has(item.id) ? ' disabled' : ''}`);
  const box = el('input');
  box.type = 'checkbox';
  box.checked = ticks.has(item.id);
  box.disabled = running;
  box.addEventListener('change', () => {
    const set = new Set(r.ticks[t.name] ?? []);
    if (box.checked) set.add(item.id);
    else set.delete(item.id);
    r.ticks[t.name] = [...set];
    sendChange();
    paintResult();
  });
  const label = el('span', 'item-name', item.label);
  label.title = blocked.has(item.id) ? `${item.label} — left out: it needs a column you unticked` : item.label;
  row.append(box, label);
  if (item.drop) row.append(el('span', 'item-kind', 'loses data'));
  if (blocked.has(item.id)) row.append(el('span', 'item-kind', 'needs an unticked column'));
  return row;
}

function paintPlan(): void {
  if (!ui) return;
  const count = plan?.count ?? 0;
  ui.sql.textContent = plan?.statements.length ? plan.statements.join('\n\n') : '-- Nothing to change: tick the differences to sync.';
  ui.copy.disabled = !plan?.statements.length;
  ui.open.disabled = !plan?.statements.length;
  ui.notes.replaceChildren(...(plan?.notes ?? []).map((n) => note(n.tone === 'info' ? 'info' : 'alert', n.text, n.tone)));
  ui.submit.button.disabled = running || !plan?.canApply;
  ui.submit.label.textContent = running ? 'Working…' : count ? `Apply ${count.toLocaleString()} Change${count === 1 ? '' : 's'}` : 'Apply';
  ui.close.replaceChildren(icon('close'), el('span', undefined, running ? 'Cancel' : 'Close'));
}

function apply(): void {
  if (!ui || running || !plan?.canApply) return;
  clearStatus(ui.status);
  vscode.postMessage({ type: 'apply' });
}
