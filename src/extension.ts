import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { runConnectionWizard, type WizardResult } from './connectionWizard';
import { errorMessage } from './drivers/common';
import { TableEditor } from './edit/applyEdits';
import { ResultsExporter } from './export/exportResults';
import { QueryHistory } from './history/queryHistory';
import { PAGE_SIZE, QueryController } from './query/runQuery';
import { SqlEditor } from './query/sqlEditor';
import { SavedQueries } from './saved/savedQueries';
import { ConnectionNode, ConnectionsTree, ObjectNode, TableNode, tableLabel, type TreeNode } from './tree/ConnectionsTree';
import { ObjectCommands } from './tree/objectCommands';
import { HistoryNode, HistoryTree } from './tree/HistoryTree';
import { SavedQueriesTree, SavedQueryNode } from './tree/SavedQueriesTree';
import { ResultsPanel } from './views/ResultsPanel';

export function activate(context: vscode.ExtensionContext) {
  const manager = new ConnectionManager(context);
  const tree = new ConnectionsTree(manager);
  const panel = new ResultsPanel(context.extensionUri);
  const queries = new QueryController(context, manager, panel);
  const exporter = new ResultsExporter(manager, panel, queries);
  const editor = new TableEditor(manager, panel, queries);
  const sqlEditor = new SqlEditor(manager, queries);
  const history = new QueryHistory(context, manager, queries);
  const historyTree = new HistoryTree(history);
  const saved = new SavedQueries(context, manager, queries);
  const savedTree = new SavedQueriesTree(saved);
  const connectionsView = vscode.window.createTreeView('dbDeck.connections', { treeDataProvider: tree, showCollapseAll: true });
  const objects = new ObjectCommands(manager, queries, tree, connectionsView);

  const command = (id: string, handler: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(`dbDeck.${id}`, handler);

  context.subscriptions.push(
    manager,
    panel,
    queries,
    exporter,
    editor,
    sqlEditor,
    history,
    historyTree,
    saved,
    savedTree,
    connectionsView,
    vscode.window.createTreeView('dbDeck.savedQueries', { treeDataProvider: savedTree, showCollapseAll: true }),
    vscode.window.createTreeView('dbDeck.history', { treeDataProvider: historyTree, showCollapseAll: true }),
    // Removed or added connections change how both views label their entries.
    manager.onDidChange(() => {
      savedTree.refresh();
      historyTree.refresh();
    }),

    command('addConnection', () => addConnection(manager)),

    command('removeConnection', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection(manager, 'Connection to remove'));
      if (!config) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove connection "${config.name}"? Its saved password is deleted too. The database itself is not touched.`,
        { modal: true },
        'Remove',
      );
      if (confirm) await manager.remove(config.id);
    }),

    command('refresh', (node?: TreeNode) => {
      // Editor suggestions reload the schema too.
      sqlEditor.clearSchema(node instanceof ConnectionNode ? node.config.id : node instanceof TableNode ? node.connectionId : undefined);
      tree.refresh(node);
    }),

    command('disconnect', async (node?: ConnectionNode) => {
      if (!node) return;
      tree.collapseOnNextRefresh(node.config.id);
      await manager.disconnect(node.config.id);
    }),

    command('newQuery', async (node?: ConnectionNode | TableNode) => {
      if (node instanceof TableNode) {
        const driver = await manager.getDriver(node.connectionId);
        await queries.newQuery(node.connectionId, driver.previewSql(node.table, { limit: PAGE_SIZE, offset: 0, orderBy: [] }));
      } else {
        await queries.newQuery(node?.config.id);
      }
    }),

    command('previewTable', (node?: TableNode) => {
      if (!node) return;
      const connection = manager.get(node.connectionId);
      return queries.previewTable(node.connectionId, node.table, `${tableLabel(node.table)} · ${connection?.name ?? ''}`);
    }),

    command('runQuery', () => queries.runActiveEditor()),
    command('runAll', () => queries.runAll()),
    // ▶ Run CodeLens: the document and the statement's offset (see SqlEditor).
    command('runStatement', (uri?: unknown, offset?: unknown) => queries.runStatementAt(uri, offset)),
    command('selectConnection', () => queries.selectConnectionForActiveEditor()),

    // Connections tree objects.
    command('showDdl', (node?: TableNode | ObjectNode) => objects.showDdl(node)),
    command('generateSelect', (node?: TableNode) => objects.generateSql(node, 'select')),
    command('generateInsert', (node?: TableNode) => objects.generateSql(node, 'insert')),
    command('generateUpdate', (node?: TableNode) => objects.generateSql(node, 'update')),
    command('generateDelete', (node?: TableNode) => objects.generateSql(node, 'delete')),
    command('copyName', (node?: TreeNode) => objects.copyName(node, false)),
    command('copyQualifiedName', (node?: TreeNode) => objects.copyName(node, true)),
    command('findObject', () => objects.findObject()),
    command('switchDatabase', (node?: ConnectionNode) => objects.switchDatabase(node)),

    // Saved Queries view and SQL editors.
    command('saveQuery', () => saved.saveActiveEditor()),
    command('runSavedQuery', (node?: SavedQueryNode) => node && saved.run(node.query)),
    command('renameSavedQuery', (node?: SavedQueryNode) => node && saved.rename(node.query)),
    command('deleteSavedQuery', (node?: SavedQueryNode) => node && saved.delete(node.query)),
    command('refreshSavedQueries', () => saved.refresh()),

    // Query History view.
    command('openHistoryEntry', (node?: HistoryNode) => node && history.open(node.entry)),
    command('runHistoryEntry', (node?: HistoryNode) => node && history.runAgain(node.entry)),
    command('copyHistorySql', (node?: HistoryNode) => node && history.copy(node.entry)),
    command('deleteHistoryEntry', (node?: HistoryNode) => node && history.delete(node.entry)),
    command('searchHistory', () => history.search()),
    command('clearHistory', () => history.clear()),

    // Results grid context menu: the webview replies with its selected cells.
    command('copySelection', () => panel.requestCopy('tsv')),
    command('copySelectionWithHeaders', () => panel.requestCopy('tsvHeaders')),
    command('copySelectionAsCsv', () => panel.requestCopy('csv')),
    command('copySelectionAsJson', () => panel.requestCopy('json')),
    command('setNull', () => panel.requestEdit('setNull')),
    command('deleteRows', () => panel.requestEdit('deleteRows')),
    command('addRow', () => panel.requestEdit('addRow')),
    command('hideColumn', () => panel.requestHideColumn()),
  );
}

export function deactivate() {}

/** Wizard → test → save. On a failed test the user can edit the settings or save anyway. */
async function addConnection(manager: ConnectionManager): Promise<void> {
  let result: WizardResult | undefined;
  for (;;) {
    result = await runConnectionWizard(result);
    if (!result) return;
    const { config, password } = result;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${config.name}…` },
        () => ConnectionManager.test(config, password),
      );
    } catch (err) {
      const choice = await vscode.window.showErrorMessage(
        `Could not connect to "${config.name}": ${errorMessage(err)}`,
        'Edit Settings',
        'Save Anyway',
      );
      if (choice === 'Edit Settings') continue;
      if (choice !== 'Save Anyway') return;
    }
    await manager.add(config, password);
    void vscode.window.showInformationMessage(`Saved connection "${config.name}".`);
    return;
  }
}

async function pickConnection(manager: ConnectionManager, placeHolder: string) {
  const picked = await vscode.window.showQuickPick(
    manager.list().map((c) => ({ label: c.name, config: c })),
    { placeHolder },
  );
  return picked?.config;
}
