import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import type { TableInfo } from './types';
import { EnvConnections } from './env/envConnections';
import { askFolderName, pickFolder } from './connectionFolders';
import { errorMessage } from './drivers/common';
import { TableEditor } from './edit/applyEdits';
import { ResultsExporter } from './export/exportResults';
import { QueryHistory } from './history/queryHistory';
import { PAGE_SIZE, QueryController } from './query/runQuery';
import { SqlEditor } from './query/sqlEditor';
import { SavedQueries } from './saved/savedQueries';
import { ConnectionFolderNode, ConnectionNode, ConnectionsTree, EnvGroupNode, FolderNode, SchemaNode, ObjectNode, TableNode, tableLabel, type TreeNode } from './tree/ConnectionsTree';
import { ObjectCommands } from './tree/objectCommands';
import { HistoryNode, HistoryTree } from './tree/HistoryTree';
import { SavedQueriesTree, SavedQueryNode } from './tree/SavedQueriesTree';
import { ConnectionForms } from './views/ConnectionForm';
import { DangerForms } from './views/DangerForm';
import { Explainer } from './views/ExplainPanel';
import { ServerPanels } from './views/ServerPanel';
import { DumpForms } from './views/DumpForm';
import { ImportForms } from './views/ImportForm';
import { RunScriptForms } from './views/RunScriptForm';
import { TableDesignForms } from './views/TableDesignForm';
import { ResultsPanel } from './views/ResultsPanel';

export function activate(context: vscode.ExtensionContext) {
  const envConnections = new EnvConnections(context);
  const manager = new ConnectionManager(context, envConnections);
  const tree = new ConnectionsTree(manager, context.extensionUri);
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
  const forms = new ConnectionForms(context.extensionUri, manager, tree);
  const dumps = new DumpForms(context.extensionUri, manager);
  const imports = new ImportForms(context.extensionUri, manager);
  // After DDL (a script, a new / renamed / dropped table): reload the tree and the editor's suggestions.
  const schemaChanged = (id: string) => {
    sqlEditor.clearSchema(id);
    tree.refresh();
  };
  const scripts = new RunScriptForms(context.extensionUri, manager, queries, schemaChanged);
  const designs = new TableDesignForms(context.extensionUri, manager, async (id, table) => {
    schemaChanged(id);
    await objects.reveal(id, { kind: 'table', name: table.name, schema: table.schema });
  });
  const dangers = new DangerForms(context.extensionUri, manager, schemaChanged);
  const explainer = new Explainer(context.extensionUri, manager, queries);
  const servers = new ServerPanels(context.extensionUri, manager);

  const command = (id: string, handler: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(`dbDeck.${id}`, handler);

  context.subscriptions.push(
    envConnections,
    manager,
    panel,
    forms,
    dumps,
    imports,
    designs,
    dangers,
    explainer,
    servers,
    scripts,
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

    command('addConnection', () => forms.openAdd()),

    command('editConnection', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection(manager, 'Connection to edit'));
      if (config && config.source !== 'env') forms.openEdit(config);
    }),

    command('moveToFolder', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection(manager, 'Connection to move'));
      if (!config || config.source === 'env') return;
      const picked = await pickFolder(`Move "${config.name}" to Folder`, manager.folders(), config.folder);
      if (picked && picked.value !== config.folder) await manager.moveToFolder(config.id, picked.value);
    }),

    // Table design.
    command('newTable', (node?: ConnectionNode | SchemaNode | FolderNode) => {
      if (node instanceof ConnectionNode) designs.openNew(node.config.id);
      else if (node instanceof SchemaNode) designs.openNew(node.connectionId, node.label);
      else if (node instanceof FolderNode) designs.openNew(node.connectionId, node.parent instanceof SchemaNode ? node.parent.label : undefined);
    }),
    command('renameTable', (node?: TableNode) => objects.renameTable(node, schemaChanged)),
    // From the tree (a TableNode) or from New Table's success status ({ connectionId, table }).
    command('designTable', (node?: { connectionId: string; table: TableInfo }) => node && designs.openDesign(node.connectionId, node.table)),
    command('truncateTable', (node?: TableNode) => node && dangers.open('truncate', node.connectionId, node.table)),
    command('dropTable', (node?: TableNode) => node && dangers.open('drop', node.connectionId, node.table)),

    // Data transfer.
    command('dumpDatabase', (node?: ConnectionNode) => node && dumps.open(node.config.id)),
    command('dumpTable', (node?: TableNode) => node && dumps.open(node.connectionId, node.table)),
    command('importCsv', (node?: TableNode) => node && imports.openForTable(node.connectionId, node.table)),
    command('importCsvFile', (uri?: unknown) => imports.openForFile(uri instanceof vscode.Uri ? uri : undefined)),
    command('runSqlFile', (uri?: unknown) => scripts.open(uri instanceof vscode.Uri ? uri : undefined)),

    // .env connections.
    command('openEnvFile', async (node?: ConnectionNode | EnvGroupNode) => {
      const file = node instanceof EnvGroupNode ? node.file : node && manager.envInfo(node.config.id)?.file;
      if (file) await vscode.window.showTextDocument(file);
    }),
    command('saveAsConnection', (node?: ConnectionNode) => {
      if (node?.config.source === 'env') forms.openAdd(node.config);
    }),
    command('toggleEnvReadOnly', async (node?: ConnectionNode) => {
      if (node?.config.source !== 'env') return;
      const config = node.config;
      if (manager.isConnected(config.id)) {
        const ok = await vscode.window.showWarningMessage(
          `${config.readOnly ? 'Turn off' : 'Turn on'} read-only for "${config.name}" and reconnect?`,
          { modal: true, detail: 'Reconnecting ends this session, including any open transaction.' },
          'Reconnect',
        );
        if (!ok) return;
      }
      await manager.setEnvReadOnly(config.id, !config.readOnly);
    }),

    command('renameFolder', async (node?: ConnectionFolderNode) => {
      if (!node) return;
      const name = await askFolderName(`Rename Folder "${node.name}"`, node.name);
      if (name && name !== node.name) await manager.renameFolder(node.name, name);
    }),

    command('removeConnection', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection(manager, 'Connection to remove'));
      if (!config || config.source === 'env') return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove connection "${config.name}"? Its saved passwords are deleted too. The database itself is not touched.`,
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
    // Quick tools.
    command('explain', () => explainer.explain(false)),
    command('explainAnalyze', () => explainer.explain(true)),
    command('explainStatement', (uri?: unknown, offset?: unknown) => uri !== undefined && explainer.explain(false, uri, offset)),
    command('serverPanel', (node?: ConnectionNode) => node && servers.open(node.config.id)),
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

/** Saved connections only: Edit, Move and Remove don't apply to .env connections (the file is their source). */
async function pickConnection(manager: ConnectionManager, placeHolder: string) {
  const picked = await vscode.window.showQuickPick(
    manager.list().filter((c) => c.source !== 'env').map((c) => ({ label: c.name, description: c.source === 'workspace' ? 'This workspace' : undefined, config: c })),
    { placeHolder },
  );
  return picked?.config;
}
