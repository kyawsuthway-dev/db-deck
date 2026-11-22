// Writes a dump: a driver's DumpPlan in restorable order, table rows streamed in pages. No `vscode`, so a
// dump → restore round trip can be smoke-tested in plain Node against the Docker databases.
import type { Driver, TableInfo } from '../types';

export const DUMP_PAGE_ROWS = 1_000;

export type DumpContent = 'all' | 'structure' | 'data';

export interface DumpOptions {
  tables: TableInfo[];
  /** Only with structure. */
  views: TableInfo[];
  content: DumpContent;
  /** The first lines of the file (comments). */
  header: string;
  write: (text: string) => Promise<void>;
  /** "orders: 12,000 rows" */
  onProgress?: (table: string, rows: number) => void;
  cancelled?: () => boolean;
}

export class DumpCancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
}

/** Returns the number of rows written. Throws DumpCancelled, or the database's error. */
export async function writeDump(driver: Driver, o: DumpOptions): Promise<number> {
  const structure = o.content !== 'data';
  const data = o.content !== 'structure';
  const plan = await driver.dumpPlan(o.tables, structure ? o.views : []);
  const check = () => {
    if (o.cancelled?.()) throw new DumpCancelled();
  };
  let total = 0;
  await o.write(o.header);
  await o.write(plan.start);
  if (structure) {
    await o.write(section('Structure'));
    await o.write(plan.structure);
    for (const t of plan.tables) await o.write(`\n${t.create}`);
  }
  if (data) {
    await o.write(section('Data'));
    for (const t of plan.tables) {
      check();
      let rows = 0;
      for (let offset = 0; ; offset += DUMP_PAGE_ROWS) {
        check();
        const page = await driver.dumpRows(t.table, t.columns, { limit: DUMP_PAGE_ROWS, offset, orderBy: t.orderBy });
        await o.write(t.insert(page));
        rows += page.length;
        o.onProgress?.(t.table.name, rows);
        if (page.length < DUMP_PAGE_ROWS) break;
      }
      total += rows;
    }
  }
  if (structure && plan.afterData) await o.write(section('Indexes and foreign keys') + plan.afterData);
  if (data && plan.sequenceValues) await o.write(section('Sequences') + plan.sequenceValues);
  if (structure && plan.views) await o.write(section('Views') + plan.views);
  await o.write(plan.end);
  return total;
}

function section(title: string): string {
  return `\n-- ${title}\n`;
}
