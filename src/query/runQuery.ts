import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { typeLabel } from '../drivers';
import type { StatementResult, TableInfo } from '../types';
import type { ResultsPanel } from '../views/ResultsPanel';

const FILE_CONNECTIONS_KEY = 'dbDeck.documentConnections';

/**
 * Links SQL editors to connections and runs their contents.
 * Untitled editors are remembered for the session; saved .sql files per workspace.
 */
export class QueryController implements vscode.Disposable {
  private readonly untitled = new Map<string, string>();
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly disposables: vscode.Disposable[] = [];

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

  async previewTable(connectionId: string, table: TableInfo, label: string): Promise<void> {
    let sql: string;
    try {
      sql = (await this.manager.getDriver(connectionId)).previewSql(table, 100);
    } catch (err) {
      void vscode.window.showErrorMessage(`DB Deck: ${errorMessage(err)}`);
      return;
    }
    await this.execute(connectionId, sql, label, vscode.ViewColumn.Active);
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

  private async execute(connectionId: string, sql: string, title: string, column: vscode.ViewColumn) {
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
