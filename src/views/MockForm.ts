import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import type { TableDesign } from '../design/model';
import { errorMessage, ImportCancelled, ImportError } from '../drivers/common';
import { DB_KINDS } from '../drivers';
import {
  checkMock,
  generateRows,
  GENERATORS,
  mockNotes,
  mockTable,
  MockError,
  type ColumnSetting,
  type GeneratorId,
  type GeneratorMeta,
  type MockData,
  type MockNote,
  type MockOptions,
  type MockRequest,
  type MockTable,
} from '../mock/plan';
import type { Cell, DumpCell, Driver, ImportRow, TableInfo } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

/** One column in the Generate Mock Data form. */
export interface MockFormColumn {
  name: string;
  type: string;
  /** PK, FK, unique, NOT NULL, auto-increment, generated, default. */
  badges: string[];
  allowed: GeneratorId[];
  defaults: Partial<Record<GeneratorId, MockOptions>>;
  setting: ColumnSetting;
}

/** Messages to the form (src/webview/mockForm.ts). */
export type MockFormMessage =
  | {
      type: 'init';
      detail: string;
      target: { label: string; logo?: { light: string; dark: string } };
      readOnly: boolean;
      generators: GeneratorMeta[];
      columns: MockFormColumn[];
      rows: string;
      seed: string;
    }
  /** The first rows exactly as they'll be inserted, for the settings sent with `token`. */
  | { type: 'preview'; token: number; columns: string[]; rows: Cell[][]; total: number; notes: MockNote[]; errors: string[] }
  | { type: 'running'; running: boolean }
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; reload?: boolean };

/** Messages from the form. Untrusted: `checkMock` checks the row count, seed and every column setting. */
export type MockFormRequest =
  | { type: 'ready' }
  | { type: 'settings'; token: number; rows: string; seed: string; columns: ColumnSetting[] }
  | { type: 'insert'; rows: string; seed: string; columns: ColumnSetting[] }
  | { type: 'reload' }
  | { type: 'cancel' }
  | { type: 'close' };

const PREVIEW_ROWS = 5;
/** Existing values read per unique key, so new rows don't clash with them. */
const EXISTING_CAP = 100_000;
/** Parent key values read per foreign key, to pick from. */
const PARENT_CAP = 10_000;

/** Generate Mock Data…: one form per connection + table. */
export class MockForms implements vscode.Disposable {
  private readonly forms = new FormTabs<MockFormPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
  ) {}

  open(connectionId: string, table: TableInfo): void {
    if (!this.manager.get(connectionId) || table.kind !== 'table') return;
    const key = `${connectionId}:${table.schema ?? ''}.${table.name}`;
    this.forms.open(key, () => new MockFormPanel(this.extensionUri, this.manager, connectionId, table));
  }

  dispose(): void {
    this.forms.dispose();
  }
}

class MockFormPanel extends FormPanel<MockFormMessage> {
  private design?: TableDesign;
  private table?: MockTable;
  /** Read on demand per unique key / foreign key, and cleared after an insert. */
  private data: { existing: (MockData['existing'][number] | undefined)[]; parents: (MockData['parents'][number] | undefined)[] } = { existing: [], parents: [] };
  private running = false;
  private cancelled = false;
  private loads = 0;

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly connectionId: string,
    private readonly tableInfo: TableInfo,
  ) {
    super(extensionUri, 'dbDeck.mockForm', `Mock Data · ${tableInfo.name}`, 'mockForm');
    this.panel.onDidDispose(() => (this.cancelled = true));
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    if (this.running && msg.type !== 'cancel') return;
    switch (msg.type) {
      case 'ready':
      case 'reload':
        return this.load();
      case 'close':
        return this.dispose();
      case 'cancel':
        this.cancelled = true;
        return;
      case 'settings':
        if (typeof msg.token === 'number' && Number.isInteger(msg.token)) return this.preview(msg.token, msg.rows, msg.seed, msg.columns);
        return;
      case 'insert':
        return this.insert(msg.rows, msg.seed, msg.columns);
    }
  }

  private async load(): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config) return;
    const load = ++this.loads;
    this.post({ type: 'status', state: 'busy', text: 'Reading the table…' });
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const design = await driver.readDesign(this.tableInfo);
      const choices = await driver.columnChoices(this.tableInfo);
      if (load !== this.loads) return;
      this.design = design;
      this.table = mockTable(design, choices);
      this.data = { existing: [], parents: [] };
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t read ${tableLabel(this.tableInfo)}: ${errorMessage(err)}` });
      return;
    }
    const kind = DB_KINDS.find((k) => k.type === config.type);
    const table = this.table;
    this.post({
      type: 'init',
      detail: `Into ${tableLabel(this.tableInfo)}`,
      target: { label: `${config.name} · ${tableLabel(this.tableInfo)}`, logo: kind && this.logo(kind.logo) },
      readOnly: !!config.readOnly,
      generators: GENERATORS,
      columns: table.columns.map((c) => ({
        name: c.name,
        type: c.type,
        badges: [
          ...(c.primaryKey ? ['PK'] : []),
          ...(c.foreignKey !== undefined ? ['FK'] : []),
          ...(c.unique && !c.primaryKey ? ['unique'] : []),
          ...(c.autoIncrement ? ['auto-increment'] : []),
          ...(c.generated ? ['generated'] : []),
          ...(c.hasDefault ? ['default'] : []),
          ...(!c.nullable && !c.primaryKey ? ['NOT NULL'] : []),
        ],
        allowed: c.allowed,
        defaults: c.defaults,
        setting: c.setting,
      })),
      rows: '100',
      seed: String(Math.floor(Math.random() * 1_000_000)),
    });
    this.post({ type: 'status', state: 'info', text: '' });
  }

  /** Reads the existing values and parent keys the settings need and haven't been read yet. */
  private async ensureData(driver: Driver, table: MockTable, request: MockRequest): Promise<MockData> {
    const generated = (i: number) => request.settings[i].generator !== 'skip';
    for (const [k, cols] of table.uniqueKeys.entries()) {
      if (this.data.existing[k] || !cols.every(generated)) continue;
      const names = cols.map((i) => table.columns[i].name);
      const rows = await driver.dumpRows(this.tableInfo, names, { limit: EXISTING_CAP, offset: 0, orderBy: names.map((column) => ({ column, direction: 'asc' })) });
      this.data.existing[k] = { rows: textRows(rows), capped: rows.length >= EXISTING_CAP };
    }
    for (const [f, fk] of table.foreignKeys.entries()) {
      if (this.data.parents[f] || !table.columns.some((c, i) => c.foreignKey === f && request.settings[i].generator === 'foreignKey')) continue;
      const parent: TableInfo = { name: fk.refTable, schema: fk.refSchema ?? this.tableInfo.schema, kind: 'table' };
      const rows = await driver.dumpRows(parent, fk.refColumns, { limit: PARENT_CAP, offset: 0, orderBy: fk.refColumns.map((column) => ({ column, direction: 'asc' })) });
      this.data.parents[f] = { rows: textRows(rows), capped: rows.length >= PARENT_CAP };
    }
    return {
      existing: table.uniqueKeys.map((_, k) => this.data.existing[k] ?? { rows: [], capped: false }),
      parents: table.foreignKeys.map((_, f) => this.data.parents[f] ?? { rows: [], capped: false }),
    };
  }

  private async preview(token: number, rows: unknown, seed: unknown, columns: unknown): Promise<void> {
    const table = this.table;
    if (!table) return;
    const empty = { type: 'preview' as const, token, columns: [] as string[], rows: [] as Cell[][], total: 0, notes: [] as MockNote[] };
    const check = checkMock(table, rows, seed, columns);
    if (!check.request) return this.post({ ...empty, errors: check.errors });
    const request = check.request;
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const data = await this.ensureData(driver, table, request);
      const notes = mockNotes(table, request, data);
      const errors = notes.filter((n) => n.tone === 'error').map((n) => n.text);
      // Every row is generated, so a unique column that runs out of values shows up now, not halfway through.
      const all = errors.length ? [] : generateRows(table, request, data);
      this.post({
        type: 'preview',
        token,
        columns: table.columns.filter((_, i) => request.settings[i].generator !== 'skip').map((c) => c.name),
        rows: all.slice(0, PREVIEW_ROWS),
        total: request.rows,
        notes: notes.filter((n) => n.tone !== 'error'),
        errors,
      });
    } catch (err) {
      this.post({ ...empty, errors: [err instanceof MockError ? err.message : `Couldn’t read the values to use: ${errorMessage(err)}`] });
    }
  }

  private async insert(rows: unknown, seed: unknown, columns: unknown): Promise<void> {
    const config = this.manager.get(this.connectionId);
    const fail = (text: string, reload = false) => this.post({ type: 'status', state: 'error', text, reload });
    if (!config || !this.table || !this.design) return;
    if (config.readOnly) return fail(`"${config.name}" is read-only, so DB Deck won’t insert into it.`);
    const check = checkMock(this.table, rows, seed, columns);
    if (!check.request) return fail(check.errors[0]);
    const request = check.request;
    const table = this.table;

    this.running = true;
    this.cancelled = false;
    this.post({ type: 'running', running: true });
    this.post({ type: 'status', state: 'busy', text: 'Checking the table…' });
    const started = performance.now();
    try {
      const driver = await this.manager.getDriver(config.id);
      // The table as it is now: refuse if its structure changed, and read existing values and parents again.
      const now = await driver.readDesign(this.tableInfo);
      if (JSON.stringify(now) !== JSON.stringify(this.design)) {
        return fail(`${tableLabel(this.tableInfo)} was changed since this form opened, so nothing was inserted. Reload to start from the current table.`, true);
      }
      this.data = { existing: [], parents: [] };
      const data = await this.ensureData(driver, table, request);
      const blocked = mockNotes(table, request, data).find((n) => n.tone === 'error');
      if (blocked) return fail(blocked.text);
      const generated = generateRows(table, request, data);
      const names = table.columns.filter((_, i) => request.settings[i].generator !== 'skip').map((c) => c.name);
      this.post({ type: 'status', state: 'busy', text: `0 of ${request.rows.toLocaleString()} rows` });
      const result = await driver.importRows(this.tableInfo, names, asImportRows(generated), {
        deleteFirst: false,
        cancelled: () => this.cancelled,
        onProgress: (n) => this.post({ type: 'status', state: 'busy', text: `${n.toLocaleString()} of ${request.rows.toLocaleString()} rows` }),
      });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      this.post({ type: 'status', state: 'ok', text: `Inserted ${result.inserted.toLocaleString()} rows into ${tableLabel(this.tableInfo)} in ${seconds} s.` });
    } catch (err) {
      if (err instanceof ImportCancelled) this.post({ type: 'status', state: 'info', text: 'Cancelled. Nothing was inserted.' });
      else if (err instanceof ImportError) fail(`Row ${err.line}: ${err.message} Nothing was inserted.`);
      else if (err instanceof MockError) fail(err.message);
      else fail(`The insert failed: ${errorMessage(err)} Nothing was inserted.`);
    } finally {
      // Existing values changed (or may have): read them again for the next preview.
      this.data = { existing: [], parents: [] };
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }
}

/** Dumped values as text; rows with binary values can't be compared or reused, so they're left out. */
function textRows(rows: DumpCell[][]): Cell[][] {
  return rows.filter((r) => r.every((v) => v === null || typeof v === 'string')) as Cell[][];
}

async function* asImportRows(rows: Cell[][]): AsyncGenerator<ImportRow> {
  for (const [i, values] of rows.entries()) yield { line: i + 1, values };
}

function tableLabel(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}
