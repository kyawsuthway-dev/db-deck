// The ER diagram canvas: table cards, relationship lines and groups as SVG, with pan, zoom, drag, selection
// and highlight. Table, column and group names are database or user text: set with textContent only.
import type { DiagramGroup, DiagramLayout, GroupColor, Relation } from '../../diagram/model';
import type { DiagramTable } from '../../types';
import { icon } from '../icons';
import { anchors, bounds, cardHeight, cardWidth, curve, endMark, GRID, groupBox, HEADER, MARK, ROW, snap, type Anchor, type Box } from './geometry';
import { autoLayout, placeBeside } from './layout';

const SVG = 'http://www.w3.org/2000/svg';
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2.5;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  if (cls) e.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function title(parent: SVGElement, text: string): void {
  const t = svgEl('title');
  t.textContent = text;
  parent.append(t);
}

interface Card {
  table: DiagramTable;
  g: SVGGElement;
  box: Box;
  rows: Map<string, number>;
  rowEls: SVGGElement[];
}

interface Edge {
  relation: Relation;
  pair: number;
  g: SVGGElement;
}

export interface CanvasEvents {
  /** Positions or groups changed (save soon). `viewOnly`: only pan / zoom. */
  changed(viewOnly: boolean): void;
  open(table: string): void;
  /** Selected tables or group changed (for the toolbar). */
  selection(): void;
  zoomed(zoom: number): void;
}

export class Canvas {
  readonly svg = svgEl('svg', 'diagram-svg', { tabindex: 0, role: 'application', 'aria-label': 'ER diagram' });
  private readonly world = svgEl('g', 'world');
  private readonly groupLayer = svgEl('g', 'groups');
  private readonly edgeLayer = svgEl('g', 'edges');
  private readonly cardLayer = svgEl('g', 'cards');
  private cards = new Map<string, Card>();
  private edges: Edge[] = [];
  private relations: Relation[] = [];
  private groups: DiagramGroup[] = [];
  private colors: Record<string, GroupColor> = {};
  private view = { x: 40, y: 40, zoom: 1 };
  private panelKey = '';
  readonly selected = new Set<string>();
  selectedGroup?: string;
  /** Clicked table whose relations stay highlighted. */
  private sticky?: string;
  private measureCtx?: CanvasRenderingContext2D | null;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: CanvasEvents,
  ) {
    this.world.append(this.groupLayer, this.edgeLayer, this.cardLayer);
    this.svg.append(this.world);
    host.append(this.svg);
    this.listen();
  }

  /** Draws a schema. Positions come from the layout; tables in `unplaced` are placed automatically. */
  load(panelKey: string, tables: DiagramTable[], relations: Relation[], layout: DiagramLayout, unplaced: string[], keepView: boolean): boolean {
    this.panelKey = panelKey;
    this.relations = relations;
    this.groups = layout.groups.map((g) => ({ ...g, tables: [...g.tables] }));
    this.colors = { ...(layout.colors ?? {}) };
    this.selected.clear();
    this.selectedGroup = undefined;
    this.sticky = undefined;
    this.cardLayer.replaceChildren();
    this.cards.clear();
    for (const table of tables) {
      const card = this.card(table, layout.positions[table.name] ?? { x: 0, y: 0 });
      this.cards.set(table.name, card);
      this.cardLayer.append(card.g);
    }
    let placed = false;
    if (unplaced.length) {
      const nodes = unplaced.filter((n) => this.cards.has(n)).map((n) => ({ name: n, width: this.cards.get(n)!.box.width, height: this.cards.get(n)!.box.height }));
      const existing = [...this.cards.values()].filter((c) => !unplaced.includes(c.table.name)).map((c) => c.box);
      const spots = existing.length ? placeBeside(existing, nodes, this.links()) : autoLayout(nodes, this.links());
      for (const [name, p] of Object.entries(spots)) this.move(name, p.x, p.y);
      placed = true;
    }
    this.paintGroupColors();
    this.drawEdges();
    this.drawGroups();
    if (!keepView) {
      if (layout.view) this.setView(layout.view.x, layout.view.y, layout.view.zoom);
      else this.fit();
    }
    this.events.selection();
    return placed;
  }

  layout(): DiagramLayout {
    const positions: DiagramLayout['positions'] = {};
    for (const [name, c] of this.cards) positions[name] = { x: c.box.x, y: c.box.y };
    const colors = Object.keys(this.colors).length ? { colors: { ...this.colors } } : {};
    return { positions, groups: this.groups.map((g) => ({ ...g, tables: [...g.tables] })), ...colors, view: { ...this.view } };
  }

  /** A table's header color: its own, else its group's; undefined is the theme's default. */
  colorOf(table: string): GroupColor | undefined {
    return this.colors[table] ?? this.groupOf(table)?.color;
  }

  /** Header color for the selected tables; undefined goes back to the group's or the default. */
  setColor(color: GroupColor | undefined): void {
    for (const name of this.selected) {
      if (color) this.colors[name] = color;
      else delete this.colors[name];
    }
    this.paintGroupColors();
    this.applyFocus();
    this.events.changed(false);
  }

  get groupList(): readonly DiagramGroup[] {
    return this.groups;
  }

  get zoom(): number {
    return this.view.zoom;
  }

  get tableCount(): number {
    return this.cards.size;
  }

  // Groups.

  createGroup(name: string, color: GroupColor): void {
    const tables = [...this.selected];
    if (!tables.length) return;
    this.takeOut(tables);
    const id = `g-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
    this.groups.push({ id, name, color, tables });
    this.selectedGroup = id;
    this.groupsChanged();
  }

  addToGroup(id: string): void {
    const group = this.groups.find((g) => g.id === id);
    if (!group || !this.selected.size) return;
    const tables = [...this.selected];
    this.takeOut(tables);
    group.tables.push(...tables);
    this.groupsChanged();
  }

  removeFromGroup(): void {
    this.takeOut([...this.selected]);
    this.groupsChanged();
  }

  editGroup(id: string, name: string, color: GroupColor): void {
    const group = this.groups.find((g) => g.id === id);
    if (!group) return;
    group.name = name;
    group.color = color;
    this.groupsChanged();
  }

  ungroup(id: string): void {
    this.groups = this.groups.filter((g) => g.id !== id);
    if (this.selectedGroup === id) this.selectedGroup = undefined;
    this.groupsChanged();
  }

  groupOf(table: string): DiagramGroup | undefined {
    return this.groups.find((g) => g.tables.includes(table));
  }

  private takeOut(tables: string[]): void {
    for (const g of this.groups) g.tables = g.tables.filter((t) => !tables.includes(t));
    this.groups = this.groups.filter((g) => g.tables.length);
  }

  private groupsChanged(): void {
    this.paintGroupColors();
    this.drawGroups();
    this.events.changed(false);
    this.events.selection();
  }

  // Layout.

  /** Re-arrange: every table laid out again. Returns the old positions for Undo. */
  rearrange(): DiagramLayout['positions'] {
    const before = this.layout().positions;
    const nodes = [...this.cards.values()].map((c) => ({ name: c.table.name, width: c.box.width, height: c.box.height }));
    for (const [name, p] of Object.entries(autoLayout(nodes, this.links()))) this.move(name, p.x, p.y);
    this.redraw();
    this.fit();
    this.events.changed(false);
    return before;
  }

  restore(positions: DiagramLayout['positions']): void {
    for (const [name, p] of Object.entries(positions)) if (this.cards.has(name)) this.move(name, p.x, p.y);
    this.redraw();
    this.fit();
    this.events.changed(false);
  }

  fit(): void {
    const all = this.contentBounds();
    const w = this.host.clientWidth || 800;
    const h = this.host.clientHeight || 600;
    if (!all) return this.setView(40, 40, 1);
    const zoom = Math.max(ZOOM_MIN, Math.min(1.25, (w - 80) / all.width, (h - 80) / all.height));
    this.setView((w - all.width * zoom) / 2 - all.x * zoom, (h - all.height * zoom) / 2 - all.y * zoom, zoom);
  }

  zoomBy(factor: number, cx = (this.host.clientWidth || 800) / 2, cy = (this.host.clientHeight || 600) / 2): void {
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.view.zoom * factor));
    const k = zoom / this.view.zoom;
    this.setView(cx - (cx - this.view.x) * k, cy - (cy - this.view.y) * k, zoom);
  }

  zoomTo(zoom: number): void {
    this.zoomBy(zoom / this.view.zoom);
  }

  /** Cards and groups, in diagram coordinates. */
  contentBounds(): Box | undefined {
    const boxes = [...this.cards.values()].map((c) => c.box);
    for (const g of this.groups) {
      const b = groupBox(g.tables.map((t) => this.cards.get(t)?.box).filter((x): x is Box => !!x));
      if (b) boxes.push(b);
    }
    for (const stub of Array.from(this.edgeLayer.querySelectorAll<SVGTextElement>('.edge-stub-label'))) {
      const x = Number(stub.getAttribute('x'));
      const y = Number(stub.getAttribute('y'));
      boxes.push({ x, y: y - 12, width: stub.getComputedTextLength?.() || 120, height: 16 });
    }
    return bounds(boxes);
  }

  /** The visible area, in diagram coordinates. */
  visibleBounds(): Box {
    const w = this.host.clientWidth || 800;
    const h = this.host.clientHeight || 600;
    return { x: -this.view.x / this.view.zoom, y: -this.view.y / this.view.zoom, width: w / this.view.zoom, height: h / this.view.zoom };
  }

  /** Removes highlight and selection marks while `fn` runs (export draws the plain diagram). */
  plain<T>(fn: () => T): T {
    const classes = this.svg.getAttribute('class') ?? '';
    const marked = Array.from(this.svg.querySelectorAll('.lit, .selected'));
    const lit = marked.map((e) => [e, e.getAttribute('class') ?? ''] as const);
    this.svg.setAttribute('class', 'diagram-svg');
    for (const e of marked) e.classList.remove('lit', 'selected');
    try {
      return fn();
    } finally {
      this.svg.setAttribute('class', classes);
      for (const [e, c] of lit) e.setAttribute('class', c);
    }
  }

  get worldElement(): SVGGElement {
    return this.world;
  }

  // Drawing.

  private measure = (text: string, bold = false): number => {
    this.measureCtx ??= document.createElement('canvas').getContext('2d');
    if (!this.measureCtx) return text.length * 7;
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    this.measureCtx.font = `${bold ? '600 ' : ''}12px ${family}`;
    return this.measureCtx.measureText(text).width;
  };

  /** `text` shortened with an ellipsis to fit `width` pixels. */
  private fitText(text: string, width: number, bold = false): string {
    if (this.measure(text, bold) <= width) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.measure(`${text.slice(0, mid)}…`, bold) <= width) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, lo)}…`;
  }

  private card(table: DiagramTable, at: { x: number; y: number }): Card {
    const shortType = (t: string) => t.replace(/character varying/i, 'varchar').replace(/timestamp(\(\d\))? with(out)? time zone/i, (m) => (/without/i.test(m) ? 'timestamp' : 'timestamptz'));
    const width = cardWidth(table.name, table.columns.map((c) => ({ name: c.name, type: shortType(c.type) })), this.measure);
    const height = cardHeight(table.columns.length);
    const g = svgEl('g', 'card');
    g.dataset.table = table.name;
    // Right-click menu (package.json webview/context): which panel and table; checked again in the extension.
    g.dataset.vscodeContext = JSON.stringify({ webviewSection: 'table', panelKey: this.panelKey, table: table.name, preventDefaultContextMenuItems: true });
    g.append(svgEl('rect', 'card-bg', { width, height, rx: 6 }));
    g.append(svgEl('path', 'card-head', { d: `M0 ${HEADER}V6a6 6 0 0 1 6-6H${width - 6}a6 6 0 0 1 6 6V${HEADER}Z` }));
    g.append(svgEl('path', 'card-strip', { d: `M0 6a6 6 0 0 1 6-6H${width - 6}a6 6 0 0 1 6 6Z` }));
    g.append(svgEl('line', 'card-sep', { x1: 0, y1: HEADER, x2: width, y2: HEADER }));
    const name = svgEl('text', 'card-title', { x: 12, y: HEADER / 2 + 5 });
    name.textContent = this.fitText(table.name, width - 24, true);
    title(name, table.name);
    g.append(name);
    const fks = new Set(this.relations.filter((r) => r.table === table.name).flatMap((r) => r.columns));
    const rows = new Map<string, number>();
    const rowEls: SVGGElement[] = [];
    table.columns.forEach((c, i) => {
      rows.set(c.name, i);
      const row = svgEl('g', 'row', { transform: `translate(0 ${HEADER + i * ROW})` });
      row.append(svgEl('rect', 'row-bg', { x: 1, width: width - 2, height: ROW }));
      if (c.primaryKey || fks.has(c.name)) {
        const mark = icon(c.primaryKey ? 'key' : 'link', c.primaryKey ? 'row-key' : 'row-fk');
        mark.setAttribute('x', '9');
        mark.setAttribute('y', String(ROW / 2 - 6));
        mark.setAttribute('width', '12');
        mark.setAttribute('height', '12');
        row.append(mark);
      }
      const type = shortType(c.type);
      const typeText = svgEl('text', 'col-type', { x: width - 10, y: ROW / 2 + 4, 'text-anchor': 'end' });
      const typeShown = this.fitText(type, Math.max(40, width / 2 - 30));
      typeText.textContent = typeShown;
      if (c.nullable) {
        const q = svgEl('tspan', 'col-null');
        q.textContent = ' ?';
        typeText.append(q);
      }
      const nameText = svgEl('text', `col-name${c.primaryKey ? ' pk' : ''}`, { x: 28, y: ROW / 2 + 4 });
      nameText.textContent = this.fitText(c.name, width - 48 - this.measure(typeShown) - (c.nullable ? 12 : 0));
      title(row, `${c.name}  ${c.type}${c.nullable ? '  NULL' : '  NOT NULL'}${c.primaryKey ? '  · primary key' : ''}${fks.has(c.name) ? '  · foreign key' : ''}`);
      row.append(nameText, typeText);
      g.append(row);
      rowEls.push(row);
    });
    const card: Card = { table, g, box: { x: at.x, y: at.y, width, height }, rows, rowEls };
    g.setAttribute('transform', `translate(${at.x} ${at.y})`);
    return card;
  }

  private move(name: string, x: number, y: number): void {
    const c = this.cards.get(name);
    if (!c) return;
    c.box.x = x;
    c.box.y = y;
    c.g.setAttribute('transform', `translate(${x} ${y})`);
  }

  private links(): { from: string; to: string }[] {
    return this.relations.filter((r) => !r.refSchema).map((r) => ({ from: r.table, to: r.refTable }));
  }

  private paintGroupColors(): void {
    for (const [name, c] of this.cards) {
      const color = this.colorOf(name);
      c.g.setAttribute('class', `card${color ? ` c-${color}` : ''}${this.selected.has(name) ? ' selected' : ''}`);
    }
  }

  private redraw(): void {
    this.drawEdges();
    this.drawGroups();
  }

  private drawEdges(): void {
    this.edgeLayer.replaceChildren();
    this.edges = [];
    this.relations.forEach((r) => {
      const from = this.cards.get(r.table);
      if (!from) return;
      const to = r.refSchema ? undefined : this.cards.get(r.refTable);
      r.columns.forEach((col, pair) => {
        const g = svgEl('g', 'edge');
        const fromRow = from.rows.get(col) ?? 0;
        const label = `${r.table}.${col} → ${r.refSchema ? `${r.refSchema}.` : ''}${r.refTable}.${r.refColumns[pair] ?? '?'} (${r.name})`;
        if (!to) {
          // Another schema, or a table that isn't on this canvas: a short stub with a label.
          const a: Anchor = { x: from.box.x + from.box.width, y: from.box.y + HEADER + fromRow * ROW + ROW / 2, side: 1 };
          const path = `M${a.x} ${a.y}H${a.x + MARK + 30}`;
          g.append(svgEl('path', 'edge-hit', { d: path }), svgEl('path', 'edge-line stub', { d: path }));
          this.marks(g, a, !r.one, r.optional);
          const text = svgEl('text', 'edge-stub-label', { x: a.x + MARK + 36, y: a.y + 4 });
          text.textContent = `→ ${r.refSchema ? `${r.refSchema}.` : ''}${r.refTable}`;
          g.append(text);
        } else {
          const toRow = to.rows.get(r.refColumns[pair] ?? '') ?? 0;
          const self = from === to;
          const [a, b] = anchors(from.box, fromRow, to.box, toRow, self);
          const d = curve(a, b, self);
          g.append(svgEl('path', 'edge-hit', { d }), svgEl('path', 'edge-line', { d }));
          this.marks(g, a, !r.one, r.optional);
          this.marks(g, b, false, false);
        }
        title(g, label);
        this.edgeLayer.append(g);
        this.edges.push({ relation: r, pair, g });
      });
    });
    this.applyFocus();
  }

  private marks(g: SVGGElement, at: Anchor, many: boolean, optional: boolean): void {
    const m = endMark(at, many, optional);
    g.append(svgEl('path', 'edge-mark', { d: m.path }));
    if (m.circle) g.append(svgEl('circle', 'edge-mark open', { cx: m.circle.cx, cy: m.circle.cy, r: 4 }));
  }

  private drawGroups(): void {
    this.groupLayer.replaceChildren();
    for (const group of this.groups) {
      const box = groupBox(group.tables.map((t) => this.cards.get(t)?.box).filter((x): x is Box => !!x));
      if (!box) continue;
      const g = svgEl('g', `group c-${group.color}${this.selectedGroup === group.id ? ' selected' : ''}`);
      g.dataset.group = group.id;
      g.append(svgEl('rect', 'group-bg', { x: box.x, y: box.y, width: box.width, height: box.height, rx: 10 }));
      const label = svgEl('text', 'group-label', { x: box.x + 12, y: box.y + 18 });
      label.textContent = this.fitText(group.name, box.width - 24, true);
      title(label, `${group.name} · drag to move the group, click to edit`);
      g.append(label);
      this.groupLayer.append(g);
    }
  }

  // Highlight.

  private hover?: { table?: string; edge?: Edge };

  private applyFocus(): void {
    const focusTable = this.hover?.table ?? (this.hover?.edge ? undefined : this.sticky);
    const edge = this.hover?.edge;
    for (const e of Array.from(this.svg.querySelectorAll('.lit'))) e.classList.remove('lit');
    for (const e of this.edges) e.g.setAttribute('class', 'edge');
    // Lit lines take the table's header color (class c-<color> sets --head; the default is the theme's).
    const light = (e: Edge, table: string) => {
      const color = this.colorOf(table);
      e.g.setAttribute('class', `edge lit${color ? ` c-${color}` : ''}`);
      // On top of the other lines, so it isn't hidden where they cross.
      this.edgeLayer.append(e.g);
    };
    if (focusTable) {
      for (const e of this.edges) {
        if (e.relation.table === focusTable || (!e.relation.refSchema && e.relation.refTable === focusTable)) {
          light(e, focusTable);
        }
      }
    }
    if (edge) {
      light(edge, edge.relation.table);
      // The line's two columns are marked too.
      const r = edge.relation;
      const from = this.cards.get(r.table);
      from?.rowEls[from.rows.get(r.columns[edge.pair]) ?? -1]?.classList.add('lit');
      if (!r.refSchema) {
        const to = this.cards.get(r.refTable);
        to?.rowEls[to.rows.get(r.refColumns[edge.pair] ?? '') ?? -1]?.classList.add('lit');
      }
    }
  }

  // Input.

  private setView(x: number, y: number, zoom: number): void {
    this.view = { x, y, zoom };
    this.world.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
    // Dot grid follows the view.
    this.host.dataset.zoom = String(Math.round(zoom * 100));
    this.events.zoomed(zoom);
  }

  private toWorld(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.x) / this.view.zoom, y: (e.clientY - r.top - this.view.y) / this.view.zoom };
  }

  private select(names: string[], add = false): void {
    if (!add) this.selected.clear();
    for (const n of names) this.selected.add(n);
    this.paintGroupColors();
    this.drawGroups();
    this.events.selection();
  }

  private listen(): void {
    type Drag =
      | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number; moved: boolean }
      | { kind: 'move'; start: { x: number; y: number }; from: Map<string, { x: number; y: number }>; moved: boolean; table?: string; group?: string };
    let drag: Drag | undefined;
    const svg = this.svg;

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      svg.focus({ preventScroll: true });
      const target = e.target as Element;
      const cardEl = target.closest<SVGGElement>('.card');
      const groupEl = target.closest<SVGGElement>('.group-label') ? target.closest<SVGGElement>('.group') : null;
      if (cardEl?.dataset.table) {
        const name = cardEl.dataset.table;
        if (e.shiftKey) {
          if (this.selected.has(name)) this.selected.delete(name);
          else this.selected.add(name);
          this.select([], true);
        } else if (!this.selected.has(name)) {
          this.selectedGroup = undefined;
          this.select([name]);
        }
        const from = new Map([...this.selected].map((n) => [n, { x: this.cards.get(n)!.box.x, y: this.cards.get(n)!.box.y }]));
        drag = { kind: 'move', start: this.toWorld(e), from, moved: false, table: name };
      } else if (groupEl?.dataset.group) {
        const group = this.groups.find((g) => g.id === groupEl.dataset.group);
        if (!group) return;
        this.selectedGroup = group.id;
        this.select(group.tables);
        const from = new Map(group.tables.map((n) => [n, { x: this.cards.get(n)!.box.x, y: this.cards.get(n)!.box.y }]));
        drag = { kind: 'move', start: this.toWorld(e), from, moved: false, group: group.id };
      } else {
        drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, viewX: this.view.x, viewY: this.view.y, moved: false };
      }
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    svg.addEventListener('pointermove', (e) => {
      if (!drag) {
        const target = e.target as Element;
        const cardEl = target.closest<SVGGElement>('.card');
        const edgeEl = target.closest<SVGGElement>('.edge');
        const next = cardEl?.dataset.table ? { table: cardEl.dataset.table } : edgeEl ? { edge: this.edges.find((x) => x.g === edgeEl) } : undefined;
        if (next?.table !== this.hover?.table || next?.edge !== this.hover?.edge) {
          this.hover = next;
          this.applyFocus();
        }
        return;
      }
      if (drag.kind === 'pan') {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        this.setView(drag.viewX + dx, drag.viewY + dy, this.view.zoom);
        svg.classList.add('panning');
      } else {
        const p = this.toWorld(e);
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3 / this.view.zoom) return;
        drag.moved = true;
        for (const [name, s] of drag.from) this.move(name, snap(s.x + dx), snap(s.y + dy));
        this.redraw();
      }
    });

    const end = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag;
      drag = undefined;
      svg.classList.remove('panning');
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      if (d.kind === 'pan') {
        if (d.moved) this.events.changed(true);
        else {
          // A click on the empty canvas.
          this.sticky = undefined;
          this.selectedGroup = undefined;
          this.select([]);
          this.applyFocus();
        }
      } else if (d.moved) {
        this.events.changed(false);
      } else if (d.table && !e.shiftKey) {
        this.sticky = d.table;
        this.selectedGroup = undefined;
        this.select([d.table]);
        this.applyFocus();
      } else if (d.group) {
        this.events.selection();
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => {
      if (!drag && this.hover) {
        this.hover = undefined;
        this.applyFocus();
      }
    });

    svg.addEventListener('dblclick', (e) => {
      const name = (e.target as Element).closest<SVGGElement>('.card')?.dataset.table;
      if (name) this.events.open(name);
    });

    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)), e.clientX - r.left, e.clientY - r.top);
        else this.setView(this.view.x - e.deltaX, this.view.y - e.deltaY, this.view.zoom);
        this.events.changed(true);
      },
      { passive: false },
    );

    // Right-click selects the table, so the menu's command and the highlight agree.
    svg.addEventListener('contextmenu', (e) => {
      const name = (e.target as Element).closest<SVGGElement>('.card')?.dataset.table;
      if (name && !this.selected.has(name)) this.select([name]);
    });

    svg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.sticky = undefined;
        this.selectedGroup = undefined;
        this.select([]);
        this.applyFocus();
        return;
      }
      const step = e.shiftKey ? GRID * 10 : GRID;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta || !this.selected.size) return;
      e.preventDefault();
      for (const name of this.selected) {
        const c = this.cards.get(name);
        if (c) this.move(name, c.box.x + delta[0], c.box.y + delta[1]);
      }
      this.redraw();
      this.events.changed(false);
    });
  }
}
