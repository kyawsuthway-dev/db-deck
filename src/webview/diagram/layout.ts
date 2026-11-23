// Automatic placement with dagre: tables in layers along their foreign keys, left to right. Only used for the
// first view, for tables added since, and for Re-arrange; dragged positions are kept otherwise.
import { Graph, layout } from '@dagrejs/dagre';
import { bounds, snap, type Box } from './geometry';

export interface LayoutNode {
  name: string;
  width: number;
  height: number;
}

/** Top-left positions for `nodes`, laid out among themselves, starting at (0, 0). */
export function autoLayout(nodes: LayoutNode[], edges: { from: string; to: string }[]): Record<string, { x: number; y: number }> {
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 110, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const names = new Set(nodes.map((n) => n.name));
  for (const n of nodes) g.setNode(n.name, { width: n.width, height: n.height });
  // Referenced tables (parents) come first, so the FK points from right to left as in most ER tools.
  edges.forEach((e, i) => {
    if (e.from !== e.to && names.has(e.from) && names.has(e.to)) g.setEdge(e.to, e.from, {}, `e${i}`);
  });
  layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const placed = g.node(n.name) as { x: number; y: number } | undefined;
    // dagre gives centers.
    out[n.name] = { x: snap((placed?.x ?? 0) - n.width / 2), y: snap((placed?.y ?? 0) - n.height / 2) };
  }
  return out;
}

/** Places new tables as their own block below the existing ones, so tables you arranged don't move. */
export function placeBeside(existing: Box[], nodes: LayoutNode[], edges: { from: string; to: string }[]): Record<string, { x: number; y: number }> {
  const placed = autoLayout(nodes, edges);
  const around = bounds(existing);
  if (!around) return placed;
  const dy = snap(around.y + around.height + 80);
  const dx = snap(around.x);
  return Object.fromEntries(Object.entries(placed).map(([k, p]) => [k, { x: p.x + dx, y: p.y + dy }]));
}
