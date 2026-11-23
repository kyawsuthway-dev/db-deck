// The Table Designer (New Table, Design Table), in a webview. Built from the shared form kit. The page only edits the design:
// the extension checks it and builds the SQL (TableDesignForm.ts), and checks it again before running it.
import type { ColumnDesign, DesignErrors, ForeignKeyDesign, TableDesign } from '../design/model';
import type { DesignMessage, DesignRequest } from '../views/TableDesignForm';
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
  selectControl,
  showStatus,
  submitButton,
  tabs as kitTabs,
  vscodeApi,
} from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<DesignRequest>();
const root = document.getElementById('root')!;

type Init = Extract<DesignMessage, { type: 'init' }>;
type DesignTab = 'columns' | 'indexes' | 'foreignKeys' | 'checks';
type Preview = Extract<DesignMessage, { type: 'preview' }>;

let init: Init | undefined;
let design: TableDesign;
/** Design Table: the table as read, to mark changes and for Reset / Undo. */
let original: TableDesign | undefined;
let preview: Preview | undefined;
let running = false;
let created = false;
let nextKey = 2;
const refColumns = new Map<string, string[]>();
/** Each column's last non-empty name (by key), so indexes and keys follow a rename even through an empty field. */
const lastNames = new Map<string, string>();
/** The referenced table's key per foreign key (index), to look up its columns. */
const fkTable: (string | undefined)[] = [];
/** Inputs by field path, to mark errors. */
const fields = new Map<string, HTMLElement>();
let ui: ReturnType<typeof build> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

window.addEventListener('message', (event: MessageEvent<DesignMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init = msg;
      design = structuredClone(msg.design);
      original = msg.mode === 'alter' ? structuredClone(msg.design) : undefined;
      created = false;
      fkTable.length = 0;
      for (const f of design.foreignKeys) fkTable.push(keyOfTable(f.refTable, f.refSchema));
      for (const k of fkTable) if (k && !refColumns.has(k)) vscode.postMessage({ type: 'refColumns', key: k });
      ui = build(msg);
      renderAll();
      break;
    case 'refColumns':
      refColumns.set(msg.key, msg.columns);
      renderForeignKeys();
      break;
    case 'preview':
      preview = msg;
      renderPreview();
      break;
    case 'running':
      running = msg.running;
      updateButtons();
      break;
    case 'status': {
      if (!ui) return;
      if (msg.created) {
        created = true;
        updateButtons();
      }
      const extra = msg.created
        ? [button('Show Rows', 'table', () => vscode.postMessage({ type: 'showRows' })), button('Design Table', 'structure', () => vscode.postMessage({ type: 'designTable' }))]
        : msg.reload
          ? [button('Reload', 'down', () => vscode.postMessage({ type: 'reload' }))]
          : [];
      showStatus(ui.status, msg.state, msg.text, ...extra);
      if (msg.state === 'error') showFirstError();
      break;
    }
  }
});
vscode.postMessage({ type: 'ready' });

function keyOfTable(name: string, schema?: string): string | undefined {
  return init?.tables.find((t) => t.name === name && (t.schema ?? '') === (schema ?? ''))?.key;
}

/** Tells the extension the design changed; it answers with the SQL and errors. */
function changed(structure = false): void {
  if (structure) renderAll();
  clearTimeout(timer);
  timer = setTimeout(() => vscode.postMessage({ type: 'change', design }), 200);
}

function build(msg: Init) {
  const form = formElement(() => create());
  const page = el('div', 'page');
  page.append(header(msg.logo ? logo(msg.logo) : icon('table'), msg.title, msg.detail));

  // Table name, schema, comment.
  const tableSection = section('table', 'Table');
  const tableFields = el('div', 'fields');
  const name = inputControl('t-name', { icon: 'table', placeholder: 'orders', value: design.name });
  // Renaming a table is Rename Table… in the tree; the designer changes what's inside it.
  name.input.disabled = msg.mode === 'alter';
  name.input.addEventListener('input', () => {
    design.name = name.input.value;
    changed();
  });
  fields.set('name', name.input);
  tableFields.append(fieldShell(name.input.id, 'Name', { span: msg.schemas.length ? 4 : 6, required: true }, name.control).field);
  if (msg.schemas.length) {
    const schema = selectControl('t-schema', msg.schemas.map((s) => ({ value: s, label: s })), 'structure', design.schema ?? msg.schemas[0]);
    design.schema = schema.select.value;
    schema.select.disabled = msg.mode === 'alter';
    schema.select.addEventListener('change', () => {
      design.schema = schema.select.value;
      changed();
    });
    tableFields.append(fieldShell(schema.select.id, 'Schema', { span: 2 }, schema.control).field);
  }
  if (msg.features.comments) {
    const comment = inputControl('t-comment', { icon: 'info', placeholder: 'Optional', value: design.comment });
    comment.input.addEventListener('input', () => {
      design.comment = comment.input.value;
      changed();
    });
    tableFields.append(fieldShell(comment.input.id, 'Comment', { span: 6 }, comment.control).field);
  }
  tableSection.section.append(tableFields);
  page.append(tableSection.section);

  // The lists: columns, indexes, foreign keys, checks.
  const types = el('datalist');
  types.id = 'types';
  for (const t of msg.features.types) {
    const o = el('option');
    o.value = t;
    types.append(o);
  }
  // Columns, indexes, foreign keys and checks each in a tab (like the connection form's tabs).
  const tabs = kitTabs<DesignTab>('design', [
    { id: 'columns', label: 'Columns', icon: 'table' },
    { id: 'indexes', label: 'Indexes', icon: 'search' },
    { id: 'foreignKeys', label: 'Foreign Keys', icon: 'link' },
    { id: 'checks', label: 'Checks', icon: 'check' },
  ]);
  page.append(tabs.list, tabs.panels.columns, tabs.panels.indexes, tabs.panels.foreignKeys, tabs.panels.checks);
  const listSection = (id: DesignTab, add: string, onAdd: () => void) => {
    const addButton = el('button', 'link-button', add);
    addButton.type = 'button';
    addButton.addEventListener('click', onAdd);
    const toolbar = el('div', 'tab-toolbar');
    toolbar.append(addButton);
    const body = el('div', 'design-list');
    tabs.panels[id].append(toolbar, body);
    return body;
  };
  const columns = listSection('columns', '+ Add Column', () => {
    design.columns.push({ key: `c${nextKey++}`, name: '', type: '', nullable: true, default: '', primaryKey: false, autoIncrement: false, comment: '' });
    changed(true);
    ui?.columns.querySelector<HTMLInputElement>('.design-row:last-child input')?.focus();
  });
  columns.parentElement!.append(types, el('p', 'hint', `Defaults are SQL expressions (0, 'text', now()). Auto-increment: ${msg.features.autoIncrement}.`));
  const indexes = listSection('indexes', '+ Add Index', () => {
    design.indexes.push({ name: '', columns: [], unique: false });
    changed(true);
  });
  const foreignKeys = listSection('foreignKeys', '+ Add Foreign Key', () => {
    design.foreignKeys.push({ name: '', columns: [], refTable: '', refColumns: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
    fkTable.push(undefined);
    changed(true);
  });
  const checks = listSection('checks', '+ Add Check', () => {
    design.checks.push({ name: '', expression: '' });
    changed(true);
  });

  // SQL.
  const copy = el('button', 'link-button', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => vscode.postMessage({ type: 'copySql' }));
  const sqlAside = el('span', 'section-aside');
  sqlAside.append(copy);
  const sqlSection = section('sql', 'SQL', sqlAside);
  const sql = el('pre', 'sql-preview');
  sqlSection.section.append(sql);
  page.append(sqlSection.section);

  const notesSection = section('notes', msg.mode === 'alter' ? 'Before you apply it' : 'Before you create it');
  const notes = el('div', 'notes');
  notesSection.section.append(notes);
  page.append(notesSection.section);

  const close = button('Close', 'close', () => vscode.postMessage({ type: 'close' }));
  const reset = button('Reset', 'up', () => {
    if (!original) return;
    design = structuredClone(original);
    fkTable.length = 0;
    for (const f of design.foreignKeys) fkTable.push(keyOfTable(f.refTable, f.refSchema));
    changed(true);
  });
  reset.hidden = msg.mode !== 'alter';
  const submit = submitButton(msg.mode === 'alter' ? 'Apply Changes' : 'Create Table', 'check');
  const bar = actionBar(close, reset, submit.button);
  form.append(page, bar.footer);
  root.replaceChildren(form);
  const removed = el('div', 'removed');
  columns.parentElement!.insertBefore(removed, columns.nextSibling);
  return { tabs, columns, removed, indexes, foreignKeys, checks, sql, notes, close, reset, submit, status: bar.status };
}

function renderAll(): void {
  renderColumns();
  renderIndexes();
  renderForeignKeys();
  renderChecks();
  markErrors();
  updateTabs();
}

/** Brings the tab with the first problem forward (after a refused Create / Apply). */
function showFirstError(): void {
  const first = Object.keys(preview?.errors ?? {})[0]?.split('.')[0];
  if (ui && first && (['columns', 'indexes', 'foreignKeys', 'checks'] as string[]).includes(first)) ui.tabs.select(first as DesignTab);
}

/** Each tab's count, and a red dot on tabs whose items have a problem. */
function updateTabs(): void {
  if (!ui) return;
  const sizes: Record<DesignTab, number> = {
    columns: design.columns.length,
    indexes: design.indexes.length,
    foreignKeys: design.foreignKeys.length,
    checks: design.checks.length,
  };
  const errors = Object.keys(preview?.errors ?? {});
  for (const id of Object.keys(sizes) as DesignTab[]) {
    ui.tabs.counts[id].textContent = String(sizes[id]);
    ui.tabs.counts[id].hidden = false;
    ui.tabs.errors[id].hidden = !errors.some((p) => p === id || p.startsWith(`${id}.`));
  }
}

/** A small text input bound to a field of an item. */
function textInput(path: string, value: string, placeholder: string, set: (v: string) => void, list?: string): HTMLInputElement {
  const input = el('input', 'input');
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', placeholder);
  if (list) input.setAttribute('list', list);
  input.addEventListener('input', () => {
    set(input.value);
    changed();
  });
  fields.set(path, input);
  return input;
}

function checkbox(path: string, checked: boolean, label: string, set: (v: boolean) => void): HTMLElement {
  const wrap = el('label', 'design-check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.setAttribute('aria-label', label);
  box.addEventListener('change', () => {
    set(box.checked);
    changed(true);
  });
  fields.set(path, box);
  wrap.append(box);
  return wrap;
}

function moveButtons<T>(items: T[], i: number): HTMLElement {
  const group = el('span', 'design-actions');
  const up = iconButton('Move up', 'up', () => {
    [items[i - 1], items[i]] = [items[i], items[i - 1]];
    changed(true);
  });
  up.disabled = i === 0;
  up.classList.add('up');
  const down = iconButton('Move down', 'down', () => {
    [items[i + 1], items[i]] = [items[i], items[i + 1]];
    changed(true);
  });
  down.disabled = i === items.length - 1;
  down.classList.add('down');
  group.append(up, down);
  return group;
}

function removeButton(onRemove: () => void, label: string): HTMLButtonElement {
  const b = iconButton(label, 'trash', () => {
    onRemove();
    changed(true);
  });
  b.classList.add('remove');
  return b;
}

function renderColumns(): void {
  if (!ui || !init) return;
  const comments = init.features.comments;
  const canMove = init.mode === 'create' || init.features.reorder !== 'none';
  const head = el('div', `design-row design-head${comments ? ' with-comment' : ''}`);
  for (const h of ['Name', 'Type', 'Null', 'PK', 'Auto', 'Default', ...(comments ? ['Comment'] : []), '']) head.append(el('span', undefined, h));
  const before = new Map((original?.columns ?? []).map((c) => [c.key, c]));
  const rows = design.columns.map((c: ColumnDesign, i) => {
    const was = before.get(c.key);
    const state = !original ? '' : !was ? ' new' : JSON.stringify({ ...was }) !== JSON.stringify({ ...c }) ? ' changed' : '';
    const row = el('div', `design-row${comments ? ' with-comment' : ''}${state}${c.generated ? ' generated' : ''}`);
    if (state) row.title = state.trim() === 'new' ? 'New column' : 'Changed';
    if (c.name.trim()) lastNames.set(c.key, c.name.trim());
    const nameInput = textInput(`columns.${i}.name`, c.name, 'Column name', (v) => {
      // A rename follows the column into indexes and foreign keys.
      c.name = v;
      const old = lastNames.get(c.key);
      const now = v.trim();
      if (!now) return;
      lastNames.set(c.key, now);
      if (old && old !== now) {
        for (const x of design.indexes) x.columns = x.columns.map((n) => (n === old ? now : n));
        for (const f of design.foreignKeys) f.columns = f.columns.map((n) => (n === old ? now : n));
        renderIndexes();
        renderForeignKeys();
      }
    });
    row.append(
      nameInput,
      textInput(`columns.${i}.type`, c.type, 'Type', (v) => (c.type = v), 'types'),
      checkbox(`columns.${i}.nullable`, c.nullable, 'Nullable', (v) => (c.nullable = v)),
      checkbox(`columns.${i}.primaryKey`, c.primaryKey, 'Primary key', (v) => {
        c.primaryKey = v;
        if (v) c.nullable = false;
      }),
      checkbox(`columns.${i}.autoIncrement`, c.autoIncrement, 'Auto-increment', (v) => (c.autoIncrement = v)),
      textInput(`columns.${i}.default`, c.default, 'Default', (v) => (c.default = v)),
    );
    if (comments) row.append(textInput(`columns.${i}.comment`, c.comment, 'Comment', (v) => (c.comment = v)));
    const actions = moveButtons(design.columns, i);
    if (!canMove) actions.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    actions.append(removeButton(() => design.columns.splice(i, 1), `Remove column ${c.name}`));
    row.append(actions);
    if (c.generated) {
      // Generated columns are shown, never changed.
      row.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((x) => (x.disabled = true));
      row.title = 'Generated column: shown for reference, not changed by the designer.';
    }
    return row;
  });
  const hint = init.mode === 'alter' && !canMove ? [el('p', 'hint', 'This database adds new columns at the end and can’t move existing ones.')] : [];
  ui.columns.replaceChildren(head, ...rows, ...hint);
  renderRemoved();
}

/** Columns of the original table that were removed, with Undo. */
function renderRemoved(): void {
  if (!ui) return;
  const kept = new Set(design.columns.map((c) => c.key));
  const gone = (original?.columns ?? []).filter((c) => !kept.has(c.key));
  if (!gone.length) {
    ui.removed.replaceChildren();
    return;
  }
  const items = gone.map((c) => {
    const item = el('span', 'removed-item');
    item.append(el('s', undefined, c.name));
    const undo = el('button', 'link-button', 'Undo');
    undo.type = 'button';
    undo.addEventListener('click', () => {
      const at = Math.min(original!.columns.findIndex((x) => x.key === c.key), design.columns.length);
      design.columns.splice(at, 0, structuredClone(c));
      changed(true);
    });
    item.append(undo);
    return item;
  });
  ui.removed.replaceChildren(el('span', 'hint', 'Removed:'), ...items);
}

/** Toggle buttons for this table's columns, in the order they were picked (index and FK column lists). */
function columnPicker(path: string, picked: string[], onChange: () => void): HTMLElement {
  const wrap = el('div', 'pills');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Columns');
  const names = design.columns.map((c) => c.name.trim()).filter(Boolean);
  for (const n of names) {
    const order = picked.indexOf(n);
    const b = el('button', `pill${order >= 0 ? ' on' : ''}`, order >= 0 && picked.length > 1 ? `${order + 1}. ${n}` : n);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(order >= 0));
    b.addEventListener('click', () => {
      const at = picked.indexOf(n);
      if (at >= 0) picked.splice(at, 1);
      else picked.push(n);
      onChange();
      changed(true);
    });
    wrap.append(b);
  }
  if (!names.length) wrap.append(el('span', 'hint', 'Add columns first.'));
  fields.set(path, wrap);
  return wrap;
}

function itemBox(...children: HTMLElement[]): HTMLElement {
  const box = el('div', 'design-item');
  box.append(...children);
  return box;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'design-field');
  wrap.append(el('span', 'field-label', text), control);
  return wrap;
}

function renderIndexes(): void {
  if (!ui) return;
  if (!design.indexes.length) {
    ui.indexes.replaceChildren(el('p', 'hint', 'No indexes. The primary key already has one.'));
    return;
  }
  ui.indexes.replaceChildren(
    ...design.indexes.map((x, i) => {
      const unique = el('label', 'design-check inline');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = x.unique;
      box.addEventListener('change', () => {
        x.unique = box.checked;
        changed();
      });
      unique.append(box, el('span', undefined, 'Unique'));
      const top = el('div', 'design-item-row');
      top.append(labelled('Name', textInput(`indexes.${i}.name`, x.name, 'Index name', (v) => (x.name = v))), unique, removeButton(() => design.indexes.splice(i, 1), 'Remove index'));
      return itemBox(top, labelled('Columns', columnPicker(`indexes.${i}.columns`, x.columns, () => undefined)));
    }),
  );
}

function selectOf(path: string, options: { value: string; label: string }[], value: string, set: (v: string) => void, label: string): HTMLSelectElement {
  const s = el('select', 'input select');
  s.setAttribute('aria-label', label);
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    s.append(opt);
  }
  s.value = value;
  s.addEventListener('change', () => {
    set(s.value);
    changed();
  });
  fields.set(path, s);
  return s;
}

function renderForeignKeys(): void {
  if (!ui || !init) return;
  if (!design.foreignKeys.length) {
    ui.foreignKeys.replaceChildren(el('p', 'hint', 'No foreign keys.'));
    return;
  }
  const actions = init.features.referentialActions.map((a) => ({ value: a, label: a }));
  ui.foreignKeys.replaceChildren(
    ...design.foreignKeys.map((f: ForeignKeyDesign, i) => {
      const top = el('div', 'design-item-row');
      top.append(labelled('Name', textInput(`foreignKeys.${i}.name`, f.name, 'Optional', (v) => (f.name = v))), removeButton(() => {
        design.foreignKeys.splice(i, 1);
        fkTable.splice(i, 1);
      }, 'Remove foreign key'));
      const tableKey = fkTable[i];
      const refTable = selectOf(
        `foreignKeys.${i}.refTable`,
        [{ value: '', label: 'Choose a table…' }, ...init!.tables.map((t) => ({ value: t.key, label: t.label }))],
        tableKey ?? '',
        (key) => {
          fkTable[i] = key || undefined;
          const t = init!.tables.find((x) => x.key === key);
          f.refTable = t?.name ?? '';
          f.refSchema = t?.schema;
          f.refColumns = [];
          if (key && !refColumns.has(key)) vscode.postMessage({ type: 'refColumns', key });
          renderForeignKeys();
        },
        'Referenced table',
      );
      const targets = tableKey ? refColumns.get(tableKey) : undefined;
      const refs = el('div', 'design-refs');
      f.columns.forEach((c, j) => {
        const pair = el('span', 'design-ref');
        pair.append(el('span', undefined, `${c} →`));
        if (targets) {
          pair.append(
            selectOf(`foreignKeys.${i}.refColumns`, [{ value: '', label: 'column…' }, ...targets.map((t) => ({ value: t, label: t }))], f.refColumns[j] ?? '', (v) => {
              f.refColumns[j] = v;
              f.refColumns = f.refColumns.slice(0, f.columns.length);
            }, `Referenced column for ${c}`),
          );
        } else {
          pair.append(el('span', 'hint', tableKey ? 'loading…' : 'choose a table'));
        }
        refs.append(pair);
      });
      const rules = el('div', 'design-item-row');
      rules.append(
        labelled('On delete', selectOf(`foreignKeys.${i}.onDelete`, actions, f.onDelete, (v) => (f.onDelete = v), 'On delete')),
        labelled('On update', selectOf(`foreignKeys.${i}.onUpdate`, actions, f.onUpdate, (v) => (f.onUpdate = v), 'On update')),
      );
      return itemBox(
        top,
        labelled('Columns', columnPicker(`foreignKeys.${i}.columns`, f.columns, () => (f.refColumns = f.refColumns.slice(0, f.columns.length)))),
        labelled('References', refTable),
        refs,
        rules,
      );
    }),
  );
  markErrors();
}

function renderChecks(): void {
  if (!ui) return;
  if (!design.checks.length) {
    ui.checks.replaceChildren(el('p', 'hint', 'No check constraints.'));
    return;
  }
  ui.checks.replaceChildren(
    ...design.checks.map((c, i) => {
      const row = el('div', 'design-item-row');
      row.append(
        labelled('Name', textInput(`checks.${i}.name`, c.name, 'Optional', (v) => (c.name = v))),
        labelled('Condition', textInput(`checks.${i}.expression`, c.expression, 'qty > 0', (v) => (c.expression = v))),
        removeButton(() => design.checks.splice(i, 1), 'Remove check'),
      );
      return itemBox(row);
    }),
  );
}

/** "Columns 2 · type" for `columns.1.type`. */
function describe(path: string): string {
  const [list, index, field] = path.split('.');
  const what: Record<string, string> = { columns: 'Column', indexes: 'Index', foreignKeys: 'Foreign key', checks: 'Check' };
  if (index === undefined) return list === 'name' ? 'Table name' : list === 'columns' ? 'Columns' : list;
  const item = list === 'columns' ? design.columns[+index]?.name.trim() : undefined;
  return `${what[list] ?? list} ${item ? `“${item}”` : +index + 1}${field ? ` · ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}` : ''}`;
}

function markErrors(): void {
  const errors: DesignErrors = preview?.errors ?? {};
  for (const [path, element] of fields) {
    if (!element.isConnected) {
      fields.delete(path);
      continue;
    }
    const message = errors[path];
    element.toggleAttribute('aria-invalid', !!message);
    element.title = message ?? '';
  }
}

function renderPreview(): void {
  if (!ui || !preview) return;
  const errors = Object.entries(preview.errors);
  ui.sql.textContent = preview.statements.length
    ? preview.statements.join('\n\n')
    : errors.length
      ? '-- Fix the problems below to see the SQL.'
      : '-- No changes yet.';
  const changeList = preview.changes.length ? [changesNote(preview.changes)] : [];
  const parts = [
    ...changeList,
    ...errors.map(([path, message]) => note('alert', `${describe(path)}: ${message}`, 'error')),
    ...preview.notes.map((n) => note(n.tone === 'info' ? 'info' : 'alert', n.text, n.tone)),
  ];
  ui.notes.replaceChildren(...parts);
  markErrors();
  updateTabs();
  updateButtons();
}

/** The list of changes (Design Table). */
function changesNote(changes: string[]): HTMLElement {
  const box = el('div', 'note info changes');
  box.append(icon('structure'));
  const list = el('ul');
  list.append(...changes.map((c) => el('li', undefined, c)));
  box.append(list);
  return box;
}

function updateButtons(): void {
  if (!ui || !init) return;
  const ok = !!preview && !Object.keys(preview.errors).length && preview.statements.length > 0;
  ui.submit.button.disabled = running || created || !ok;
  ui.reset.disabled = running;
  if (init.mode === 'alter') {
    const n = preview?.changes.length ?? 0;
    ui.submit.label.textContent = running ? 'Applying…' : n ? `Apply ${n} Change${n === 1 ? '' : 's'}` : 'Apply Changes';
  } else {
    ui.submit.label.textContent = running ? 'Creating…' : created ? 'Created' : 'Create Table';
  }
}

function create(): void {
  if (!ui || !init || ui.submit.button.disabled) return;
  clearStatus(ui.status);
  clearTimeout(timer);
  vscode.postMessage(init.mode === 'alter' ? { type: 'apply', design } : { type: 'create', design });
}
