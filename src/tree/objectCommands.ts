import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { defaultServerName } from '../connectionForm/fields';
import { buildTemplate, errorMessage, type TemplateKind } from '../drivers/common';
import { DATABASE_SCOPE } from '../drivers';
import type { QueryController } from '../query/runQuery';
import type { DbObject, Driver } from '../types';
import { type ConnectionNode, type ConnectionsTree, ObjectNode, TableNode, tableLabel, type TreeNode } from './ConnectionsTree';

const KIND_LABEL: Record<DbObject['kind'], string> = {
  table: 'table',
  view: 'view',
  function: 'function',
  procedure: 'procedure',
  sequence: 'sequence',
  index: 'index',
  trigger: 'trigger',
};

/**
 * Tree object actions: Show DDL, Generate SQL, Copy Name, Find Object…, Switch Database….
 * Everything here reads or opens an editor; nothing runs SQL that changes data (core.md rule 4).
 */
export class ObjectCommands {
  constructor(
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
    private readonly tree: ConnectionsTree,
    private readonly view: vscode.TreeView<TreeNode>,
  ) {}

  /** Opens the object's definition in a new SQL editor linked to its connection. Nothing runs. */
  async showDdl(node?: TableNode | ObjectNode): Promise<void> {
    if (node) await this.showDdlFor(node.connectionId, node.object);
  }

  /** Show DDL for an object found elsewhere (the ER diagram). */
  async showDdlFor(connectionId: string, object: DbObject): Promise<void> {
    try {
      const driver = await this.manager.getDriver(connectionId);
      const ddl = await driver.objectDdl(object);
      const header = `-- ${KIND_LABEL[object.kind]} ${this.qualified(driver, object)} · ${this.manager.get(connectionId)?.name ?? ''}\n`;
      await this.queries.openSql(connectionId, header + ddl);
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn’t get the definition of ${object.name}: ${errorMessage(err)}`);
    }
  }

  /** Opens starting SQL for a table in a new editor. Never run: see buildTemplate for why it's safe unedited. */
  async generateSql(node: TableNode | undefined, kind: TemplateKind): Promise<void> {
    if (!node) return;
    try {
      const driver = await this.manager.getDriver(node.connectionId);
      const columns = await driver.listColumns(node.table);
      // Tables in the default schema are written without it, as people usually do.
      const name = node.table.schema ? this.qualified(driver, node.object) : driver.filterIdentifier(node.table.name);
      const sql = buildTemplate(kind, name, columns, (c) => driver.filterIdentifier(c));
      await this.queries.newQuery(node.connectionId, sql);
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn’t generate SQL for ${node.table.name}: ${errorMessage(err)}`);
    }
  }

  async copyName(node: TreeNode | undefined, qualified: boolean): Promise<void> {
    if (!node || (node.kind !== 'table' && node.kind !== 'object' && node.kind !== 'column')) return;
    try {
      const driver = await this.manager.getDriver(node.connectionId);
      let text: string;
      if (node.kind === 'column') {
        const column = driver.filterIdentifier(node.column.name);
        text = qualified ? `${this.qualified(driver, node.table)}.${column}` : column;
      } else {
        text = qualified ? this.qualified(driver, node.object) : driver.filterIdentifier(node.object.name);
      }
      await vscode.env.clipboard.writeText(text);
    } catch (err) {
      void vscode.window.showErrorMessage(`DB Deck: ${errorMessage(err)}`);
    }
  }

  /**
   * A searchable list of tables, views, functions, procedures and sequences in the open connections.
   * It never connects. Picking one reveals it in the tree, then shows its rows (tables, views) or its DDL.
   */
  /**
   * Rename Table…: an input box (not destructive, like Rename Folder). Runs one ALTER / RENAME on the driver's
   * script connection; `changed` refreshes the tree and suggestions, then the renamed table is shown.
   */
  async renameTable(node: TableNode | undefined, changed: (connectionId: string) => void): Promise<void> {
    if (!node || node.table.kind !== 'table') return;
    const config = this.manager.get(node.connectionId);
    if (!config) return;
    if (config.readOnly) {
      void vscode.window.showErrorMessage(`"${config.name}" is read-only, so DB Deck won’t rename tables on it.`);
      return;
    }
    const old = node.table.name;
    const name = await vscode.window.showInputBox({
      title: `Rename Table ${tableLabel(node.table)}`,
      prompt: 'New name (in the same schema)',
      value: old,
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() ? 'Required' : v.trim().length > 63 ? 'Use at most 63 characters' : undefined),
    });
    if (!name || name.trim() === old) return;
    try {
      const driver = await this.manager.getDriver(node.connectionId);
      await driver.runScript([driver.renameTableSql(node.table, name.trim())], { transaction: true });
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn’t rename ${old}: ${errorMessage(err)}`);
      return;
    }
    changed(node.connectionId);
    await this.reveal(node.connectionId, { kind: 'table', name: name.trim(), schema: node.table.schema });
  }

  /** Shows an object in the tree (after creating or renaming it). Quietly does nothing if it isn't there. */
  async reveal(connectionId: string, object: DbObject): Promise<void> {
    const node = await this.tree.findNode(connectionId, object);
    if (node) await this.view.reveal(node, { select: true, focus: false });
  }

  async findObject(): Promise<void> {
    const connections = this.manager.list().filter((c) => this.manager.isConnected(c.id));
    if (!connections.length) {
      void vscode.window.showInformationMessage('Find Object searches open connections. Expand a connection in the Connections view first.');
      return;
    }
    type Item = vscode.QuickPickItem & { connectionId: string; object: DbObject };
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'Find Object';
    pick.placeholder = 'Search tables, views, functions, procedures and sequences';
    pick.matchOnDescription = true;
    pick.busy = true;
    pick.show();
    const items: Item[] = [];
    await Promise.all(
      connections.map(async (c) => {
        try {
          const objects = await (await this.manager.getDriver(c.id)).listObjects();
          for (const object of objects) {
            items.push({
              // `$(` would otherwise be read as an icon.
              label: `$(${iconFor(object)}) ${tableLabel(object).replace(/\$\(/g, '\\$(')}`,
              description: `${KIND_LABEL[object.kind]}${object.detail ? ` ${object.detail}` : ''} · ${c.name}`,
              connectionId: c.id,
              object,
            });
          }
          pick.items = [...items];
        } catch {
          // A connection that fails here is skipped; the tree shows its error when expanded.
        }
      }),
    );
    pick.busy = false;
    const chosen = await new Promise<Item | undefined>((resolve) => {
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => resolve(undefined));
    });
    pick.dispose();
    if (!chosen) return;

    const node = await this.tree.findNode(chosen.connectionId, chosen.object);
    if (node) await this.view.reveal(node, { select: true, focus: false });
    const target = node ?? (chosen.object.kind === 'table' || chosen.object.kind === 'view'
      ? new TableNode(chosen.connectionId, chosen.object, '')
      : undefined);
    if (target instanceof TableNode) {
      await vscode.commands.executeCommand('dbDeck.previewTable', target);
    } else if (target instanceof ObjectNode) {
      await this.showDdl(target);
    }
  }

  /** Lists the server's databases and reconnects to the chosen one. Asks first if the connection is open. */
  async switchDatabase(node?: ConnectionNode): Promise<void> {
    const config = node && this.manager.get(node.config.id);
    if (!config || DATABASE_SCOPE[config.type] === 'none') return;
    const wasConnected = this.manager.isConnected(config.id);
    let databases: string[];
    try {
      databases = await (await this.manager.getDriver(config.id)).listDatabases();
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn’t list databases: ${errorMessage(err)}`);
      return;
    }
    const items: (vscode.QuickPickItem & { value: string | undefined })[] = databases.map((d) => ({
      label: d,
      description: d === config.database ? 'current' : undefined,
      value: d,
    }));
    if (DATABASE_SCOPE[config.type] === 'optional') {
      items.unshift({ label: 'All databases', description: config.database ? undefined : 'current', value: undefined });
    }
    const picked = await vscode.window.showQuickPick(items, { title: `Switch Database · ${config.name}`, placeHolder: 'Choose a database' });
    if (!picked || picked.value === config.database) return;

    if (wasConnected) {
      const ok = await vscode.window.showWarningMessage(
        `Switch "${config.name}" to ${picked.value ?? 'all databases'}?`,
        { modal: true, detail: 'Reconnecting ends this session, including any open transaction.' },
        'Switch Database',
      );
      if (!ok) return;
    }
    // A name the wizard suggested follows the database; a name the user chose is kept.
    const name =
      config.name === defaultServerName(config.user, config.host, config.database)
        ? defaultServerName(config.user, config.host, picked.value)
        : config.name;
    this.tree.collapseOnNextRefresh(config.id);
    await this.manager.update({ ...config, database: picked.value, name });
  }

  /** schema.name, each part quoted only when needed; the default schema's name is used for objects without one. */
  private qualified(driver: Driver, object: { name: string; schema?: string }): string {
    const schema = object.schema ?? driver.defaultSchemaLabel();
    return [schema, object.name].filter((p): p is string => !!p).map((p) => driver.filterIdentifier(p)).join('.');
  }
}

function iconFor(object: DbObject): string {
  return { table: 'table', view: 'eye', function: 'symbol-method', procedure: 'symbol-event', sequence: 'symbol-number', index: 'list-ordered', trigger: 'zap' }[object.kind];
}

