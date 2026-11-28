// The Add / Edit Connection form, in a webview. Plain DOM, values inserted with textContent only (webview.md).
// It never sees a stored password. Everything it sends is checked again by the extension (ConnectionForm.ts).
import type { FieldErrors, FormValues, KindInfo } from '../connectionForm/fields';
import type { FormMessage, FormRequest, PathTarget } from '../views/ConnectionForm';
import { parseConnectionString } from '../shared/connectionString';
import { icon, type IconName } from './icons';
import {
  actionBar,
  button,
  chips,
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
  selectControl,
  showStatus as renderStatus,
  submitButton,
  switchRow,
  tabs as kitTabs,
  vscodeApi,
  type Span,
  type StatusState,
} from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<FormRequest>();
const root = document.getElementById('root')!;

type Tab = 'main' | 'ssh' | 'options';
type Init = Extract<FormMessage, { type: 'init' }>;

const SSL_OPTIONS = [
  { value: 'off', label: 'No SSL' },
  { value: 'require', label: 'SSL, verify the certificate' },
  { value: 'no-verify', label: 'SSL, allow self-signed' },
];
/** Every sign-in method; each kind offers some of them (KindInfo.signIns). */
const SIGN_IN_OPTIONS = [
  { value: 'password', label: 'User and password' },
  { value: 'entra-account', label: 'Microsoft Entra ID (VS Code account)' },
  { value: 'entra-default', label: 'Microsoft Entra ID (Azure CLI, environment, managed identity)' },
];
const READ_ONLY_NOTE =
  'The database session is read-only and table editing is off. A guard against mistakes, not a security boundary: for a real guarantee, connect as a user that can’t write.';
/** Which tab shows each field, so an error can bring its tab forward. */
const FIELD_TAB: Partial<Record<keyof FormValues, Tab>> = {
  sshEnabled: 'ssh',
  sshHost: 'ssh',
  sshPort: 'ssh',
  sshUser: 'ssh',
  sshAuth: 'ssh',
  sshKeyPath: 'ssh',
  sshSecret: 'ssh',
  readOnly: 'options',
};

let init: Init | undefined;
let values: FormValues;
let busy = false;
const inputs = new Map<keyof FormValues, HTMLInputElement | HTMLSelectElement>();
const errorSpans = new Map<keyof FormValues, HTMLElement>();
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<FormMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init = msg;
      values = { ...msg.values };
      ui = build(msg);
      update();
      ui.focusFirst();
      break;
    case 'fieldErrors':
      showErrors(msg.errors);
      break;
    case 'status':
      busy = msg.state === 'busy';
      showStatus(msg.state, msg.text, msg.saveAnyway, msg.trustCertificate);
      update();
      break;
    case 'path':
      setPath(msg.target, msg.path);
      break;
    case 'workspace':
      if (init) init.hasWorkspace = msg.hasWorkspace;
      update();
      break;
  }
});
vscode.postMessage({ type: 'ready' });

function kind(): KindInfo {
  return init!.kinds.find((k) => k.label === values.kind) ?? init!.kinds[0];
}

function build(msg: Init) {
  inputs.clear();
  errorSpans.clear();
  const form = formElement(() => send('save'));
  const page = el('div', 'page');
  page.append(
    header(
      icon('database'),
      msg.mode === 'edit' ? 'Edit Connection' : 'Add Connection',
      msg.mode === 'edit' ? msg.values.name : 'Connect to a SQLite file or a database server.',
    ),
  );

  // Database type: compact chips (logo + name) that wrap as more databases are added.
  const typeSection = section('type', 'Database');
  const types = chips(
    typeSection.titleId,
    msg.kinds.map((k) => ({
      value: k.label,
      label: k.label,
      title: k.database === 'none' ? `${k.label} · local file` : `${k.label} · server${k.defaultPort ? `, port ${k.defaultPort}` : ''}`,
      picture: logo(msg.logos[k.logo]),
    })),
    (label) => {
      const k = msg.kinds.find((x) => x.label === label);
      if (k) changeKind(k);
    },
  );
  typeSection.section.append(types.group, errorSpan('kind'));
  page.append(typeSection.section);

  // Name and folder.
  const general = el('section', 'section');
  const generalFields = el('div', 'fields');
  const name = textField('name', 'Name', { icon: 'database', placeholder: 'Suggested from user, host and database', span: 3 });
  const folder = textField('folder', 'Folder', { icon: 'folder', placeholder: 'None', span: 3 });
  const list = el('datalist');
  list.id = 'folders';
  for (const f of msg.folders) {
    const option = el('option');
    option.value = f;
    list.append(option);
  }
  folder.input.setAttribute('list', list.id);
  const scope = segmentedField(
    'scope',
    'Available in',
    [
      { value: 'global', label: 'All workspaces', icon: 'globe' },
      { value: 'workspace', label: 'This workspace', icon: 'folder' },
    ],
    6,
  );
  const scopeHint = el('span', 'hint');
  scope.field.append(scopeHint);
  generalFields.append(name.field, folder.field, scope.field, list);
  general.append(generalFields);
  page.append(general);

  // Tabs.
  const tabs = kitTabs<Tab>('conn', [
    { id: 'main', label: 'Connection', icon: 'plug' },
    { id: 'ssh', label: 'SSH Tunnel', icon: 'tunnel' },
    { id: 'options', label: 'Options', icon: 'shield' },
  ]);
  page.append(tabs.list, tabs.panels.main, tabs.panels.ssh, tabs.panels.options);

  // Connection: SQLite file, or server settings.
  const sqlite = el('div', 'fields');
  const file = textField('filePath', 'Database file', { icon: 'fileDb', required: true, placeholder: 'Full path of the SQLite file', span: 6 });
  const fileButtons = el('div', 'button-row span-6');
  fileButtons.append(button('Browse…', 'folderOpen', () => browse('sqliteOpen')), button('Create New…', 'plus', () => browse('sqliteCreate')));
  sqlite.append(file.field, fileButtons);

  const server = el('div', 'fields');
  const url = el('input', 'input');
  url.type = 'text';
  url.id = 'connection-string';
  url.spellcheck = false;
  url.autocomplete = 'off';
  const urlField = el('div', 'field span-6');
  const urlLabel = el('label', 'field-label');
  urlLabel.htmlFor = url.id;
  urlLabel.append(el('span', 'label-text', 'Connection string'), el('span', 'optional', 'optional'));
  const urlControl = el('div', 'control has-icon');
  urlControl.append(icon('link', 'leading'), url);
  const urlHint = el('span', 'hint', 'Paste a URL to fill in the fields below.');
  urlField.append(urlLabel, urlControl, urlHint);
  url.addEventListener('input', () => applyConnectionString(url, urlHint));
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyConnectionString(url, urlHint, true);
    }
  });
  const divider = el('div', 'divider span-6');
  const host = textField('host', 'Host', { icon: 'globe', required: true, span: 4 });
  const port = textField('port', 'Port', { icon: 'hash', required: true, inputMode: 'numeric', span: 2 });
  const instance = textField('instance', 'Instance', { icon: 'database', placeholder: 'Optional — like SQLEXPRESS', span: 3 });
  // The port is found through SQL Browser while an instance is set.
  instance.input.addEventListener('input', () => update());
  const signIn = selectField('signIn', 'Sign in with', SIGN_IN_OPTIONS, { icon: 'user', span: 3 });
  const user = textField('user', 'User', { icon: 'user', required: true, span: 3 });
  const password = textField('password', 'Password', { icon: 'key', type: 'password', span: 3 });
  const database = textField('database', 'Database', { icon: 'database', span: 3 });
  const ssl = selectField('ssl', 'Encryption', SSL_OPTIONS, { icon: 'lock', span: 3 });
  const tunnelNote = note('tunnel', 'SSH tunnel on: enter the host and port as seen from the SSH host (often localhost).');
  tunnelNote.classList.add('span-6');
  server.append(urlField, divider, host.field, port.field, instance.field, signIn.field, user.field, password.field, database.field, ssl.field, tunnelNote);
  tabs.panels.main.append(sqlite, server);

  // SSH tunnel.
  const sshToggle = switchField('sshEnabled', 'Connect through an SSH tunnel', 'One SSH session per connection, no local port opened. The first time, DB Deck asks you to trust the SSH host’s key.');
  const sshFields = el('fieldset', 'fields');
  sshFields.append(el('legend', 'visually-hidden', 'SSH settings'));
  const sshHost = textField('sshHost', 'SSH host', { icon: 'globe', required: true, span: 4 });
  const sshPort = textField('sshPort', 'Port', { icon: 'hash', required: true, inputMode: 'numeric', span: 2 });
  const sshUser = textField('sshUser', 'SSH user', { icon: 'user', required: true, span: 3 });
  const auth = segmentedField(
    'sshAuth',
    'Log in with',
    [
      { value: 'password', label: 'Password', icon: 'lock' },
      { value: 'key', label: 'Key file', icon: 'key' },
    ],
    3,
  );
  const keyPath = textField('sshKeyPath', 'Private key file', { icon: 'key', required: true, placeholder: '~/.ssh/id_ed25519', span: 6 });
  keyPath.control.append(iconButton('Browse…', 'folderOpen', () => browse('sshKey')));
  const secret = textField('sshSecret', 'SSH password', { icon: 'lock', type: 'password', span: 6 });
  sshFields.append(sshHost.field, sshPort.field, sshUser.field, auth.field, keyPath.field, secret.field);
  tabs.panels.ssh.append(sshToggle.row, sshFields);

  // Options.
  const readOnly = switchField('readOnly', 'Read-only connection', READ_ONLY_NOTE);
  tabs.panels.options.append(readOnly.row);

  // Action bar.
  const test = button('Test Connection', 'plug', () => send('test'));
  const close = button('Cancel', 'close', () => vscode.postMessage({ type: 'close' }));
  const { button: save, label: saveLabel } = submitButton('Save', 'check');
  const { footer, status } = actionBar(test, close, save);

  form.append(page, footer);
  root.replaceChildren(form);
  return {
    types,
    tabs,
    sqlite,
    server,
    tunnelNote,
    sshFields,
    keyPath,
    secret,
    password,
    database,
    instance,
    signIn,
    user,
    port,
    readOnly,
    auth,
    scope,
    scopeHint,
    save,
    saveLabel,
    test,
    status,
    url,
    focusFirst: () => (msg.mode === 'edit' ? name.input : types.choices.find((c) => c.value === values.kind)?.button ?? name.input).focus(),
  };
}

interface FieldOptions {
  icon: IconName;
  span: Span;
  type?: 'text' | 'password';
  required?: boolean;
  placeholder?: string;
  inputMode?: 'numeric';
}

/** A text field bound to `values[key]`, with its error span. */
function textField(key: keyof FormValues, label: string, opts: FieldOptions) {
  const { control, input } = inputControl(`f-${key}`, { ...opts, value: String(values[key] ?? '') });
  input.addEventListener('input', () => {
    (values as unknown as Record<string, unknown>)[key] = input.value;
    clearError(key);
  });
  inputs.set(key, input);
  return { ...fieldShell(input.id, label, opts, control, errorSpan(key)), input, control };
}

function selectField(key: keyof FormValues, label: string, options: { value: string; label: string }[], opts: Pick<FieldOptions, 'icon' | 'span'>) {
  const { control, select } = selectControl(`f-${key}`, options, opts.icon, String(values[key]));
  select.addEventListener('change', () => {
    (values as unknown as Record<string, unknown>)[key] = select.value;
    clearError(key);
    update();
  });
  inputs.set(key, select);
  return fieldShell(select.id, label, opts, control, errorSpan(key));
}

/** A segmented control bound to `values[key]`: SSH login (password / key file) and scope (all / this workspace). */
function segmentedField(key: 'sshAuth' | 'scope', label: string, options: readonly { value: string; label: string; icon: IconName }[], span: Span) {
  return segmented(
    key,
    label,
    options,
    span,
    (value) => {
      values[key] = value;
      clearError(key);
      update();
    },
    errorSpan(key),
  );
}

/** A switch row bound to `values[key]`. */
function switchField(key: 'sshEnabled' | 'readOnly', title: string, description: string) {
  const sw = switchRow(
    `f-${key}`,
    title,
    description,
    values[key],
    (checked) => {
      values[key] = checked;
      update();
    },
    errorSpan(key),
  );
  inputs.set(key, sw.input);
  return sw;
}

function errorSpan(key: keyof FormValues): HTMLElement {
  const span = el('span', 'error');
  span.id = `e-${key}`;
  errorSpans.set(key, span);
  return span;
}

/** Shows and hides parts of the form for the current kind, tab, SSH and busy state. */
function update(): void {
  if (!ui || !init) return;
  const k = kind();
  const isFile = k.database === 'none';
  paintChoices(ui.types.choices, values.kind);
  ui.tabs.setHidden('ssh', !k.network);
  ui.tabs.dots.ssh.hidden = !(values.sshEnabled && k.network);
  ui.tabs.dots.options.hidden = !values.readOnly;
  ui.sqlite.hidden = !isFile;
  ui.server.hidden = isFile;
  ui.tunnelNote.hidden = isFile || !values.sshEnabled;
  ui.url.placeholder = k.urlExample ?? '';
  // SQL Server: named instances, and sign-in without a password (Microsoft Entra ID).
  ui.instance.field.hidden = !k.instances;
  ui.signIn.field.hidden = k.signIns.length < 2;
  const select = inputs.get('signIn') as HTMLSelectElement;
  for (const option of Array.from(select.options)) option.hidden = option.disabled = !k.signIns.includes(option.value as never);
  const withPassword = values.signIn === 'password';
  ui.user.field.hidden = ui.password.field.hidden = !withPassword;
  // A named instance's port comes from SQL Browser.
  ui.port.input.disabled = !!values.instance.trim() && k.instances;
  const readOnlyNote = document.getElementById('d-f-readOnly');
  if (readOnlyNote) readOnlyNote.textContent = k.readOnlyNote ?? READ_ONLY_NOTE;

  const editing = init.mode === 'edit';
  ui.password.input.placeholder = init.fromEnv
    ? init.hasPassword
      ? 'From .env — type to replace'
      : 'Leave empty for none'
    : editing
      ? init.hasPassword
        ? 'Unchanged — type to replace'
        : 'None — type to set one'
      : 'Leave empty for none';
  ui.database.required.hidden = k.database !== 'required';
  ui.database.input.placeholder = k.database === 'optional' ? 'Optional — empty shows all' : '';

  ui.sshFields.disabled = !values.sshEnabled;
  ui.sshFields.classList.toggle('off', !values.sshEnabled);
  const keyAuth = values.sshAuth === 'key';
  paintChoices(ui.auth.choices, values.sshAuth);
  paintChoices(ui.scope.choices, values.scope);
  // "This workspace" needs an open folder; say why it's off instead of only greying it out.
  const workspaceChoice = ui.scope.choices.find((c) => c.value === 'workspace')!.button;
  workspaceChoice.disabled = !init.hasWorkspace;
  workspaceChoice.title = init.hasWorkspace ? '' : 'No folder is open in this window.';
  ui.scopeHint.textContent = init.hasWorkspace
    ? 'This-workspace connections are stored privately in VS Code, not in your project files.'
    : 'No folder is open in this window, so connections are saved for all workspaces. Open a folder (File → Open Folder…) to save one for it only.';
  ui.keyPath.field.hidden = !keyAuth;
  ui.secret.text.textContent = keyAuth ? 'Key passphrase' : 'SSH password';
  const keep = editing && init.hasSshSecret && init.values.sshEnabled && init.values.sshAuth === values.sshAuth;
  ui.secret.input.placeholder = keep ? 'Unchanged — type to replace' : keyAuth ? 'Leave empty if the key has none' : '';

  ui.save.disabled = ui.test.disabled = busy;
  ui.saveLabel.textContent = busy ? 'Connecting…' : 'Save';
}

/** Switching type: fields still at the old type's defaults take the new type's. */
function changeKind(next: KindInfo): void {
  if (!init || next.label === values.kind) return;
  const prev = kind();
  const swap = (key: 'port' | 'user' | 'database', before: string, after: string) => {
    if (values[key] === '' || values[key] === before) setValue(key, after);
  };
  swap('port', String(prev.defaultPort ?? ''), String(next.defaultPort ?? ''));
  swap('user', prev.defaultUser ?? '', next.defaultUser ?? '');
  swap('database', prev.defaultDatabase ?? '', next.defaultDatabase ?? '');
  if (values.ssl === prev.defaultSsl) setValue('ssl', next.defaultSsl);
  if (!next.signIns.includes(values.signIn as never)) setValue('signIn', next.signIns[0] ?? 'password');
  if (!next.instances) setValue('instance', '');
  if (next.network && !values.host) setValue('host', 'localhost');
  values.kind = next.label;
  showErrors({});
  update();
}

function setValue(key: keyof FormValues, value: string | boolean): void {
  (values as unknown as Record<string, unknown>)[key] = value;
  const input = inputs.get(key);
  if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value === true;
  else if (input) input.value = String(value);
  clearError(key);
}

function applyConnectionString(input: HTMLInputElement, hint: HTMLElement, explicit = false): void {
  const text = input.value.trim();
  if (!text) {
    hint.textContent = 'Paste a URL to fill in the fields below.';
    hint.className = 'hint';
    return;
  }
  // Wait for a complete URL (or a SQL Server `Server=…;` string) while typing; Enter always tries.
  if (!explicit && !/^[a-z]+:\/\/.+/i.test(text) && !/(^|;)\s*(server|data source)\s*=[^;]+;/i.test(text)) return;
  const parsed = parseConnectionString(text);
  if (typeof parsed === 'string') {
    if (explicit) {
      hint.textContent = parsed;
      hint.className = 'hint error-text';
    }
    return;
  }
  const target = init!.kinds.find((k) => k.label === parsed.kind);
  if (!target) return;
  changeKind(target);
  if (parsed.filePath !== undefined) {
    setValue('filePath', parsed.filePath);
    input.value = '';
    hint.textContent = 'Filled in. Use a full path, or Browse….';
    hint.className = 'hint ok-text';
    update();
    return;
  }
  if (parsed.host) setValue('host', parsed.host);
  setValue('port', parsed.port ?? String(target.defaultPort ?? ''));
  if (parsed.user) setValue('user', parsed.user);
  if (parsed.password) setValue('password', parsed.password);
  setValue('database', parsed.database ?? '');
  if (parsed.ssl) setValue('ssl', parsed.ssl);
  setValue('instance', parsed.instance ?? '');
  if (parsed.signIn && target.signIns.includes(parsed.signIn)) setValue('signIn', parsed.signIn);
  // The URL may hold a password: clear it once the fields have it.
  input.value = '';
  hint.textContent = parsed.password ? 'Filled in, including the password.' : 'Filled in.';
  hint.className = 'hint ok-text';
  update();
}

function setPath(target: PathTarget, path: string): void {
  if (target === 'sshKey') setValue('sshKeyPath', path);
  else {
    setValue('filePath', path);
    // Suggest the file's name until the user picks one.
    if (!values.name) inputs.get('name')!.setAttribute('placeholder', path.split(/[\\/]/).pop() ?? '');
  }
}

function browse(target: PathTarget): void {
  vscode.postMessage({ type: 'browse', target });
}

/** What the last Save / Test click asked for, so Trust Server Certificate can do it again. */
let lastSend: 'save' | 'test' = 'save';

function send(type: 'save' | 'test', force = false): void {
  if (busy) return;
  lastSend = type;
  vscode.postMessage(type === 'save' ? { type, values: { ...values }, force } : { type, values: { ...values } });
}

function showErrors(errors: FieldErrors): void {
  for (const [key, span] of errorSpans) {
    const text = errors[key] ?? '';
    span.textContent = text;
    const input = inputs.get(key);
    if (input) {
      if (text) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-errormessage', span.id);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-errormessage');
      }
    }
  }
  const first = (Object.keys(errors) as (keyof FormValues)[])[0];
  if (first) {
    ui?.tabs.select(FIELD_TAB[first] ?? 'main');
    update();
    inputs.get(first)?.focus();
  }
}

function clearError(key: keyof FormValues): void {
  const span = errorSpans.get(key);
  if (span?.textContent) {
    span.textContent = '';
    inputs.get(key)?.removeAttribute('aria-invalid');
  }
}

function showStatus(state: StatusState, text: string, saveAnyway?: boolean, trustCertificate?: boolean): void {
  if (!ui) return;
  const extra: HTMLElement[] = [];
  // The server's certificate didn't verify (a local server's self-signed one): trust it and try again.
  if (trustCertificate) {
    extra.push(
      button('Trust Server Certificate', 'shield', () => {
        setValue('ssl', 'no-verify');
        send(lastSend);
      }),
    );
  }
  if (saveAnyway) extra.push(button('Save Anyway', 'check', () => send('save', true)));
  renderStatus(ui.status, state, text, ...extra);
}
