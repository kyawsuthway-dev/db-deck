// Reads every row of a table view in batches, for "Export all matching rows". No vscode, so it can be
// smoke-tested in plain Node against the Docker databases.
import type { Cell, Driver, SortKey, TableInfo } from '../types';

export const EXPORT_BATCH_SIZE = 1_000;

export interface Batch {
  columns: string[];
  rows: Cell[][];
}

/**
 * Yields the table's rows matching `where`, in `orderBy` order, one batch at a time. Each batch is
 * one `selectPage` call, so the filter guards and the per-statement row cap still apply.
 * Without an order (no primary key, no sort), offset batches may repeat or skip rows; callers say so.
 * Throws the database's error if a batch fails. Stops early when `cancelled()` returns true.
 */
export async function* readAllRows(
  driver: Driver,
  table: TableInfo,
  where: string | undefined,
  orderBy: SortKey[],
  cancelled: () => boolean,
  batchSize = EXPORT_BATCH_SIZE,
): AsyncGenerator<Batch> {
  for (let offset = 0; !cancelled(); offset += batchSize) {
    const result = await driver.selectPage(table, { limit: batchSize, offset, orderBy }, where);
    if (result.error) throw new Error(result.error);
    if (result.rows.length) yield { columns: result.columns, rows: result.rows };
    if (result.rows.length < batchSize) return;
  }
}
