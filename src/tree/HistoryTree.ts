import * as vscode from 'vscode';
import { firstLine, groupByDay, type HistoryEntry } from '../history/entries';
import type { QueryHistory } from '../history/queryHistory';

class DayNode {
  readonly kind = 'day';
  constructor(
    readonly label: string,
    readonly entries: HistoryEntry[],
    readonly first: boolean,
    readonly treeId: string,
  ) {}
}

export class HistoryNode {
  readonly kind = 'entry';
  constructor(
    readonly entry: HistoryEntry,
    readonly treeId: string,
  ) {}
}

type Node = DayNode | HistoryNode;

/** Query History view: runs from SQL editors in this workspace, newest first, grouped by day. */
export class HistoryTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly history: QueryHistory) {
    this.subscription = history.onDidChange(() => this.changed.fire(undefined));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'day') {
      // The newest day starts open; VS Code remembers the state by id afterwards.
      const item = new vscode.TreeItem(node.label, node.first ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.treeId;
      item.description = String(node.entries.length);
      return item;
    }
    const e = node.entry;
    const at = new Date(e.at);
    const item = new vscode.TreeItem(firstLine(e.sql) || '(empty)', vscode.TreeItemCollapsibleState.None);
    item.id = node.treeId;
    item.description = `${this.history.connectionLabel(e)} · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${e.durationMs.toLocaleString('en-US')} ms`;
    item.iconPath = e.ok ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(`${this.history.connectionLabel(e)} · ${at.toLocaleString()} · ${e.summary}${e.shortened ? ' · shortened' : ''}`);
    tooltip.appendCodeblock(e.sql.length > 2000 ? `${e.sql.slice(0, 2000)}\n…` : e.sql, 'sql');
    item.tooltip = tooltip;
    // A shortened entry can't be run again (it would run partial SQL), so it gets its own context value.
    item.contextValue = e.shortened ? 'historyEntry.shortened' : 'historyEntry';
    item.command = { command: 'dbDeck.openHistoryEntry', title: 'Open', arguments: [node] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return groupByDay(this.history.entries(), new Date()).map((g, i) => new DayNode(g.label, g.entries, i === 0, `day/${g.key}`));
    }
    return node.kind === 'day' ? node.entries.map((e) => new HistoryNode(e, `entry/${e.id}`)) : [];
  }
}
