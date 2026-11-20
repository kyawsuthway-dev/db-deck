import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { typeLabel } from '../drivers';
import type { ColumnInfo, Driver, SortKey, StatementResult, TableInfo } from '../types';
import type { ResultsPanel, ResultsRequest, TableViewState } from '../views/ResultsPanel';

const FILE_CONNECTIONS_KEY = 'dbDeck.documentConnections';

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
}

/**
 * Links SQL editors to connections and runs their contents.
 * Untitled editors are remembered for the session; saved .sql files per workspace.
 */
export class QueryController implements vscode.Disposable {
  private readonly untitled = new Map<string, string>();
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly disposables: vscode.Disposable[] = [];
  private tableView?: TableView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly panel: ResultsPanel,
  ) {
    this.statusItem.command = 'dbDeck.selectConnection';
    this.statusItem.tooltip = 'Connection used by Run Query (click to change)';
    this.disposables.push(
      this.statusItem,
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

  /** Runs the selection, or the whole editor if nothing is selected. */
  async runActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a SQL editor to run a query (DB Deck: New Query).');
      return;
    }
    const doc = editor.document;
    const sql = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
    if (!sql.trim()) {
      void vscode.window.showInformationMessage('There is no SQL to run.');
      return;
    }
    let connectionId = this.connectionFor(doc);
    if (!connectionId) {
      connectionId = await this.pickConnection();
      if (!connectionId) return;
      await this.setConnection(doc, connectionId);
    }
    const name = this.manager.get(connectionId)?.name ?? 'Query';
    await this.execute(connectionId, sql, `Query · ${name}`, vscode.ViewColumn.Beside);
  }

  /** Opens a table view at its first page, ordered by primary key when there is one. */
  async previewTable(connectionId: string, table: TableInfo, label: string): Promise<void> {
    let columns: ColumnInfo[];
    try {
      columns = await (await this.manager.getDriver(connectionId)).listColumns(table);
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
    };
    await this.showTablePage(this.tableView, true);
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
    const view = this.tableView;
    if (!view) return;
    if (request.type === 'page') {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) return;
      view.offset = request.offset;
    } else {
      const sort = request.sort;
      if (sort && (!view.columns.includes(sort.column) || (sort.direction !== 'asc' && sort.direction !== 'desc'))) return;
      view.sort = sort && { column: sort.column, direction: sort.direction };
      view.offset = 0;
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
        this.panel.showResults(this.panel.startRun(), view.label, [failed], tableState(view, false));
      }
      return;
    }
    const orderBy = view.sort ? [view.sort] : view.keyOrder;
    const sql = driver.previewSql(view.table, { limit: PAGE_SIZE + 1, offset: view.offset, orderBy });
    // A first load shows "Running…"; paging keeps the grid on screen while the webview shows it's busy.
    const token = firstLoad ? this.panel.showLoading(view.label, sql, vscode.ViewColumn.Active) : this.panel.startRun();
    let results: StatementResult[];
    try {
      results = await driver.query(sql);
    } catch (err) {
      results = [{ sql, columns: [], rows: [], durationMs: 0, error: errorMessage(err) }];
    }
    const [result] = results;
    const hasMore = !!result && result.rows.length > PAGE_SIZE;
    if (hasMore) result.rows = result.rows.slice(0, PAGE_SIZE);
    this.panel.showResults(token, view.label, results, tableState(view, hasMore));
  }

  private async execute(connectionId: string, sql: string, title: string, column: vscode.ViewColumn) {
    // The panel now shows query results, so page and sort requests no longer apply to a table.
    this.tableView = undefined;
    const token = this.panel.showLoading(title, sql, column);
    let results: StatementResult[];
    try {
      results = await (await this.manager.getDriver(connectionId)).query(sql);
    } catch (err) {
      results = [{ sql, columns: [], rows: [], durationMs: 0, error: errorMessage(err) }];
    }
    this.panel.showResults(token, title, results);
  }

  private connectionFor(doc: vscode.TextDocument): string | undefined {
    const key = doc.uri.toString();
    const id = doc.isUntitled ? this.untitled.get(key) : this.fileConnections()[key];
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
  }

  private fileConnections(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(FILE_CONNECTIONS_KEY, {});
  }

  private async pickConnection(): Promise<string | undefined> {
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

  private updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'sql') {
      this.statusItem.hide();
      return;
    }
    const id = this.connectionFor(doc);
    this.statusItem.text = `$(database) ${id ? this.manager.get(id)!.name : 'No connection'}`;
    this.statusItem.show();
  }
}

function tableState(view: TableView, hasMore: boolean): TableViewState {
  return { offset: view.offset, pageSize: PAGE_SIZE, hasMore, sort: view.sort, orderedByKey: view.keyOrder.length > 0 };
}
