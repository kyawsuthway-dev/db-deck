// Generate Mock Data, in a webview. Built from the shared form kit, like the other forms. It sends only the row
// count, seed and per-column settings; the extension (MockForm.ts) checks them and makes every value itself,
// including the preview.
import type { GeneratorId, GeneratorMeta, MockOptions } from '../mock/plan';
import type { MockFormColumn, MockFormMessage, MockFormRequest } from '../views/MockForm';
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
  section,
  showStatus,
  submitButton,
  vscodeApi,
} from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<MockFormRequest>();
const root = document.getElementById('root')!;

type Init = Extract<MockFormMessage, { type: 'init' }>;
type Preview = Extract<MockFormMessage, { type: 'preview' }>;

interface ColumnState {
  column: MockFormColumn;
  generator: GeneratorId;
  /** Options per generator, so switching back keeps what was typed. */
  options: Partial<Record<GeneratorId, MockOptions>>;
  select: HTMLSelectElement;
  optionsBox: HTMLElement;
}

let init: Init | undefined;
let generators = new Map<GeneratorId, GeneratorMeta>();
let states: ColumnState[] = [];
let preview: Preview | undefined;
let token = 0;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<MockFormMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init = msg;
      generators = new Map(msg.generators.map((g) => [g.id, g]));
      preview = undefined;
      ui = build(msg);
      update();
      sendSettings(true);
      break;
    case 'preview':
      if (msg.token !== token) return;
      preview = msg;
      renderPreview();
      update();
      break;
    case 'running':
      running = msg.running;
      update();
      // Existing values changed: ask for a fresh preview.
      if (!running) sendSettings(true);
      break;
    case 'status': {
      if (!msg.text) {
        if (ui) clearStatus(ui.status);
        return;
      }
      if (!ui) {
        root.replaceChildren(note(msg.state === 'error' ? 'alert' : 'info', msg.text, msg.state === 'error' ? 'error' : 'info'));
        return;
      }
      const extra = msg.reload ? [button('Reload', 'refresh', () => vscode.postMessage({ type: 'reload' }))] : [];
      showStatus(ui.status, msg.state, msg.text, ...extra);
      break;
    }
  }
});
vscode.postMessage({ type: 'ready' });

function settings() {
  return { rows: ui?.rows.value.trim() ?? '', seed: ui?.seed.value.trim() ?? '', columns: states.map((s) => ({ generator: s.generator, options: { ...s.options[s.generator] } })) };
}

/** Asks the extension for a preview of the current settings; typing is debounced. */
function sendSettings(now = false): void {
  if (timer) clearTimeout(timer);
  const send = () => {
    timer = undefined;
    token++;
    vscode.postMessage({ type: 'settings', token, ...settings() });
  };
  if (now) send();
  else timer = setTimeout(send, 250);
  update();
}

function build(msg: Init) {
  const form = formElement(() => doInsert());
  const page = el('div', 'page');
  page.append(header(icon('rows'), 'Generate Mock Data', msg.detail));

  const into = section('into', 'Into');
  const line = el('div', 'value-line');
  line.append(logo(msg.target.logo), el('span', undefined, msg.target.label));
  into.section.append(line);
  if (msg.readOnly) into.section.append(note('lock', 'This connection is read-only, so DB Deck won’t insert into it.', 'warning'));
  page.append(into.section);

  // Rows and seed.
  const amount = section('amount', 'Rows');
  const fields = el('div', 'fields');
  const rows = inputControl('rows', { icon: 'rows', inputMode: 'numeric', value: msg.rows });
  const seed = inputControl('seed', { icon: 'hash', inputMode: 'numeric', value: msg.seed });
  // A new random seed; the extension checks it like any typed one.
  seed.control.append(
    iconButton('New seed', 'refresh', () => {
      seed.input.value = String(Math.floor(Math.random() * 1_000_000));
      sendSettings(true);
    }),
  );
  rows.input.addEventListener('input', () => sendSettings());
  seed.input.addEventListener('input', () => sendSettings());
  fields.append(
    fieldShell('rows', 'Rows to insert (1–10,000)', { span: 2, required: true }, rows.control).field,
    fieldShell('seed', 'Seed (same seed, same rows)', { span: 4 }, seed.control).field,
  );
  amount.section.append(fields);
  page.append(amount.section);

  // One row per column: name and type, badges, generator, its options.
  const cols = section('columns', 'Columns');
  const list = el('div', 'mock-list');
  states = msg.columns.map((c, i) => {
    const row = el('div', 'mock-row');
    const name = el('div', 'mock-name');
    name.append(el('span', 'mock-column', c.name), el('span', 'mock-type', c.type));
    const badges = el('div', 'mock-badges');
    for (const b of c.badges) badges.append(el('span', 'own-badge', b));
    name.append(badges);
    const select = el('select', 'input select mock-generator');
    select.id = `gen-${i}`;
    select.setAttribute('aria-label', `Generator for ${c.name}`);
    for (const id of c.allowed) {
      const o = el('option', undefined, generators.get(id)?.label ?? id);
      o.value = id;
      select.append(o);
    }
    select.value = c.setting.generator;
    const control = el('div', 'control');
    control.append(select);
    const optionsBox = el('div', 'mock-options');
    row.append(name, control, optionsBox);
    list.append(row);
    const state: ColumnState = { column: c, generator: c.setting.generator, options: { ...c.defaults, [c.setting.generator]: { ...c.setting.options } }, select, optionsBox };
    select.addEventListener('change', () => {
      const id = c.allowed.find((a) => a === select.value);
      if (!id) return;
      state.generator = id;
      renderOptions(state);
      sendSettings(true);
    });
    renderOptions(state);
    return state;
  });
  cols.section.append(list);
  page.append(cols.section);

  const previewSection = section('preview', 'Preview');
  const previewWrap = el('div', 'preview-wrap');
  previewWrap.append(el('p', 'hint', 'Making the first rows…'));
  previewSection.section.append(previewWrap);
  page.append(previewSection.section);

  const notesSection = section('notes', 'Before you insert');
  const notes = el('div', 'notes');
  notesSection.section.append(notes);
  page.append(notesSection.section);

  const close = button('Close', 'close', () => vscode.postMessage(running ? { type: 'cancel' } : { type: 'close' }));
  const submit = submitButton('Insert', 'save');
  const bar = actionBar(close, submit.button);
  form.append(page, bar.footer);
  root.replaceChildren(form);
  return { rows: rows.input, seed: seed.input, previewWrap, notes, close, submit, status: bar.status };
}

const OPTION_INPUTS: Record<string, { key: keyof MockOptions; label: string; type?: 'date'; placeholder?: string; wide?: boolean }[]> = {
  range: [
    { key: 'min', label: 'Min' },
    { key: 'max', label: 'Max' },
  ],
  places: [{ key: 'places', label: 'Places' }],
  length: [{ key: 'maxLength', label: 'Max length', placeholder: 'No limit' }],
  dates: [
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
  ],
  values: [{ key: 'values', label: 'Values', placeholder: 'a, b, c', wide: true }],
  value: [{ key: 'value', label: 'Value', placeholder: 'Text sent as is', wide: true }],
};

/** The inputs of a column's generator, filled from what was typed before or the defaults. */
function renderOptions(state: ColumnState): void {
  const meta = generators.get(state.generator);
  const options = (state.options[state.generator] ??= { ...state.column.defaults[state.generator] });
  const inputs: HTMLElement[] = [];
  for (const field of meta?.fields ?? []) {
    for (const spec of OPTION_INPUTS[field] ?? []) {
      const label = el('label', spec.wide ? 'mock-option wide' : 'mock-option');
      const input = el('input', 'input');
      input.type = spec.type ?? 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.value = options[spec.key] ?? '';
      if (spec.placeholder) input.placeholder = spec.placeholder;
      input.setAttribute('aria-label', `${spec.label} for ${state.column.name}`);
      input.addEventListener('input', () => {
        options[spec.key] = input.value;
        sendSettings();
      });
      label.append(el('span', 'mock-option-label', spec.label), input);
      inputs.push(label);
    }
  }
  if (!inputs.length) inputs.push(el('span', 'hint', hintFor(state)));
  state.optionsBox.replaceChildren(...inputs);
}

function hintFor(state: ColumnState): string {
  switch (state.generator) {
    case 'skip':
      return state.column.badges.includes('generated') ? 'Computed by the database.' : 'Left to the database (default, auto-increment or NULL).';
    case 'foreignKey':
      return 'A key of an existing parent row.';
    case 'null':
      return 'Always NULL.';
    default:
      return '';
  }
}

function renderPreview(): void {
  if (!ui) return;
  const p = preview;
  if (!p || !p.columns.length) {
    ui.previewWrap.replaceChildren(el('p', 'hint', p?.errors.length ? 'Fix the settings to see the first rows.' : 'Making the first rows…'));
    return;
  }
  const table = el('table', 'preview');
  const head = el('thead');
  const names = el('tr');
  for (const c of p.columns) names.append(el('th', undefined, c));
  head.append(names);
  const body = el('tbody');
  for (const row of p.rows) {
    const tr = el('tr');
    row.forEach((v) => {
      const td = el('td', v === null ? 'null' : undefined, v === null ? 'NULL' : v);
      if (v !== null && v.length > 30) td.title = v;
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(head, body);
  const more = p.total > p.rows.length ? el('p', 'hint', `First ${p.rows.length} of ${p.total.toLocaleString()} rows, exactly as they’ll be inserted.`) : undefined;
  ui.previewWrap.replaceChildren(table, ...(more ? [more] : []));
}

/** True while the shown preview is for the current settings (no change waiting to be sent or answered). */
const current = () => !!preview && preview.token === token && !timer;

function update(): void {
  if (!ui || !init) return;
  ui.rows.disabled = ui.seed.disabled = running;
  for (const s of states) {
    s.select.disabled = running || s.column.allowed.length < 2;
    s.optionsBox.querySelectorAll('input').forEach((i) => (i.disabled = running));
  }
  const parts: HTMLElement[] = [];
  const p = preview;
  if (p) {
    for (const e of p.errors) parts.push(note('alert', e, 'error'));
    if (!p.errors.length) parts.push(note('rows', `${p.total.toLocaleString()} row${p.total === 1 ? '' : 's'}, in one transaction: if any row fails, or you cancel, nothing is kept.`));
    for (const n of p.notes) parts.push(note(n.tone === 'info' ? 'info' : 'alert', n.text, n.tone));
    if (!p.errors.length) parts.push(note('info', 'Values are sent as text and the database converts them.'));
  }
  ui.notes.replaceChildren(...parts);
  const ready = !running && !init.readOnly && current() && !!p && !p.errors.length && p.columns.length > 0;
  ui.submit.button.disabled = !ready;
  ui.submit.label.textContent = running ? 'Inserting…' : ready && p ? `Insert ${p.total.toLocaleString()} Row${p.total === 1 ? '' : 's'}` : 'Insert';
  ui.close.replaceChildren(icon('close'), el('span', undefined, running ? 'Cancel' : 'Close'));
}

function doInsert(): void {
  if (!ui || running || ui.submit.button.disabled) return;
  clearStatus(ui.status);
  vscode.postMessage({ type: 'insert', ...settings() });
}
