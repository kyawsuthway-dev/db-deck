// Run SQL File, in a webview. Built from the shared form kit, so it looks and works like the connection and
// dump forms. The extension re-reads and re-checks the file before running anything (RunScriptForm.ts).
import type { ScriptMessage, ScriptRequest } from '../views/RunScriptForm';
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
  showStatus,
  submitButton,
  vscodeApi,
} from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<ScriptRequest>();
const root = document.getElementById('root')!;

type Init = Extract<ScriptMessage, { type: 'init' }>;
type Analysis = Extract<ScriptMessage, { type: 'analysis' }>;

let chosen: string | undefined;
let analysis: Analysis | undefined;
let running = false;
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<ScriptMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      chosen = msg.selected;
      if (analysis && analysis.connectionId !== chosen) analysis = undefined;
      ui = build(msg);
      update();
      break;
    case 'analysis':
      if (msg.connectionId !== chosen) return;
      analysis = msg;
      update();
      break;
    case 'running':
      running = msg.running;
      update();
      break;
    case 'status': {
      if (!ui) return;
      const line = msg.line;
      showStatus(ui.status, msg.state, msg.text, ...(line ? [button('Show Line', 'file', () => vscode.postMessage({ type: 'showLine', line }))] : []));
      break;
    }
  }
});
vscode.postMessage({ type: 'ready' });

function build(msg: Init) {
  const form = formElement(() => run());
  const page = el('div', 'page');
  page.append(header(icon('play'), 'Run SQL File', msg.fileName));

  // The file.
  const fileSection = section('file', 'File');
  const line = el('div', 'value-line');
  line.title = msg.filePath;
  line.append(icon('file'), el('span', undefined, msg.filePath), el('span', 'value-detail', msg.size));
  fileSection.section.append(line);
  page.append(fileSection.section);

  // The connection.
  const connectionSection = section('connection', 'Run on');
  const connections = chips(
    connectionSection.titleId,
    msg.connections.map((c) => ({ value: c.id, label: c.name, title: c.detail, picture: logo(c.logo) })),
    (id) => {
      if (running || id === chosen) return;
      chosen = id;
      analysis = undefined;
      if (ui) clearStatus(ui.status);
      update();
      vscode.postMessage({ type: 'choose', connectionId: id });
    },
  );
  if (!msg.connections.length) connectionSection.section.append(el('p', 'hint', 'No connections yet. Add one in the Connections view first.'));
  connectionSection.section.append(connections.group);
  page.append(connectionSection.section);

  // What will happen.
  const notesSection = section('notes', 'Before you run it');
  const notes = el('div', 'notes');
  notesSection.section.append(notes);
  page.append(notesSection.section);

  const saveFile = button('Save File', 'save', () => vscode.postMessage({ type: 'save' }));
  const close = button('Close', 'close', () => vscode.postMessage(running ? { type: 'cancel' } : { type: 'close' }));
  const submit = submitButton('Run', 'play');
  const bar = actionBar(close, submit.button);
  form.append(page, bar.footer);
  root.replaceChildren(form);
  return { connections, notes, saveFile, close, submit, status: bar.status };
}

function update(): void {
  if (!ui) return;
  paintChoices(ui.connections.choices, chosen ?? '');
  for (const c of ui.connections.choices) c.button.disabled = running;
  // Without a choice, the first chip takes Tab focus.
  if (!chosen && ui.connections.choices[0]) ui.connections.choices[0].button.tabIndex = 0;

  if (!chosen) {
    ui.notes.replaceChildren(note('info', 'Choose the connection to run the file on.'));
  } else if (!analysis) {
    ui.notes.replaceChildren(note('spinner', 'Reading the file…'));
  } else {
    const count = analysis.statements;
    const parts = analysis.notes.map((n) => note(n.tone === 'info' ? 'info' : 'alert', n.text, n.tone));
    parts.unshift(note('rows', count === 1 ? 'The file has 1 statement.' : `The file has ${count.toLocaleString()} statements.`));
    if (analysis.dirty) parts.push(ui.saveFile);
    ui.notes.replaceChildren(...parts);
  }
  const count = analysis?.statements ?? 0;
  ui.submit.button.disabled = running || !analysis || analysis.blocked || count === 0;
  ui.submit.label.textContent = running ? 'Running…' : count ? `Run ${count.toLocaleString()} Statement${count === 1 ? '' : 's'}` : 'Run';
  ui.close.replaceChildren(icon('close'), el('span', undefined, running ? 'Cancel' : 'Close'));
}

function run(): void {
  if (!ui || running || !chosen || !analysis || analysis.blocked) return;
  clearStatus(ui.status);
  vscode.postMessage({ type: 'run', connectionId: chosen });
}
