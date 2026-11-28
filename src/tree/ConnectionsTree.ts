import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { DATABASE_SCOPE, TREE_LAYOUT, typeLabel } from '../drivers';
import { logoForType, logoUris } from '../logos';
import { treeIcon } from '../treeIcons';
import type { ColumnInfo, ConnectionConfig, DbObject, ObjectKind, SchemaEntry, TableInfo } from '../types';

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

/** The connection's database, above its Schemas folder (TREE_LAYOUT `database`: PostgreSQL). */
export class DatabaseNode implements Base {
  readonly kind = 'database';
  constructor(
    readonly connectionId: string,
    readonly name: string,
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}
}

/** The Schemas folder under a database node. */
export class SchemasNode implements Base {
  readonly kind = 'schemas';
  constructor(
    readonly connectionId: string,
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}
}

/** A schema (PostgreSQL) or database (MySQL). Its objects are read when it's expanded. */
export class SchemaNode implements Base {
  readonly kind = 'schema';
  constructor(
    readonly connectionId: string,
    readonly entry: SchemaEntry,
    readonly treeId: string,
    readonly parent: TreeNode,
  ) {}

  get label(): string {
    return this.entry.name;
  }

  /** As in `DbObject.schema` / `TableInfo.schema`: undefined for the connection's default one. */
  get schema(): string | undefined {
    return this.entry.isDefault ? undefined : this.entry.name;
  }
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
    /** The kind of objects it lists (Tables, Views…); undefined for Indexes / Triggers under a table. */
    readonly holds?: ObjectKind,
    /** In a system schema: browse and query only. */
    readonly system = false,
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
    /** In a system schema: no design, write or transfer menus (context value `table.system` / `view.system`). */
    readonly system = false,
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

export type TreeNode = ConnectionFolderNode | EnvGroupNode | ConnectionNode | DatabaseNode | SchemasNode | SchemaNode | FolderNode | TableNode | ObjectNode | ColumnNode | MessageNode;

export function tableLabel(table: { name: string; schema?: string }): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/** Folder labels under a connection or schema; the driver's `objectKinds()` says which show, and in what order. */
const FOLDER_LABELS: Partial<Record<ObjectKind, string>> = {
  table: 'Tables',
  view: 'Views',
  function: 'Functions',
  procedure: 'Procedures',
  sequence: 'Sequences',
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
      case 'database': {
        const item = new vscode.TreeItem(node.name, C.Collapsed);
        item.iconPath = treeIcon(this.extensionUri, 'database');
        item.tooltip = `Database ${node.name} — use Switch Database… on the connection for another one`;
        item.contextValue = 'database';
        return withId(item, node);
      }
      case 'schemas': {
        const item = new vscode.TreeItem('Schemas', C.Collapsed);
        item.iconPath = treeIcon(this.extensionUri, 'schemas');
        item.contextValue = 'schemas';
        return withId(item, node);
      }
      case 'schema': {
        const { entry } = node;
        const item = new vscode.TreeItem(entry.name, C.Collapsed);
        item.iconPath = treeIcon(this.extensionUri, 'schema');
        item.description = entry.isDefault ? 'default' : entry.system ? 'system' : undefined;
        if (entry.system) item.tooltip = `${entry.name} is a system schema: browse and query only`;
        // `schema.system` matches no design or write menu (they use `== schema`).
        item.contextValue = entry.system ? 'schema.system' : 'schema';
        return withId(item, node);
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.label, node.objects.length ? C.Collapsed : C.None);
        item.description = String(node.objects.length);
        // The kind's own icon (Indexes / Triggers under a table: their items' kind; they're shown only when not empty).
        const kind = node.holds ?? node.objects[0]?.kind;
        item.iconPath = kind ? treeIcon(this.extensionUri, kind) : new vscode.ThemeIcon('folder');
        // `objects.table` offers New Table…; not `folder…`, which connection folders use (vscode-api.md).
        if (node.holds) item.contextValue = `objects.${node.holds}${node.system ? '.system' : ''}`;
        return withId(item, node);
      }
      case 'table': {
        const o = node.object;
        // Under its schema node, so the plain name; the tooltip has the qualified one.
        const item = new vscode.TreeItem(o.name, C.Collapsed);
        item.iconPath = treeIcon(this.extensionUri, o.kind);
        item.description = o.detail;
        // `.system`: menus safe there match /^(table|view)(\.system)?$/; write menus match exactly (vscode-api.md).
        item.contextValue = `${o.kind === 'view' ? 'view' : 'table'}${node.system ? '.system' : ''}`;
        item.tooltip = `${o.kind === 'view' ? 'View' : 'Table'} ${tableLabel(o)} — click to show the first 100 rows${node.system ? ' (read-only: system schema)' : ''}`;
        item.command = { command: 'dbDeck.previewTable', title: 'Show Rows', arguments: [node] };
        return withId(item, node);
      }
      case 'object': {
        const o = node.object;
        const item = new vscode.TreeItem(o.name, C.None);
        item.iconPath = treeIcon(this.extensionUri, o.kind);
        item.description = o.detail;
        item.contextValue = o.kind;
        item.tooltip = `${o.table ? o.name : tableLabel(o)}${o.detail ? ` ${o.detail}` : ''} — click to show its definition`;
        item.command = { command: 'dbDeck.showDdl', title: 'Show DDL', arguments: [node] };
        return withId(item, node);
      }
      case 'column': {
        const col = node.column;
        const item = new vscode.TreeItem(col.name, C.None);
        item.description = col.primaryKey ? `${col.type} · PK` : col.type;
        item.iconPath = treeIcon(this.extensionUri, col.primaryKey ? 'key' : 'column');
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
          const c = node.config;
          // Connects here for every layout, so the green dot shows as soon as the connection is expanded.
          const driver = await this.manager.getDriver(c.id);
          switch (TREE_LAYOUT[c.type]) {
            case 'objects':
              return folders(c.id, await driver.listObjects(), await driver.objectKinds(), node, false);
            case 'schemas':
              return this.schemaNodes(c.id, node);
            case 'database':
              return [new DatabaseNode(c.id, c.database ?? '', `${node.treeId}/db`, node)];
          }
        }
        case 'database':
          return [new SchemasNode(node.connectionId, `${node.treeId}/schemas`, node)];
        case 'schemas':
          return this.schemaNodes(node.connectionId, node);
        case 'schema': {
          const driver = await this.manager.getDriver(node.connectionId);
          const [objects, kinds] = await Promise.all([driver.listSchemaObjects(node.entry.name), driver.objectKinds()]);
          return folders(node.connectionId, objects, kinds, node, node.entry.system);
        }
        case 'folder':
          return node.objects.map((o) =>
            o.kind === 'table' || o.kind === 'view'
              ? new TableNode(node.connectionId, o, `${node.treeId}/${o.name}`, node, node.system)
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

  private async schemaNodes(connectionId: string, parent: TreeNode): Promise<SchemaNode[]> {
    const entries = await (await this.manager.getDriver(connectionId)).listTreeSchemas();
    return entries.map((entry) => new SchemaNode(connectionId, entry, `${parent.treeId}/schema:${entry.name}`, parent));
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
    // The path down: connection → (database → Schemas) → schema → folder → object.
    const leadsTo = (n: TreeNode) =>
      n.kind === 'database' ||
      n.kind === 'schemas' ||
      (n.kind === 'schema' && n.schema === object.schema) ||
      (n.kind === 'folder' && n.holds === object.kind);
    for (let depth = 0; level && depth < 6; depth++) {
      if (wanted(level)) return level;
      const children = await this.getChildren(level);
      level = children.find(wanted) ?? children.find(leadsTo);
    }
    return level && wanted(level) ? level : undefined;
  }
}

/** One folder per kind the database has, empty ones too, so Functions / Procedures can always be found. */
function folders(connectionId: string, objects: DbObject[], kinds: ObjectKind[], parent: TreeNode, system: boolean): FolderNode[] {
  return kinds.flatMap((kind) => {
    const label = FOLDER_LABELS[kind];
    if (!label) return [];
    const items = objects.filter((o) => o.kind === kind);
    return [new FolderNode(connectionId, label, items, `${parent.treeId}/${label.toLowerCase()}`, parent, kind, system)];
  });
}

function withId(item: vscode.TreeItem, node: TreeNode): vscode.TreeItem {
  item.id = node.treeId;
  return item;
}
