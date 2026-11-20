import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { errorMessage } from '../drivers/common';
import { SQL_DIALECTS } from '../drivers';
import type { Driver, TableInfo } from '../types';
import { cursorContext, findTable, resolveQualifier, SQL_KEYWORDS, tableReferences } from './completion';
import { formatSql } from './formatSql';
import type { QueryController } from './runQuery';
import { SchemaCache } from './schemaCache';
import { codeAt, splitSqlRanges, statementAt } from './splitSql';

const SQL: vscode.DocumentSelector = { language: 'sql' };
/** More lenses than this in one file would only add noise (and work on every keystroke). */
const MAX_LENSES = 1000;
/** Columns are loaded for at most this many tables of one statement. */
const MAX_TABLES_FOR_COLUMNS = 20;

/**
 * Language features for SQL editors linked to a connection: suggestions for tables, columns and keywords,
 * a ▶ Run CodeLens per statement, and Format Document / Format Selection.
 * Suggestions never open a connection: tables and columns appear only once it's connected.
 */
export class SqlEditor implements vscode.Disposable {
  private readonly cache = new SchemaCache();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
  ) {
    this.disposables.push(
      this.lensesChanged,
      vscode.languages.registerCompletionItemProvider(SQL, { provideCompletionItems: (doc, pos) => this.complete(doc, pos) }, '.'),
      vscode.languages.registerCodeLensProvider(SQL, {
        onDidChangeCodeLenses: this.lensesChanged.event,
        provideCodeLenses: (doc) => this.lenses(doc),
      }),
      vscode.languages.registerDocumentFormattingEditProvider(SQL, {
        provideDocumentFormattingEdits: (doc, options) => {
          const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
          return this.format(doc, all, options);
        },
      }),
      vscode.languages.registerDocumentRangeFormattingEditProvider(SQL, {
        provideDocumentRangeFormattingEdits: (doc, range, options) => this.format(doc, range, options),
      }),
      queries.onDidChangeConnection(() => this.lensesChanged.fire()),
      queries.onDidChangeSchema((id) => this.cache.clear(id)),
      manager.onDidChange(() => {
        // Disconnected or removed connections forget their schema; lenses follow the editors' links.
        for (const c of manager.list()) if (!manager.isConnected(c.id)) this.cache.clear(c.id);
        this.lensesChanged.fire();
      }),
    );
  }

  /** Forgets cached tables and columns (the Refresh command), for one connection or all. */
  clearSchema(connectionId?: string): void {
    this.cache.clear(connectionId);
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async complete(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const connectionId = this.queries.connectionFor(doc);
    const config = connectionId ? this.manager.get(connectionId) : undefined;
    if (!connectionId || !config) return undefined;
    const text = doc.getText();
    const offset = doc.offsetAt(position);
    if (!codeAt(text, offset, config.type)) return undefined;

    const context = cursorContext(text.slice(Math.max(0, offset - 1000), offset));
    const items: vscode.CompletionItem[] = [];
    if (this.manager.isConnected(connectionId)) {
      try {
        const driver = await this.manager.getDriver(connectionId);
        const tables = await this.cache.tables(connectionId, driver);
        const statement = statementAt(text, splitSqlRanges(text, config.type), offset);
        const refs = statement ? tableReferences(statement.text, config.type) : [];

        if (context.kind === 'member') {
          const target = resolveQualifier(context.qualifier, refs, tables);
          const table = target && findTable(tables, target);
          if (table) {
            items.push(...(await this.columnItems(connectionId, driver, [table])));
          } else if (context.qualifier.length === 1) {
            // `schema.` → that schema's tables.
            const schema = context.qualifier[0].toLowerCase();
            for (const t of tables) if (t.schema?.toLowerCase() === schema) items.push(tableItem(t, driver, false));
          }
          return items;
        }

        const referenced = refs
          .map((r) => findTable(tables, r))
          .filter((t): t is TableInfo => !!t)
          .slice(0, MAX_TABLES_FOR_COLUMNS);
        items.push(...(await this.columnItems(connectionId, driver, referenced)));
        items.push(...tables.map((t) => tableItem(t, driver, true)));
      } catch {
        // Schema unavailable (e.g. the connection dropped): keywords still help.
      }
    } else if (context.kind === 'member') {
      return undefined;
    }

    for (const keyword of [...SQL_KEYWORDS, ...SQL_DIALECTS[config.type].keywords]) {
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
      item.sortText = `2${keyword}`;
      items.push(item);
    }
    return items;
  }

  private async columnItems(connectionId: string, driver: Driver, tables: TableInfo[]): Promise<vscode.CompletionItem[]> {
    const lists = await Promise.all(tables.map((t) => this.cache.columns(connectionId, driver, t).catch(() => [])));
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    lists.forEach((columns, i) => {
      for (const column of columns) {
        const key = `${tables[i].schema ?? ''}.${tables[i].name}.${column.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = new vscode.CompletionItem(
          { label: column.name, description: `${column.type}${column.primaryKey ? ' · PK' : ''} · ${tables[i].name}` },
          vscode.CompletionItemKind.Field,
        );
        item.insertText = driver.filterIdentifier(column.name);
        item.filterText = column.name;
        item.sortText = `0${column.name}`;
        items.push(item);
      }
    });
    return items;
  }

  private lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const connectionId = this.queries.connectionFor(doc);
    const config = connectionId ? this.manager.get(connectionId) : undefined;
    if (!config) return [];
    return splitSqlRanges(doc.getText(), config.type)
      .slice(0, MAX_LENSES)
      .map((r) => {
        const at = doc.positionAt(r.codeStart);
        return new vscode.CodeLens(new vscode.Range(at, at), {
          title: '$(play) Run',
          tooltip: 'Run this statement',
          command: 'dbDeck.runStatement',
          arguments: [doc.uri.toString(), r.codeStart],
        });
      });
  }

  /** Formats the range in the connection's dialect (generic SQL without one). Unparseable SQL is left as it is. */
  private format(doc: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions): vscode.TextEdit[] {
    const connectionId = this.queries.connectionFor(doc);
    const type = connectionId ? this.manager.get(connectionId)?.type : undefined;
    const original = doc.getText(range);
    if (!original.trim()) return [];
    let formatted: string;
    try {
      formatted = formatSql(original.trim(), type ? SQL_DIALECTS[type].format : 'sql', {
        tabWidth: options.tabSize,
        useTabs: !options.insertSpaces,
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn't format the SQL, so it was left unchanged: ${errorMessage(err)}`);
      return [];
    }
    // Keep the whitespace around the text (the file's final newline, a selection's indentation).
    const lead = original.slice(0, original.length - original.trimStart().length);
    const trail = original.slice(original.trimEnd().length);
    const result = lead + formatted + trail;
    return result === original ? [] : [vscode.TextEdit.replace(range, result)];
  }
}

/** A table suggestion; `qualified` adds the schema when the table is outside the default one. */
function tableItem(table: TableInfo, driver: Driver, qualified: boolean): vscode.CompletionItem {
  const withSchema = qualified && table.schema !== undefined;
  const label = withSchema ? `${table.schema}.${table.name}` : table.name;
  const item = new vscode.CompletionItem(
    { label, description: table.kind === 'view' ? 'view' : 'table' },
    table.kind === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Struct,
  );
  item.insertText = withSchema ? `${driver.filterIdentifier(table.schema!)}.${driver.filterIdentifier(table.name)}` : driver.filterIdentifier(table.name);
  item.filterText = label;
  item.sortText = `1${label}`;
  return item;
}
