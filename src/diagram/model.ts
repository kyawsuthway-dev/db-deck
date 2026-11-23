// The ER diagram's model: relationships with their cardinality, and the saved layout (positions, groups,
// view) merged with the current schema. Layouts come back from the webview, so `checkLayout` treats them as
// untrusted. No `vscode`, no I/O, so it's smoke-tested in plain Node.
import type { SchemaDiagram } from '../types';

/** Group and table header colors: names of theme chart colors (`--vscode-charts-<name>`), never raw colors. */
export const GROUP_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export interface DiagramGroup {
  id: string;
  name: string;
  color: GroupColor;
  tables: string[];
}

export interface DiagramLayout {
  /** Top-left corner of each table card, by table name. */
  positions: Record<string, { x: number; y: number }>;
  groups: DiagramGroup[];
  /** Header colors chosen per table; they win over the table's group color. */
  colors?: Record<string, GroupColor>;
  /** The last pan and zoom. */
  view?: { x: number; y: number; zoom: number };
}

/** One foreign key as drawn: column pairs, and how many rows on each side. */
export interface Relation {
  name: string;
  table: string;
  columns: string[];
  /** Undefined: same schema. Otherwise the line ends in a stub label. */
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  /** One-to-one: the FK columns are the table's primary key or a unique key. */
  one: boolean;
  /** A child row may have no parent: an FK column is nullable. */
  optional: boolean;
}

export const LIMITS = { coordinate: 1_000_000, groups: 100, groupName: 60, zoomMin: 0.1, zoomMax: 4 };

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function relations(diagram: SchemaDiagram): Relation[] {
  const tables = new Map(diagram.tables.map((t) => [t.name, t]));
  return diagram.foreignKeys.map((f) => {
    const t = tables.get(f.table);
    const pk = t?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
    const one = (pk.length > 0 && sameSet(f.columns, pk)) || (t?.uniques.some((u) => sameSet(u, f.columns)) ?? false);
    const optional = f.columns.some((name) => t?.columns.find((c) => c.name === name)?.nullable ?? false);
    return { ...f, one, optional };
  });
}

/**
 * The saved layout for the schema as it is now: positions and group members of tables that no longer exist are
 * dropped (and groups left empty), and tables without a position are listed so the page can place them.
 */
export function mergeLayout(saved: DiagramLayout | undefined, diagram: SchemaDiagram): { layout: DiagramLayout; unplaced: string[] } {
  const names = new Set(diagram.tables.map((t) => t.name));
  const positions: DiagramLayout['positions'] = {};
  for (const [name, p] of Object.entries(saved?.positions ?? {})) if (names.has(name)) positions[name] = p;
  const groups = (saved?.groups ?? []).map((g) => ({ ...g, tables: g.tables.filter((t) => names.has(t)) })).filter((g) => g.tables.length);
  const colors: Record<string, GroupColor> = {};
  for (const [name, c] of Object.entries(saved?.colors ?? {})) if (names.has(name)) colors[name] = c;
  return {
    layout: { positions, groups, ...(Object.keys(colors).length ? { colors } : {}), ...(saved?.view ? { view: saved.view } : {}) },
    unplaced: diagram.tables.map((t) => t.name).filter((n) => !(n in positions)),
  };
}

const finite = (v: unknown, limit: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;

/**
 * A layout sent by the page, checked: positions only for known tables and in range, at most `LIMITS.groups`
 * groups with a name, a palette color, a simple id and known tables (each table in one group at most).
 * Returns undefined when anything is off, so a bad message never replaces a good layout.
 */
export function checkLayout(input: unknown, tables: Set<string>): DiagramLayout | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  if (!raw.positions || typeof raw.positions !== 'object' || !Array.isArray(raw.groups)) return undefined;
  const positions: DiagramLayout['positions'] = {};
  for (const [name, p] of Object.entries(raw.positions as Record<string, unknown>)) {
    const pos = p as Record<string, unknown> | null;
    if (!tables.has(name) || !pos || !finite(pos.x, LIMITS.coordinate) || !finite(pos.y, LIMITS.coordinate)) return undefined;
    positions[name] = { x: pos.x, y: pos.y };
  }
  if (raw.groups.length > LIMITS.groups) return undefined;
  const grouped = new Set<string>();
  const ids = new Set<string>();
  const groups: DiagramGroup[] = [];
  for (const g of raw.groups as unknown[]) {
    const group = g as Record<string, unknown> | null;
    if (!group || typeof group.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(group.id) || ids.has(group.id)) return undefined;
    const name = typeof group.name === 'string' ? group.name.trim() : '';
    if (!name || name.length > LIMITS.groupName) return undefined;
    if (!GROUP_COLORS.includes(group.color as GroupColor)) return undefined;
    if (!Array.isArray(group.tables) || !group.tables.length) return undefined;
    for (const t of group.tables) if (typeof t !== 'string' || !tables.has(t) || grouped.has(t)) return undefined;
    group.tables.forEach((t) => grouped.add(t as string));
    ids.add(group.id);
    groups.push({ id: group.id, name, color: group.color as GroupColor, tables: [...(group.tables as string[])] });
  }
  let colors: DiagramLayout['colors'];
  if (raw.colors !== undefined) {
    if (!raw.colors || typeof raw.colors !== 'object') return undefined;
    colors = {};
    for (const [name, c] of Object.entries(raw.colors as Record<string, unknown>)) {
      if (!tables.has(name) || !GROUP_COLORS.includes(c as GroupColor)) return undefined;
      colors[name] = c as GroupColor;
    }
  }
  let view: DiagramLayout['view'];
  if (raw.view !== undefined) {
    const v = raw.view as Record<string, unknown> | null;
    if (!v || !finite(v.x, LIMITS.coordinate * 4) || !finite(v.y, LIMITS.coordinate * 4) || !finite(v.zoom, LIMITS.zoomMax) || v.zoom < LIMITS.zoomMin) return undefined;
    view = { x: v.x, y: v.y, zoom: v.zoom };
  }
  return { positions, groups, ...(colors && Object.keys(colors).length ? { colors } : {}), ...(view ? { view } : {}) };
}
