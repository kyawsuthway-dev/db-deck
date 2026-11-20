import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { runConnectionWizard, type WizardResult } from './connectionWizard';
import { errorMessage } from './drivers/common';
import { ResultsExporter } from './export/exportResults';
import { PAGE_SIZE, QueryController } from './query/runQuery';
import { ConnectionNode, ConnectionsTree, TableNode, tableLabel, type TreeNode } from './tree/ConnectionsTree';
import { ResultsPanel } from './views/ResultsPanel';

export function activate(context: vscode.ExtensionContext) {
  const manager = new ConnectionManager(context);
  const tree = new ConnectionsTree(manager);
  const panel = new ResultsPanel(context.extensionUri);
  const queries = new QueryController(context, manager, panel);
  const exporter = new ResultsExporter(manager, panel, queries);

  const command = (id: string, handler: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(`dbDeck.${id}`, handler);

  context.subscriptions.push(
    manager,
    panel,
    queries,
    exporter,
    vscode.window.createTreeView('dbDeck.connections', { treeDataProvider: tree, showCollapseAll: true }),

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

    command('refresh', (node?: TreeNode) => tree.refresh(node)),

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
    command('selectConnection', () => queries.selectConnectionForActiveEditor()),

    // Results grid context menu: the webview replies with its selected cells.
    command('copySelection', () => panel.requestCopy('tsv')),
    command('copySelectionWithHeaders', () => panel.requestCopy('tsvHeaders')),
    command('copySelectionAsCsv', () => panel.requestCopy('csv')),
    command('copySelectionAsJson', () => panel.requestCopy('json')),
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
