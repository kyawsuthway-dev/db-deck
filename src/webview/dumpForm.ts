// Dump to SQL File, in a webview. Built from the shared form kit, so it looks and works like the connection
// form. Everything it sends is checked again by the extension (DumpForm.ts).
import type { DumpMessage, DumpObject, DumpRequest } from '../views/DumpForm';
import type { DumpContent } from '../transfer/dumpWriter';
import { icon } from './icons';
import {
  actionBar,
  button,
  clearStatus,
  el,
  fieldShell,
  formElement,
  header,
  iconButton,
  inputControl,
  logo,
  note,
  paintChoices,
  section,
  segmented,
  showStatus,
  submitButton,
  vscodeApi,
} from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<DumpRequest>();
const root = document.getElementById('root')!;

type Init = Extract<DumpMessage, { type: 'init' }>;

let content: DumpContent = 'all';
let filter = '';
let running = false;
const selected = new Set<string>();
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<DumpMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      selected.clear();
      for (const k of msg.selected) selected.add(k);
      ui = build(msg);
      update();
      break;
    case 'path':
      if (ui) ui.file.value = msg.path;
      break;
    case 'running':
      running = msg.running;
      update();
      break;
    case 'status':
      if (!ui) return;
      showStatus(ui.status, msg.state, msg.text, ...(msg.openFile ? [button('Open File', 'file', () => vscode.postMessage({ type: 'openFile' }))] : []));
      break;
  }
});
vscode.postMessage({ type: 'ready' });

function build(msg: Init) {
  const form = formElement(() => dump());
  const page = el('div', 'page');
  page.append(header(msg.logo ? logo(msg.logo) : icon('database'), msg.title, msg.detail));

  // What to include.
  const what = section('content');
  const fields = el('div', 'fields');
  const contents = segmented(
    'content',
    'Include',
    [
      { value: 'all', label: 'Structure and data', icon: 'database' },
      { value: 'structure', label: 'Structure only', icon: 'structure' },
      { value: 'data', label: 'Data only', icon: 'rows' },
    ],
    6,
    (value) => {
      content = value as DumpContent;
      update();
    },
  );
  fields.append(contents.field);
  what.section.append(fields);
  page.append(what.section);

  // Tables and views.
  const count = el('span');
  const all = el('button', 'link-button', 'All');
  all.type = 'button';
  all.addEventListener('click', () => setAll(true));
  const none = el('button', 'link-button', 'None');
  none.type = 'button';
  none.addEventListener('click', () => setAll(false));
  const aside = el('span', 'section-aside');
  aside.append(count, all, none);
  const objectsSection = section('objects', 'Tables and views', aside);
  const search = inputControl('filter', { icon: 'search', placeholder: 'Filter…' });
  search.input.setAttribute('aria-label', 'Filter tables and views');
  search.input.addEventListener('input', () => {
    filter = search.input.value.trim().toLowerCase();
    update();
  });
  const list = el('div', 'checklist');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-labelledby', objectsSection.titleId);
  const items = msg.objects.map((o) => checkItem(o));
  const empty = el('div', 'checklist-empty', msg.objects.length ? 'Nothing matches the filter.' : 'No tables or views.');
  list.append(...items.map((i) => i.row), empty);
  objectsSection.section.append(search.control, list);
  page.append(objectsSection.section);

  // File.
  const fileSection = section('file');
  const fileFields = el('div', 'fields');
  const file = inputControl('file', { icon: 'file', value: msg.file, placeholder: 'Full path of the .sql file' });
  file.control.append(iconButton('Browse…', 'folderOpen', () => vscode.postMessage({ type: 'browse', file: file.input.value })));
  fileFields.append(fieldShell(file.input.id, 'Save to', { span: 6, required: true }, file.control).field);
  fileSection.section.append(fileFields);
  page.append(fileSection.section);

  page.append(
    note(
      'info',
      'Not included: functions, procedures, triggers, users, permissions and server settings. Restore into an empty database with Run SQL File.',
    ),
  );

  const close = button('Close', 'close', () => vscode.postMessage(running ? { type: 'cancel' } : { type: 'close' }));
  const submit = submitButton('Dump', 'save');
  const bar = actionBar(close, submit.button);
  form.append(page, bar.footer);
  root.replaceChildren(form);
  return { contents, count, items, empty, file: file.input, close, submit, status: bar.status };
}

function checkItem(o: DumpObject) {
  const row = el('label', 'check-item');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = selected.has(o.key);
  box.addEventListener('change', () => {
    if (box.checked) selected.add(o.key);
    else selected.delete(o.key);
    update();
  });
  row.append(box, icon(o.kind === 'view' ? 'eye' : 'table'), el('span', 'item-name', o.label));
  if (o.kind === 'view') row.append(el('span', 'item-kind', 'view'));
  row.title = o.label;
  return { object: o, row, box };
}

/** Selects or clears every item that's shown (the filter applies) and can be dumped. */
function setAll(on: boolean): void {
  if (!ui) return;
  for (const item of ui.items) {
    if (item.row.hidden || item.box.disabled) continue;
    if (on) selected.add(item.object.key);
    else selected.delete(item.object.key);
  }
  update();
}

function usable(o: DumpObject): boolean {
  return o.kind === 'table' || content !== 'data';
}

function update(): void {
  if (!ui) return;
  paintChoices(ui.contents.choices, content);
  let shown = 0;
  for (const item of ui.items) {
    const can = usable(item.object);
    item.row.hidden = !!filter && !item.object.label.toLowerCase().includes(filter);
    item.box.disabled = !can || running;
    item.box.checked = selected.has(item.object.key) && can;
    item.row.classList.toggle('disabled', !can);
    item.row.title = can ? item.object.label : `${item.object.label}: views have no data to dump`;
    if (!item.row.hidden) shown++;
  }
  ui.empty.hidden = shown > 0;
  const chosen = ui.items.filter((i) => selected.has(i.object.key) && usable(i.object)).length;
  const total = ui.items.filter((i) => usable(i.object)).length;
  ui.count.textContent = `${chosen} of ${total} selected`;
  for (const c of ui.contents.choices) c.button.disabled = running;
  ui.file.disabled = running;
  ui.submit.button.disabled = running || chosen === 0;
  ui.submit.label.textContent = running ? 'Dumping…' : 'Dump';
  ui.close.replaceChildren(icon('close'), el('span', undefined, running ? 'Cancel' : 'Close'));
}

function dump(): void {
  if (!ui || running) return;
  clearStatus(ui.status);
  const keys = ui.items.filter((i) => selected.has(i.object.key) && usable(i.object)).map((i) => i.object.key);
  vscode.postMessage({ type: 'dump', content, keys, file: ui.file.value });
}
