import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import type { QueryController, QueryRun } from '../query/runQuery';
import { addEntry, firstLine, makeEntry, readEntries, type HistoryEntry } from './entries';

const HISTORY_KEY = 'dbDeck.queryHistory';
const ENABLED_SETTING = 'dbDeck.history.enabled';

/**
 * Records every run from a SQL editor in this workspace's state (newest first, capped in entries.ts).
 * SQL is kept as typed and never leaves the machine (core.md rule 6); dbDeck.history.enabled turns
 * recording off, and Clear History removes it.
 */
export class QueryHistory implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Runs are recorded one at a time, so two quick runs can't overwrite each other's update. */
  private writing: Promise<void> = Promise.resolve();

  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
  ) {
    this.disposables.push(this.changed, queries.onDidRun((run) => this.record(run)));
  }

  entries(): HistoryEntry[] {
    return readEntries(this.context.workspaceState.get(HISTORY_KEY));
  }

  /** The connection's current name, or the one it had with "(removed)". */
  connectionLabel(entry: HistoryEntry): string {
    return this.manager.get(entry.connectionId)?.name ?? `${entry.connectionName} (removed)`;
  }

  /** Opens the SQL in a new editor, linked to its connection if it still exists. Nothing runs. */
  async open(entry: HistoryEntry): Promise<void> {
    const note = entry.shortened ? '-- Shortened in DB Deck’s query history: only the start of this SQL was kept.\n' : '';
    await this.queries.openSql(entry.connectionId, note + entry.sql);
  }

  /** Runs the entry again, like running it from an editor. Shortened SQL is never run. */
  async runAgain(entry: HistoryEntry): Promise<void> {
    if (entry.shortened) {
      void vscode.window.showWarningMessage('This query was too long to keep in full, so it can’t be run again from history.');
      return;
    }
    await this.queries.runSqlOn(entry.connectionId, entry.sql);
  }

  async copy(entry: HistoryEntry): Promise<void> {
    await vscode.env.clipboard.writeText(entry.sql);
  }

  delete(entry: HistoryEntry): Promise<void> {
    return this.update((entries) => entries.filter((e) => e.id !== entry.id));
  }

  async clear(): Promise<void> {
    const count = this.entries().length;
    if (!count) return;
    const choice = await vscode.window.showWarningMessage(
      `Clear the query history of this workspace (${count.toLocaleString('en-US')} ${count === 1 ? 'entry' : 'entries'})?`,
      { modal: true, detail: 'Saved queries aren’t affected.' },
      'Clear History',
    );
    if (choice) await this.update(() => []);
  }

  /** A searchable list of the history (SQL, connection, time); the picked entry opens in an editor. */
  async search(): Promise<void> {
    const items = this.entries().map((entry) => ({
      // `$(` would otherwise be read as an icon.
      label: `$(${entry.ok ? 'pass' : 'error'}) ${firstLine(entry.sql).replace(/\$\(/g, '\\$(')}`,
      description: `${this.connectionLabel(entry)} · ${new Date(entry.at).toLocaleString()}`,
      detail: entry.sql.replace(/\s+/g, ' ').slice(0, 500),
      entry,
    }));
    if (!items.length) {
      void vscode.window.showInformationMessage('No queries have been run in this workspace yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Query History',
      placeHolder: 'Search SQL or connection',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked) await this.open(picked.entry);
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private record(run: QueryRun): void {
    if (!vscode.workspace.getConfiguration().get<boolean>(ENABLED_SETTING, true)) return;
    const entry = makeEntry({
      id: randomUUID(),
      connectionId: run.connectionId,
      connectionName: this.manager.get(run.connectionId)?.name ?? 'Unknown connection',
      sql: run.sql,
      at: run.startedAt,
      results: run.results,
    });
    void this.update((entries) => addEntry(entries, entry));
  }

  private update(change: (entries: HistoryEntry[]) => HistoryEntry[]): Promise<void> {
    this.writing = this.writing
      .then(() => this.context.workspaceState.update(HISTORY_KEY, change(this.entries())))
      .then(() => this.changed.fire())
      .catch(() => undefined);
    return this.writing;
  }
}
