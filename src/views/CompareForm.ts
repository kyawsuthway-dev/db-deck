import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { buildSync, compareSchemas, defaultTicks, type Renames, type Side, type SyncPlan, type TableCompare } from '../compare/compare';
import { checkDesign, type TableDesign } from '../design/model';
import { changeNotes, type DesignNote } from '../design/notes';
import { errorMessage, ScriptError } from '../drivers/common';
import { createDriver, DB_KINDS, TABLE_FEATURES, TRANSACTIONAL_DDL, typeLabel } from '../drivers';
import type { QueryController } from '../query/runQuery';
import type { ConnectionConfig, Driver } from '../types';
import { FormPanel, FormTabs } from './FormPanel';

export type CompareSideName = 'source' | 'target';

/** A side as the form shows it: a connection and a schema by name ('' when the database has no names: SQLite). */
export interface CompareSidePick {
  connectionId: string;
  schema: string;
}

/** Messages to the Compare Structure form (src/webview/compareForm.ts). */
export type CompareMessage =
  | {
      type: 'init';
      title: string;
      detail: string;
      connections: { id: string; name: string; type: string; detail: string; logo?: { light: string; dark: string }; readOnly: boolean }[];
      source: CompareSidePick;
      target?: CompareSidePick;
    }
  | { type: 'schemas'; side: CompareSideName; connectionId: string; schemas: { value: string; label: string }[]; selected: string }
  /** Differences, with the ticks and renames they were built with (the extension keeps the truth). */
  | { type: 'result'; tables: TableCompare[]; ticks: Record<string, string[]>; renames: Renames; source: string; target: string }
  | { type: 'plan'; statements: string[]; count: number; notes: DesignNote[]; blocked: Record<string, string[]>; canApply: boolean }
  | { type: 'running'; running: boolean }
  | { type: 'status'; state: 'busy' | 'ok' | 'error' | 'info'; text: string; compareAgain?: boolean };

/** Messages from the form. Untrusted: connections and schemas are checked against the extension's own lists. */
export type CompareRequest =
  | { type: 'ready' }
  | { type: 'pick'; side: CompareSideName; connectionId: string }
  | { type: 'compare'; source: CompareSidePick; target: CompareSidePick }
  | { type: 'change'; ticks: Record<string, string[]>; renames: Renames }
  | { type: 'apply' }
  | { type: 'cancel' }
  | { type: 'copySql' }
  | { type: 'openEditor' }
  | { type: 'close' };

/** Compare Structure…: one form per source connection. */
export class CompareForms implements vscode.Disposable {
  private readonly forms = new FormTabs<ComparePanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
    private readonly onSchemaChanged: (connectionId: string) => void,
  ) {}

  /** `schema` as in `TableInfo.schema` (undefined: the connection's default). */
  open(connectionId: string, schema?: string): void {
    if (!this.manager.get(connectionId)) return;
    this.forms.open(connectionId, () => new ComparePanel(this.extensionUri, this.manager, this.queries, this.onSchemaChanged, connectionId, schema));
  }

  dispose(): void {
    this.forms.dispose();
  }
}

interface Compared {
  source: CompareSidePick;
  target: CompareSidePick;
  from: Side;
  to: Side;
  sourceLabel: string;
  targetLabel: string;
}

class ComparePanel extends FormPanel<CompareMessage> {
  private compared?: Compared;
  private ticks: Record<string, string[]> = {};
  private renames: Renames = {};
  private plan?: SyncPlan;
  private running = false;
  private cancelled = false;
  /** NULL counts of target columns becoming NOT NULL (`table\0column`). */
  private readonly nulls = new Map<string, number>();
  /** The last schema lists sent, to check the form's picks. */
  private readonly schemaLists = new Map<string, string[]>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly queries: QueryController,
    private readonly onSchemaChanged: (connectionId: string) => void,
    private readonly connectionId: string,
    private readonly schema: string | undefined,
  ) {
    super(extensionUri, 'dbDeck.compare', 'Compare Structure', 'compareForm');
  }

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
      case 'pick':
        if ((msg.side === 'source' || msg.side === 'target') && typeof msg.connectionId === 'string') await this.sendSchemas(msg.side, msg.connectionId);
        return;
      case 'compare': {
        const source = this.pickOf(msg.source);
        const target = this.pickOf(msg.target);
        if (source && target) await this.compare(source, target);
        return;
      }
      case 'change':
        if (this.compared && !this.running) {
          this.ticks = cleanTicks(msg.ticks);
          this.renames = cleanRenames(msg.renames);
          this.refresh();
        }
        return;
      case 'copySql':
        if (this.plan) await vscode.env.clipboard.writeText(this.plan.statements.join('\n\n'));
        return;
      case 'openEditor':
        if (this.plan?.statements.length && this.compared) {
          const header = `-- Make ${this.compared.targetLabel} like ${this.compared.sourceLabel}. Built by DB Deck's Compare Structure; review before running.\n\n`;
          await this.queries.openSql(this.compared.target.connectionId, header + this.plan.statements.join('\n\n'));
        }
        return;
      case 'apply':
        return this.apply();
    }
  }

  /** A side from the form, checked: a known connection and a schema from the list sent for it. */
  private pickOf(value: unknown): CompareSidePick | undefined {
    const v = value as Partial<CompareSidePick> | undefined;
    if (typeof v?.connectionId !== 'string' || typeof v.schema !== 'string' || !this.manager.get(v.connectionId)) return undefined;
    const list = this.schemaLists.get(v.connectionId);
    if (!list || !(list.includes(v.schema) || (v.schema === '' && !list.length))) return undefined;
    return { connectionId: v.connectionId, schema: v.schema };
  }

  private async init(): Promise<void> {
    const config = this.manager.get(this.connectionId);
    if (!config) return this.dispose();
    const connections = this.manager.list().map((c) => {
      const kind = DB_KINDS.find((k) => k.type === c.type);
      return { id: c.id, name: c.name, type: c.type, detail: typeLabel(c.type), logo: kind && this.logo(kind.logo), readOnly: !!c.readOnly };
    });
    let sourceSchema = '';
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      sourceSchema = this.schema ?? driver.defaultSchemaLabel() ?? '';
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t connect to ${config.name}: ${errorMessage(err)}` });
    }
    // The other side starts as another connection of the same type, or this one (another schema there).
    const other = this.manager.list().find((c) => c.id !== config.id && c.type === config.type);
    this.post({
      type: 'init',
      title: 'Compare Structure',
      detail: `${typeLabel(config.type)} · make the target’s tables like the source’s`,
      connections,
      source: { connectionId: config.id, schema: sourceSchema },
    });
    await this.sendSchemas('source', config.id, sourceSchema);
    await this.sendSchemas('target', other?.id ?? config.id);
  }

  private async sendSchemas(side: CompareSideName, connectionId: string, selected?: string): Promise<void> {
    const config = this.manager.get(connectionId);
    if (!config) return;
    try {
      const driver = await this.manager.getDriver(connectionId);
      const names = await driver.listSchemas();
      this.schemaLists.set(connectionId, names);
      const label = driver.defaultSchemaLabel();
      const schemas = names.length ? names.map((n) => ({ value: n, label: n === label ? `${n} (default)` : n })) : [{ value: '', label: 'main' }];
      const pick = selected !== undefined && (names.includes(selected) || (!names.length && selected === '')) ? selected : (label && names.includes(label) ? label : schemas[0].value);
      this.post({ type: 'schemas', side, connectionId, schemas, selected: pick });
    } catch (err) {
      this.post({ type: 'status', state: 'error', text: `Couldn’t read the schemas of ${config.name}: ${errorMessage(err)}` });
    }
  }

  /** A schema name → `TableInfo.schema` (undefined for the connection's default). */
  private schemaOf(driver: Driver, name: string): string | undefined {
    return !name || name === driver.defaultSchemaLabel() ? undefined : name;
  }

  private async readSide(config: ConnectionConfig, driver: Driver, pick: CompareSidePick, progress: (n: number, total: number) => void): Promise<Side> {
    const schema = this.schemaOf(driver, pick.schema);
    const tables = (await driver.listTables()).filter((t) => t.kind === 'table' && t.schema === schema);
    const designs: TableDesign[] = [];
    for (const [i, t] of tables.entries()) {
      if (this.cancelled) throw new Error(`Cancelled while reading ${config.name}.`);
      progress(i, tables.length);
      designs.push(await driver.readDesign(t));
    }
    return { schema, defaultSchema: driver.defaultSchemaLabel(), tables: designs };
  }

  private label(config: ConnectionConfig, pick: CompareSidePick): string {
    return pick.schema ? `${config.name} · ${pick.schema}` : config.name;
  }

  private async compare(source: CompareSidePick, target: CompareSidePick): Promise<void> {
    if (this.running) return;
    const sc = this.manager.get(source.connectionId);
    const tc = this.manager.get(target.connectionId);
    if (!sc || !tc) return;
    if (sc.type !== tc.type) {
      this.post({ type: 'status', state: 'error', text: `Both sides must be the same kind of database (${typeLabel(sc.type)} and ${typeLabel(tc.type)} aren’t).` });
      return;
    }
    if (source.connectionId === target.connectionId && source.schema === target.schema) {
      this.post({ type: 'status', state: 'error', text: 'Source and target are the same schema: pick another target.' });
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.post({ type: 'running', running: true });
    try {
      const [sd, td] = [await this.manager.getDriver(sc.id), await this.manager.getDriver(tc.id)];
      const from = await this.readSide(sc, sd, source, (n, total) => this.post({ type: 'status', state: 'busy', text: `Reading the source: table ${n + 1} of ${total}…` }));
      const to = await this.readSide(tc, td, target, (n, total) => this.post({ type: 'status', state: 'busy', text: `Reading the target: table ${n + 1} of ${total}…` }));
      const sameSide = this.compared && this.compared.source.connectionId === source.connectionId && this.compared.target.connectionId === target.connectionId && this.compared.source.schema === source.schema && this.compared.target.schema === target.schema;
      this.compared = { source, target, from, to, sourceLabel: this.label(sc, source), targetLabel: this.label(tc, target) };
      if (!sameSide) {
        this.renames = {};
        this.ticks = {};
        this.nulls.clear();
      }
      this.refresh(!sameSide);
      const differ = compareSchemas(from, to, this.renames, TABLE_FEATURES[tc.type].reorder !== 'none').filter((t) => t.status !== 'same').length;
      this.post({ type: 'status', state: 'ok', text: differ ? `${differ} table${differ === 1 ? '' : 's'} differ.` : 'The tables are the same.' });
    } catch (err) {
      this.post({ type: 'status', state: this.cancelled ? 'info' : 'error', text: this.cancelled ? 'Comparing was cancelled.' : `Couldn’t compare: ${errorMessage(err)}` });
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }

  /** Differences and SQL for the current ticks and renames (pure, no queries except NULL counts). */
  private refresh(resetTicks = false): void {
    const c = this.compared;
    const config = c && this.manager.get(c.target.connectionId);
    if (!c || !config) return;
    const reorder = TABLE_FEATURES[config.type].reorder !== 'none';
    // Renames only from a column just the source has to one just the target has, each used once.
    this.renames = validRenames(c.from, c.to, this.renames);
    const tables = compareSchemas(c.from, c.to, this.renames, reorder);
    // Ticks: kept for items that still exist; new items get their default (drops unticked).
    const defaults = defaultTicks(tables);
    const ticks: Record<string, string[]> = {};
    for (const t of tables) {
      const known = new Set(t.items.map((i) => i.id));
      const before = resetTicks ? undefined : this.ticks[t.name];
      const kept = before ? before.filter((id) => known.has(id)) : defaults[t.name];
      const seen = new Set(this.seenItems.get(t.name) ?? []);
      const fresh = before ? defaults[t.name].filter((id) => !seen.has(id)) : [];
      ticks[t.name] = [...new Set([...kept, ...fresh])];
      this.seenItems.set(t.name, [...known]);
    }
    this.ticks = ticks;
    const driver = this.builderFor(config);
    this.plan = buildSync(c.from, c.to, this.renames, ticks, driver, reorder);
    this.post({ type: 'result', tables, ticks, renames: this.renames, source: c.sourceLabel, target: c.targetLabel });
    this.post({ type: 'plan', statements: this.plan.statements, count: this.plan.count, notes: this.notes(config, this.plan), blocked: this.plan.blocked, canApply: !config.readOnly && this.plan.statements.length > 0 });
  }

  /** Items each table had last time, so an item that's new (after a rename) gets its default tick. */
  private readonly seenItems = new Map<string, string[]>();

  /** The target's SQL builders: pure, so an unconnected driver builds them (as Design Table's preview does). */
  private builderFor(config: ConnectionConfig) {
    const sql = createDriver(config, undefined);
    return {
      createTableSql: (d: TableDesign) => sql.createTableSql(d),
      alterTableSql: (b: TableDesign, a: TableDesign, ch: Parameters<Driver['alterTableSql']>[2]) => sql.alterTableSql(b, a, ch),
      dropSql: (t: { name: string; schema?: string; kind: 'table' }) => sql.dropSql(t),
      check: (d: TableDesign) => {
        const errors = checkDesign(d, TABLE_FEATURES[config.type], config.type);
        const first = Object.entries(errors)[0];
        return first ? `${first[1]} (${first[0]})` : undefined;
      },
    };
  }

  private notes(config: ConnectionConfig, plan: SyncPlan): DesignNote[] {
    const notes: DesignNote[] = [];
    if (config.readOnly) notes.push({ tone: 'error', text: `"${config.name}" is read-only: DB Deck won’t change it. Open in Editor still works.` });
    for (const name of plan.dropped) notes.push({ tone: 'warning', text: `Dropping table ${name} deletes all its rows.` });
    for (const { table, changes } of plan.changes) {
      notes.push(
        ...changeNotes(
          changes,
          (ch) => {
            const key = `${table}\u0000${ch.before.name}`;
            const n = this.nulls.get(key);
            if (n === undefined) void this.countNulls(config, table, ch.before.name);
            return n;
          },
          table,
        ),
      );
    }
    for (const name of plan.rebuilt) notes.push({ tone: 'warning', text: `SQLite can’t change ${name} in place: it is rebuilt (rows copied into a new table, indexes and triggers recreated).` });
    for (const s of plan.skipped) notes.push({ tone: 'warning', text: `${s.table} is left out: ${s.reason}.` });
    const blocked = Object.entries(plan.blocked);
    if (blocked.length) notes.push({ tone: 'info', text: `Some ticked changes are left out because they need a column you unticked (${blocked.map(([t]) => t).join(', ')}).` });
    const hidden = this.compared?.from.tables.concat(this.compared.to.tables).some((t) => t.columns.some((c) => c.generated) || t.preserved?.indexes.length || t.preserved?.triggers.length);
    if (hidden) notes.push({ tone: 'info', text: 'Generated columns, expression or partial indexes and triggers aren’t compared.' });
    if (plan.statements.length > 1 && !TRANSACTIONAL_DDL[config.type]) {
      notes.push({ tone: 'warning', text: 'This database commits each CREATE, ALTER and DROP on its own: if a later statement fails, the earlier ones stay applied.' });
    } else if (plan.statements.length) {
      notes.push({ tone: 'info', text: 'Runs in one transaction on its own connection: if any statement fails, nothing is changed.' });
    }
    // Notes from several tables may repeat (the duplicate-values one).
    return notes.filter((n, i) => notes.findIndex((m) => m.text === n.text) === i);
  }

  private async countNulls(config: ConnectionConfig, table: string, column: string): Promise<void> {
    const key = `${table}\u0000${column}`;
    if (this.nulls.has(key) || !this.compared) return;
    this.nulls.set(key, 0);
    try {
      const driver = await this.manager.getDriver(config.id);
      const info = { name: table, schema: this.compared.to.schema, kind: 'table' as const };
      this.nulls.set(key, Number(await driver.countRows(info, `${driver.filterIdentifier(column)} IS NULL`)));
    } catch {
      this.nulls.delete(key);
      return;
    }
    if (this.plan && !this.running) this.post({ type: 'plan', statements: this.plan.statements, count: this.plan.count, notes: this.notes(config, this.plan), blocked: this.plan.blocked, canApply: !config.readOnly && this.plan.statements.length > 0 });
  }

  /** Apply: re-read the affected target tables, refuse if any changed since Compare, then run the SQL. */
  private async apply(): Promise<void> {
    const c = this.compared;
    const plan = this.plan;
    if (this.running || !c || !plan?.statements.length) return;
    const config = this.manager.get(c.target.connectionId);
    if (!config) return;
    if (config.readOnly) {
      this.post({ type: 'status', state: 'error', text: `"${config.name}" is read-only, so DB Deck won’t change it.` });
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.post({ type: 'running', running: true });
    try {
      const driver = await this.manager.getDriver(config.id);
      this.post({ type: 'status', state: 'busy', text: 'Checking the target hasn’t changed…' });
      const now = (await driver.listTables()).filter((t) => t.kind === 'table' && t.schema === c.to.schema);
      const names = new Set(now.map((t) => t.name));
      const was = new Map(c.to.tables.map((t) => [t.name, t]));
      const changed: string[] = plan.created.filter((n) => names.has(n));
      for (const name of [...plan.changes.map((x) => x.table), ...plan.dropped]) {
        const before = was.get(name);
        const table = now.find((t) => t.name === name);
        if (!before || !table || JSON.stringify(await driver.readDesign(table)) !== JSON.stringify(before)) changed.push(name);
      }
      if (changed.length) {
        this.post({ type: 'status', state: 'error', text: `${changed.join(', ')} changed in the target since you compared, so nothing was applied. Compare again.`, compareAgain: true });
        return;
      }
      this.post({ type: 'status', state: 'busy', text: `Applying ${plan.count} change${plan.count === 1 ? '' : 's'}…` });
      await driver.runScript(plan.statements, {
        transaction: true,
        onProgress: (done) => this.post({ type: 'status', state: 'busy', text: `Applying: statement ${done} of ${plan.statements.length}…` }),
        cancelled: () => this.cancelled,
      });
      this.onSchemaChanged(config.id);
      const count = plan.count;
      this.running = false;
      await this.compare(c.source, c.target);
      this.post({ type: 'status', state: 'ok', text: `Applied ${count} change${count === 1 ? '' : 's'} to ${c.targetLabel}. Compared again.` });
    } catch (err) {
      const which = err instanceof ScriptError && plan.statements.length > 1 ? `Statement ${err.index + 1} failed: ` : '';
      const kept = TRANSACTIONAL_DDL[config.type] || plan.statements.length === 1 ? 'Nothing was changed.' : 'Statements before it may have been kept: compare again to see where the target is.';
      this.post({ type: 'status', state: 'error', text: `${which}${errorMessage(err)} ${kept}`, compareAgain: !TRANSACTIONAL_DDL[config.type] });
    } finally {
      this.running = false;
      this.post({ type: 'running', running: false });
    }
  }
}

/** Ticks from the form: table name → item ids (strings only; unknown ids just never match). */
function cleanTicks(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
  return out;
}

/** Renames from the form: table → source column → target column (checked when the tables are compared). */
function cleanRenames(value: unknown): Renames {
  if (!value || typeof value !== 'object') return {};
  const out: Renames = {};
  for (const [t, m] of Object.entries(value as Record<string, unknown>)) {
    if (!m || typeof m !== 'object') continue;
    const pairs = Object.entries(m as Record<string, unknown>).filter((p): p is [string, string] => typeof p[1] === 'string');
    if (pairs.length) out[t] = Object.fromEntries(pairs);
  }
  return out;
}

/** Renames the form may ask for: source column (only in the source table) → target column (only in the target table). */
function validRenames(from: Side, to: Side, renames: Renames): Renames {
  const out: Renames = {};
  for (const [table, pairs] of Object.entries(renames)) {
    const s = from.tables.find((t) => t.name === table);
    const t = to.tables.find((x) => x.name === table);
    if (!s || !t) continue;
    const sourceNames = new Set(s.columns.map((c) => c.name.trim()));
    const targetNames = new Set(t.columns.map((c) => c.name.trim()));
    const used = new Set<string>();
    const kept: Record<string, string> = {};
    for (const [src, dst] of Object.entries(pairs)) {
      if (!sourceNames.has(src) || targetNames.has(src) || !targetNames.has(dst) || sourceNames.has(dst) || used.has(dst)) continue;
      used.add(dst);
      kept[src] = dst;
    }
    if (Object.keys(kept).length) out[table] = kept;
  }
  return out;
}
