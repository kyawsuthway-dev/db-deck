import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { typeLabel } from '../drivers';
import type { ColumnInfo, ConnectionConfig, TableInfo } from '../types';

export class ConnectionNode {
  readonly kind = 'connection';
  constructor(
    readonly config: ConnectionConfig,
    readonly treeId: string,
  ) {}
}

export class GroupNode {
  readonly kind = 'group';
  constructor(
    readonly connectionId: string,
    readonly label: 'Tables' | 'Views',
    readonly tables: TableInfo[],
    readonly treeId: string,
  ) {}
}

export class TableNode {
  readonly kind = 'table';
  constructor(
    readonly connectionId: string,
    readonly table: TableInfo,
    readonly treeId: string,
  ) {}
}

class ColumnNode {
  readonly kind = 'column';
  constructor(
    readonly column: ColumnInfo,
    readonly treeId: string,
  ) {}
}

class MessageNode {
  readonly kind = 'message';
  constructor(
    readonly message: string,
    readonly detail: string,
    readonly treeId: string,
  ) {}
}

export type TreeNode = ConnectionNode | GroupNode | TableNode | ColumnNode | MessageNode;

export function tableLabel(table: TableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /**
   * VS Code remembers expansion by item id. Bumping a connection's generation on disconnect
   * gives it a new id, so it shows collapsed instead of immediately reconnecting.
   */
  private readonly generations = new Map<string, number>();

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(node?: TreeNode): void {
    this.changed.fire(node);
  }

  collapseOnNextRefresh(connectionId: string): void {
    this.generations.set(connectionId, (this.generations.get(connectionId) ?? 0) + 1);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'connection': {
        const c = node.config;
        const connected = this.manager.isConnected(c.id);
        const item = new vscode.TreeItem(c.name, C.Collapsed);
        item.description = c.type === 'sqlite' ? typeLabel(c.type) : `${typeLabel(c.type)} · ${c.host}:${c.port}`;
        item.tooltip = c.type === 'sqlite' ? c.filePath : `${c.user}@${c.host}:${c.port}${c.database ? `/${c.database}` : ''}`;
        item.iconPath = new vscode.ThemeIcon('database', connected ? new vscode.ThemeColor('charts.green') : undefined);
        item.contextValue = connected ? 'connection.connected' : 'connection';
        return withId(item, node);
      }
      case 'group': {
        const item = new vscode.TreeItem(node.label, node.tables.length ? C.Collapsed : C.None);
        item.description = String(node.tables.length);
        item.iconPath = new vscode.ThemeIcon('folder');
        return withId(item, node);
      }
      case 'table': {
        const item = new vscode.TreeItem(tableLabel(node.table), C.Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.table.kind === 'view' ? 'eye' : 'table');
        item.contextValue = 'table';
        item.tooltip = `${node.table.kind === 'view' ? 'View' : 'Table'} ${tableLabel(node.table)} — click to show the first 100 rows`;
        item.command = { command: 'dbDeck.previewTable', title: 'Show Rows', arguments: [node] };
        return withId(item, node);
      }
      case 'column': {
        const col = node.column;
        const item = new vscode.TreeItem(col.name, C.None);
        item.description = col.primaryKey ? `${col.type} · PK` : col.type;
        item.iconPath = new vscode.ThemeIcon(col.primaryKey ? 'key' : 'symbol-field');
        item.tooltip = `${col.name} ${col.type}${col.primaryKey ? ' PRIMARY KEY' : ''}${col.nullable ? '' : ' NOT NULL'}`;
        return withId(item, node);
      }
      case 'message': {
        const item = new vscode.TreeItem(node.message, C.None);
        item.tooltip = node.detail;
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        return withId(item, node);
      }
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return this.manager.list().map((c) => new ConnectionNode(c, `${c.id}#${this.generations.get(c.id) ?? 0}`));
    }
    try {
      switch (node.kind) {
        case 'connection': {
          const id = node.config.id;
          const tables = await (await this.manager.getDriver(id)).listTables();
          return [
            new GroupNode(id, 'Tables', tables.filter((t) => t.kind === 'table'), `${node.treeId}/tables`),
            new GroupNode(id, 'Views', tables.filter((t) => t.kind === 'view'), `${node.treeId}/views`),
          ];
        }
        case 'group':
          return node.tables.map((t) => new TableNode(node.connectionId, t, `${node.treeId}/${tableLabel(t)}`));
        case 'table': {
          const driver = await this.manager.getDriver(node.connectionId);
          const columns = await driver.listColumns(node.table);
          return columns.map((col) => new ColumnNode(col, `${node.treeId}/${col.name}`));
        }
        default:
          return [];
      }
    } catch (err) {
      const message = errorMessage(err);
      void vscode.window.showErrorMessage(`DB Deck: ${message}`);
      return [new MessageNode(message.split('\n')[0], `${message}\n\nUse Refresh to try again.`, `${node.treeId}/error`)];
    }
  }
}

function withId(item: vscode.TreeItem, node: TreeNode): vscode.TreeItem {
  item.id = node.treeId;
  return item;
}
