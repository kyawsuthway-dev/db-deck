import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { DB_KINDS, typeLabel } from '../drivers';
import { FileOut } from '../export/fileOut';
import { DumpCancelled, writeDump, type DumpContent } from '../transfer/dumpWriter';
import type { TableInfo } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

/** A table or view offered in the dump form; `key` is its index in the extension's own list. */
export interface DumpObject {
  key: string;
  label: string;
  kind: 'table' | 'view';
}

export type DumpStatusState = 'busy' | 'ok' | 'error' | 'info';

/** Messages to the dump form (src/webview/dumpForm.ts). */
export type DumpMessage =
  | {
      type: 'init';
      title: string;
      detail: string;
      logo?: { light: string; dark: string };
      objects: DumpObject[];
      /** Keys preselected: the right-clicked table, or every table. */
      selected: string[];
      file: string;
    }
  | { type: 'path'; path: string }
  /** `openFile`: the dump finished, offer Open File. */
  | { type: 'status'; state: DumpStatusState; text: string; openFile?: boolean }
  | { type: 'running'; running: boolean };

/** Messages from the dump form. Untrusted: content, keys and file are all checked here. */
export type DumpRequest =
  | { type: 'ready' }
  | { type: 'browse'; file: string }
  | { type: 'dump'; content: DumpContent; keys: string[]; file: string }
  | { type: 'cancel' }
  | { type: 'openFile' }
  | { type: 'close' };

const CONTENTS: Record<DumpContent, string> = { all: 'structure and data', structure: 'structure only', data: 'data only' };

/** Dump to SQL File…: one form per connection. Read-only, so it also works on read-only connections. */
export class DumpForms implements vscode.Disposable {
  private readonly forms = new FormTabs<DumpFormPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
  ) {}

  /** `only`: the right-clicked table, preselected alone (when the form isn't open already). */
  open(connectionId: string, only?: TableInfo): void {
    if (!this.manager.get(connectionId)) return;
    this.forms.open(connectionId, () => new DumpFormPanel(this.extensionUri, this.manager, connectionId, only));
  }

  dispose(): void {
    this.forms.dispose();
  }
}

class DumpFormPanel extends FormPanel<DumpMessage> {
  private objects: TableInfo[] = [];
  private running = false;
  private cancelled = false;
  /** The file the last dump wrote, for Open File. */
  private written?: string;
  /** A path the save dialog already confirmed (it asks before replacing a file). */
  private confirmedPath?: string;

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly connectionId: string,
    private readonly only?: TableInfo,
  ) {
    super(extensionUri, 'dbDeck.dumpForm', `Dump ${manager.get(connectionId)?.name ?? ''}`, 'dumpForm');
    this.panel.onDidDispose(() => (this.cancelled = true));
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.init();
      case 'close':
        if (!this.running) this.dispose();
        return;
      case 'cancel':
        this.cancelled = true;
        return;
      case 'browse':
        return this.browse(typeof msg.file === 'string' ? msg.file : '');
      case 'openFile':
        if (this.written) await vscode.window.showTextDocument(vscode.Uri.file(this.written));
        return;
      case 'dump':
        return this.dump(msg.content, msg.keys, msg.file);
    }
  }

  private async init(): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    const kind = DB_KINDS.find((k) => k.type === config.type);
    const base = {
      type: 'init' as const,
      title: 'Dump to SQL File',
      detail: `${config.name} · ${typeLabel(config.type)}`,
      logo: kind && this.logo(kind.logo),
      file: defaultFile(config.database ?? (config.filePath ? path.parse(config.filePath).name : config.name), this.only?.name),
    };
    try {
      this.objects = await (await this.manager.getDriver(this.connectionId)).listTables();
    } catch (err) {
      this.post({ ...base, objects: [], selected: [] });
      this.post({ type: 'status', state: 'error', text: `Couldn’t list tables: ${errorMessage(err)}` });
      return;
    }
    const objects = this.objects.map((o, i) => ({ key: String(i), label: o.schema ? `${o.schema}.${o.name}` : o.name, kind: o.kind }));
    const same = (o: TableInfo) => !!this.only && o.name === this.only.name && o.schema === this.only.schema;
    const selected = this.objects.map((o, i) => ({ o, key: String(i) })).filter(({ o }) => (this.only ? same(o) : o.kind === 'table')).map((x) => x.key);
    this.post({ ...base, objects, selected });
  }

  private async browse(current: string): Promise<void> {
    const start = path.isAbsolute(current) ? current : defaultFile('dump');
    const uri = await vscode.window.showSaveDialog({ title: 'Dump to SQL File', defaultUri: vscode.Uri.file(start), filters: { 'SQL files': ['sql'] } });
    if (!uri) return;
    this.confirmedPath = uri.fsPath;
    this.post({ type: 'path', path: uri.fsPath });
  }

  private async dump(rawContent: unknown, rawKeys: unknown, rawFile: unknown): Promise<void> {
    if (this.running) return;
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    const content = rawContent === 'all' || rawContent === 'structure' || rawContent === 'data' ? rawContent : undefined;
    const keys = Array.isArray(rawKeys) ? rawKeys.filter((k): k is string => typeof k === 'string' && /^\d+$/.test(k) && +k < this.objects.length) : [];
    const picked = [...new Set(keys)].map((k) => this.objects[+k]);
    const tables = picked.filter((o) => o.kind === 'table');
    const views = content === 'data' ? [] : picked.filter((o) => o.kind === 'view');
    const file = typeof rawFile === 'string' ? rawFile.trim() : '';
    const problem = !content
      ? 'Choose what to include.'
      : !tables.length && !views.length
        ? content === 'data' ? 'Choose at least one table (views have no data to dump).' : 'Choose at least one table or view.'
        : !path.isAbsolute(file)
          ? 'Choose where to save the file (a full path, or Browse…).'
          : !fs.existsSync(path.dirname(file))
            ? `The folder ${path.dirname(file)} doesn’t exist.`
            : undefined;
    if (problem || !content) {
      this.post({ type: 'status', state: 'error', text: problem ?? 'Choose what to include.' });
      return;
    }
    if (fs.existsSync(file) && file !== this.confirmedPath) {
      const ok = await vscode.window.showWarningMessage(`${path.basename(file)} already exists.`, { modal: true, detail: 'Replace it with this dump?' }, 'Replace');
      if (!ok) return;
    }

    const header = [
      `-- ${config.name} (${typeLabel(config.type)}), dumped by DB Deck on ${new Date().toISOString()}`,
      `-- Contents: ${CONTENTS[content]}; ${tables.length} table(s)${views.length ? `, ${views.length} view(s)` : ''}.`,
      '-- Not included: functions, procedures, triggers, users, permissions and server settings.',
      '-- Restore into an empty database with DB Deck’s Run SQL File (one transaction).',
      '',
    ].join('\n');

    this.running = true;
    this.cancelled = false;
    this.post({ type: 'running', running: true });
    this.post({ type: 'status', state: 'busy', text: 'Starting…' });
    const out = new FileOut(file);
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const rows = await writeDump(driver, {
        tables,
        views,
        content,
        header,
        write: (text) => out.write(text),
        onProgress: (table, n) => this.post({ type: 'status', state: 'busy', text: `${table}: ${n.toLocaleString()} rows` }),
        cancelled: () => this.cancelled,
      });
      await out.close();
      this.written = file;
      const what = `${tables.length} table${tables.length === 1 ? '' : 's'}${views.length ? ` and ${views.length} view${views.length === 1 ? '' : 's'}` : ''}`;
      this.post({
        type: 'status',
        state: 'ok',
        text: `Dumped ${what}${content !== 'structure' ? ` (${rows.toLocaleString()} rows)` : ''} to ${path.basename(file)}.`,
        openFile: true,
      });
    } catch (err) {
      await out.discard();
      this.post(
        err instanceof DumpCancelled
          ? { type: 'status', state: 'info', text: 'Cancelled. The partial file was deleted.' }
          : { type: 'status', state: 'error', text: `The dump failed and the partial file was deleted: ${errorMessage(err)}` },
      );
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }
}

/** `<folder>/<name>-YYYY-MM-DD.sql`, in the first workspace folder or the home folder. */
function defaultFile(base: string, table?: string): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const name = `${(table ?? base).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'dump'}-${date}.sql`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  return path.join(folder, name);
}
