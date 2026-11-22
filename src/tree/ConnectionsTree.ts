import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { DATABASE_SCOPE, typeLabel } from '../drivers';
import { logoForType, logoUris } from '../logos';
import type { ColumnInfo, ConnectionConfig, DbObject, ObjectKind, TableInfo } from '../types';

/** Every node knows its parent, so `TreeView.reveal` (Find Object…) can walk up from it. */
interface Base {
  readonly treeId: string;
  readonly parent?: TreeNode;
}

/** A folder of connections (one level; `ConnectionConfig.folder`). Exists while a connection is in it. */
export class ConnectionFolderNode implements Base {
  readonly kind = 'connectionFolder';
  readonly parent = undefined;
  readonly treeId: string;
  constructor(
    readonly name: string,
    readonly connections: ConnectionConfig[],
  ) {
    this.treeId = `folder:${name}`;
  }
}

/** The connections found in one .env file ("<workspace folder> · .env"), shown above the others. */
export class EnvGroupNode implements Base {
  readonly kind = 'envGroup';
  readonly parent = undefined;
  readonly treeId: string;
  constructor(
    readonly label: string,
    readonly file: vscode.Uri,
    readonly connections: ConnectionConfig[],
  ) {
    this.treeId = `env:${file.toString()}`;
  }
}

export class ConnectionNode implements Base {
  readonly kind = 'connection';
  constructor(
    readonly config: ConnectionConfig,
    readonly treeId: string,
    readonly parent?: ConnectionFolderNode | EnvGroupNode,
  ) {}
}

/** A schema (PostgreSQL) or database (MySQL), shown only when a connection has more than one. */
export class SchemaNode implements Base {
  readonly kind = 'schema';
  constructor(
    readonly connectionId: string,
    readonly label: string,
    readonly objects: DbObject[],
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}
}

/** Tables / Views / Functions / … under a connection or schema; Indexes / Triggers under a table. */
export class FolderNode implements Base {
  readonly kind = 'folder';
  constructor(
    readonly connectionId: string,
    readonly label: string,
    readonly objects: DbObject[],
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}
}

/** A table or view: click shows its rows; expands to columns, indexes and triggers. */
export class TableNode implements Base {
  readonly kind = 'table';
  readonly table: TableInfo;
  constructor(
    readonly connectionId: string,
    readonly object: DbObject,
    readonly treeId: string,
    readonly parent?: TreeNode,
  ) {
    this.table = { name: object.name, schema: object.schema, kind: object.kind === 'view' ? 'view' : 'table' };
  }
}

/** A function, procedure, sequence, index or trigger: click shows its DDL. */
export class ObjectNode implements Base {
  readonly kind = 'object';
  constructor(
    readonly connectionId: string,
    readonly object: DbObject,
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}
}

export class ColumnNode implements Base {
  readonly kind = 'column';
  constructor(
    readonly connectionId: string,
    readonly table: TableInfo,
    readonly column: ColumnInfo,
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}
}

class MessageNode implements Base {
  readonly kind = 'message';
  constructor(
    readonly message: string,
    readonly detail: string,
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}
}

export type TreeNode = ConnectionFolderNode | EnvGroupNode | ConnectionNode | SchemaNode | FolderNode | TableNode | ObjectNode | ColumnNode | MessageNode;

export function tableLabel(table: { name: string; schema?: string }): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/** Folders under a connection or schema, in this order; empty ones aren't shown. */
const FOLDERS: { kind: ObjectKind; label: string }[] = [
  { kind: 'table', label: 'Tables' },
  { kind: 'view', label: 'Views' },
  { kind: 'function', label: 'Functions' },
  { kind: 'procedure', label: 'Procedures' },
  { kind: 'sequence', label: 'Sequences' },
];

const ICONS: Record<ObjectKind, string> = {
  table: 'table',
  view: 'eye',
  function: 'symbol-method',
  procedure: 'symbol-event',
  sequence: 'symbol-number',
  index: 'list-ordered',
  trigger: 'zap',
};

/** Whether the connection's tree items offer server-only actions (Switch Database…). */
const isServer = (c: ConnectionConfig) => DATABASE_SCOPE[c.type] !== 'none';

export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /**
   * VS Code remembers expansion by item id. Bumping a connection's generation on disconnect
   * gives it a new id, so it shows collapsed instead of immediately reconnecting.
   */
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(node?: TreeNode): void {
    this.changed.fire(node);
  }

  collapseOnNextRefresh(connectionId: string): void {
    this.generations.set(connectionId, (this.generations.get(connectionId) ?? 0) + 1);
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node.parent;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'connectionFolder': {
        const item = new vscode.TreeItem(node.name, C.Expanded);
        item.description = String(node.connections.length);
        item.iconPath = new vscode.ThemeIcon('folder');
        // Not `connection…`: connection menus match /^connection/ (vscode-api.md).
        item.contextValue = 'folder';
        return withId(item, node);
      }
      case 'envGroup': {
        const item = new vscode.TreeItem(node.label, C.Expanded);
        item.description = String(node.connections.length);
        item.iconPath = new vscode.ThemeIcon('gear');
        item.tooltip = `Connections read from ${node.file.fsPath}. Edit the file to change them.`;
        // Compose files get a package (container) icon; .env files a gear.
        if (/compose\.ya?ml$/.test(node.file.path)) item.iconPath = new vscode.ThemeIcon('package');
        item.contextValue = 'envGroup';
        return withId(item, node);
      }
      case 'connection': {
        const c = node.config;
        const connected = this.manager.isConnected(c.id);
        const item = new vscode.TreeItem(c.name, C.Collapsed);
        const where = DATABASE_SCOPE[c.type] === 'none' ? typeLabel(c.type) : `${typeLabel(c.type)} · ${c.host}:${c.port}`;
        const scope = c.source === 'workspace' ? 'this workspace · ' : '';
        item.description = `${c.readOnly ? 'read-only · ' : ''}${scope}${where}`;
        const target = DATABASE_SCOPE[c.type] === 'none' ? c.filePath : `${c.user}@${c.host}:${c.port}${c.database ? `/${c.database}` : ''}`;
        const via = c.ssh ? `\nvia SSH ${c.ssh.user}@${c.ssh.host}:${c.ssh.port}` : '';
        const env = c.source === 'env' ? this.manager.envInfo(c.id) : undefined;
        const from = env
          ? `\nFrom ${env.file.fsPath} (${env.keys.join(', ')})${env.via ? `\nDocker: ${env.via}` : ''}`
          : c.source === 'workspace'
            ? '\nSaved for this workspace only'
            : '';
        item.tooltip = `${target}${via}${from}${c.readOnly ? '\nRead-only' : ''}${connected ? '\nConnected' : ''}`;
        // The database's logo; open connections use the version with a green dot. (A file decoration badge
        // would also color the name, which the maintainer didn't want.)
        const logo = logoForType(c.type);
        item.iconPath =
          (logo && logoUris(this.extensionUri, logo, connected)) ||
          new vscode.ThemeIcon('database', connected ? new vscode.ThemeColor('charts.green') : undefined);
        // connection[.connected][.server]: menus match with regexes (vscode-api.md).
        // `.env` last, so saved-connection menus can require /^connection(\.connected)?(\.server)?$/.
        item.contextValue = `connection${connected ? '.connected' : ''}${isServer(c) ? '.server' : ''}${c.source === 'env' ? '.env' : ''}`;
        return withId(item, node);
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.label, C.Collapsed);
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return withId(item, node);
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.label, node.objects.length ? C.Collapsed : C.None);
        item.description = String(node.objects.length);
        item.iconPath = new vscode.ThemeIcon('folder');
        return withId(item, node);
      }
      case 'table': {
        const o = node.object;
        const item = new vscode.TreeItem(tableLabel(o), C.Collapsed);
        item.iconPath = new vscode.ThemeIcon(ICONS[o.kind]);
        item.description = o.detail;
        item.contextValue = o.kind === 'view' ? 'view' : 'table';
        item.tooltip = `${o.kind === 'view' ? 'View' : 'Table'} ${tableLabel(o)} — click to show the first 100 rows`;
        item.command = { command: 'dbDeck.previewTable', title: 'Show Rows', arguments: [node] };
        return withId(item, node);
      }
      case 'object': {
        const o = node.object;
        const item = new vscode.TreeItem(o.table ? o.name : tableLabel(o), C.None);
        item.iconPath = new vscode.ThemeIcon(ICONS[o.kind]);
        item.description = o.detail;
        item.contextValue = o.kind;
        item.tooltip = `${o.name}${o.detail ? ` ${o.detail}` : ''} — click to show its definition`;
        item.command = { command: 'dbDeck.showDdl', title: 'Show DDL', arguments: [node] };
        return withId(item, node);
      }
      case 'column': {
        const col = node.column;
        const item = new vscode.TreeItem(col.name, C.None);
        item.description = col.primaryKey ? `${col.type} · PK` : col.type;
        item.iconPath = new vscode.ThemeIcon(col.primaryKey ? 'key' : 'symbol-field');
        item.tooltip = `${col.name} ${col.type}${col.primaryKey ? ' PRIMARY KEY' : ''}${col.nullable ? '' : ' NOT NULL'}`;
        item.contextValue = 'column';
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
      const list = this.manager.list();
      const saved = list.filter((c) => c.source !== 'env');
      const envGroups = new Map<string, { file: vscode.Uri; connections: ConnectionConfig[] }>();
      for (const c of list.filter((x) => x.source === 'env')) {
        const info = this.manager.envInfo(c.id);
        if (!info) continue;
        const group = envGroups.get(info.group) ?? { file: info.file, connections: [] };
        group.connections.push(c);
        envGroups.set(info.group, group);
      }
      const env = [...envGroups].map(([label, g]) => new EnvGroupNode(label, g.file, g.connections));
      const folders = this.manager.folders().map((name) => new ConnectionFolderNode(name, saved.filter((c) => c.folder === name)));
      return [...env, ...folders, ...saved.filter((c) => !c.folder).map((c) => this.connectionNode(c))];
    }
    if (node.kind === 'connectionFolder' || node.kind === 'envGroup') return node.connections.map((c) => this.connectionNode(c, node));
    try {
      switch (node.kind) {
        case 'connection': {
          const id = node.config.id;
          const driver = await this.manager.getDriver(id);
          const objects = await driver.listObjects();
          // Objects without a schema are in the connection's default one; it's listed first.
          const schemas = [...new Set(objects.map((o) => o.schema))].sort((a, b) =>
            a === undefined ? -1 : b === undefined ? 1 : a.localeCompare(b),
          );
          if (schemas.length <= 1) return folders(id, objects, node);
          return schemas.map((schema) => {
            const label = schema ?? driver.defaultSchemaLabel() ?? 'default';
            return new SchemaNode(id, label, objects.filter((o) => o.schema === schema), `${node.treeId}/schema:${label}`, node);
          });
        }
        case 'schema':
          return folders(node.connectionId, node.objects, node);
        case 'folder':
          return node.objects.map((o) =>
            o.kind === 'table' || o.kind === 'view'
              ? new TableNode(node.connectionId, o, `${node.treeId}/${o.name}`, node)
              : new ObjectNode(node.connectionId, o, `${node.treeId}/${o.name}${o.id ? `#${o.id}` : ''}`, node),
          );
        case 'table': {
          const driver = await this.manager.getDriver(node.connectionId);
          const table = node.table;
          const [columns, indexes, triggers] = await Promise.all([
            driver.listColumns(table),
            table.kind === 'table' ? driver.listIndexes(table) : Promise.resolve([]),
            driver.listTriggers(table),
          ]);
          const children: TreeNode[] = columns.map((col) => new ColumnNode(node.connectionId, table, col, `${node.treeId}/${col.name}`, node));
          const indexObjects = indexes.map((ix): DbObject => ({
            kind: 'index',
            name: ix.name,
            schema: table.schema,
            table: table.name,
            detail: `(${ix.columns})${ix.primary ? ' · PRIMARY' : ix.unique ? ' · UNIQUE' : ''}`,
          }));
          if (indexObjects.length) children.push(new FolderNode(node.connectionId, 'Indexes', indexObjects, `${node.treeId}/:indexes`, node));
          if (triggers.length) children.push(new FolderNode(node.connectionId, 'Triggers', triggers, `${node.treeId}/:triggers`, node));
          return children;
        }
        default:
          return [];
      }
    } catch (err) {
      const message = errorMessage(err);
      void vscode.window.showErrorMessage(`DB Deck: ${message}`);
      return [new MessageNode(message.split('\n')[0], `${message}\n\nUse Refresh to try again.`, `${node.treeId}/error`, node)];
    }
  }

  private connectionNode(config: ConnectionConfig, parent?: ConnectionFolderNode | EnvGroupNode): ConnectionNode {
    return new ConnectionNode(config, `${config.id}#${this.generations.get(config.id) ?? 0}`, parent);
  }

  /**
   * The tree node for an object, found by walking the tree the way VS Code would (same ids), so it can be
   * revealed. Undefined when it isn't there (e.g. the schema changed since the list was made).
   */
  async findNode(connectionId: string, object: DbObject): Promise<TreeNode | undefined> {
    const config = this.manager.get(connectionId);
    const root = await this.getChildren();
    const folder = root.find(
      (n) =>
        (n.kind === 'connectionFolder' && config?.source !== 'env' && n.name === config?.folder) ||
        (n.kind === 'envGroup' && n.connections.some((c) => c.id === connectionId)),
    );
    let level = (folder ? await this.getChildren(folder) : root).find((n) => n.kind === 'connection' && n.config.id === connectionId);
    const wanted = (n: TreeNode) =>
      (n.kind === 'table' || n.kind === 'object') && n.object.kind === object.kind && n.object.name === object.name &&
      n.object.schema === object.schema && n.object.id === object.id;
    for (let depth = 0; level && depth < 4; depth++) {
      if (wanted(level)) return level;
      const children = await this.getChildren(level);
      level =
        children.find(wanted) ??
        children.find((n) => n.kind === 'schema' && n.objects.some((o) => same(o, object))) ??
        children.find((n) => n.kind === 'folder' && n.objects.some((o) => same(o, object)));
    }
    return level && wanted(level) ? level : undefined;
  }
}

function folders(connectionId: string, objects: DbObject[], parent: TreeNode): FolderNode[] {
  return FOLDERS.map(({ kind, label }) => ({ label, objects: objects.filter((o) => o.kind === kind) }))
    .filter((f) => f.objects.length > 0 || f.label === 'Tables')
    .map((f) => new FolderNode(connectionId, f.label, f.objects, `${parent.treeId}/${f.label.toLowerCase()}`, parent));
}

const same = (a: DbObject, b: DbObject) => a.kind === b.kind && a.name === b.name && a.schema === b.schema && a.id === b.id;

function withId(item: vscode.TreeItem, node: TreeNode): vscode.TreeItem {
  item.id = node.treeId;
  return item;
}
