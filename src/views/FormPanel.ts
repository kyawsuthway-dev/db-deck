import * as vscode from 'vscode';
import { logoUris } from '../logos';

/**
 * The extension side shared by DB Deck's form webviews (connection, dump, run file, CSV import): an editor
 * tab with the strict CSP (webview.md), `dist/webview` and `media/logos` as the only resource roots, kept
 * alive while hidden so typed values survive switching tabs. The page script is `dist/webview/<entry>.js`.
 * Messages from the page are untrusted: subclasses check every field in `onMessage`.
 */
export abstract class FormPanel<Message> {
  protected readonly panel: vscode.WebviewPanel;

  constructor(
    protected readonly extensionUri: vscode.Uri,
    viewType: string,
    title: string,
    entry: string,
  ) {
    const distUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    const logosUri = vscode.Uri.joinPath(extensionUri, 'media', 'logos');
    this.panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [distUri, logosUri],
      retainContextWhenHidden: true,
    });
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, `${entry}.js`));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, `${entry}.css`));
    // No inline code; the page inserts every value with textContent.
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <script src="${script}" defer></script>
</head>
<body><main id="root"></main></body>
</html>`;
    webview.onDidReceiveMessage((msg: unknown) => {
      if (msg && typeof msg === 'object') void this.onMessage(msg as Record<string, unknown>);
    });
  }

  /** A message from the page (an object; its fields are still unchecked). */
  protected abstract onMessage(msg: Record<string, unknown>): void | Promise<void>;

  readonly onDidDispose = (listener: () => void) => this.panel.onDidDispose(listener);

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }

  protected post(message: Message): void {
    void this.panel.webview.postMessage(message);
  }

  /** Webview URIs of a database logo (`DbKind.logo`), or undefined when there's no logo file. */
  protected logo(name: string): { light: string; dark: string } | undefined {
    const uris = logoUris(this.extensionUri, name);
    return uris && { light: this.panel.webview.asWebviewUri(uris.light).toString(), dark: this.panel.webview.asWebviewUri(uris.dark).toString() };
  }
}

/** One form tab per key (a connection, a file…): opening it again shows the existing tab. */
export class FormTabs<P extends { reveal(): void; dispose(): void; onDidDispose(listener: () => void): vscode.Disposable }> implements vscode.Disposable {
  private readonly forms = new Map<string, P>();

  open(key: string, create: () => P): P {
    const existing = this.forms.get(key);
    if (existing) {
      existing.reveal();
      return existing;
    }
    const form = create();
    this.forms.set(key, form);
    form.onDidDispose(() => {
      if (this.forms.get(key) === form) this.forms.delete(key);
    });
    return form;
  }

  all(): P[] {
    return [...this.forms.values()];
  }

  dispose(): void {
    for (const form of this.all()) form.dispose();
  }
}
