import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { describeChange, diffDesign, type DesignChange } from '../design/diff';
import { changeNotes, type DesignNote, type DesignNoteTone } from '../design/notes';
import { checkDesign, parseDesign, withServerFields, type DesignErrors, type TableDesign } from '../design/model';
import { errorMessage, ScriptError } from '../drivers/common';
import { createDriver, DB_KINDS, TABLE_FEATURES, TRANSACTIONAL_DDL, typeLabel } from '../drivers';
import type { TableInfo } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

export type { DesignNoteTone };
type Init = Extract<DesignMessage, { type: 'init' }>;

/** Messages to the Table Designer (src/webview/tableDesignForm.ts). */
export type DesignMessage =
  | {
      type: 'init';
      /** `create`: New Table. `alter`: Design Table, starting from the table as read. */
      mode: 'create' | 'alter';
      title: string;
      detail: string;
      logo?: { light: string; dark: string };
      features: { types: string[]; comments: boolean; autoIncrement: string; referentialActions: string[]; reorder: 'alter' | 'rebuild' | 'none' };
      /** Schemas to choose from; empty when there's only one. */
      schemas: string[];
      /** Tables a foreign key can reference (`key` is an index into the extension's list). */
      tables: { key: string; label: string; name: string; schema?: string }[];
      design: TableDesign;
    }
  | { type: 'refColumns'; key: string; columns: string[] }
  /** The SQL for the current design, and what's wrong with it (by field path). */
  | { type: 'preview'; statements: string[]; errors: DesignErrors; notes: { tone: DesignNoteTone; text: string }[]; changes: string[] }
  | { type: 'running'; running: boolean }
  /** `created`: offer Show Rows / Design Table. `reload`: the table changed meanwhile; offer Reload. */
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; created?: boolean; reload?: boolean };

/** Messages from the designer. Untrusted: the design is parsed and checked again before anything runs. */
export type DesignRequest =
  | { type: 'ready' }
  | { type: 'change'; design: TableDesign }
  | { type: 'refColumns'; key: string }
  | { type: 'create'; design: TableDesign }
  | { type: 'apply'; design: TableDesign }
  | { type: 'reload' }
  | { type: 'copySql' }
  | { type: 'showRows' }
  | { type: 'designTable' }
  | { type: 'close' };

/** New Table… and Design Table… (alter an existing table): the same form. */
export class TableDesignForms implements vscode.Disposable {
  private readonly forms = new FormTabs<TableDesignPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    /** After a table is created: refresh the tree and suggestions, then show it. */
    private readonly onCreated: (connectionId: string, table: TableInfo) => Promise<void>,
  ) {}

  /** `schema`: where it was opened (a schema folder); otherwise the connection's default. */
  openNew(connectionId: string, schema?: string): void {
    const config = this.manager.get(connectionId);
    if (!config) return;
    if (config.readOnly) {
      void vscode.window.showErrorMessage(`"${config.name}" is read-only, so DB Deck won’t create tables on it.`);
      return;
    }
    // Several New Table forms may be open at once: each gets its own tab.
    this.forms.open(`new:${connectionId}:${Date.now()}`, () => new TableDesignPanel(this.extensionUri, this.manager, connectionId, schema, this.onCreated));
  }

  openDesign(connectionId: string, table: TableInfo): void {
    const config = this.manager.get(connectionId);
    if (!config || table.kind !== 'table') return;
    if (config.readOnly) {
      void vscode.window.showErrorMessage(`"${config.name}" is read-only, so DB Deck won’t change tables on it.`);
      return;
    }
    this.forms.open(`design:${connectionId}:${table.schema ?? ''}.${table.name}`, () =>
      new TableDesignPanel(this.extensionUri, this.manager, connectionId, table.schema, this.onCreated, table),
    );
  }

  dispose(): void {
    this.forms.dispose();
  }
}

class TableDesignPanel extends FormPanel<DesignMessage> {
  private tables: TableInfo[] = [];
  private design?: TableDesign;
  private statements: string[] = [];
  private running = false;
  private created?: TableInfo;
  /** Design Table: the table as read when the form opened (or after the last apply / reload). */
  private original?: TableDesign;
  /** Rows in the table (for the rebuild note) and NULL counts per column (for NOT NULL warnings). */
  private rowCount?: string;
  private readonly nullCounts = new Map<string, number>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly connectionId: string,
    private readonly schema: string | undefined,
    private readonly onCreated: (connectionId: string, table: TableInfo) => Promise<void>,
    /** Set for Design Table. */
    private readonly existing?: TableInfo,
  ) {
    super(extensionUri, 'dbDeck.tableDesign', existing ? `Design ${existing.name}` : 'New Table', 'tableDesignForm');
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.init();
      case 'close':
        if (!this.running) this.dispose();
        return;
      case 'change': {
        const design = parseDesign(msg.design);
        if (design) this.preview(design);
        return;
      }
      case 'refColumns': {
        const t = typeof msg.key === 'string' && /^\d+$/.test(msg.key) ? this.tables[+msg.key] : undefined;
        if (!t) return;
        try {
          const columns = await (await this.manager.getDriver(this.connectionId)).listColumns(t);
          this.post({ type: 'refColumns', key: msg.key as string, columns: columns.map((c) => c.name) });
        } catch (err) {
          this.post({ type: 'status', state: 'error', text: `Couldn’t read ${t.name}: ${errorMessage(err)}` });
        }
        return;
      }
      case 'copySql':
        await vscode.env.clipboard.writeText(this.statements.join('\n\n'));
        return;
      case 'showRows': {
        const table = this.created ?? this.existing;
        if (table) await vscode.commands.executeCommand('dbDeck.previewTable', { connectionId: this.connectionId, table });
        return;
      }
      case 'designTable':
        if (this.created) await vscode.commands.executeCommand('dbDeck.designTable', { connectionId: this.connectionId, table: this.created });
        return;
      case 'reload':
        if (!this.running) await this.init();
        return;
      case 'apply': {
        const design = parseDesign(msg.design);
        if (design) await this.apply(design);
        return;
      }
      case 'create': {
        const design = parseDesign(msg.design);
        if (design) await this.create(design);
        return;
      }
    }
  }

  private async init(): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    const features = TABLE_FEATURES[config.type];
    const kind = DB_KINDS.find((k) => k.type === config.type);
    let schemas: string[] = [];
    let defaultSchema = this.schema;
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const objects = await driver.listObjects();
      this.tables = (await driver.listTables()).filter((t) => t.kind === 'table');
      const label = driver.defaultSchemaLabel();
      const named = new Set(objects.map((o) => o.schema).filter((s): s is string => !!s));
      if (label) named.add(label);
      schemas = named.size > 1 ? [...named].sort() : [];
      defaultSchema ??= schemas.length ? label : undefined;
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t read ${config.name}: ${errorMessage(err)}` });
    }
    if (this.existing) return this.initAlter(features, kind && this.logo(kind.logo), schemas);
    const intType = features.types[0];
    const design: TableDesign = {
      schema: defaultSchema,
      name: '',
      comment: '',
      columns: [{ key: 'c1', name: 'id', type: intType, nullable: false, default: '', primaryKey: true, autoIncrement: true, comment: '' }],
      indexes: [],
      foreignKeys: [],
      checks: [],
    };
    this.post({
      type: 'init',
      mode: 'create',
      title: 'New Table',
      detail: `${config.name} · ${typeLabel(config.type)}`,
      logo: kind && this.logo(kind.logo),
      features: this.featuresFor(features),
      schemas,
      tables: this.tableList(),
      design,
    });
    this.preview(design);
  }

  private featuresFor(f: (typeof TABLE_FEATURES)[keyof typeof TABLE_FEATURES]): Init['features'] {
    return { types: f.types, comments: f.comments, autoIncrement: f.autoIncrement, referentialActions: f.referentialActions, reorder: f.reorder };
  }

  private tableList(): Init['tables'] {
    return this.tables.map((t, i) => ({ key: String(i), label: t.schema ? `${t.schema}.${t.name}` : t.name, name: t.name, schema: t.schema }));
  }

  /** Design Table: read the table, then show it in the form. */
  private async initAlter(features: (typeof TABLE_FEATURES)[keyof typeof TABLE_FEATURES], logo: Init['logo'], schemas: string[]): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config || !this.existing) return;
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      this.original = await driver.readDesign(this.existing);
      this.rowCount = await driver.countRows(this.existing);
      this.nullCounts.clear();
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t read ${this.existing.name}: ${errorMessage(err)}` });
      return;
    }
    // What the form may edit; the SQL to restore and the constraint names stay here (withServerFields).
    const { preserved: _p, primaryKeyName: _k, ...shown } = this.original;
    this.post({
      type: 'init',
      mode: 'alter',
      title: 'Design Table',
      detail: `${this.existing.schema ? `${this.existing.schema}.` : ''}${this.existing.name} · ${config.name} · ${typeLabel(config.type)}`,
      logo,
      features: this.featuresFor(features),
      schemas: schemas.length ? [this.original.schema ?? schemas[0]] : [],
      tables: this.tableList(),
      design: shown,
    });
    this.preview(shown);
  }

  /** Checks the design and builds its SQL; the form shows both. */
  private preview(design: TableDesign): { ok: boolean } {
    this.design = design;
    if (this.original) return { ok: this.previewAlter(design).ok };
    const config = this.manager.get(this.connectionId);
    if (!config) return { ok: false };
    const errors = checkDesign(design, TABLE_FEATURES[config.type], config.type);
    let statements: string[] = [];
    if (!Object.keys(errors).length) {
      try {
        // Building the SQL needs no connection: a driver's SQL builders are pure.
        statements = createDriver(config, undefined).createTableSql(design);
      } catch (err) {
        errors.name = errorMessage(err);
      }
    }
    this.statements = statements;
    const notes: { tone: DesignNoteTone; text: string }[] = [];
    if (statements.length > 1 && !TRANSACTIONAL_DDL[config.type]) {
      notes.push({
        tone: 'warning',
        text: 'This database commits each CREATE statement on its own: if a later one fails (an index, say), the table stays created without it.',
      });
    } else {
      notes.push({ tone: 'info', text: 'Runs in one transaction on its own connection: if any statement fails, nothing is created.' });
    }
    this.post({ type: 'preview', statements, errors, notes, changes: [] });
    return { ok: !Object.keys(errors).length && statements.length > 0 };
  }

  /** Design Table: the changes from the table as read, their SQL, and what they may do to the data. */
  private previewAlter(edited: TableDesign): { ok: boolean; statements: string[]; changes: DesignChange[] } {
    const config = this.manager.get(this.connectionId);
    const original = this.original;
    if (!config || !original) return { ok: false, statements: [], changes: [] };
    const after = withServerFields({ ...edited, schema: original.schema, name: original.name }, original);
    const errors = checkDesign(after, TABLE_FEATURES[config.type], config.type);
    const changes = Object.keys(errors).length ? [] : diffDesign(original, after);
    let statements: string[] = [];
    let rebuild = false;
    if (changes.length) {
      try {
        ({ statements, rebuild } = createDriver(config, undefined).alterTableSql(original, after, changes));
      } catch (err) {
        errors.columns = errorMessage(err);
      }
    }
    this.statements = statements;
    const notes: DesignNote[] = changeNotes(changes, (c) => {
      const nulls = this.nullCounts.get(c.after.key);
      if (nulls === undefined) void this.countNulls(c.after.key, c.before.name);
      return nulls;
    });
    if (rebuild) {
      notes.push({
        tone: 'warning',
        text: `SQLite can’t make this change in place: the table is rebuilt (its ${this.rowCount ?? ''} rows copied into a new table, indexes and triggers recreated), in one transaction.`,
      });
    }
    if (statements.length && !TRANSACTIONAL_DDL[config.type]) {
      notes.push({ tone: 'info', text: 'Everything is one ALTER TABLE statement: MySQL commits it on its own, but it applies whole or not at all.' });
    } else if (statements.length) {
      notes.push({ tone: 'info', text: 'Runs in one transaction on its own connection: if any statement fails, nothing is changed.' });
    }
    if (!changes.length && !Object.keys(errors).length) notes.push({ tone: 'info', text: 'No changes yet.' });
    this.post({ type: 'preview', statements, errors, notes, changes: changes.map(describeChange) });
    return { ok: !Object.keys(errors).length && statements.length > 0, statements, changes };
  }

  /** Counts NULLs of a column that's becoming NOT NULL (read-only), then refreshes the notes. */
  private async countNulls(key: string, column: string): Promise<void> {
    if (!this.existing || this.nullCounts.has(key)) return;
    this.nullCounts.set(key, 0);
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      this.nullCounts.set(key, Number(await driver.countRows(this.existing, `${driver.filterIdentifier(column)} IS NULL`)));
    } catch {
      this.nullCounts.delete(key);
      return;
    }
    if (this.design) this.previewAlter(this.design);
  }

  /** Design Table's Apply: re-read the table, refuse if it changed meanwhile, then run the ALTER SQL. */
  private async apply(edited: TableDesign): Promise<void> {
    if (this.running || !this.existing || !this.original) return;
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    if (config.readOnly) {
      this.post({ type: 'status', state: 'error', text: `"${config.name}" is read-only, so DB Deck won’t change tables on it.` });
      return;
    }
    this.design = edited;
    const planned = this.previewAlter(edited);
    if (!planned.ok) {
      this.post({ type: 'status', state: 'error', text: planned.changes.length ? 'Check the highlighted fields.' : 'There are no changes to apply.' });
      return;
    }
    this.running = true;
    this.post({ type: 'running', running: true });
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const now = await driver.readDesign(this.existing);
      if (JSON.stringify(now) !== JSON.stringify(this.original)) {
        this.post({
          type: 'status',
          state: 'error',
          text: `${this.existing.name} was changed since this form opened, so nothing was applied. Reload to start from the current table (your edits here are lost).`,
          reload: true,
        });
        return;
      }
      this.post({ type: 'status', state: 'busy', text: `Applying ${planned.changes.length} change${planned.changes.length === 1 ? '' : 's'}…` });
      await driver.runScript(planned.statements, { transaction: true });
      await this.onCreated(this.connectionId, this.existing);
      this.running = false;
      await this.init();
      this.post({ type: 'status', state: 'ok', text: `Applied ${planned.changes.length} change${planned.changes.length === 1 ? '' : 's'} to ${this.existing.name}.` });
    } catch (err) {
      const which = err instanceof ScriptError && planned.statements.length > 1 ? `Statement ${err.index + 1} failed: ` : '';
      const kept = TRANSACTIONAL_DDL[config.type] || planned.statements.length === 1 ? 'Nothing was changed.' : 'Statements before it may have been kept.';
      this.post({ type: 'status', state: 'error', text: `${which}${errorMessage(err)} ${kept}` });
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }

  private async create(design: TableDesign): Promise<void> {
    if (this.running) return;
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    if (config.readOnly) {
      this.post({ type: 'status', state: 'error', text: `"${config.name}" is read-only, so DB Deck won’t create tables on it.` });
      return;
    }
    const driver = await this.manager.getDriver(this.connectionId);
    if (!this.preview(design).ok) {
      this.post({ type: 'status', state: 'error', text: 'Check the highlighted fields.' });
      return;
    }
    const statements = driver.createTableSql(design);
    this.running = true;
    this.post({ type: 'running', running: true });
    this.post({ type: 'status', state: 'busy', text: 'Creating the table…' });
    try {
      await driver.runScript(statements, { transaction: true });
      const table: TableInfo = { name: design.name.trim(), schema: design.schema, kind: 'table' };
      this.created = table;
      this.post({ type: 'status', state: 'ok', text: `Created ${design.schema ? `${design.schema}.` : ''}${table.name}.`, created: true });
      this.panel.title = table.name;
      await this.onCreated(this.connectionId, table);
    } catch (err) {
      const which = err instanceof ScriptError && statements.length > 1 ? `Statement ${err.index + 1} failed: ` : '';
      const kept = TRANSACTIONAL_DDL[config.type] ? 'Nothing was created.' : 'Statements before it may have been kept.';
      this.post({ type: 'status', state: 'error', text: `${which}${errorMessage(err)} ${kept}` });
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }
}
