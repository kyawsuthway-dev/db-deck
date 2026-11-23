import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { DB_KINDS, typeLabel } from '../drivers';
import { checkLayout, mergeLayout, relations, type DiagramLayout, type Relation } from '../diagram/model';
import type { DiagramTable, TableInfo } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

/** Saved positions, groups and view per connection + database + schema (`layoutKey`). Never in the project. */
const LAYOUTS_KEY = 'dbDeck.diagramLayouts';
/** Exported files bigger than this are refused (a huge schema at 2× still fits well below it). */
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

/** Messages to the ER diagram (src/webview/diagram.ts). */
export type DiagramMessage =
  | { type: 'loading' }
  | {
      type: 'data';
      title: string;
      detail: string;
      logo?: { light: string; dark: string };
      /** The panel's key, put into each table's `data-vscode-context` for the right-click commands. */
      panelKey: string;
      tables: DiagramTable[];
      relations: Relation[];
      layout: DiagramLayout;
      /** Tables without a saved position: the page places them next to the others. */
      unplaced: string[];
    }
  | { type: 'error'; text: string }
  | { type: 'notice'; text: string; tone: 'info' | 'error' };

/** Messages from the ER diagram. Untrusted: layouts go through `checkLayout`, table names must be on the diagram. */
export type DiagramRequest =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'save'; layout: DiagramLayout }
  | { type: 'open'; table: string; how: DiagramAction }
  | { type: 'export'; format: 'svg' | 'png'; data: string };

export type DiagramAction = 'rows' | 'design' | 'ddl';

/** What the diagram can do with a table, through the existing commands. */
export interface DiagramActions {
  openRows(connectionId: string, table: TableInfo): unknown;
  design(connectionId: string, table: TableInfo): unknown;
  showDdl(connectionId: string, table: TableInfo): unknown;
}

/** ER Diagram: one panel per connection + schema. */
export class DiagramPanels implements vscode.Disposable {
  private readonly panels = new FormTabs<DiagramPanel>();
  private readonly byKey = new Map<string, DiagramPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly actions: DiagramActions,
  ) {}

  /**
   * `schema` as in `TableInfo.schema` (undefined: the default one). `ask`: from a connection with several
   * schemas, ask which (a quick pick).
   */
  async open(connectionId: string, schema: string | undefined, ask: boolean): Promise<void> {
    const config = this.manager.get(connectionId);
    if (!config) return;
    if (ask) {
      try {
        const driver = await this.manager.getDriver(connectionId);
        const objects = await driver.listObjects();
        const schemas = [...new Set(objects.filter((o) => o.kind === 'table').map((o) => o.schema))].sort((a, b) =>
          a === undefined ? -1 : b === undefined ? 1 : a.localeCompare(b),
        );
        if (schemas.length > 1) {
          const picked = await vscode.window.showQuickPick(
            schemas.map((s) => ({ label: s ?? driver.defaultSchemaLabel() ?? 'default', schema: s })),
            { title: `ER Diagram · ${config.name}`, placeHolder: 'Which schema?', ignoreFocusOut: true },
          );
          if (!picked) return;
          schema = picked.schema;
        } else {
          schema = schemas[0];
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Couldn’t list the schemas of ${config.name}: ${errorMessage(err)}`);
        return;
      }
    }
    const key = `${connectionId}\u0000${schema ?? ''}`;
    const panel = this.panels.open(key, () => new DiagramPanel(this.context, this.manager, this.actions, connectionId, schema, key));
    this.byKey.set(key, panel);
    panel.onDidDispose(() => {
      if (this.byKey.get(key) === panel) this.byKey.delete(key);
    });
  }

  /** A right-click command on a table card: `context` is the card's `data-vscode-context` (untrusted). */
  run(context: unknown, how: DiagramAction): void {
    const ctx = context as { panelKey?: unknown; table?: unknown } | undefined;
    if (typeof ctx?.panelKey !== 'string' || typeof ctx.table !== 'string') return;
    this.byKey.get(ctx.panelKey)?.act(ctx.table, how);
  }

  /** Forgets the layouts of a removed connection. */
  async forget(connectionId: string): Promise<void> {
    const all = this.context.globalState.get<Record<string, DiagramLayout>>(LAYOUTS_KEY, {});
    const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${connectionId}\u0000`)));
    if (Object.keys(kept).length !== Object.keys(all).length) await this.context.globalState.update(LAYOUTS_KEY, kept);
  }

  dispose(): void {
    this.panels.dispose();
  }
}

class DiagramPanel extends FormPanel<DiagramMessage> {
  private tables = new Set<string>();
  private loaded?: Extract<DiagramMessage, { type: 'data' }>;
  private load = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly actions: DiagramActions,
    private readonly connectionId: string,
    private readonly schema: string | undefined,
    private readonly panelKey: string,
  ) {
    super(context.extensionUri, 'dbDeck.diagram', 'ER Diagram', 'diagram', { blobImages: true });
  }

  /** Where this schema's layout is kept: Switch Database changes `config.database`, so it's part of the key. */
  private get layoutKey(): string {
    const config = this.manager.get(this.connectionId);
    return `${this.connectionId}\u0000${config?.database ?? ''}\u0000${this.schema ?? ''}`;
  }

  act(table: string, how: DiagramAction): void {
    if (!this.tables.has(table)) return;
    const info: TableInfo = { name: table, schema: this.schema, kind: 'table' };
    if (how === 'rows') void this.actions.openRows(this.connectionId, info);
    else if (how === 'design') void this.actions.design(this.connectionId, info);
    else void this.actions.showDdl(this.connectionId, info);
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (this.loaded) this.post(this.loaded);
        else await this.read();
        break;
      case 'refresh':
        await this.read();
        break;
      case 'save': {
        const layout = checkLayout(msg.layout, this.tables);
        if (!layout) return;
        const all = this.context.globalState.get<Record<string, DiagramLayout>>(LAYOUTS_KEY, {});
        await this.context.globalState.update(LAYOUTS_KEY, { ...all, [this.layoutKey]: layout });
        if (this.loaded) this.loaded = { ...this.loaded, layout, unplaced: [] };
        break;
      }
      case 'open':
        if (typeof msg.table === 'string' && (msg.how === 'rows' || msg.how === 'design' || msg.how === 'ddl')) this.act(msg.table, msg.how);
        break;
      case 'export':
        if ((msg.format === 'svg' || msg.format === 'png') && typeof msg.data === 'string') await this.export(msg.format, msg.data);
        break;
    }
  }

  private async read(): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config) return;
    const token = ++this.load;
    this.post({ type: 'loading' });
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const diagram = await driver.schemaDiagram(this.schema);
      if (token !== this.load) return;
      const saved = this.context.globalState.get<Record<string, DiagramLayout>>(LAYOUTS_KEY, {})[this.layoutKey];
      const { layout, unplaced } = mergeLayout(saved, diagram);
      this.tables = new Set(diagram.tables.map((t) => t.name));
      const label = this.schema ?? driver.defaultSchemaLabel() ?? config.name;
      this.panel.title = `ER: ${label}`;
      const kind = DB_KINDS.find((k) => k.type === config.type);
      this.loaded = {
        type: 'data',
        title: `ER Diagram · ${label}`,
        detail: `${config.name} · ${typeLabel(config.type)} · ${diagram.tables.length} table${diagram.tables.length === 1 ? '' : 's'}`,
        logo: kind && this.logo(kind.logo),
        panelKey: this.panelKey,
        tables: diagram.tables,
        relations: relations(diagram),
        layout,
        unplaced,
      };
      this.post(this.loaded);
    } catch (err) {
      if (token === this.load) this.post({ type: 'error', text: errorMessage(err) });
    }
  }

  /** The page sends the file's content (SVG text, or PNG as base64); the extension checks it and writes it. */
  private async export(format: 'svg' | 'png', data: string): Promise<void> {
    let bytes: Uint8Array;
    if (format === 'svg') {
      if (!/^<svg[\s>]/.test(data)) return;
      bytes = new TextEncoder().encode(data);
    } else {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
      bytes = Buffer.from(data, 'base64');
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (!signature.every((b, i) => bytes[i] === b)) return;
    }
    if (bytes.length > MAX_EXPORT_BYTES) {
      this.post({ type: 'notice', text: 'The image is too large to save. Try exporting the current view instead.', tone: 'error' });
      return;
    }
    const base = (this.panel.title.replace(/^ER: /, '') || 'diagram').replace(/[\\/:*?"<>|]/g, '_');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      title: `Export ER Diagram as ${format.toUpperCase()}`,
      defaultUri: folder ? vscode.Uri.joinPath(folder, `${base}-er.${format}`) : undefined,
      filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, bytes);
      this.post({ type: 'notice', text: `Saved ${vscode.workspace.asRelativePath(target)}.`, tone: 'info' });
    } catch (err) {
      this.post({ type: 'notice', text: `Couldn’t save the image: ${errorMessage(err)}`, tone: 'error' });
    }
  }
}
