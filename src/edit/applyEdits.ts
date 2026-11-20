import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { ChangeConflict, errorMessage } from '../drivers/common';
import { isBinaryType } from '../export/formats';
import type { QueryController } from '../query/runQuery';
import type { ChangeStatement, Driver } from '../types';
import type { ResultsPanel, ResultsRequest } from '../views/ResultsPanel';
import { buildRowChanges, describeChanges, InvalidChanges, isApproximateType } from './changes';

/** A validated change set waiting for the user's Apply in the grid's confirmation. */
interface PreparedSave {
  token: string;
  /** The page it was built from. If other results replace it, the save is void. */
  shown: object;
  connectionId: string;
  statements: ChangeStatement[];
  summary: string;
  tableName: string;
}

/**
 * Saves the table view's pending edits in two steps. `save` validates the webview's change set, builds the
 * statements and asks the grid to show a confirmation. Nothing is written until the user clicks Apply there
 * (core.md rule 4), which sends back the one-time token; only the change set prepared under that token runs.
 * Everything runs in one transaction on the driver's separate edit connection; any conflict or error rolls it
 * all back.
 */
export class TableEditor implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private prepared?: PreparedSave;
  private saving = false;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly panel: ResultsPanel,
    private readonly queries: QueryController,
  ) {
    this.subscription = panel.onDidRequest((request) => {
      if (request.type === 'save') void this.prepare(request);
      else if (request.type === 'applySave') void this.apply(request.token);
      else if (request.type === 'cancelSave' && request.token === this.prepared?.token) this.prepared = undefined;
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private async prepare(request: Extract<ResultsRequest, { type: 'save' }>): Promise<void> {
    if (this.saving) return;
    this.prepared = undefined;
    const view = this.queries.currentTableView();
    const shown = this.panel.lastResults();
    const page = shown?.table ? shown.results[0] : undefined;
    if (!view || !shown || !page || page.error) return;
    if (view.table.kind !== 'table' || !view.key.length) {
      void vscode.window.showErrorMessage('This table can’t be edited: it needs a primary key.');
      return;
    }

    let changes;
    try {
      changes = buildRowChanges(request.changes, {
        columns: page.columns,
        rows: page.rows,
        key: view.key,
        readOnly: new Set(view.columns.filter((c) => isBinaryType(c.type)).map((c) => c.name)),
        approximate: new Set(view.columns.filter((c) => isApproximateType(c.type)).map((c) => c.name)),
      });
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof InvalidChanges ? err.message : errorMessage(err));
      return;
    }
    if (!changes.length) {
      void vscode.window.showInformationMessage('There are no changes to save.');
      return;
    }

    let driver: Driver;
    try {
      driver = await this.manager.getDriver(view.connectionId);
    } catch (err) {
      void vscode.window.showErrorMessage(`DB Deck: ${errorMessage(err)}`);
      return;
    }
    // The page may have changed while connecting.
    if (this.panel.lastResults() !== shown) return;
    const statements = driver.changeStatements(view.table, changes);
    const summary = describeChanges(changes);
    const token = randomUUID();
    this.prepared = { token, shown, connectionId: view.connectionId, statements, summary, tableName: view.table.name };
    this.panel.confirmSave(
      token,
      `Apply ${summary} to ${view.table.name}?`,
      'All changes run in one transaction. If any row was changed or deleted since this page was loaded, nothing is saved.',
      statements.map((s) => s.display),
    );
  }

  private async apply(token: unknown): Promise<void> {
    const prepared = this.prepared;
    if (this.saving || !prepared || typeof token !== 'string' || token !== prepared.token) return;
    // One Apply per confirmation.
    this.prepared = undefined;
    if (this.panel.lastResults() !== prepared.shown) {
      this.panel.closeConfirm();
      return;
    }

    this.saving = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Saving changes to ${prepared.tableName}…` },
        async () => (await this.manager.getDriver(prepared.connectionId)).applyChanges(prepared.statements),
      );
      this.queries.clearPending();
      await this.queries.reloadTablePage();
      void vscode.window.showInformationMessage(`Saved ${prepared.summary} to ${prepared.tableName}.`);
    } catch (err) {
      this.panel.closeConfirm();
      if (err instanceof ChangeConflict) {
        // Pending edits stay, so the user can decide: reload (losing them) or keep them and discard later.
        const reload = await vscode.window.showErrorMessage(err.message, 'Discard Changes and Reload');
        if (reload) {
          this.queries.clearPending();
          await this.queries.reloadTablePage();
        }
      } else {
        void vscode.window.showErrorMessage(`Save failed, nothing was saved: ${errorMessage(err)}`);
      }
    } finally {
      this.saving = false;
    }
  }
}
