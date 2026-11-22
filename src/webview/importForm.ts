// Import CSV, in a webview. Built from the shared form kit, like the other forms. The extension re-checks
// everything (ImportForm.ts) and re-reads the file while importing.
import type { ImportDelimiter, ImportMessage, ImportRequest } from '../views/ImportForm';
import { icon } from './icons';
import {
  actionBar,
  button,
  chips,
  clearStatus,
  el,
  formElement,
  header,
  logo,
  note,
  paintChoices,
  section,
  segmented,
  showStatus,
  submitButton,
  switchRow,
  vscodeApi,
} from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<ImportRequest>();
const root = document.getElementById('root')!;

type Init = Extract<ImportMessage, { type: 'init' }>;
type Summary = Extract<ImportMessage, { type: 'summary' }>;
type Column = Extract<ImportMessage, { type: 'columns' }>['columns'][number];

let init: Init | undefined;
let connectionId: string | undefined;
let tables: { key: string; label: string }[] = [];
let tableKey: string | undefined;
let columns: Column[] = [];
let existingRows = '0';
let summary: Summary | undefined;
let mapping: (string | null)[] = [];
let delimiter: ImportDelimiter = 'auto';
let headerRow = true;
let nullEmpty = true;
let deleteFirst = false;
let running = false;
let file: { name: string; path: string; size: string } | undefined;
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<ImportMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init = msg;
      connectionId = msg.connectionId;
      ui = build(msg);
      update();
      break;
    case 'tables':
      if (msg.connectionId !== connectionId) return;
      tables = msg.tables;
      tableKey = msg.tableKey;
      renderTables();
      update();
      break;
    case 'columns':
      columns = msg.columns;
      existingRows = msg.existingRows ?? '0';
      renderPreview();
      update();
      break;
    case 'file':
      file = msg;
      update();
      break;
    case 'summary':
      summary = msg;
      mapping = [...msg.mapping];
      renderPreview();
      update();
      break;
    case 'running':
      running = msg.running;
      update();
      break;
    case 'status': {
      if (!ui) return;
      if (!msg.text) {
        clearStatus(ui.status);
        return;
      }
      const line = msg.line;
      showStatus(ui.status, msg.state, msg.text, ...(line ? [button('Show Line', 'file', () => vscode.postMessage({ type: 'showLine', line }))] : []));
      break;
    }
  }
});
vscode.postMessage({ type: 'ready' });

function sendOptions(): void {
  vscode.postMessage({ type: 'options', delimiter, header: headerRow, nullEmpty });
}

function build(msg: Init) {
  const form = formElement(() => doImport());
  const page = el('div', 'page');
  page.append(header(icon('table'), 'Import CSV', msg.detail));

  // File.
  const fileSection = section('file', 'File');
  const fileLine = el('div', 'value-line');
  const fileName = el('span', undefined, 'No file chosen');
  const fileDetail = el('span', 'value-detail');
  fileLine.append(icon('file'), fileName, fileDetail);
  const choose = button('Choose File…', 'folderOpen', () => vscode.postMessage({ type: 'chooseFile' }));
  const fileRow = el('div', 'button-row');
  fileRow.append(choose);
  fileSection.section.append(fileLine, fileRow);
  page.append(fileSection.section);

  // Into: a fixed table, or connection chips and a table list.
  const intoSection = section('into', 'Into');
  let connections: ReturnType<typeof chips> | undefined;
  const tableSelect = el('select', 'input select');
  tableSelect.id = 'table';
  tableSelect.addEventListener('change', () => {
    tableKey = tableSelect.value || undefined;
    if (tableKey) vscode.postMessage({ type: 'chooseTable', key: tableKey });
    update();
  });
  if (msg.mode === 'table' && msg.target) {
    const line = el('div', 'value-line');
    line.append(logo(msg.target.logo), el('span', undefined, msg.target.label));
    intoSection.section.append(line);
  } else {
    connections = chips(
      intoSection.titleId,
      msg.connections.map((c) => ({ value: c.id, label: c.name, title: c.detail, picture: logo(c.logo) })),
      (id) => {
        if (running || id === connectionId) return;
        if (msg.connections.find((c) => c.id === id)?.readOnly) return;
        connectionId = id;
        tables = [];
        tableKey = undefined;
        columns = [];
        renderTables();
        update();
        vscode.postMessage({ type: 'chooseConnection', connectionId: id });
      },
    );
    for (const c of connections.choices) {
      if (msg.connections.find((x) => x.id === c.value)?.readOnly) {
        c.button.disabled = true;
        c.button.title = 'Read-only connection';
      }
    }
    const tableControl = el('div', 'control has-icon');
    tableControl.append(icon('table', 'leading'), tableSelect);
    const tableField = el('div', 'field');
    const label = el('label', 'field-label');
    label.htmlFor = tableSelect.id;
    label.append(el('span', 'label-text', 'Table'));
    tableField.append(label, tableControl);
    if (!msg.connections.length) intoSection.section.append(el('p', 'hint', 'No connections yet. Add one in the Connections view first.'));
    intoSection.section.append(connections.group, tableField);
  }
  page.append(intoSection.section);

  // Options.
  const optionsSection = section('options', 'Options');
  const fields = el('div', 'fields');
  const delimiters = segmented(
    'delimiter',
    'Delimiter',
    [
      { value: 'auto', label: 'Auto', icon: 'search' },
      { value: ',', label: 'Comma', icon: 'rows' },
      { value: ';', label: 'Semicolon', icon: 'rows' },
      { value: '\t', label: 'Tab', icon: 'rows' },
      { value: '|', label: 'Pipe', icon: 'rows' },
    ],
    6,
    (value) => {
      delimiter = value as ImportDelimiter;
      update();
      sendOptions();
    },
  );
  fields.append(delimiters.field);
  const headerSwitch = switchRow('header', 'First row is a header', 'Its names are matched to the table’s columns.', headerRow, (on) => {
    headerRow = on;
    sendOptions();
  });
  const nullSwitch = switchRow('nullEmpty', 'Empty fields are NULL', 'An empty unquoted field becomes NULL; a quoted "" stays an empty string (how DB Deck exports CSV).', nullEmpty, (on) => {
    nullEmpty = on;
    sendOptions();
  });
  const deleteSwitch = switchRow('deleteFirst', 'Delete existing rows first', 'Replace the table’s rows with the file’s, in the same transaction.', deleteFirst, (on) => {
    deleteFirst = on;
    update();
  });
  optionsSection.section.append(fields, headerSwitch.row, nullSwitch.row, deleteSwitch.row);
  page.append(optionsSection.section);

  // Columns: each CSV column with its target, then the first rows.
  const columnsSection = section('columns', 'Columns');
  const previewWrap = el('div', 'preview-wrap');
  columnsSection.section.append(previewWrap);
  page.append(columnsSection.section);

  // Notes.
  const notesSection = section('notes', 'Before you import it');
  const notes = el('div', 'notes');
  notesSection.section.append(notes);
  page.append(notesSection.section);

  const close = button('Close', 'close', () => vscode.postMessage(running ? { type: 'cancel' } : { type: 'close' }));
  const submit = submitButton('Import', 'save');
  const bar = actionBar(close, submit.button);
  form.append(page, bar.footer);
  root.replaceChildren(form);
  return { fileName, fileDetail, choose, connections, tableSelect, delimiters, headerSwitch, nullSwitch, deleteSwitch, previewWrap, notes, close, submit, status: bar.status };
}

function renderTables(): void {
  if (!ui) return;
  const placeholder = el('option', undefined, connectionId ? (tables.length ? 'Choose a table…' : 'No tables') : 'Choose a connection first');
  placeholder.value = '';
  const options = tables.map((t) => {
    const o = el('option', undefined, t.label);
    o.value = t.key;
    return o;
  });
  ui.tableSelect.replaceChildren(placeholder, ...options);
  ui.tableSelect.value = tableKey ?? '';
}

/** The preview table: CSV headers, a target dropdown per column, and the first rows. */
function renderPreview(): void {
  if (!ui) return;
  if (!summary || !summary.columns) {
    ui.previewWrap.replaceChildren(el('p', 'hint', file ? 'Reading the file…' : 'Choose a CSV file to see its columns.'));
    return;
  }
  const table = el('table', 'preview');
  const head = el('thead');
  const names = el('tr');
  const targets = el('tr', 'targets');
  for (let i = 0; i < summary.columns; i++) {
    names.append(el('th', undefined, summary.headers?.[i] ?? `Column ${i + 1}`));
    const cell = el('th');
    const select = el('select', 'input select mapping');
    select.setAttribute('aria-label', `Table column for ${summary.headers?.[i] ?? `column ${i + 1}`}`);
    const skip = el('option', undefined, 'Skip');
    skip.value = '';
    select.append(skip, ...columns.map((c) => {
      const o = el('option', undefined, `${c.name} (${c.type})${c.required ? ' *' : ''}`);
      o.value = c.name;
      return o;
    }));
    select.value = mapping[i] ?? '';
    select.disabled = running;
    select.addEventListener('change', () => {
      mapping[i] = select.value || null;
      update();
    });
    cell.append(select);
    targets.append(cell);
  }
  head.append(names, targets);
  const body = el('tbody');
  for (const row of summary.preview) {
    const tr = el('tr');
    for (let i = 0; i < summary.columns; i++) {
      const v = row[i] ?? null;
      const td = el('td', v === null ? 'null' : undefined, v === null ? 'NULL' : v);
      if (v !== null && v.length > 40) td.title = v;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  const more = summary.rows > summary.preview.length ? el('p', 'hint', `First ${summary.preview.length} of ${summary.rows.toLocaleString()} rows.`) : undefined;
  ui.previewWrap.replaceChildren(table, ...(more ? [more] : []));
}

function mappingProblems(): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const used = mapping.filter((m): m is string => !!m);
  if (summary && !used.length && columns.length) errors.push('Map at least one CSV column to a table column.');
  const seen = new Set<string>();
  for (const m of used) {
    if (seen.has(m)) errors.push(`Two CSV columns go into ${m}.`);
    seen.add(m);
  }
  for (const c of columns) if (c.required && !seen.has(c.name)) warnings.push(`${c.name} is required (NOT NULL, no default) but nothing is mapped to it.`);
  return { errors: [...new Set(errors)], warnings };
}

function update(): void {
  if (!ui || !init) return;
  ui.fileName.textContent = file ? file.name : 'No file chosen';
  ui.fileName.title = file?.path ?? '';
  ui.fileDetail.textContent = file ? `${file.size}${summary && !summary.problem ? ` · ${summary.rows.toLocaleString()} rows` : ''}` : '';
  if (ui.connections) {
    paintChoices(ui.connections.choices, connectionId ?? '');
    if (!connectionId) {
      const first = ui.connections.choices.find((c) => !c.button.disabled);
      if (first) first.button.tabIndex = 0;
    }
    for (const c of ui.connections.choices) if (running) c.button.disabled = true;
  }
  ui.tableSelect.disabled = running || !connectionId;
  paintChoices(ui.delimiters.choices, delimiter);
  for (const c of ui.delimiters.choices) c.button.disabled = running;
  ui.headerSwitch.input.disabled = ui.nullSwitch.input.disabled = ui.deleteSwitch.input.disabled = ui.choose.disabled = running;
  ui.previewWrap.querySelectorAll<HTMLSelectElement>('select.mapping').forEach((s) => (s.disabled = running));

  const parts: HTMLElement[] = [];
  const blocked: string[] = [];
  const hasTable = init.mode === 'table' || !!tableKey;
  if (!file) blocked.push('Choose a CSV file.');
  if (!hasTable) blocked.push(connectionId ? 'Choose the table to import into.' : 'Choose a connection and a table.');
  if (summary?.problem) parts.push(note('alert', summary.problem.message, 'error'));
  const check = mappingProblems();
  for (const e of check.errors) parts.push(note('alert', e, 'error'));
  for (const w of check.warnings) parts.push(note('alert', w, 'warning'));
  if (summary && !summary.problem) {
    parts.unshift(note('rows', `${summary.rows.toLocaleString()} row${summary.rows === 1 ? '' : 's'}, in one transaction: if any row fails, or you cancel, nothing is kept.`));
  }
  if (deleteFirst && hasTable) {
    parts.push(
      note(
        'alert',
        `Deletes the ${existingRows} existing row${existingRows === '1' ? '' : 's'} first, in the same transaction. Rows in other tables linked through ON DELETE CASCADE are deleted too.`,
        'warning',
      ),
    );
  }
  if (summary && !summary.problem) parts.push(note('info', 'Values are sent as text and the database converts them, so dates and numbers must be in formats it accepts.'));
  for (const b of blocked) parts.unshift(note('info', b));
  ui.notes.replaceChildren(...parts);

  const ready = !running && !!file && hasTable && !!summary && !summary.problem && summary.rows > 0 && !check.errors.length && columns.length > 0;
  ui.submit.button.disabled = !ready;
  const rows = summary?.rows.toLocaleString() ?? '';
  ui.submit.label.textContent = running
    ? 'Importing…'
    : !ready
      ? 'Import'
      : deleteFirst
        ? `Replace ${existingRows} Rows with ${rows}`
        : `Import ${rows} Row${summary?.rows === 1 ? '' : 's'}`;
  ui.close.replaceChildren(icon('close'), el('span', undefined, running ? 'Cancel' : 'Close'));
}

function doImport(): void {
  if (!ui || running || ui.submit.button.disabled) return;
  clearStatus(ui.status);
  vscode.postMessage({ type: 'import', mapping: [...mapping], deleteFirst });
}
