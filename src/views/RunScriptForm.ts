import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage, ScriptCancelled, ScriptError } from '../drivers/common';
import { DB_KINDS, TRANSACTIONAL_DDL, typeLabel } from '../drivers';
import type { QueryController } from '../query/runQuery';
import { analyzeScript, type ScriptAnalysis } from '../transfer/script';
import { FormPanel, FormTabs } from './FormPanel';

/** Files bigger than this get a warning: they're read into memory to be split into statements. */
const LARGE_FILE_BYTES = 100 * 1024 * 1024;

export interface ScriptConnection {
  id: string;
  name: string;
  detail: string;
  logo?: { light: string; dark: string };
  readOnly: boolean;
}

export type ScriptNoteTone = 'info' | 'warning' | 'error';

/** Messages to the Run SQL File form (src/webview/runScriptForm.ts). */
export type ScriptMessage =
  | { type: 'init'; fileName: string; filePath: string; size: string; connections: ScriptConnection[]; selected?: string }
  /** What running the file on `connectionId` will do; `statements` 0 or `blocked` disables Run. */
  | { type: 'analysis'; connectionId: string; statements: number; notes: { tone: ScriptNoteTone; text: string }[]; blocked: boolean; dirty: boolean }
  | { type: 'running'; running: boolean }
  /** `line`: offer Show Line (a failed statement). */
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; line?: number };

/** Messages from the form. Untrusted: the connection id is checked; the file is re-read and re-analyzed on Run. */
export type ScriptRequest =
  | { type: 'ready' }
  | { type: 'choose'; connectionId: string }
  | { type: 'run'; connectionId: string }
  | { type: 'cancel' }
  | { type: 'save' }
  | { type: 'showLine'; line: number }
  | { type: 'close' };

/** Run SQL File…: one form per file. Running only happens from the form's Run button, after its notes. */
export class RunScriptForms implements vscode.Disposable {
  private readonly forms = new FormTabs<RunScriptPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
    private readonly onSchemaChanged: (connectionId: string) => void,
  ) {}

  /** `uri`: from the Explorer's menu; otherwise the active SQL editor's file, or a file picker. */
  async open(uri?: vscode.Uri): Promise<void> {
    const file = await pickFile(uri);
    if (!file) return;
    this.forms.open(file.toString(), () => new RunScriptPanel(this.extensionUri, this.manager, this.queries, this.onSchemaChanged, file));
  }

  dispose(): void {
    this.forms.dispose();
  }
}

class RunScriptPanel extends FormPanel<ScriptMessage> {
  private running = false;
  private cancelled = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
    private readonly onSchemaChanged: (connectionId: string) => void,
    private readonly file: vscode.Uri,
  ) {
    super(extensionUri, 'dbDeck.runScriptForm', `Run ${path.basename(file.fsPath)}`, 'runScriptForm');
    // Saving or editing the file changes what would run: analyze again.
    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((d) => d.uri.toString() === file.toString() && void this.refresh()),
      // Typing only changes the "unsaved changes" note: check once typing pauses.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== file.toString()) return;
        clearTimeout(this.typing);
        this.typing = setTimeout(() => void this.refresh(), 400);
      }),
      manager.onDidChange(() => void this.init()),
    );
    this.panel.onDidDispose(() => {
      this.cancelled = true;
      clearTimeout(this.typing);
      for (const s of this.subscriptions) s.dispose();
    });
  }

  private chosen?: string;
  private typing?: ReturnType<typeof setTimeout>;

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.init();
      case 'close':
        if (!this.running) this.dispose();
        return;
      case 'cancel':
        this.cancelled = true;
        return;
      case 'choose':
        if (typeof msg.connectionId === 'string' && this.manager.get(msg.connectionId)) {
          this.chosen = msg.connectionId;
          await this.refresh();
        }
        return;
      case 'save': {
        const doc = this.openDocument();
        if (doc?.isDirty) await doc.save();
        await this.refresh();
        return;
      }
      case 'showLine':
        if (typeof msg.line === 'number' && Number.isInteger(msg.line) && msg.line >= 1) {
          const position = new vscode.Position(msg.line - 1, 0);
          await vscode.window.showTextDocument(this.file, { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.Beside });
        }
        return;
      case 'run':
        if (typeof msg.connectionId === 'string') return this.run(msg.connectionId);
        return;
    }
  }

  private openDocument(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.file.toString());
  }

  private async init(): Promise<void> {
    if (this.running) return;
    let size = 0;
    try {
      size = (await vscode.workspace.fs.stat(this.file)).size;
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t read ${path.basename(this.file.fsPath)}: ${errorMessage(err)}` });
      return;
    }
    const connections = this.manager.list().map((c) => {
      const kind = DB_KINDS.find((k) => k.type === c.type);
      return {
        id: c.id,
        name: c.name,
        detail: `${typeLabel(c.type)}${c.readOnly ? ' · read-only' : ''}`,
        logo: kind && this.logo(kind.logo),
        readOnly: !!c.readOnly,
      };
    });
    // The editor's linked connection is preselected; the user can pick another.
    const doc = this.openDocument();
    const linked = doc ? this.queries.connectionFor(doc) : undefined;
    if (!this.chosen || !this.manager.get(this.chosen)) this.chosen = linked;
    this.post({
      type: 'init',
      fileName: path.basename(this.file.fsPath),
      filePath: this.file.fsPath,
      size: size < 1024 ? `${size} bytes` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`,
      connections,
      selected: this.chosen,
    });
    await this.refresh();
  }

  /** Reads and analyzes the file for the chosen connection, and tells the form what Run will do. */
  private async refresh(): Promise<{ analysis: ScriptAnalysis } | undefined> {
    if (this.running || !this.chosen) return undefined;
    const config = this.manager.get(this.chosen);
    if (!config) return undefined;
    let text: string;
    let size: number;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file);
      size = bytes.byteLength;
      text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t read ${path.basename(this.file.fsPath)}: ${errorMessage(err)}` });
      return undefined;
    }
    const analysis = analyzeScript(text, config.type);
    const notes: { tone: ScriptNoteTone; text: string }[] = [];
    let blocked = false;
    if (config.readOnly) {
      notes.push({ tone: 'error', text: `"${config.name}" is read-only, so DB Deck won’t run a script on it.` });
      blocked = true;
    }
    if (analysis.delimiter) {
      notes.push({ tone: 'error', text: 'The file uses DELIMITER, which DB Deck doesn’t support yet. Run it with the mysql command-line client.' });
      blocked = true;
    }
    const dirty = !!this.openDocument()?.isDirty;
    if (dirty) {
      notes.push({ tone: 'warning', text: 'The file has unsaved changes. Run SQL File runs it as saved on disk: save it first to run your changes.' });
    }
    if (size > LARGE_FILE_BYTES) notes.push({ tone: 'warning', text: 'This is a large file: DB Deck reads all of it into memory to split it into statements.' });
    if (analysis.ownTransactions) {
      notes.push({
        tone: 'warning',
        text: 'The file has its own BEGIN / COMMIT, so DB Deck runs it as written, without its own transaction. If a statement fails, the statements before it may be kept.',
      });
    } else {
      notes.push({ tone: 'info', text: 'Everything runs in one transaction: if any statement fails, or you cancel, nothing is kept.' });
      if (analysis.schemaChanges && !TRANSACTIONAL_DDL[config.type]) {
        notes.push({
          tone: 'warning',
          text: 'This database commits at every CREATE / ALTER / DROP: those statements, and everything before them, are kept even if a later statement fails. Only what runs after the last one is rolled back.',
        });
      }
    }
    notes.push({ tone: 'info', text: 'It runs on its own connection: a transaction open in your SQL editors isn’t affected.' });
    this.post({ type: 'analysis', connectionId: config.id, statements: analysis.statements.length, notes, blocked, dirty });
    return blocked ? undefined : { analysis };
  }

  private async run(connectionId: string): Promise<void> {
    if (this.running) return;
    const config = this.manager.get(connectionId);
    if (!config) return;
    this.chosen = connectionId;
    // Read and analyze again: what runs is exactly what the notes describe now.
    const ready = await this.refresh();
    if (!ready) return;
    const { statements } = ready.analysis;
    if (!statements.length) {
      this.post({ type: 'status', state: 'info', text: 'The file has no statements to run.' });
      return;
    }
    const transaction = !ready.analysis.ownTransactions;
    const count = statements.length;
    this.running = true;
    this.cancelled = false;
    this.post({ type: 'running', running: true });
    this.post({ type: 'status', state: 'busy', text: `Statement 0 of ${count.toLocaleString()}` });
    const started = performance.now();
    let lastPost = 0;
    try {
      const driver = await this.manager.getDriver(connectionId);
      const result = await driver.runScript(
        statements.map((s) => s.sql),
        {
          transaction,
          cancelled: () => this.cancelled,
          onProgress: (done) => {
            // Messages are cheap but not free: at most every 100 ms, and the last one.
            const now = performance.now();
            if (now - lastPost > 100 || done === count) {
              lastPost = now;
              this.post({ type: 'status', state: 'busy', text: `Statement ${done.toLocaleString()} of ${count.toLocaleString()}` });
            }
          },
        },
      );
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const rows = result.affectedRows ? ` (${result.affectedRows.toLocaleString()} rows affected)` : '';
      this.post({ type: 'status', state: 'ok', text: `Ran ${result.statements.toLocaleString()} statements${rows} in ${seconds} s on "${config.name}".` });
    } catch (err) {
      const kept = transaction ? 'Everything was rolled back.' : 'Statements before it may have been kept.';
      if (err instanceof ScriptCancelled) {
        this.post({
          type: 'status',
          state: 'info',
          text: `Cancelled after ${err.done.toLocaleString()} statements. ${transaction ? 'Everything was rolled back.' : 'Statements that ran were kept.'}`,
        });
      } else if (err instanceof ScriptError) {
        const line = statements[err.index]?.line ?? 1;
        this.post({ type: 'status', state: 'error', text: `Statement ${err.index + 1} (line ${line}) failed: ${err.message} ${kept}`, line });
      } else {
        this.post({ type: 'status', state: 'error', text: `Couldn’t run the file: ${errorMessage(err)}` });
      }
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
      this.onSchemaChanged(connectionId);
    }
  }
}

async function pickFile(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri instanceof vscode.Uri) return uri;
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.languageId === 'sql' && doc.uri.scheme === 'file') return doc.uri;
  const picked = await vscode.window.showOpenDialog({
    title: 'Run SQL File',
    canSelectMany: false,
    filters: { 'SQL files': ['sql'], 'All files': ['*'] },
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return picked?.[0];
}
