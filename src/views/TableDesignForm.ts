import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { checkDesign, parseDesign, type DesignErrors, type TableDesign } from '../design/model';
import { errorMessage, ScriptError } from '../drivers/common';
import { createDriver, DB_KINDS, TABLE_FEATURES, TRANSACTIONAL_DDL, typeLabel } from '../drivers';
import type { TableInfo } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

export type DesignNoteTone = 'info' | 'warning' | 'error';

/** Messages to the Table Designer (src/webview/tableDesignForm.ts). */
export type DesignMessage =
  | {
      type: 'init';
      title: string;
      detail: string;
      logo?: { light: string; dark: string };
      features: { types: string[]; comments: boolean; autoIncrement: string; referentialActions: string[] };
      /** Schemas to choose from; empty when there's only one. */
      schemas: string[];
      /** Tables a foreign key can reference (`key` is an index into the extension's list). */
      tables: { key: string; label: string; name: string; schema?: string }[];
      design: TableDesign;
    }
  | { type: 'refColumns'; key: string; columns: string[] }
  /** The SQL for the current design, and what's wrong with it (by field path). */
  | { type: 'preview'; statements: string[]; errors: DesignErrors; notes: { tone: DesignNoteTone; text: string }[] }
  | { type: 'running'; running: boolean }
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; created?: boolean };

/** Messages from the designer. Untrusted: the design is parsed and checked again before anything runs. */
export type DesignRequest =
  | { type: 'ready' }
  | { type: 'change'; design: TableDesign }
  | { type: 'refColumns'; key: string }
  | { type: 'create'; design: TableDesign }
  | { type: 'copySql' }
  | { type: 'showRows' }
  | { type: 'close' };

/** New Table… (12a). Design Table… (alter, 12b) will open the same form for an existing table. */
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

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly connectionId: string,
    private readonly schema: string | undefined,
    private readonly onCreated: (connectionId: string, table: TableInfo) => Promise<void>,
  ) {
    super(extensionUri, 'dbDeck.tableDesign', 'New Table', 'tableDesignForm');
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
      case 'showRows':
        if (this.created) await vscode.commands.executeCommand('dbDeck.previewTable', { connectionId: this.connectionId, table: this.created });
        return;
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
      title: 'New Table',
      detail: `${config.name} · ${typeLabel(config.type)}`,
      logo: kind && this.logo(kind.logo),
      features: { types: features.types, comments: features.comments, autoIncrement: features.autoIncrement, referentialActions: features.referentialActions },
      schemas,
      tables: this.tables.map((t, i) => ({ key: String(i), label: t.schema ? `${t.schema}.${t.name}` : t.name, name: t.name, schema: t.schema })),
      design,
    });
    this.preview(design);
  }

  /** Checks the design and builds its SQL; the form shows both. */
  private preview(design: TableDesign): { ok: boolean } {
    const config = this.manager.get(this.connectionId);
    if (!config) return { ok: false };
    this.design = design;
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
    this.post({ type: 'preview', statements, errors, notes });
    return { ok: !Object.keys(errors).length && statements.length > 0 };
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
