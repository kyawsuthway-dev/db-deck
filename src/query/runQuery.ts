import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { typeLabel } from '../drivers';
import { isBinaryType } from '../export/formats';
import type { ColumnInfo, Driver, FilterHints, SortKey, StatementResult, TableInfo } from '../types';
import type { ResultsPanel, ResultsRequest, TableViewState } from '../views/ResultsPanel';
import { splitSql, splitSqlRanges, statementAt, stripLeadingComments } from './splitSql';

const FILE_CONNECTIONS_KEY = 'dbDeck.documentConnections';
/** Hidden table-view columns, by connection and table: `{ [key]: names }`. */
const HIDDEN_COLUMNS_KEY = 'dbDeck.hiddenColumns';

/** Rows per page in a table view. */
export const PAGE_SIZE = 100;

/** The table shown in the Results panel, so its page and sort controls know what to query. */
interface TableView {
  connectionId: string;
  table: TableInfo;
  label: string;
  /** Column names, to check sort requests coming from the webview. */
  columns: string[];
  /** Primary key order; empty when the table or view has none. */
  keyOrder: SortKey[];
  offset: number;
  sort?: SortKey;
  /** The WHERE box's condition, as typed. */
  where?: string;
  /** Autocomplete for the WHERE box, built once when the table opens. */
  hints: FilterHints;
  /** Column names the user hid; remembered per table in workspaceState. */
  hidden: string[];
  /** The Count button's result for the current filter; cleared when the filter changes or after a save. */
  total?: string;
  /** In a system schema (`Driver.isSystemSchema`): never editable, however the table was opened. */
  system: boolean;
}

/** What the export and edit services need to know about the open table view. */
export interface TableViewSource {
  connectionId: string;
  table: TableInfo;
  label: string;
  where?: string;
  /** The sort, or the primary key order; empty when neither exists (batches may then repeat or skip rows). */
  orderBy: SortKey[];
  /** Column names and types, in table order. */
  columns: { name: string; type: string }[];
  /** Primary key column names; empty when there is none. */
  key: string[];
  /** In a system schema: the edit service refuses to save. */
  system: boolean;
}

/** A finished run from a SQL editor (Run Query, Run All, ▶ Run, Run Again). */
export interface QueryRun {
  connectionId: string;
  sql: string;
  results: StatementResult[];
  startedAt: Date;
}

/** Statements after which cached tables and columns may be out of date. */
const SCHEMA_CHANGE = /^(CREATE|ALTER|DROP|RENAME)\b/i;

/** Longest filter condition accepted from the webview. */
const MAX_WHERE_LENGTH = 10_000;

/**
 * Links SQL editors to connections and runs their contents.
 * Untitled editors are remembered for the session; saved .sql files per workspace.
 */
export class QueryController implements vscode.Disposable {
  private readonly untitled = new Map<string, string>();
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly disposables: vscode.Disposable[] = [];
  private tableView?: TableView;
  /** Pending edits the grid reports; replacing the view asks first when there are any. */
  private pendingCount = 0;
  private linked?: boolean;
  private readonly connectionChanged = new vscode.EventEmitter<vscode.TextDocument>();
  private readonly schemaChanged = new vscode.EventEmitter<string>();
  private readonly ran = new vscode.EventEmitter<QueryRun>();
  /** Other ways a document is linked to a connection (saved queries: their folder). */
  private readonly linkResolvers = new Set<(uri: vscode.Uri) => string | undefined>();

  /** An editor was linked to a (different) connection. */
  readonly onDidChangeConnection = this.connectionChanged.event;
  /** A run included CREATE / ALTER / DROP / RENAME, so cached tables and columns may be out of date. */
  readonly onDidChangeSchema = this.schemaChanged.event;
  /** A run from a SQL editor finished (for query history). Table views and paging don't count. */
  readonly onDidRun = this.ran.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly panel: ResultsPanel,
  ) {
    this.statusItem.command = 'dbDeck.selectConnection';
    this.statusItem.tooltip = 'Connection used by Run Query (click to change)';
    this.disposables.push(
      this.statusItem,
      this.connectionChanged,
      this.schemaChanged,
      this.ran,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      manager.onDidChange(() => this.updateStatus()),
      vscode.workspace.onDidCloseTextDocument((doc) => this.untitled.delete(doc.uri.toString())),
      panel.onDidRequest((request) => this.onPanelRequest(request)),
    );
    this.updateStatus();
  }

  /** Opens a new SQL editor bound to a connection. */
  async newQuery(connectionId?: string, initialSql = ''): Promise<void> {
    connectionId ??= await this.pickConnection();
    if (!connectionId) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: initialSql });
    await this.setConnection(doc, connectionId);
    const editor = await vscode.window.showTextDocument(doc);
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
  }

  /** Runs the selection, or the statement at the cursor if nothing is selected. */
  runActiveEditor(): Promise<void> {
    return this.runEditor('cursor');
  }

  /** Runs everything in the active editor. */
  runAll(): Promise<void> {
    return this.runEditor('all');
  }

  /**
   * Runs the statement at `offset` in an open SQL document (the ▶ Run CodeLens). The text is read now,
   * not when the lens was drawn, so an edit in between can't run stale SQL.
   */
  async runStatementAt(uri: unknown, offset: unknown): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (!doc || typeof offset !== 'number' || !Number.isSafeInteger(offset)) return;
    const connectionId = this.connectionFor(doc);
    if (!connectionId) return;
    const text = doc.getText();
    const statement = statementAt(text, splitSqlRanges(text, this.manager.get(connectionId)!.type), offset);
    if (statement) await this.runSql(connectionId, statement.text);
  }

  private async runEditor(scope: 'cursor' | 'all'): Promise<void> {
    const picked = await this.editorSql(scope);
    if (picked) await this.runSql(picked.connectionId, picked.sql);
  }

  /**
   * The SQL the active editor would run (Run Query, Explain): the whole editor, the selection, or the
   * statement at the cursor; asks for a connection if the editor has none. Says why when there's nothing.
   */
  async editorSql(scope: 'cursor' | 'all' = 'cursor'): Promise<{ connectionId: string; sql: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a SQL editor to run a query (DB Deck: New Query).');
      return undefined;
    }
    const doc = editor.document;
    if (!doc.getText().trim()) {
      void vscode.window.showInformationMessage('There is no SQL to run.');
      return undefined;
    }
    let connectionId = this.connectionFor(doc);
    if (!connectionId) {
      connectionId = await this.pickConnection();
      if (!connectionId) return undefined;
      await this.setConnection(doc, connectionId);
    }
    let sql: string;
    if (scope === 'all') {
      sql = doc.getText();
    } else if (!editor.selection.isEmpty) {
      sql = doc.getText(editor.selection);
    } else {
      const text = doc.getText();
      const statement = statementAt(text, splitSqlRanges(text, this.manager.get(connectionId)!.type), doc.offsetAt(editor.selection.active));
      sql = statement?.text ?? '';
    }
    if (!sql.trim()) {
      void vscode.window.showInformationMessage('There is no SQL to run.');
      return undefined;
    }
    return { connectionId, sql };
  }

  /** The statement at `offset` in an open SQL document, read now (the Explain CodeLens). */
  statementIn(uri: unknown, offset: unknown): { connectionId: string; sql: string } | undefined {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (!doc || typeof offset !== 'number' || !Number.isSafeInteger(offset)) return undefined;
    const connectionId = this.connectionFor(doc);
    if (!connectionId) return undefined;
    const text = doc.getText();
    const statement = statementAt(text, splitSqlRanges(text, this.manager.get(connectionId)!.type), offset);
    return statement ? { connectionId, sql: statement.text } : undefined;
  }

  /**
   * Runs SQL on a connection, as if run from an editor (Run Again, saved queries). When the connection
   * is missing or was removed, asks which one to use.
   */
  async runSqlOn(connectionId: string | undefined, sql: string): Promise<void> {
    const id = connectionId && this.manager.get(connectionId) ? connectionId : await this.pickConnection();
    if (id) await this.runSql(id, sql);
  }

  /** Opens SQL in a new editor, linked to the connection if it still exists. Nothing runs. */
  async openSql(connectionId: string | undefined, sql: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    if (connectionId && this.manager.get(connectionId)) await this.setConnection(doc, connectionId);
    await vscode.window.showTextDocument(doc);
  }

  /**
   * Adds another way to find a document's connection, used when it has no explicit link
   * (saved queries: from their folder). Returns a disposable that removes it.
   */
  registerLinkResolver(resolve: (uri: vscode.Uri) => string | undefined): vscode.Disposable {
    this.linkResolvers.add(resolve);
    this.updateStatus();
    return new vscode.Disposable(() => this.linkResolvers.delete(resolve));
  }

  private async runSql(connectionId: string, sql: string): Promise<void> {
    const name = this.manager.get(connectionId)?.name ?? 'Query';
    if (!(await this.confirmDiscard())) return;
    await this.execute(connectionId, sql, `Query · ${name}`, vscode.ViewColumn.Beside);
  }

  /** Opens a table view at its first page, ordered by primary key when there is one. */
  async previewTable(connectionId: string, table: TableInfo, label: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    let columns: ColumnInfo[];
    let hints: FilterHints;
    let system: boolean;
    try {
      const driver = await this.manager.getDriver(connectionId);
      system = driver.isSystemSchema(table.schema);
      columns = await driver.listColumns(table);
      hints = {
        columns: columns.map((c) => ({ name: c.name, type: c.type, insert: driver.filterIdentifier(c.name) })),
        operators: driver.filterOperators(),
      };
    } catch (err) {
      void vscode.window.showErrorMessage(`DB Deck: ${errorMessage(err)}`);
      return;
    }
    this.tableView = {
      connectionId,
      table,
      label,
      columns: columns.map((c) => c.name),
      keyOrder: columns.filter((c) => c.primaryKey).map((c): SortKey => ({ column: c.name, direction: 'asc' })),
      offset: 0,
      hints,
      hidden: [],
      system,
    };
    const remembered = this.context.workspaceState.get<Record<string, string[]>>(HIDDEN_COLUMNS_KEY, {})[hiddenKey(this.tableView)];
    // Columns that no longer exist are dropped.
    if (Array.isArray(remembered)) this.tableView.hidden = remembered.filter((n) => this.tableView!.columns.includes(n));
    await this.showTablePage(this.tableView, true);
  }

  /** The table shown in the panel, with its filter, order and key, for export and editing. */
  currentTableView(): TableViewSource | undefined {
    const view = this.tableView;
    if (!view) return undefined;
    return {
      connectionId: view.connectionId,
      table: view.table,
      label: view.label,
      where: view.where,
      orderBy: view.sort ? [view.sort] : view.keyOrder,
      columns: view.hints.columns.map((c) => ({ name: c.name, type: c.type })),
      key: view.keyOrder.map((k) => k.column),
      system: view.system,
    };
  }

  /** Reloads the open table page, keeping its filter, sort and offset (after saving edits). */
  async reloadTablePage(): Promise<void> {
    if (!this.tableView) return;
    // Inserts and deletes change the count.
    this.tableView.total = undefined;
    await this.showTablePage(this.tableView, false);
  }

  /** The webview already shows the change; this remembers it for the next time the table opens. */
  private async rememberHidden(view: TableView, names: unknown): Promise<void> {
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && view.columns.includes(n))) return;
    view.hidden = [...new Set(names as string[])];
    const all = this.context.workspaceState.get<Record<string, string[]>>(HIDDEN_COLUMNS_KEY, {});
    const key = hiddenKey(view);
    const next = { ...all };
    if (view.hidden.length) next[key] = view.hidden;
    else delete next[key];
    await this.context.workspaceState.update(HIDDEN_COLUMNS_KEY, next);
  }

  /** SELECT COUNT(*) with the current filter (the Count button). The page on screen gets the total. */
  private async countRows(view: TableView): Promise<void> {
    const shown = this.panel.lastResults();
    if (!shown?.table) return;
    try {
      const driver = await this.manager.getDriver(view.connectionId);
      view.total = await driver.countRows(view.table, view.where);
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn’t count the rows: ${errorMessage(err)}`);
    }
    // Sent even after an error, so the webview leaves its "Counting…" state.
    if (this.tableView === view) this.panel.updateTable(shown, tableState(view, shown.table.hasMore, this.readOnly(view.connectionId)));
  }

  /** Forgets the grid's pending edits (saved, or the user chose to discard them). */
  clearPending(): void {
    this.pendingCount = 0;
    this.panel.clearPending();
  }

  /** True when there are no pending edits, or the user agreed to discard them. */
  private async confirmDiscard(): Promise<boolean> {
    const n = this.pendingCount;
    if (n === 0) return true;
    const choice = await vscode.window.showWarningMessage(
      `Discard ${n} pending change${n === 1 ? '' : 's'} in the Results grid?`,
      { modal: true, detail: 'They haven’t been saved to the database.' },
      'Discard',
    );
    if (choice !== 'Discard') return false;
    this.clearPending();
    return true;
  }

  /** Lets the user pick the connection for the active SQL editor. */
  async selectConnectionForActiveEditor(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return;
    const id = await this.pickConnection();
    if (id) await this.setConnection(doc, id);
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** Page and sort requests come from the webview, so they're checked against the open table view. */
  private onPanelRequest(request: Exclude<ResultsRequest, { type: 'ready' }>): void {
    if (request.type === 'pending') {
      if (Number.isSafeInteger(request.count) && request.count >= 0) this.pendingCount = request.count;
      return;
    }
    const view = this.tableView;
    // Only the table view's own requests are handled here; export and copy go to ResultsExporter, save to
    // TableEditor. Anything else is ignored, so a new request type can't reload the page by accident.
    if (!view) return;
    if (request.type === 'hideColumns') {
      void this.rememberHidden(view, request.names);
      return;
    }
    if (request.type === 'count') {
      void this.countRows(view);
      return;
    }
    if (request.type === 'page') {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) return;
      view.offset = request.offset;
    } else if (request.type === 'filter') {
      if (typeof request.where !== 'string' || request.where.length > MAX_WHERE_LENGTH) return;
      // Typed by the user and run as their own SQL (core.md rule 4); the driver checks it's one statement.
      view.where = request.where.trim() || undefined;
      view.offset = 0;
      view.total = undefined;
    } else if (request.type === 'sort') {
      const sort = request.sort;
      if (sort && (!view.columns.includes(sort.column) || (sort.direction !== 'asc' && sort.direction !== 'desc'))) return;
      view.sort = sort && { column: sort.column, direction: sort.direction };
      view.offset = 0;
    } else {
      return;
    }
    void this.showTablePage(view, false);
  }

  /** Fetches one extra row to know whether there's a next page, without a COUNT(*). */
  private async showTablePage(view: TableView, firstLoad: boolean): Promise<void> {
    let driver: Driver;
    try {
      driver = await this.manager.getDriver(view.connectionId);
    } catch (err) {
      if (firstLoad) {
        void vscode.window.showErrorMessage(`DB Deck: ${errorMessage(err)}`);
      } else {
        // Show it in the grid so the webview leaves its busy state and the user can retry.
        const failed: StatementResult = { sql: '', columns: [], rows: [], durationMs: 0, error: errorMessage(err) };
        this.panel.showResults(this.panel.startRun(), view.label, [failed], tableState(view, false, this.readOnly(view.connectionId)));
      }
      return;
    }
    const page = { limit: PAGE_SIZE + 1, offset: view.offset, orderBy: view.sort ? [view.sort] : view.keyOrder };
    // A first load shows "Running…"; paging keeps the grid on screen while the webview shows it's busy.
    const token = firstLoad
      ? this.panel.showLoading(view.label, driver.previewSql(view.table, page), vscode.ViewColumn.Active)
      : this.panel.startRun();
    let result: StatementResult;
    try {
      result = await driver.selectPage(view.table, page, view.where);
    } catch (err) {
      result = { sql: '', columns: [], rows: [], durationMs: 0, error: errorMessage(err) };
    }
    const hasMore = result.rows.length > PAGE_SIZE;
    if (hasMore) result.rows = result.rows.slice(0, PAGE_SIZE);
    this.panel.showResults(token, view.label, [result], tableState(view, hasMore, this.readOnly(view.connectionId)));
  }

  private async execute(connectionId: string, sql: string, title: string, column: vscode.ViewColumn) {
    // The panel now shows query results, so page and sort requests no longer apply to a table.
    this.tableView = undefined;
    const token = this.panel.showLoading(title, sql, column);
    const startedAt = new Date();
    let results: StatementResult[];
    try {
      results = await (await this.manager.getDriver(connectionId)).query(sql);
    } catch (err) {
      results = [{ sql, columns: [], rows: [], durationMs: 0, error: errorMessage(err) }];
    }
    this.panel.showResults(token, title, results);
    this.ran.fire({ connectionId, sql, results, startedAt });
    const type = this.manager.get(connectionId)?.type;
    if (type && splitSql(sql, type).some((st) => SCHEMA_CHANGE.test(stripLeadingComments(st)))) this.schemaChanged.fire(connectionId);
  }

  /** The connection an editor is linked to, if any. */
  connectionFor(doc: vscode.TextDocument): string | undefined {
    const key = doc.uri.toString();
    let id = doc.isUntitled ? this.untitled.get(key) : this.fileConnections()[key];
    if (!id) for (const resolve of this.linkResolvers) id ??= resolve(doc.uri);
    return id && this.manager.get(id) ? id : undefined;
  }

  private async setConnection(doc: vscode.TextDocument, connectionId: string): Promise<void> {
    const key = doc.uri.toString();
    if (doc.isUntitled) {
      this.untitled.set(key, connectionId);
    } else {
      await this.context.workspaceState.update(FILE_CONNECTIONS_KEY, { ...this.fileConnections(), [key]: connectionId });
    }
    this.updateStatus();
    this.connectionChanged.fire(doc);
  }

  private fileConnections(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(FILE_CONNECTIONS_KEY, {});
  }

  async pickConnection(): Promise<string | undefined> {
    const connections = this.manager.list();
    if (connections.length === 0) {
      const add = await vscode.window.showInformationMessage('No database connections yet.', 'Add Connection');
      if (add) await vscode.commands.executeCommand('dbDeck.addConnection');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      connections.map((c) => ({ label: c.name, description: typeLabel(c.type), id: c.id })),
      { placeHolder: 'Choose a connection' },
    );
    return picked?.id;
  }

  private readOnly(connectionId: string): boolean {
    return !!this.manager.get(connectionId)?.readOnly;
  }

  /** The status bar item, and the `dbDeck.editorLinked` context key that DB Deck's keybindings depend on. */
  private updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'sql') {
      this.statusItem.hide();
      this.setLinked(false);
      return;
    }
    const id = this.connectionFor(doc);
    const config = id ? this.manager.get(id) : undefined;
    this.statusItem.text = `$(${config?.readOnly ? 'lock' : 'database'}) ${config ? config.name : 'No connection'}`;
    this.statusItem.tooltip = config?.readOnly
      ? 'Read-only connection used by Run Query (click to change)'
      : 'Connection used by Run Query (click to change)';
    this.statusItem.show();
    this.setLinked(!!id);
  }

  /**
   * Ctrl/Cmd+Enter, Ctrl/Cmd+Shift+Enter and Ctrl/Cmd+S (untitled) apply only in editors linked to a DB Deck
   * connection, so other SQL extensions keep their own keys in their editors.
   */
  private setLinked(linked: boolean): void {
    if (linked === this.linked) return;
    this.linked = linked;
    void vscode.commands.executeCommand('setContext', 'dbDeck.editorLinked', linked);
  }
}

function tableState(view: TableView, hasMore: boolean, readOnly: boolean): TableViewState {
  return {
    offset: view.offset,
    pageSize: PAGE_SIZE,
    hasMore,
    sort: view.sort,
    orderedByKey: view.keyOrder.length > 0,
    where: view.where,
    hints: view.hints,
    edit: editability(view, readOnly),
    hidden: view.hidden,
    types: Object.fromEntries(view.hints.columns.map((c) => [c.name, c.type])),
    total: view.total,
  };
}

function hiddenKey(view: TableView): string {
  return `${view.connectionId}\u0000${view.table.schema ?? ''}\u0000${view.table.name}`;
}

/** Only tables with a primary key are editable, so every change targets exactly one row. Binary columns stay read-only. */
function editability(view: TableView, readOnly: boolean): TableViewState['edit'] {
  if (readOnly) return { reason: 'Read-only connection.' };
  if (view.system) return { reason: 'System schema: read-only.' };
  if (view.table.kind !== 'table') return { reason: 'Views are read-only.' };
  if (!view.keyOrder.length) return { reason: 'Read-only: this table has no primary key.' };
  return {
    key: view.keyOrder.map((k) => k.column),
    readOnly: view.hints.columns.filter((c) => isBinaryType(c.type)).map((c) => c.name),
  };
}
