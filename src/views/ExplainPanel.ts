import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { DB_KINDS, SERVER_TOOLS, typeLabel } from '../drivers';
import { splitSql } from '../query/splitSql';
import type { QueryController } from '../query/runQuery';
import { readOnlyStatement, type PlanNode } from '../tools/plan';
import { FormPanel } from './FormPanel';

/** Messages to the Explain panel (src/webview/explainView.ts). */
export type ExplainMessage =
  | { type: 'loading'; title: string; detail: string; logo?: { light: string; dark: string }; statement: string; analyze: boolean }
  | { type: 'plan'; plan: PlanNode; raw: string; note?: string; analyze: boolean }
  | { type: 'error'; text: string };

export type ExplainRequest = { type: 'ready' } | { type: 'copyRaw' };

/**
 * Explain / Explain Analyze for the statement in the SQL editor. One panel, reused for each plan (like Results).
 * Plain Explain never runs the statement; Explain Analyze does, so it's only offered for read-only statements,
 * and the driver runs it in a read-only transaction that is rolled back.
 */
export class Explainer implements vscode.Disposable {
  private panel?: ExplainPanel;
  /** Each explain gets a number; a result for an older one is dropped (like Results' run tokens). */
  private run = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
  ) {}

  /** From the editor (selection or statement at the cursor), or from the CodeLens (uri + offset). */
  async explain(analyze: boolean, uri?: unknown, offset?: unknown): Promise<void> {
    const picked = uri !== undefined ? this.queries.statementIn(uri, offset) : await this.queries.editorSql('cursor');
    if (!picked) return;
    const config = this.manager.get(picked.connectionId);
    if (!config) return;
    const statements = splitSql(picked.sql, config.type).filter((s) => s.trim().replace(/;$/, '').trim());
    if (statements.length !== 1) {
      void vscode.window.showInformationMessage(
        statements.length ? 'Explain works on one statement at a time: select just one, or put the cursor in it.' : 'There is no statement to explain.',
      );
      return;
    }
    const sql = statements[0];
    if (analyze) {
      const refuse = !SERVER_TOOLS[config.type].explainAnalyze
        ? `${typeLabel(config.type)} has no EXPLAIN ANALYZE.`
        : (() => {
            const check = readOnlyStatement(sql, config.type);
            return check.ok ? undefined : check.reason;
          })();
      if (refuse) {
        const choice = await vscode.window.showInformationMessage(refuse, 'Explain Instead');
        if (choice) await this.show(picked.connectionId, sql, false);
        return;
      }
    }
    await this.show(picked.connectionId, sql, analyze);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async show(connectionId: string, sql: string, analyze: boolean): Promise<void> {
    const config = this.manager.get(connectionId);
    if (!config) return;
    if (!this.panel) {
      this.panel = new ExplainPanel(this.extensionUri);
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal();
    }
    const panel = this.panel;
    const token = ++this.run;
    const kind = DB_KINDS.find((k) => k.type === config.type);
    panel.send({
      type: 'loading',
      title: analyze ? 'Explain Analyze' : 'Explain',
      detail: `${config.name} · ${typeLabel(config.type)}`,
      logo: kind && panel.logoOf(kind.logo),
      statement: sql.trim(),
      analyze,
    });
    try {
      const result = await (await this.manager.getDriver(connectionId)).explain(sql, analyze);
      if (token !== this.run) return;
      const note = [result.note, analyze ? 'Explain Analyze ran the statement in a read-only transaction on a separate connection, then rolled it back; temporary tables and SET from your editor’s session weren’t there.' : undefined]
        .filter(Boolean)
        .join(' ');
      panel.send({ type: 'plan', plan: result.plan, raw: result.raw, note: note || undefined, analyze });
    } catch (err) {
      if (token === this.run) panel.send({ type: 'error', text: errorMessage(err) });
    }
  }
}

class ExplainPanel extends FormPanel<ExplainMessage> {
  /** The loading and plan messages, replayed when the page is (re)loaded. */
  private shown: ExplainMessage[] = [];
  private raw = '';

  constructor(extensionUri: vscode.Uri) {
    super(extensionUri, 'dbDeck.explain', 'Explain', 'explainView');
  }

  send(message: ExplainMessage): void {
    if (message.type === 'loading') {
      this.shown = [message];
      this.panel.title = message.title;
    } else {
      this.shown.push(message);
    }
    if (message.type === 'plan') this.raw = message.raw;
    this.post(message);
  }

  logoOf(name: string) {
    return this.logo(name);
  }

  protected async onMessage(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === 'ready') for (const m of this.shown) this.post(m);
    else if (msg.type === 'copyRaw') await vscode.env.clipboard.writeText(this.raw);
  }
}
