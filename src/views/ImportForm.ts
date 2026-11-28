import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage, ImportCancelled, ImportError } from '../drivers/common';
import { DB_KINDS, typeLabel } from '../drivers';
import { CsvError } from '../import/csv';
import { importRowsOf, summarizeCsv, type CsvReadOptions, type CsvSummary } from '../import/csvFile';
import { autoMap, checkMapping, importTargets } from '../import/mapping';
import type { Cell, ColumnInfo, TableInfo } from '../types';
import { tableLabel } from '../tree/ConnectionsTree';
import { FormPanel, FormTabs } from './FormPanel';
import type { ScriptConnection } from './RunScriptForm';

export type ImportDelimiter = 'auto' | ',' | ';' | '\t' | '|';

/** Messages to the Import CSV form (src/webview/importForm.ts). */
export type ImportMessage =
  | {
      type: 'init';
      detail: string;
      /** `table`: opened from a table (fixed target); `file`: from a CSV file (choose connection and table). */
      mode: 'table' | 'file';
      target?: { label: string; logo?: { light: string; dark: string } };
      connections: ScriptConnection[];
      connectionId?: string;
    }
  | { type: 'tables'; connectionId: string; tables: { key: string; label: string }[]; tableKey?: string }
  /** The chosen table's columns that can be filled, and how many rows it has now (for "delete first"). */
  | { type: 'columns'; columns: { name: string; type: string; required: boolean; identity?: boolean }[]; existingRows?: string }
  | { type: 'file'; name: string; path: string; size: string }
  /** The file as read with the current options; `mapping` is the suggested target per CSV column. */
  | {
      type: 'summary';
      delimiter: string;
      headers?: string[];
      columns: number;
      rows: number;
      preview: Cell[][];
      problem?: { line?: number; message: string };
      mapping: (string | null)[];
    }
  | { type: 'running'; running: boolean }
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; line?: number };

/** Messages from the form. Untrusted: every id, key, column name and option is checked here. */
export type ImportRequest =
  | { type: 'ready' }
  | { type: 'chooseFile' }
  | { type: 'chooseConnection'; connectionId: string }
  | { type: 'chooseTable'; key: string }
  | { type: 'options'; delimiter: ImportDelimiter; header: boolean; nullEmpty: boolean }
  | { type: 'import'; mapping: (string | null)[]; deleteFirst: boolean }
  | { type: 'cancel' }
  | { type: 'showLine'; line: number }
  | { type: 'close' };

const DELIMITERS: ImportDelimiter[] = ['auto', ',', ';', '\t', '|'];

/** Import CSV…: from a table (file chosen in the form) or from a CSV file (connection and table chosen). */
export class ImportForms implements vscode.Disposable {
  private readonly forms = new FormTabs<ImportFormPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
  ) {}

  openForTable(connectionId: string, table: TableInfo): void {
    if (!this.manager.get(connectionId) || table.kind !== 'table') return;
    const key = `table:${connectionId}:${table.schema ?? ''}.${table.name}`;
    this.forms.open(key, () => new ImportFormPanel(this.extensionUri, this.manager, { connectionId, table }));
  }

  async openForFile(uri?: vscode.Uri): Promise<void> {
    const file = uri instanceof vscode.Uri ? uri : await pickCsv();
    if (!file) return;
    this.forms.open(`file:${file.toString()}`, () => new ImportFormPanel(this.extensionUri, this.manager, { file: file.fsPath }));
  }

  dispose(): void {
    this.forms.dispose();
  }
}

class ImportFormPanel extends FormPanel<ImportMessage> {
  private readonly mode: 'table' | 'file';
  private connectionId?: string;
  private table?: TableInfo;
  private tables: TableInfo[] = [];
  private targets: ColumnInfo[] = [];
  private existingRows = 0;
  private file?: string;
  private options: CsvReadOptions = { delimiter: 'auto', header: true, nullEmpty: true };
  private summary?: CsvSummary;
  private running = false;
  private cancelled = false;

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    start: { connectionId: string; table: TableInfo } | { file: string },
  ) {
    super(extensionUri, 'dbDeck.importForm', 'file' in start ? `Import ${path.basename(start.file)}` : `Import into ${start.table.name}`, 'importForm');
    this.mode = 'file' in start ? 'file' : 'table';
    if ('file' in start) this.file = start.file;
    else {
      this.connectionId = start.connectionId;
      this.table = start.table;
    }
    this.panel.onDidDispose(() => (this.cancelled = true));
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    if (this.running && msg.type !== 'cancel' && msg.type !== 'showLine') return;
    switch (msg.type) {
      case 'ready':
        return this.init();
      case 'close':
        return this.dispose();
      case 'cancel':
        this.cancelled = true;
        return;
      case 'chooseFile': {
        const uri = await pickCsv(this.file);
        if (!uri) return;
        this.file = uri.fsPath;
        return this.readFile();
      }
      case 'chooseConnection':
        if (this.mode === 'file' && typeof msg.connectionId === 'string' && this.manager.get(msg.connectionId)) {
          this.connectionId = msg.connectionId;
          this.table = undefined;
          return this.loadTables();
        }
        return;
      case 'chooseTable': {
        const t = typeof msg.key === 'string' && /^\d+$/.test(msg.key) ? this.tables[+msg.key] : undefined;
        if (this.mode === 'file' && t) {
          this.table = t;
          await this.loadColumns();
          this.postSummary();
        }
        return;
      }
      case 'options': {
        const delimiter = DELIMITERS.find((d) => d === msg.delimiter);
        if (!delimiter || typeof msg.header !== 'boolean' || typeof msg.nullEmpty !== 'boolean') return;
        this.options = { delimiter, header: msg.header, nullEmpty: msg.nullEmpty };
        return this.readFile();
      }
      case 'showLine':
        if (this.file && typeof msg.line === 'number' && Number.isInteger(msg.line) && msg.line >= 1) {
          const position = new vscode.Position(msg.line - 1, 0);
          await vscode.window.showTextDocument(vscode.Uri.file(this.file), { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.Beside });
        }
        return;
      case 'import':
        return this.import(msg.mapping, msg.deleteFirst);
    }
  }

  private connectionList(): ScriptConnection[] {
    return this.manager.list().map((c) => {
      const kind = DB_KINDS.find((k) => k.type === c.type);
      return { id: c.id, name: c.name, detail: `${typeLabel(c.type)}${c.readOnly ? ' · read-only' : ''}`, logo: kind && this.logo(kind.logo), readOnly: !!c.readOnly };
    });
  }

  private async init(): Promise<void> {
    const config = this.connectionId ? this.manager.get(this.connectionId) : undefined;
    const kind = config && DB_KINDS.find((k) => k.type === config.type);
    this.post({
      type: 'init',
      mode: this.mode,
      detail: this.mode === 'table' && this.table ? `Into ${tableLabel(this.table)}` : path.basename(this.file ?? ''),
      target: this.mode === 'table' && config && this.table ? { label: `${config.name} · ${tableLabel(this.table)}`, logo: kind && this.logo(kind.logo) } : undefined,
      connections: this.mode === 'file' ? this.connectionList() : [],
      connectionId: this.connectionId,
    });
    if (this.mode === 'table') await this.loadColumns();
    if (this.file) await this.readFile();
  }

  private async loadTables(): Promise<void> {
    if (!this.connectionId) return;
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      this.tables = (await driver.listTables()).filter((t) => t.kind === 'table');
    } catch (err) {
      this.tables = [];
      this.post({ type: 'status', state: 'error', text: `Couldn’t list tables: ${errorMessage(err)}` });
    }
    this.targets = [];
    this.post({ type: 'tables', connectionId: this.connectionId, tables: this.tables.map((t, i) => ({ key: String(i), label: tableLabel(t) })) });
    this.post({ type: 'columns', columns: [] });
    this.postSummary();
  }

  private async loadColumns(): Promise<void> {
    if (!this.connectionId || !this.table) return;
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      this.targets = importTargets(await driver.listColumns(this.table));
      this.existingRows = Number(await driver.countRows(this.table));
    } catch (err) {
      this.targets = [];
      this.post({ type: 'status', state: 'error', text: `Couldn’t read the table: ${errorMessage(err)}` });
    }
    this.post({
      type: 'columns',
      columns: this.targets.map((c) => ({ name: c.name, type: c.type, required: !c.nullable && !c.hasDefault, ...(c.identity ? { identity: true } : {}) })),
      existingRows: this.existingRows.toLocaleString(),
    });
  }

  private async readFile(): Promise<void> {
    if (!this.file) return;
    let size = 0;
    try {
      size = (await vscode.workspace.fs.stat(vscode.Uri.file(this.file))).size;
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t read ${path.basename(this.file)}: ${errorMessage(err)}` });
      return;
    }
    this.post({ type: 'file', name: path.basename(this.file), path: this.file, size: formatSize(size) });
    this.post({ type: 'status', state: 'busy', text: 'Reading the file…' });
    try {
      this.summary = await summarizeCsv(this.file, this.options);
      this.post({ type: 'status', state: 'info', text: '' });
    } catch (err) {
      this.summary = undefined;
      this.post({ type: 'status', state: 'error', text: `Couldn’t read ${path.basename(this.file)}: ${errorMessage(err)}` });
      return;
    }
    this.postSummary();
  }

  private postSummary(): void {
    const s = this.summary;
    if (!s) return;
    this.post({
      type: 'summary',
      delimiter: s.delimiter,
      headers: s.headers,
      columns: s.columns,
      rows: s.rows,
      preview: s.preview,
      problem: s.problem,
      mapping: this.targets.length ? autoMap(s.columns, s.headers, this.targets) : new Array<null>(s.columns).fill(null),
    });
  }

  private async import(rawMapping: unknown, rawDelete: unknown): Promise<void> {
    const config = this.connectionId ? this.manager.get(this.connectionId) : undefined;
    const table = this.table;
    const s = this.summary;
    const file = this.file;
    const fail = (text: string) => this.post({ type: 'status', state: 'error', text });
    if (!config || !table) return fail('Choose the table to import into.');
    if (config.readOnly) return fail(`"${config.name}" is read-only, so DB Deck won’t import into it.`);
    if (!file || !s) return fail('Choose a CSV file.');
    if (s.problem) return fail(s.problem.message);
    const names = new Set(this.targets.map((t) => t.name));
    if (!Array.isArray(rawMapping) || rawMapping.length !== s.columns || rawMapping.some((m) => m !== null && (typeof m !== 'string' || !names.has(m)))) {
      return fail('The column mapping doesn’t match the file. Check the file again.');
    }
    const mapping = rawMapping as (string | null)[];
    const check = checkMapping(mapping, this.targets);
    if (check.errors.length) return fail(check.errors[0]);
    const deleteFirst = rawDelete === true;
    const pick = mapping.map((m, i) => (m === null ? -1 : i)).filter((i) => i >= 0);
    const columns = pick.map((i) => mapping[i] as string);

    this.running = true;
    this.cancelled = false;
    this.post({ type: 'running', running: true });
    this.post({ type: 'status', state: 'busy', text: `0 of ${s.rows.toLocaleString()} rows` });
    const started = performance.now();
    try {
      const driver = await this.manager.getDriver(config.id);
      const result = await driver.importRows(table, columns, importRowsOf(file, this.options, s, pick), {
        deleteFirst,
        cancelled: () => this.cancelled,
        onProgress: (n) => this.post({ type: 'status', state: 'busy', text: `${n.toLocaleString()} of ${s.rows.toLocaleString()} rows` }),
      });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const replaced = deleteFirst ? ` (after deleting ${result.deleted.toLocaleString()} rows)` : '';
      this.post({ type: 'status', state: 'ok', text: `Imported ${result.inserted.toLocaleString()} rows into ${tableLabel(table)}${replaced} in ${seconds} s.` });
      await this.loadColumns();
    } catch (err) {
      const kept = deleteFirst ? 'Nothing was imported, and the existing rows are still there.' : 'Nothing was imported.';
      if (err instanceof ImportCancelled) {
        this.post({ type: 'status', state: 'info', text: `Cancelled. ${kept}` });
      } else if (err instanceof ImportError) {
        this.post({ type: 'status', state: 'error', text: `Line ${err.line}: ${err.message} ${kept}`, line: err.line });
      } else if (err instanceof CsvError) {
        // Its message already names the line.
        this.post({ type: 'status', state: 'error', text: `${err.message} ${kept}`, line: err.line || undefined });
      } else {
        this.post({ type: 'status', state: 'error', text: `The import failed: ${errorMessage(err)} ${kept}` });
      }
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }
}

function formatSize(size: number): string {
  return size < 1024 ? `${size} bytes` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function pickCsv(current?: string): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import CSV',
    canSelectMany: false,
    filters: { 'CSV files': ['csv', 'tsv', 'txt'], 'All files': ['*'] },
    defaultUri: current ? vscode.Uri.file(path.dirname(current)) : vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return picked?.[0];
}
