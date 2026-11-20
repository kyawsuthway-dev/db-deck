import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import type { QueryController, TableViewSource } from '../query/runQuery';
import type { Cell, Driver, StatementResult } from '../types';
import type { CopyFormat, ResultsPanel, ResultsRequest } from '../views/ResultsPanel';
import { isBinaryType, streamFormat, toDelimited, toJson, type ExportFormat } from './formats';
import { FileOut } from './fileOut';
import { readAllRows } from './readAll';

const EXTENSIONS: Record<ExportFormat, string> = { csv: 'csv', json: 'json', sql: 'sql' };

/**
 * Export (to a file) and copy (to the clipboard) for the Results panel. All formatting happens here
 * and in formats.ts; the webview only says which result and which cells.
 */
export class ResultsExporter implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly panel: ResultsPanel,
    private readonly queries: QueryController,
  ) {
    this.subscription = panel.onDidRequest((request) => {
      if (request.type === 'export') void this.exportResult(request);
      else if (request.type === 'copy') void this.copy(request);
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private async exportResult(request: Extract<ResultsRequest, { type: 'export' }>): Promise<void> {
    const shown = this.panel.lastResults();
    const result = Number.isSafeInteger(request.index) ? shown?.results[request.index] : undefined;
    if (!shown || !result || result.error || !result.columns.length) return;
    const view = shown.table ? this.queries.currentTableView() : undefined;

    const format = await pickFormat(!!view);
    if (!format) return;

    let allRows = false;
    if (view) {
      const scope = await vscode.window.showQuickPick(
        [
          { label: `Current page (${result.rows.length.toLocaleString()} rows)`, all: false },
          {
            label: 'All matching rows',
            description: view.where ? 'with the WHERE filter' : undefined,
            detail: view.orderBy.length ? undefined : 'No primary key or sort: rows may repeat or be skipped between batches.',
            all: true,
          },
        ],
        { title: 'Export Rows', placeHolder: 'Which rows?', ignoreFocusOut: true },
      );
      if (!scope) return;
      allRows = scope.all;
    }

    if (format === 'sql' && view && view.columns.some((c) => isBinaryType(c.type))) {
      const go = await vscode.window.showWarningMessage(
        'This table has binary columns. The grid shows them as shortened hex, so the INSERT statements would insert that text, not the original bytes.',
        { modal: true },
        'Export Anyway',
      );
      if (!go) return;
    }

    const base = view ? view.table.name : 'results';
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, `${base}.${EXTENSIONS[format]}`),
      filters: { [format.toUpperCase()]: [EXTENSIONS[format]] },
      saveLabel: 'Export',
      title: 'Export Results',
    });
    if (!uri) return;
    if (uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('DB Deck can only export to a file on this machine.');
      return;
    }

    try {
      const driver = view ? await this.manager.getDriver(view.connectionId) : undefined;
      const rows = allRows && view && driver
        ? await this.writeAllRows(uri.fsPath, format, driver, view, result.columns)
        : await writeFile(uri.fsPath, format, driver && view ? { driver, view } : undefined, result.columns, ordered(result, request.order));
      if (rows === undefined) {
        void vscode.window.showInformationMessage('Export cancelled.');
        return;
      }
      const open = await vscode.window.showInformationMessage(
        `Exported ${rows.toLocaleString()} row${rows === 1 ? '' : 's'} to ${path.basename(uri.fsPath)}.`,
        'Open File',
      );
      if (open) await vscode.commands.executeCommand('vscode.open', uri);
    } catch (err) {
      void vscode.window.showErrorMessage(`Export failed: ${errorMessage(err)}`);
    }
  }

  /** Streams every matching row to the file. Returns the row count, or undefined if cancelled. */
  private writeAllRows(file: string, format: ExportFormat, driver: Driver, view: TableViewSource, columns: string[]) {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${view.table.name}`, cancellable: true },
      async (progress, token) => {
        const out = new FileOut(file);
        try {
          const writer = streamFormat(format, (cols, rows) => driver.insertSql(view.table, cols, rows));
          await out.write(writer.start(columns));
          let count = 0;
          for await (const batch of readAllRows(driver, view.table, view.where, view.orderBy, () => token.isCancellationRequested)) {
            await out.write(writer.rows(batch.rows));
            count += batch.rows.length;
            progress.report({ message: `${count.toLocaleString()} rows` });
          }
          if (token.isCancellationRequested) {
            await out.discard();
            return undefined;
          }
          await out.write(writer.end());
          await out.close();
          return count;
        } catch (err) {
          await out.discard();
          throw err;
        }
      },
    );
  }

  private async copy(request: Extract<ResultsRequest, { type: 'copy' }>): Promise<void> {
    const result = Number.isSafeInteger(request.index) ? this.panel.lastResults()?.results[request.index] : undefined;
    if (!result || !Array.isArray(request.rows) || !Array.isArray(request.columns)) return;
    const [from, to] = request.columns;
    const validRow = (r: unknown) => Number.isSafeInteger(r) && (r as number) >= 0 && (r as number) < result.rows.length;
    if (!validColumn(from, result) || !validColumn(to, result) || from > to || !request.rows.every(validRow)) return;

    const columns = result.columns.slice(from, to + 1);
    const rows = request.rows.map((r) => result.rows[r].slice(from, to + 1));
    const text = formatCopy(request.format, columns, rows);
    if (text === undefined) return;
    await vscode.env.clipboard.writeText(text);
    const cells = rows.length * columns.length;
    vscode.window.setStatusBarMessage(
      `DB Deck: copied ${cells === 1 ? '1 cell' : `${rows.length.toLocaleString()} × ${columns.length} cells`}`,
      3000,
    );
  }
}

async function pickFormat(tableView: boolean): Promise<ExportFormat | undefined> {
  const items: (vscode.QuickPickItem & { format: ExportFormat })[] = [
    { label: 'CSV', description: 'Comma-separated, opens in Excel and Google Sheets', format: 'csv' },
    { label: 'JSON', description: 'Array of objects; values stay text, NULL is null', format: 'json' },
  ];
  if (tableView) items.push({ label: 'SQL INSERT statements', description: 'One INSERT per row, for this table', format: 'sql' });
  const picked = await vscode.window.showQuickPick(items, { title: 'Export Results', placeHolder: 'Format', ignoreFocusOut: true });
  return picked?.format;
}

/** Rows in the order the webview showed them. An invalid order (it's untrusted) falls back to the original order. */
function ordered(result: StatementResult, order: unknown): Cell[][] {
  if (!Array.isArray(order) || order.length !== result.rows.length) return result.rows;
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isSafeInteger(i) || i < 0 || i >= result.rows.length || seen.has(i)) return result.rows;
    seen.add(i);
  }
  return order.map((i: number) => result.rows[i]);
}

/** Writes rows already in memory (a page or query results). Returns the row count. */
async function writeFile(
  file: string,
  format: ExportFormat,
  source: { driver: Driver; view: TableViewSource } | undefined,
  columns: string[],
  rows: Cell[][],
): Promise<number> {
  const writer = streamFormat(format, source && ((cols, batch) => source.driver.insertSql(source.view.table, cols, batch)));
  const out = new FileOut(file);
  try {
    await out.write(writer.start(columns) + writer.rows(rows) + writer.end());
    await out.close();
    return rows.length;
  } catch (err) {
    await out.discard();
    throw err;
  }
}

function validColumn(i: unknown, result: StatementResult): i is number {
  return Number.isSafeInteger(i) && (i as number) >= 0 && (i as number) < result.columns.length;
}

function formatCopy(format: CopyFormat, columns: string[], rows: Cell[][]): string | undefined {
  switch (format) {
    case 'tsv':
      return toDelimited(columns, rows, '\t', false);
    case 'tsvHeaders':
      return toDelimited(columns, rows, '\t', true);
    case 'csv':
      return toDelimited(columns, rows, ',', true);
    case 'json':
      return toJson(columns, rows);
    default:
      return undefined; // untrusted input from the webview
  }
}
