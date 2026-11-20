// Tables and columns for SQL editor suggestions, loaded on first use and kept per connection.
// No vscode import: the editor service decides when to clear it (Refresh, Disconnect, schema-changing runs).
import type { ColumnInfo, Driver, TableInfo } from '../types';

interface Entry {
  tables?: Promise<TableInfo[]>;
  columns: Map<string, Promise<ColumnInfo[]>>;
}

export class SchemaCache {
  private readonly entries = new Map<string, Entry>();

  tables(connectionId: string, driver: Driver): Promise<TableInfo[]> {
    const entry = this.entry(connectionId);
    entry.tables ??= this.forgetOnError(() => driver.listTables(), () => (entry.tables = undefined));
    return entry.tables;
  }

  columns(connectionId: string, driver: Driver, table: TableInfo): Promise<ColumnInfo[]> {
    const entry = this.entry(connectionId);
    const key = `${table.schema ?? ''}\u0000${table.name}`;
    let columns = entry.columns.get(key);
    if (!columns) {
      columns = this.forgetOnError(() => driver.listColumns(table), () => entry.columns.delete(key));
      entry.columns.set(key, columns);
    }
    return columns;
  }

  /** Forgets one connection's schema, or every connection's. */
  clear(connectionId?: string): void {
    if (connectionId === undefined) this.entries.clear();
    else this.entries.delete(connectionId);
  }

  private entry(connectionId: string): Entry {
    let entry = this.entries.get(connectionId);
    if (!entry) {
      entry = { columns: new Map() };
      this.entries.set(connectionId, entry);
    }
    return entry;
  }

  /** A failed load isn't cached, so the next suggestion request tries again. */
  private forgetOnError<T>(load: () => Promise<T>, forget: () => void): Promise<T> {
    const promise = load();
    promise.catch(forget);
    return promise;
  }
}
