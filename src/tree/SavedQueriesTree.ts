import * as vscode from 'vscode';
import type { SavedQueries, SavedQuery, SavedQueryGroup } from '../saved/savedQueries';

class ConnectionGroupNode {
  readonly kind = 'group';
  constructor(readonly group: SavedQueryGroup) {}
}

export class SavedQueryNode {
  readonly kind = 'query';
  constructor(readonly query: SavedQuery) {}
}

type Node = ConnectionGroupNode | SavedQueryNode;

/** Saved Queries view: .sql files per connection, browsable without connecting. */
export class SavedQueriesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly saved: SavedQueries) {
    this.subscription = saved.onDidChange(() => this.changed.fire(undefined));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const g = node.group;
      const item = new vscode.TreeItem(g.removed ? `Removed connection (${g.connectionName})` : g.connectionName, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group/${g.connectionId}`;
      item.description = String(g.queries.length);
      item.iconPath = new vscode.ThemeIcon(g.removed ? 'circle-slash' : 'database');
      if (g.removed) item.tooltip = 'This connection was removed. Its saved queries are kept; running one asks which connection to use.';
      return item;
    }
    const q = node.query;
    const item = new vscode.TreeItem(q.name, vscode.TreeItemCollapsibleState.None);
    item.id = `query/${q.connectionId}/${q.name}`;
    item.resourceUri = q.uri;
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.contextValue = 'savedQuery';
    item.tooltip = `${q.name}.sql — click to open`;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [q.uri] };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return (await this.saved.groups()).map((g) => new ConnectionGroupNode(g));
    return node.kind === 'group' ? node.group.queries.map((q) => new SavedQueryNode(q)) : [];
  }
}
