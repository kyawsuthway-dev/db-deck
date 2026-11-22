// Truncate / Drop, in a webview: what will happen, the SQL, and the name typed to confirm. Built from the
// shared form kit. The extension compares the typed name again before running anything (DangerForm.ts).
import type { DangerMessage, DangerRequest } from '../views/DangerForm';
import { icon } from './icons';
import { actionBar, button, el, fieldShell, formElement, header, inputControl, note, section, showStatus, submitButton, vscodeApi } from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<DangerRequest>();
const root = document.getElementById('root')!;

type Init = Extract<DangerMessage, { type: 'init' }>;

let init: Init | undefined;
let running = false;
let done = false;
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<DangerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init = msg;
      ui = build(msg);
      update();
      ui.confirm.focus();
      break;
    case 'running':
      running = msg.running;
      update();
      break;
    case 'status':
      if (!ui) return;
      if (msg.done) done = true;
      showStatus(ui.status, msg.state, msg.text);
      update();
      break;
  }
});
vscode.postMessage({ type: 'ready' });

function build(msg: Init) {
  const form = formElement(() => run());
  const page = el('div', 'page');
  const head = header(icon('warning'), msg.title, msg.detail);
  head.querySelector('.badge')?.classList.add('danger');
  page.append(head);

  const what = section('what', 'What will happen');
  const notes = el('div', 'notes');
  notes.append(...msg.notes.map((n) => note(n.tone === 'info' ? 'info' : 'alert', n.text, n.tone)));
  what.section.append(notes);
  page.append(what.section);

  const sqlSection = section('sql', 'SQL');
  sqlSection.section.append(el('pre', 'sql-preview', msg.sql || '-- Not available.'));
  page.append(sqlSection.section);

  const confirmSection = section('confirm', 'Confirm');
  const fields = el('div', 'fields');
  const confirm = inputControl('confirm', { icon: 'warning', placeholder: msg.confirmName });
  confirm.input.addEventListener('input', update);
  const field = fieldShell(confirm.input.id, `Type ${msg.confirmName} to confirm`, { span: 6, required: true }, confirm.control);
  fields.append(field.field);
  confirmSection.section.append(fields);
  page.append(confirmSection.section);

  const close = button('Close', 'close', () => vscode.postMessage({ type: 'close' }));
  const submit = submitButton(msg.button, 'trash');
  submit.button.className = 'button danger';
  const bar = actionBar(close, submit.button);
  form.append(page, bar.footer);
  root.replaceChildren(form);
  return { confirm: confirm.input, close, submit, status: bar.status };
}

function update(): void {
  if (!ui || !init) return;
  const matches = ui.confirm.value === init.confirmName;
  ui.submit.button.disabled = running || done || !matches || !init.sql;
  ui.confirm.disabled = running || done;
  ui.submit.label.textContent = running ? 'Working…' : done ? 'Done' : init.button;
}

function run(): void {
  if (!ui || ui.submit.button.disabled) return;
  vscode.postMessage({ type: 'run', typed: ui.confirm.value });
}
