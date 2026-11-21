import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { ConnectionManager, ConnectionSecrets } from '../connectionManager';
import { checkForm, initialValues, readValues, type FieldErrors, type FormContext, type FormValues, type KindInfo } from '../connectionForm/fields';
import { errorMessage } from '../drivers/common';
import { DATABASE_SCOPE, DB_KINDS, USES_NETWORK } from '../drivers';
import { logoUris } from '../logos';
import type { ConnectionsTree } from '../tree/ConnectionsTree';
import type { ConnectionConfig } from '../types';

/** Which file a Browse… button picks. */
export type PathTarget = 'sqliteOpen' | 'sqliteCreate' | 'sshKey';

/** Messages to the connection form (src/webview/connectionForm.ts). Never contain a stored password. */
export type FormMessage =
  | {
      type: 'init';
      mode: 'add' | 'edit';
      values: FormValues;
      kinds: KindInfo[];
      folders: string[];
      /** Editing: secrets are stored, so empty fields say "Unchanged". */
      hasPassword: boolean;
      hasSshSecret: boolean;
      /** Webview URIs of each kind's logo (by DbKind.logo), light and dark. */
      logos: Record<string, { light: string; dark: string }>;
    }
  | { type: 'fieldErrors'; errors: FieldErrors }
  /** `saveAnyway`: the test failed, offer to save without it. */
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; saveAnyway?: boolean }
  | { type: 'path'; target: PathTarget; path: string };

/** Messages from the form. Untrusted: every field is checked here (readValues, checkForm). */
export type FormRequest =
  | { type: 'ready' }
  | { type: 'save'; values: FormValues; force?: boolean }
  | { type: 'test'; values: FormValues }
  | { type: 'browse'; target: PathTarget }
  | { type: 'close' };

const SQLITE_FILTERS = { 'SQLite databases': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] };

/** The form's view of the database registry, so the webview needs no runtime import. */
function kinds(): KindInfo[] {
  return DB_KINDS.map((k) => ({
    label: k.label,
    type: k.type,
    defaultPort: k.defaultPort,
    defaultUser: k.defaultUser,
    defaultDatabase: k.defaultDatabase,
    logo: k.logo,
    network: USES_NETWORK[k.type],
    database: DATABASE_SCOPE[k.type],
  }));
}

/**
 * Add Connection and Edit Connection… as a form in an editor tab: one tab per connection being edited,
 * one for a new connection. Save tests the connection first; on failure the form offers Save Anyway.
 */
export class ConnectionForms implements vscode.Disposable {
  private readonly forms = new Map<string, ConnectionFormPanel>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly tree: ConnectionsTree,
  ) {
    // A connection removed while its form is open: close the form.
    this.subscription = manager.onDidChange(() => {
      for (const form of [...this.forms.values()]) if (form.editingId && !manager.get(form.editingId)) form.dispose();
    });
  }

  openAdd(): void {
    this.open('new', () => new ConnectionFormPanel(this.extensionUri, this.manager, this.tree, randomUUID(), undefined));
  }

  openEdit(config: ConnectionConfig): void {
    this.open(config.id, () => new ConnectionFormPanel(this.extensionUri, this.manager, this.tree, config.id, config));
  }

  dispose(): void {
    for (const form of [...this.forms.values()]) form.dispose();
    this.subscription.dispose();
  }

  private open(key: string, create: () => ConnectionFormPanel): void {
    const existing = this.forms.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const form = create();
    this.forms.set(key, form);
    form.onDidDispose(() => {
      if (this.forms.get(key) === form) this.forms.delete(key);
    });
  }
}

class ConnectionFormPanel {
  private readonly panel: vscode.WebviewPanel;
  private busy = false;
  private readonly extensionUri: vscode.Uri;
  /** Stored secrets of the connection being edited, read once when the form opens. */
  private stored: ConnectionSecrets = {};
  readonly editingId?: string;

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly tree: ConnectionsTree,
    private readonly id: string,
    editing: ConnectionConfig | undefined,
  ) {
    this.editingId = editing?.id;
    this.extensionUri = extensionUri;
    const distUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    const logosUri = vscode.Uri.joinPath(extensionUri, 'media', 'logos');
    this.panel = vscode.window.createWebviewPanel(
      'dbDeck.connectionForm',
      editing ? `Edit ${editing.name}` : 'Add Connection',
      vscode.ViewColumn.Active,
      // Kept alive while hidden, so switching tabs doesn't lose what was typed.
      { enableScripts: true, localResourceRoots: [distUri, logosUri], retainContextWhenHidden: true },
    );
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'connectionForm.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'connectionForm.css'));
    // Same rules as the Results grid (webview.md): no inline code, values inserted with textContent.
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <script src="${script}" defer></script>
</head>
<body><main id="root"></main></body>
</html>`;
    webview.onDidReceiveMessage((msg: unknown) => void this.onMessage(msg));
  }

  readonly onDidDispose = (listener: () => void) => this.panel.onDidDispose(listener);

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }

  private post(message: FormMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Partial<FormRequest> & { values?: unknown; force?: unknown; target?: unknown };
    switch (msg.type) {
      case 'ready':
        return this.init();
      case 'close':
        return this.dispose();
      case 'browse':
        if (msg.target === 'sqliteOpen' || msg.target === 'sqliteCreate' || msg.target === 'sshKey') return this.browse(msg.target);
        return;
      case 'test':
      case 'save': {
        const values = readValues(msg.values);
        if (!values) return;
        return msg.type === 'test' ? this.test(values) : this.save(values, msg.force === true);
      }
    }
  }

  private async init(): Promise<void> {
    const editing = this.editingId ? this.manager.get(this.editingId) : undefined;
    if (this.editingId && !editing) return this.dispose();
    this.stored = editing ? await this.manager.storedSecrets(editing.id) : {};
    const all = kinds();
    const kind = (editing && all.find((k) => k.type === editing.type)) || all.find((k) => k.network) || all[0];
    this.post({
      type: 'init',
      mode: editing ? 'edit' : 'add',
      values: initialValues(kind, editing),
      kinds: all,
      folders: this.manager.folders(),
      hasPassword: !!this.stored.password,
      hasSshSecret: !!this.stored.sshSecret,
      logos: this.logos(all),
    });
  }

  private logos(all: KindInfo[]): Record<string, { light: string; dark: string }> {
    const webview = this.panel.webview;
    const result: Record<string, { light: string; dark: string }> = {};
    for (const k of all) {
      const uris = logoUris(this.extensionUri, k.logo);
      if (uris) result[k.logo] = { light: webview.asWebviewUri(uris.light).toString(), dark: webview.asWebviewUri(uris.dark).toString() };
    }
    return result;
  }

  private context(): FormContext {
    const existing = this.editingId ? this.manager.get(this.editingId) : undefined;
    return {
      mode: this.editingId ? 'edit' : 'add',
      id: this.id,
      kinds: kinds(),
      existing,
      hasSshSecret: !!this.stored.sshSecret,
      fileExists: (file) => fs.existsSync(file),
    };
  }

  /** Checks the fields; posts field errors and returns undefined when something is wrong. */
  private check(values: FormValues) {
    if (this.editingId && !this.manager.get(this.editingId)) {
      this.post({ type: 'status', state: 'error', text: 'This connection was removed.' });
      return undefined;
    }
    const checked = checkForm(values, this.context());
    this.post({ type: 'fieldErrors', errors: checked.ok ? {} : checked.errors });
    if (!checked.ok) {
      this.post({ type: 'status', state: 'error', text: 'Check the highlighted fields.' });
      return undefined;
    }
    return checked;
  }

  private async test(values: FormValues): Promise<void> {
    if (this.busy) return;
    const checked = this.check(values);
    if (!checked) return;
    this.busy = true;
    this.post({ type: 'status', state: 'busy', text: `Connecting to ${checked.config.name}…` });
    try {
      await this.manager.test(checked.config, this.secretsForTest(checked));
      this.post({ type: 'status', state: 'ok', text: `Connected to ${checked.config.name}.` });
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t connect: ${errorMessage(err)}` });
    } finally {
      this.busy = false;
    }
  }

  /** Tests first (unless `force`, from Save Anyway), then saves and closes the form. */
  private async save(values: FormValues, force: boolean): Promise<void> {
    if (this.busy) return;
    const checked = this.check(values);
    if (!checked) return;
    const { config } = checked;
    this.busy = true;
    try {
      if (!force) {
        this.post({ type: 'status', state: 'busy', text: `Connecting to ${config.name}…` });
        try {
          await this.manager.test(config, this.secretsForTest(checked));
        } catch (err) {
          this.post({ type: 'status', state: 'error', text: `Couldn’t connect: ${errorMessage(err)}`, saveAnyway: true });
          return;
        }
      }
      const secrets = { password: checked.password, sshSecret: checked.sshSecret };
      if (this.editingId) {
        if (this.manager.isConnected(this.editingId)) {
          const ok = await vscode.window.showWarningMessage(
            `Save changes to "${config.name}" and reconnect?`,
            { modal: true, detail: 'Reconnecting ends this session, including any open transaction.' },
            'Save and Reconnect',
          );
          if (!ok) {
            this.post({ type: 'status', state: 'info', text: 'Not saved.' });
            return;
          }
        }
        if (!this.manager.get(this.editingId)) {
          this.post({ type: 'status', state: 'error', text: 'This connection was removed.' });
          return;
        }
        this.tree.collapseOnNextRefresh(config.id);
        await this.manager.update(config, secrets);
      } else {
        await this.manager.add(config, secrets);
      }
      void vscode.window.showInformationMessage(`Saved connection "${config.name}".`);
      this.dispose();
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t save: ${errorMessage(err)}` });
    } finally {
      this.busy = false;
    }
  }

  /** Secrets not retyped while editing are the stored ones; '' means none. */
  private secretsForTest(checked: { config: ConnectionConfig; password?: string; sshSecret?: string }): ConnectionSecrets {
    return {
      password: checked.password ?? this.stored.password,
      sshSecret: checked.sshSecret ?? (checked.config.ssh ? this.stored.sshSecret : undefined),
    };
  }

  private async browse(target: PathTarget): Promise<void> {
    let file: string | undefined;
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (target === 'sqliteOpen') {
      const uris = await vscode.window.showOpenDialog({ title: 'SQLite database file', defaultUri: workspace, canSelectMany: false, filters: SQLITE_FILTERS });
      file = uris?.[0]?.fsPath;
    } else if (target === 'sqliteCreate') {
      const uri = await vscode.window.showSaveDialog({
        title: 'New SQLite database file',
        defaultUri: workspace && vscode.Uri.joinPath(workspace, 'database.sqlite'),
        filters: SQLITE_FILTERS,
      });
      file = uri?.fsPath;
      // An empty file is a valid empty SQLite database. Never truncate a file that already exists.
      if (file && !fs.existsSync(file)) fs.writeFileSync(file, new Uint8Array());
    } else {
      const sshDir = path.join(os.homedir(), '.ssh');
      const uris = await vscode.window.showOpenDialog({
        title: 'Private key file',
        defaultUri: vscode.Uri.file(fs.existsSync(sshDir) ? sshDir : os.homedir()),
        canSelectMany: false,
        openLabel: 'Use Key',
      });
      file = uris?.[0]?.fsPath;
    }
    if (file) this.post({ type: 'path', target, path: file });
  }
}
