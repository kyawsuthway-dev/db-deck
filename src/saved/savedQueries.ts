import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import type { QueryController } from '../query/runQuery';
import { connectionOfPath, fileNameOf, nameProblem, queryNameOf, sameName } from './names';

/** id → last known name, so queries of removed connections can still say whose they were. */
const NAMES_KEY = 'dbDeck.savedQueryConnections';

export interface SavedQuery {
  connectionId: string;
  name: string;
  uri: vscode.Uri;
}

export interface SavedQueryGroup {
  connectionId: string;
  connectionName: string;
  /** The connection was removed; its queries are kept. */
  removed: boolean;
  queries: SavedQuery[];
}

/**
 * Saved queries are real .sql files in DB Deck's storage: `<globalStorage>/queries/<connectionId>/<name>.sql`.
 * VS Code's editor does the editing and saving; a file is linked to the connection of its folder.
 * File access goes through vscode.workspace.fs, so it works in remote sessions too.
 */
export class SavedQueries implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly root: vscode.Uri;

  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
  ) {
    this.root = vscode.Uri.joinPath(context.globalStorageUri, 'queries');
    this.disposables.push(this.changed, queries.registerLinkResolver((uri) => this.connectionOf(uri)));
  }

  /** The connection a saved query file belongs to, from its folder; undefined for other files. */
  connectionOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.root.scheme || uri.authority !== this.root.authority) return undefined;
    return connectionOfPath(this.root.path, uri.path);
  }

  /** Every connection folder with at least one query, current connections first, names sorted. */
  async groups(): Promise<SavedQueryGroup[]> {
    const names = this.context.globalState.get<Record<string, string>>(NAMES_KEY, {});
    const groups: SavedQueryGroup[] = [];
    const learned: Record<string, string> = {};
    for (const [folder, type] of await readDirectory(this.root)) {
      if (type !== vscode.FileType.Directory) continue;
      const dir = vscode.Uri.joinPath(this.root, folder);
      const queries = (await readDirectory(dir))
        .filter(([file, t]) => t === vscode.FileType.File && queryNameOf(file))
        .map(([file]) => ({ connectionId: folder, name: queryNameOf(file)!, uri: vscode.Uri.joinPath(dir, file) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!queries.length) continue;
      const config = this.manager.get(folder);
      if (config && names[folder] !== config.name) learned[folder] = config.name;
      groups.push({
        connectionId: folder,
        connectionName: config?.name ?? names[folder] ?? 'Unknown connection',
        removed: !config,
        queries,
      });
    }
    if (Object.keys(learned).length) await this.context.globalState.update(NAMES_KEY, { ...names, ...learned });
    return groups.sort((a, b) => Number(a.removed) - Number(b.removed) || a.connectionName.localeCompare(b.connectionName));
  }

  /**
   * Saves the active SQL editor's text as a named query of its connection. An untitled editor is replaced
   * by the saved file; an editor that already is a saved query just saves.
   */
  async saveActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (!editor || !doc || doc.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a SQL editor to save its query (DB Deck: New Query).');
      return;
    }
    if (this.connectionOf(doc.uri)) {
      await doc.save();
      return;
    }
    if (!doc.getText().trim()) {
      void vscode.window.showInformationMessage('There is no SQL to save yet.');
      return;
    }
    const connectionId = this.queries.connectionFor(doc) ?? (await this.queries.pickConnection());
    if (!connectionId) return;
    const folder = vscode.Uri.joinPath(this.root, connectionId);
    const existing = await this.namesIn(folder);
    const name = await vscode.window.showInputBox({
      title: `Save Query · ${this.manager.get(connectionId)?.name ?? ''}`,
      prompt: 'Name of the saved query',
      ignoreFocusOut: true,
      validateInput: (value) => nameProblem(value) ?? (existing.some((n) => sameName(n, value)) ? 'A saved query with this name already exists.' : undefined),
    });
    if (name === undefined) return;

    const uri = vscode.Uri.joinPath(folder, fileNameOf(name));
    const text = doc.getText();
    try {
      await vscode.workspace.fs.createDirectory(folder);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn’t save the query: ${errorMessage(err)}`);
      return;
    }
    await this.rememberName(connectionId);
    // The untitled editor's text is now in the file, so close it without asking and open the file instead.
    if (doc.isUntitled && vscode.window.activeTextEditor?.document === doc) {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await vscode.window.showTextDocument(uri, { preview: false });
    this.changed.fire();
  }

  /** Open Query…: picks one of the connection's saved queries and opens it (linked to the connection by its folder). */
  async pickAndOpen(connectionId: string): Promise<void> {
    const name = this.manager.get(connectionId)?.name ?? 'this connection';
    const group = (await this.groups()).find((g) => g.connectionId === connectionId);
    if (!group) {
      void vscode.window.showInformationMessage(
        `No saved queries for ${name} yet. In one of its SQL editors, use Save Query… (Ctrl/Cmd+S in a new editor).`,
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      group.queries.map((query) => ({ label: query.name, query })),
      { title: `Open Query · ${name}`, placeHolder: 'Saved query to open' },
    );
    if (picked) await vscode.window.showTextDocument(picked.query.uri);
  }

  /** Runs the whole query, including unsaved changes in an open editor. */
  async run(query: SavedQuery): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(query.uri);
    const sql = doc.getText();
    if (!sql.trim()) {
      void vscode.window.showInformationMessage('This saved query is empty.');
      return;
    }
    await this.queries.runSqlOn(this.queries.connectionFor(doc), sql);
  }

  async rename(query: SavedQuery): Promise<void> {
    const folder = vscode.Uri.joinPath(this.root, query.connectionId);
    const others = (await this.namesIn(folder)).filter((n) => n !== query.name);
    const name = await vscode.window.showInputBox({
      title: 'Rename Saved Query',
      value: query.name,
      ignoreFocusOut: true,
      validateInput: (value) => nameProblem(value) ?? (others.some((n) => sameName(n, value)) ? 'A saved query with this name already exists.' : undefined),
    });
    if (name === undefined || name === query.name) return;
    // A WorkspaceEdit also moves an open editor to the new file.
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(query.uri, vscode.Uri.joinPath(folder, fileNameOf(name)), { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage(`Couldn’t rename "${query.name}".`);
    }
    this.changed.fire();
  }

  async delete(query: SavedQuery): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Delete the saved query "${query.name}"?`,
      { modal: true, detail: 'Its file is deleted. The database isn’t touched.' },
      'Delete',
    );
    if (!choice) return;
    try {
      await vscode.workspace.fs.delete(query.uri);
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn’t delete "${query.name}": ${errorMessage(err)}`);
    }
    this.changed.fire();
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async namesIn(folder: vscode.Uri): Promise<string[]> {
    return (await readDirectory(folder)).map(([file]) => queryNameOf(file)).filter((n): n is string => !!n);
  }

  private async rememberName(connectionId: string): Promise<void> {
    const name = this.manager.get(connectionId)?.name;
    if (!name) return;
    const names = this.context.globalState.get<Record<string, string>>(NAMES_KEY, {});
    if (names[connectionId] !== name) await this.context.globalState.update(NAMES_KEY, { ...names, [connectionId]: name });
  }
}

/** A folder's entries, or none when it doesn't exist yet. */
async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
}
