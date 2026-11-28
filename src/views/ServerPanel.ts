import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage, formatDuration } from '../drivers/common';
import { DB_KINDS, SERVER_TOOLS, typeLabel } from '../drivers';
import type { ServerItem, ServerProcess } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

export type ServerTab = 'status' | 'processes' | 'settings';

/** Messages to the Server panel (src/webview/serverView.ts). */
export type ServerMessage =
  | {
      type: 'init';
      title: string;
      detail: string;
      logo?: { light: string; dark: string };
      /** Whether the database has sessions to list (SERVER_TOOLS). */
      processes: boolean;
      /** Cancel Query / End Session are offered (off on read-only connections). */
      canEnd: boolean;
      /** Cancel Query is offered (SERVER_TOOLS.cancelQuery; SQL Server can only end a session). */
      canCancel: boolean;
    }
  | { type: 'status'; items: ServerItem[] }
  | { type: 'settings'; items: ServerItem[] }
  | { type: 'processes'; items: ServerProcess[] }
  | { type: 'loading'; tab: ServerTab }
  | { type: 'error'; tab: ServerTab; text: string }
  /** After Cancel Query / End Session. */
  | { type: 'notice'; text: string; tone: 'info' | 'error' };

/** Messages from the Server panel. Untrusted: a session id must be one the extension itself listed. */
export type ServerRequest = { type: 'ready' } | { type: 'refresh'; tab: ServerTab } | { type: 'end'; id: string; how: 'cancel' | 'terminate' };

const TABS: ServerTab[] = ['status', 'processes', 'settings'];

/** Server…: one panel per connection, with the server's status, sessions and settings. */
export class ServerPanels implements vscode.Disposable {
  private readonly panels = new FormTabs<ServerPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
  ) {}

  open(connectionId: string): void {
    if (!this.manager.get(connectionId)) return;
    this.panels.open(connectionId, () => new ServerPanel(this.extensionUri, this.manager, connectionId));
  }

  dispose(): void {
    this.panels.dispose();
  }
}

class ServerPanel extends FormPanel<ServerMessage> {
  /** The sessions last sent to the page: Cancel / End only act on one of these. */
  private sessions: ServerProcess[] = [];
  /** Each tab's load gets a number; an older load's answer is dropped. */
  private readonly loads: Record<ServerTab, number> = { status: 0, processes: 0, settings: 0 };

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly connectionId: string,
  ) {
    super(extensionUri, 'dbDeck.server', `Server: ${manager.get(connectionId)?.name ?? ''}`, 'serverView');
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config) return;
    const tools = SERVER_TOOLS[config.type];
    if (msg.type === 'ready') {
      const kind = DB_KINDS.find((k) => k.type === config.type);
      this.post({
        type: 'init',
        title: 'Server',
        detail: `${config.name} · ${typeLabel(config.type)}`,
        logo: kind && this.logo(kind.logo),
        processes: tools.processes,
        canEnd: tools.processes && !config.readOnly,
        canCancel: tools.cancelQuery,
      });
      for (const tab of TABS) if (tab !== 'processes' || tools.processes) void this.load(tab);
    } else if (msg.type === 'refresh' && TABS.includes(msg.tab as ServerTab)) {
      const tab = msg.tab as ServerTab;
      if (tab !== 'processes' || tools.processes) await this.load(tab);
    } else if (msg.type === 'end' && (msg.how === 'cancel' || msg.how === 'terminate') && typeof msg.id === 'string') {
      await this.end(msg.id, msg.how);
    }
  }

  private async load(tab: ServerTab): Promise<void> {
    const token = ++this.loads[tab];
    this.post({ type: 'loading', tab });
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      if (tab === 'status') {
        const items = await driver.serverStatus();
        if (token === this.loads[tab]) this.post({ type: 'status', items });
      } else if (tab === 'settings') {
        const items = await driver.serverSettings();
        if (token === this.loads[tab]) this.post({ type: 'settings', items });
      } else {
        const items = await driver.listProcesses();
        if (token !== this.loads[tab]) return;
        this.sessions = items;
        this.post({ type: 'processes', items });
      }
    } catch (err) {
      if (token === this.loads[tab]) this.post({ type: 'error', tab, text: errorMessage(err) });
    }
  }

  /** Cancel Query / End Session, after a modal that names the session. Checked again here, not only in the page. */
  private async end(id: string, how: 'cancel' | 'terminate'): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config || !SERVER_TOOLS[config.type].processes) return;
    if (how === 'cancel' && !SERVER_TOOLS[config.type].cancelQuery) return;
    if (config.readOnly) {
      this.post({ type: 'notice', text: 'This connection is read-only: DB Deck doesn’t cancel queries or end sessions through it.', tone: 'error' });
      return;
    }
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    const who = [session.user, session.database].filter(Boolean).join('@');
    const running = session.seconds !== undefined ? `, running ${formatDuration(session.seconds)}` : '';
    const query = session.query.replace(/\s+/g, ' ').trim();
    const what = `${who || 'unknown user'}${running}${query ? `: ${query.length > 120 ? `${query.slice(0, 120)}…` : query}` : ''}`;
    const own = session.own ? ' This is one of DB Deck’s own connections.' : '';
    const [question, detail, action] =
      how === 'cancel'
        ? [`Cancel the query in session ${id}?`, `${what}\n\nThe running statement stops with an error; the session stays open.${own}`, 'Cancel Query']
        : [`End session ${id}?`, `${what}\n\nThe session is disconnected and its open transaction is rolled back.${own}`, 'End Session'];
    const choice = await vscode.window.showWarningMessage(question, { modal: true, detail }, action);
    if (choice !== action) return;
    try {
      await (await this.manager.getDriver(this.connectionId)).endProcess(id, how);
      this.post({ type: 'notice', text: how === 'cancel' ? `Asked session ${id} to cancel its query.` : `Ended session ${id}.`, tone: 'info' });
    } catch (err) {
      this.post({ type: 'notice', text: errorMessage(err), tone: 'error' });
    }
    await this.load('processes');
  }
}
