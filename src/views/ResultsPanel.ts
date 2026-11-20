import * as vscode from 'vscode';
import type { FilterHints, SortKey, StatementResult } from '../types';

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
}

/** Messages sent to the webview (src/webview/results.ts). */
export type ResultsMessage =
  | { type: 'loading'; title: string; sql: string }
  | { type: 'results'; title: string; results: StatementResult[]; table?: TableViewState };

/** Messages the webview sends back. Treat them as untrusted input. */
export type ResultsRequest =
  | { type: 'ready' }
  | { type: 'page'; offset: number }
  | { type: 'sort'; sort?: SortKey }
  | { type: 'filter'; where: string };

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
      } else if (msg?.type === 'page' || msg?.type === 'sort' || msg?.type === 'filter') {
        this.requests.fire(msg as Exclude<ResultsRequest, { type: 'ready' }>);
      }
    });
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
    return panel;
  }
}
