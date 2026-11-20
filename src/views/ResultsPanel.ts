import * as vscode from 'vscode';
import type { FilterHints, PendingChanges, SortKey, StatementResult } from '../types';

/** Paging and sort state of a table view; absent for query results. */
export interface TableViewState {
  offset: number;
  pageSize: number;
  hasMore: boolean;
  /** The column the user sorted by; undefined means the default order. */
  sort?: SortKey;
  /** True when the default order is the primary key, so pages are stable. */
  orderedByKey: boolean;
  /** The applied filter condition (the WHERE box); undefined when unfiltered. */
  where?: string;
  /** Column names and operators the WHERE box suggests. */
  hints: FilterHints;
  /** Editable: the primary key and the columns that can't be edited. Otherwise why the table is read-only. */
  edit: { key: string[]; readOnly: string[] } | { reason: string };
}

/** Grid actions from VS Code's context menu, carried out by the webview on its selection. */
export type EditCommand = 'setNull' | 'deleteRows' | 'addRow';

/** Messages sent to the webview (src/webview/results.ts). */
export type ResultsMessage =
  | { type: 'loading'; title: string; sql: string }
  | { type: 'results'; title: string; results: StatementResult[]; table?: TableViewState };

/** How copied cells are put on the clipboard. */
export type CopyFormat = 'tsv' | 'tsvHeaders' | 'csv' | 'json';

/** One-off commands to the webview. Unlike ResultsMessage, they're never replayed on reload. */
export type ResultsCommand =
  | { type: 'copyRequest'; format: CopyFormat }
  | { type: 'edit'; command: EditCommand }
  /** Forget pending edits (after a save, or when the user agreed to discard them). */
  | { type: 'clearPending' }
  /**
   * Ask the user to confirm a save, inside the grid. `statements` are for reading only (Review SQL).
   * Apply sends `token` back; the extension runs only the change set it prepared under that token.
   */
  | { type: 'confirmSave'; token: string; title: string; detail: string; statements: string[] }
  /** The save finished or failed: close the confirmation. */
  | { type: 'closeConfirm' };

/** Messages the webview sends back. Treat them as untrusted input. */
export type ResultsRequest =
  | { type: 'ready' }
  | { type: 'page'; offset: number }
  | { type: 'sort'; sort?: SortKey }
  | { type: 'filter'; where: string }
  /** `order`: the row order shown, when query results were sorted in the webview. */
  | { type: 'export'; index: number; order?: number[] }
  /** `rows`: original row indexes in display order; `columns`: the first and last column. */
  | { type: 'copy'; index: number; rows: number[]; columns: [number, number]; format: CopyFormat }
  /** How many pending edits the grid holds, so opening something else can ask first. */
  | { type: 'pending'; count: number }
  | { type: 'save'; changes: PendingChanges }
  /** The user clicked Apply or Cancel in the save confirmation (`confirmSave`). */
  | { type: 'applySave'; token: string }
  | { type: 'cancelSave'; token: string };

const REQUEST_TYPES = new Set(['page', 'sort', 'filter', 'export', 'copy', 'pending', 'save', 'applySave', 'cancelSave']);

/** One reusable "Results" editor tab showing the latest run. */
export class ResultsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private last?: ResultsMessage;
  private runId = 0;
  private readonly requests = new vscode.EventEmitter<Exclude<ResultsRequest, { type: 'ready' }>>();

  /** Page and sort requests from the table view's controls. */
  readonly onDidRequest = this.requests.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Shows a loading state. Returns a token; results for an older token are ignored. */
  showLoading(title: string, sql: string, column: vscode.ViewColumn): number {
    this.post({ type: 'loading', title, sql }, column);
    return ++this.runId;
  }

  /** Starts a run that keeps the current grid on screen (the webview shows its own busy state). */
  startRun(): number {
    return ++this.runId;
  }

  showResults(token: number, title: string, results: StatementResult[], table?: TableViewState): void {
    if (token === this.runId) this.post({ type: 'results', title, results, table });
  }

  /** The results on screen (for export and copy), or undefined while loading or before any run. */
  lastResults(): Extract<ResultsMessage, { type: 'results' }> | undefined {
    return this.last?.type === 'results' ? this.last : undefined;
  }

  /** Asks the webview to send its selected cells back as a `copy` request (from the context menu). */
  requestCopy(format: CopyFormat): void {
    this.command({ type: 'copyRequest', format });
  }

  /** A context-menu edit action (Set to NULL, Delete Rows, Add Row) for the webview's selection. */
  requestEdit(command: EditCommand): void {
    this.command({ type: 'edit', command });
  }

  clearPending(): void {
    this.command({ type: 'clearPending' });
  }

  confirmSave(token: string, title: string, detail: string, statements: string[]): void {
    this.command({ type: 'confirmSave', token, title, detail, statements });
  }

  closeConfirm(): void {
    this.command({ type: 'closeConfirm' });
  }

  private command(command: ResultsCommand): void {
    if (this.panel) void this.panel.webview.postMessage(command);
  }

  dispose(): void {
    this.panel?.dispose();
    this.requests.dispose();
  }

  private post(message: ResultsMessage, column?: vscode.ViewColumn): void {
    this.last = message;
    const panel = this.ensurePanel(column ?? vscode.ViewColumn.Beside);
    panel.title = message.title;
    void panel.webview.postMessage(message);
  }

  private ensurePanel(column: vscode.ViewColumn): vscode.WebviewPanel {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(undefined, true);
      return this.panel;
    }
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      'dbDeck.results',
      'Results',
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [distUri] },
    );
    const webview = panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'results.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'results.css'));
    // No inline code is allowed; all values are inserted with textContent in results.ts.
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <script src="${script}" defer></script>
</head>
<body><main id="root"></main></body>
</html>`;
    webview.onDidReceiveMessage((msg: Partial<ResultsRequest> | undefined) => {
      // The webview asks for data once its script loads, including after being hidden and shown again.
      if (msg?.type === 'ready') {
        if (this.last) void webview.postMessage(this.last);
      } else if (typeof msg?.type === 'string' && REQUEST_TYPES.has(msg.type)) {
        this.requests.fire(msg as Exclude<ResultsRequest, { type: 'ready' }>);
      }
    });
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
    return panel;
  }
}
