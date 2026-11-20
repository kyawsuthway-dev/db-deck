import * as vscode from 'vscode';
import type { StatementResult } from '../types';

/** Messages sent to the webview (src/webview/results.ts). */
export type ResultsMessage =
  | { type: 'loading'; title: string; sql: string }
  | { type: 'results'; title: string; results: StatementResult[] };

/** One reusable "Results" editor tab showing the latest run. */
export class ResultsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private last?: ResultsMessage;
  private runId = 0;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Shows a loading state. Returns a token; results for an older token are ignored. */
  showLoading(title: string, sql: string, column: vscode.ViewColumn): number {
    this.post({ type: 'loading', title, sql }, column);
    return ++this.runId;
  }

  showResults(token: number, title: string, results: StatementResult[]): void {
    if (token === this.runId) this.post({ type: 'results', title, results });
  }

  dispose(): void {
    this.panel?.dispose();
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
    // The webview asks for data once its script loads, including after being hidden and shown again.
    webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === 'ready' && this.last) void webview.postMessage(this.last);
    });
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
    return panel;
  }
}
