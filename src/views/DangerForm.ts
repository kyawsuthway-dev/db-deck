import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { DB_KINDS, TABLE_FEATURES, typeLabel } from '../drivers';
import type { TableInfo } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

export type DangerAction = 'truncate' | 'drop';

/** Messages to the danger form (src/webview/dangerForm.ts). */
export type DangerMessage =
  | {
      type: 'init';
      title: string;
      detail: string;
      logo?: { light: string; dark: string };
      /** What will happen, most important first. */
      notes: { tone: 'info' | 'warning' | 'error'; text: string }[];
      sql: string;
      /** The name to type to enable the button. */
      confirmName: string;
      button: string;
    }
  | { type: 'running'; running: boolean }
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; done?: boolean };

/** Messages from the danger form. Untrusted: the typed name is compared again here. */
export type DangerRequest = { type: 'ready' } | { type: 'run'; typed: string } | { type: 'close' };

/** Truncate Table… and Drop Table / View…: what will happen, the SQL, and the name typed to confirm. */
export class DangerForms implements vscode.Disposable {
  private readonly forms = new FormTabs<DangerPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly onDone: (connectionId: string) => void,
  ) {}

  open(action: DangerAction, connectionId: string, object: TableInfo): void {
    const config = this.manager.get(connectionId);
    if (!config) return;
    if (config.readOnly) {
      void vscode.window.showErrorMessage(`"${config.name}" is read-only, so DB Deck won’t ${action} tables on it.`);
      return;
    }
    if (action === 'truncate' && object.kind !== 'table') return;
    const key = `${action}:${connectionId}:${object.schema ?? ''}.${object.name}`;
    this.forms.open(key, () => new DangerPanel(this.extensionUri, this.manager, action, connectionId, object, this.onDone));
  }

  dispose(): void {
    this.forms.dispose();
  }
}

class DangerPanel extends FormPanel<DangerMessage> {
  private running = false;
  private done = false;
  private readonly label: string;

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly action: DangerAction,
    private readonly connectionId: string,
    private readonly object: TableInfo,
    private readonly onDone: (connectionId: string) => void,
  ) {
    const label = object.schema ? `${object.schema}.${object.name}` : object.name;
    const verb = action === 'truncate' ? 'Truncate' : 'Drop';
    super(extensionUri, 'dbDeck.dangerForm', `${verb} ${label}`, 'dangerForm');
    this.label = label;
  }

  private get what(): string {
    return this.object.kind === 'view' ? 'View' : 'Table';
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.init();
      case 'close':
        if (!this.running) this.dispose();
        return;
      case 'run':
        return this.run(typeof msg.typed === 'string' ? msg.typed : '');
    }
  }

  private async init(): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    const features = TABLE_FEATURES[config.type];
    const kind = DB_KINDS.find((k) => k.type === config.type);
    const notes: { tone: 'info' | 'warning' | 'error'; text: string }[] = [];
    let sql = '';
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      sql = this.action === 'truncate' ? driver.truncateTableSql(this.object) : driver.dropSql(this.object);
      if (this.object.kind === 'table') {
        const rows = Number(await driver.countRows(this.object)).toLocaleString();
        notes.push({
          tone: 'warning',
          text: this.action === 'truncate' ? `Deletes all ${rows} rows of ${this.label}. The table itself stays.` : `Deletes the table ${this.label} and its ${rows} rows.`,
        });
        const referencing = await driver.referencingTables(this.object);
        if (referencing.length) {
          notes.push({
            tone: 'warning',
            text: `Referenced by foreign keys from: ${referencing.join(', ')}. Depending on those keys, the database refuses, or ON DELETE CASCADE deletes their rows too.`,
          });
        }
      } else {
        notes.push({ tone: 'warning', text: `Deletes the view ${this.label}. Its tables and their rows aren’t touched.` });
      }
      notes.push({ tone: 'info', text: this.action === 'truncate' ? features.truncateNote : features.dropNote });
    } catch (err) {
      notes.push({ tone: 'error', text: `Couldn’t read ${this.label}: ${errorMessage(err)}` });
    }
    this.post({
      type: 'init',
      title: `${this.action === 'truncate' ? 'Truncate' : 'Drop'} ${this.what}`,
      detail: `${this.label} · ${config.name} · ${typeLabel(config.type)}`,
      logo: kind && this.logo(kind.logo),
      notes,
      sql,
      confirmName: this.object.name,
      button: `${this.action === 'truncate' ? 'Truncate' : 'Drop'} ${this.what}`,
    });
  }

  private async run(typed: string): Promise<void> {
    if (this.running || this.done) return;
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    if (config.readOnly) {
      this.post({ type: 'status', state: 'error', text: `"${config.name}" is read-only.` });
      return;
    }
    // The page only enables the button when the name matches; check again here.
    if (typed !== this.object.name) {
      this.post({ type: 'status', state: 'error', text: `Type ${this.object.name} exactly to confirm.` });
      return;
    }
    this.running = true;
    this.post({ type: 'running', running: true });
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const sql = this.action === 'truncate' ? driver.truncateTableSql(this.object) : driver.dropSql(this.object);
      const result = await driver.runScript([sql], { transaction: true });
      this.done = true;
      const text =
        this.action === 'truncate'
          ? `Truncated ${this.label}${result.affectedRows ? ` (${result.affectedRows.toLocaleString()} rows deleted)` : ''}.`
          : `Dropped ${this.what.toLowerCase()} ${this.label}.`;
      this.post({ type: 'status', state: 'ok', text, done: true });
      this.onDone(this.connectionId);
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `${errorMessage(err)} Nothing was changed.` });
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }
}
