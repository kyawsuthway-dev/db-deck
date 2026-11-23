// ER diagram geometry: card sizes, where a column row's line leaves the card, the curve between two rows and
// the crow's-foot marks. DOM-free, so it can be smoke-tested in plain Node.

export const GRID = 10;
export const HEADER = 34;
export const ROW = 24;
export const PAD_BOTTOM = 6;
export const MIN_WIDTH = 180;
export const MAX_WIDTH = 380;
/** Space around a group's tables, and above them for its label. */
export const GROUP_PAD = 20;
export const GROUP_LABEL = 26;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const snap = (v: number) => Math.round(v / GRID) * GRID;

export function cardHeight(columns: number): number {
  return HEADER + Math.max(columns, 1) * ROW + PAD_BOTTOM;
}

/** Width from the widest text: `measure` gives a string's width in pixels at the card's font. */
export function cardWidth(name: string, rows: { name: string; type: string }[], measure: (text: string, bold?: boolean) => number): number {
  // Row: 10 padding, 18 key mark, name, 24 gap, type, 10 padding.
  const widest = Math.max(measure(name, true) + 40, ...rows.map((r) => 62 + measure(r.name) + measure(r.type)));
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(widest / GRID) * GRID));
}

/** The y of a column row's middle, relative to the card. */
export const rowMiddle = (index: number) => HEADER + index * ROW + ROW / 2;

export interface Anchor {
  x: number;
  y: number;
  /** -1: leaves to the left, 1: to the right. */
  side: -1 | 1;
}

/**
 * Where a line between rows of two cards leaves each: from the sides that face each other, or both from the
 * right when the cards overlap horizontally (one above the other) and for a table that references itself.
 */
export function anchors(from: Box, fromRow: number, to: Box, toRow: number, self: boolean): [Anchor, Anchor] {
  const fy = from.y + rowMiddle(fromRow);
  const ty = to.y + rowMiddle(toRow);
  if (self) return [{ x: from.x + from.width, y: fy, side: 1 }, { x: to.x + to.width, y: ty, side: 1 }];
  if (from.x + from.width + 40 <= to.x) return [{ x: from.x + from.width, y: fy, side: 1 }, { x: to.x, y: ty, side: -1 }];
  if (to.x + to.width + 40 <= from.x) return [{ x: from.x, y: fy, side: -1 }, { x: to.x + to.width, y: ty, side: 1 }];
  // Stacked: both on the right, or both on the left when that's shorter.
  const right = Math.abs(from.x + from.width - (to.x + to.width));
  const left = Math.abs(from.x - to.x);
  return left < right
    ? [{ x: from.x, y: fy, side: -1 }, { x: to.x, y: ty, side: -1 }]
    : [{ x: from.x + from.width, y: fy, side: 1 }, { x: to.x + to.width, y: ty, side: 1 }];
}

/** Length of the end marks: the curve starts and ends this far out from the cards. */
export const MARK = 18;

/** The curve between two anchors (after the marks), as an SVG path. */
export function curve(a: Anchor, b: Anchor, self = false): string {
  const ax = a.x + a.side * MARK;
  const bx = b.x + b.side * MARK;
  if (self) {
    const out = Math.max(ax, bx) + 40;
    return `M${a.x} ${a.y}H${ax}C${out} ${a.y} ${out} ${b.y} ${bx} ${b.y}H${b.x}`;
  }
  const reach = Math.max(40, Math.abs(bx - ax) / 2);
  return `M${a.x} ${a.y}H${ax}C${ax + a.side * reach} ${a.y} ${bx + b.side * reach} ${b.y} ${bx} ${b.y}H${b.x}`;
}

/**
 * The end mark at an anchor: crow's foot for many, a bar for one; a circle for optional, a second bar for
 * mandatory. Returns line paths and circles to draw.
 */
export function endMark(at: Anchor, many: boolean, optional: boolean): { path: string; circle?: { cx: number; cy: number } } {
  const s = at.side;
  const parts: string[] = [];
  if (many) {
    // Three prongs meeting 10 px out, spreading to the card edge.
    const tip = at.x + s * 10;
    parts.push(`M${tip} ${at.y}L${at.x} ${at.y - 7}`, `M${tip} ${at.y}L${at.x} ${at.y + 7}`);
  } else {
    parts.push(`M${at.x + s * 6} ${at.y - 6}V${at.y + 6}`);
  }
  if (optional) return { path: parts.join(''), circle: { cx: at.x + s * 14, cy: at.y } };
  parts.push(`M${at.x + s * 13} ${at.y - 6}V${at.y + 6}`);
  return { path: parts.join('') };
}

/** The box around a group's cards, with room for its label above. */
export function groupBox(cards: Box[]): Box | undefined {
  if (!cards.length) return undefined;
  const x = Math.min(...cards.map((c) => c.x)) - GROUP_PAD;
  const y = Math.min(...cards.map((c) => c.y)) - GROUP_PAD - GROUP_LABEL;
  const right = Math.max(...cards.map((c) => c.x + c.width)) + GROUP_PAD;
  const bottom = Math.max(...cards.map((c) => c.y + c.height)) + GROUP_PAD;
  return { x, y, width: right - x, height: bottom - y };
}

export function bounds(boxes: Box[]): Box | undefined {
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}
