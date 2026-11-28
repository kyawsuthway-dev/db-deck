import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { ConnectionManager, ConnectionSecrets } from '../connectionManager';
import { checkForm, initialValues, readValues, type FieldErrors, type FormContext, type FormValues, type KindInfo } from '../connectionForm/fields';
import { errorMessage } from '../drivers/common';
import { DATABASE_SCOPE, offeredKinds, USES_NETWORK } from '../drivers';
import type { ConnectionsTree } from '../tree/ConnectionsTree';
import { FormPanel, FormTabs } from './FormPanel';
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
      /** Copied from a .env connection: an empty password field uses the .env password. */
      fromEnv: boolean;
      /** A folder or workspace is open, so "This Workspace" can be chosen. */
      hasWorkspace: boolean;
      hasSshSecret: boolean;
      /** Webview URIs of each kind's logo (by DbKind.logo), light and dark. */
      logos: Record<string, { light: string; dark: string }>;
    }
  | { type: 'fieldErrors'; errors: FieldErrors }
  /**
   * `saveAnyway`: the test failed, offer to save without it. `trustCertificate`: it failed on the server's
   * certificate (a local server's self-signed one), offer to switch SSL to no-verify and try again.
   */
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; saveAnyway?: boolean; trustCertificate?: boolean }
  | { type: 'path'; target: PathTarget; path: string }
  /** Workspace folders were added or removed while the form is open. */
  | { type: 'workspace'; hasWorkspace: boolean };

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
  return offeredKinds().map((k) => ({
    label: k.label,
    type: k.type,
    defaultPort: k.defaultPort,
    defaultUser: k.defaultUser,
    defaultDatabase: k.defaultDatabase,
    logo: k.logo,
    network: USES_NETWORK[k.type],
    database: k.databaseRequired ? 'required' : DATABASE_SCOPE[k.type],
    defaultSsl: k.defaultSsl ?? 'off',
    instances: !!k.instances,
    signIns: k.signIns ?? ['password'],
    readOnlyNote: k.readOnlyNote,
    urlExample: k.urlExample,
  }));
}

/**
 * Add Connection and Edit Connection… as a form in an editor tab: one tab per connection being edited,
 * one for a new connection. Save tests the connection first; on failure the form offers Save Anyway.
 */
export class ConnectionForms implements vscode.Disposable {
  private readonly forms = new FormTabs<ConnectionFormPanel>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly tree: ConnectionsTree,
  ) {
    // A connection removed while its form is open: close the form.
    this.subscription = manager.onDidChange(() => {
      for (const form of this.forms.all()) if (form.editingId && !manager.get(form.editingId)) form.dispose();
    });
  }

  /** A new connection; `copyOf` (a .env connection) prefills it, and its password is used unless one is typed. */
  openAdd(copyOf?: ConnectionConfig): void {
    this.forms.open(copyOf ? `copy:${copyOf.id}` : 'new', () =>
      new ConnectionFormPanel(this.extensionUri, this.manager, this.tree, randomUUID(), undefined, copyOf),
    );
  }

  openEdit(config: ConnectionConfig): void {
    this.forms.open(config.id, () => new ConnectionFormPanel(this.extensionUri, this.manager, this.tree, config.id, config));
  }

  dispose(): void {
    this.forms.dispose();
    this.subscription.dispose();
  }
}

class ConnectionFormPanel extends FormPanel<FormMessage> {
  private busy = false;
  /** Stored secrets of the connection being edited, read once when the form opens. */
  private stored: ConnectionSecrets = {};
  readonly editingId?: string;

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly tree: ConnectionsTree,
    private readonly id: string,
    editing: ConnectionConfig | undefined,
    private readonly copyOf?: ConnectionConfig,
  ) {
    super(extensionUri, 'dbDeck.connectionForm', editing ? `Edit ${editing.name}` : copyOf ? `Save ${copyOf.name}` : 'Add Connection', 'connectionForm');
    this.editingId = editing?.id;
    const folders = vscode.workspace.onDidChangeWorkspaceFolders(() =>
      this.post({ type: 'workspace', hasWorkspace: this.manager.hasWorkspace() }),
    );
    this.panel.onDidDispose(() => folders.dispose());
  }

  protected async onMessage(raw: Record<string, unknown>): Promise<void> {
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
    const source = editing ?? this.copyOf;
    this.stored = source ? await this.manager.storedSecrets(source.id) : {};
    const all = kinds();
    const kind = (source && all.find((k) => k.type === source.type)) || all.find((k) => k.network) || all[0];
    // A copy of a .env connection starts as a new connection for all workspaces (its read-only setting is kept).
    const start = this.copyOf ? { ...this.copyOf, source: undefined } : editing;
    this.post({
      type: 'init',
      mode: editing ? 'edit' : 'add',
      values: initialValues(kind, start),
      kinds: all,
      folders: this.manager.folders(),
      hasPassword: !!this.stored.password,
      fromEnv: !!this.copyOf,
      hasWorkspace: this.manager.hasWorkspace(),
      hasSshSecret: !!this.stored.sshSecret,
      logos: this.logos(all),
    });
  }

  private logos(all: KindInfo[]): Record<string, { light: string; dark: string }> {
    const result: Record<string, { light: string; dark: string }> = {};
    for (const k of all) {
      const uris = this.logo(k.logo);
      if (uris) result[k.logo] = uris;
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
      hasWorkspace: this.manager.hasWorkspace(),
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
      this.post({ type: 'status', state: 'error', text: `Couldn’t connect: ${errorMessage(err)}`, trustCertificate: certificateFailure(checked.config, err) });
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
          this.post({
            type: 'status',
            state: 'error',
            text: `Couldn’t connect: ${errorMessage(err)}`,
            saveAnyway: true,
            trustCertificate: certificateFailure(config, err),
          });
          return;
        }
      }
      // A copy of a .env connection keeps the .env password unless another one was typed.
      const secrets = { password: checked.password ?? (this.copyOf ? this.stored.password : undefined), sshSecret: checked.sshSecret };
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
        await this.manager.update(config, secrets, checked.scope);
      } else {
        await this.manager.add(config, secrets, checked.scope);
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
    // Adding without a copy: nothing is stored, so `stored` is empty.
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

/** The connection verifies certificates and the server's didn't pass (often a self-signed one on a local server). */
function certificateFailure(config: ConnectionConfig, err: unknown): boolean {
  return config.ssl === 'require' && /certificate/i.test(errorMessage(err));
}
