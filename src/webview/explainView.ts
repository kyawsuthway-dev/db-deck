// The Explain panel, in a webview: the plan as a collapsible tree with cost / time bars, and the raw output.
// Built from the shared form kit and tabs. Plan labels and details are database text: textContent only.
import type { PlanNode } from '../tools/plan';
import type { ExplainMessage, ExplainRequest } from '../views/ExplainPanel';
import { icon } from './icons';
import { el, header, logo, note, section, tabs as kitTabs, vscodeApi } from './forms/kit';
import './forms/form.css';

const vscode = vscodeApi<ExplainRequest>();
const root = document.getElementById('root')!;

type Loading = Extract<ExplainMessage, { type: 'loading' }>;
let ui: ReturnType<typeof build> | undefined;

window.addEventListener('message', (event: MessageEvent<ExplainMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loading':
      ui = build(msg);
      break;
    case 'plan':
      if (!ui) return;
      ui.body.replaceChildren(...(msg.note ? [note('info', msg.note)] : []), tree(msg.plan, msg.analyze));
      ui.raw.textContent = msg.raw;
      ui.copy.disabled = false;
      break;
    case 'error':
      ui?.body.replaceChildren(note('alert', msg.text, 'error'));
      break;
  }
});
vscode.postMessage({ type: 'ready' });

function build(msg: Loading) {
  const page = el('div', 'page');
  page.append(header(msg.logo ? logo(msg.logo) : icon('structure'), msg.title, msg.detail));
  const statement = section('statement', 'Statement');
  const sql = el('pre', 'sql-preview statement', msg.statement);
  sql.title = msg.statement;
  statement.section.append(sql);
  page.append(statement.section);

  const tabs = kitTabs<'plan' | 'raw'>('explain', [
    { id: 'plan', label: 'Plan', icon: 'structure' },
    { id: 'raw', label: 'Raw', icon: 'file' },
  ]);
  const body = el('div', 'plan');
  body.append(note('spinner', msg.analyze ? 'Running the statement to measure it…' : 'Asking the database for its plan…'));
  tabs.panels.plan.append(body);
  const copy = el('button', 'link-button', 'Copy');
  copy.type = 'button';
  copy.disabled = true;
  copy.addEventListener('click', () => vscode.postMessage({ type: 'copyRaw' }));
  const toolbar = el('div', 'tab-toolbar');
  toolbar.append(copy);
  const raw = el('pre', 'sql-preview raw');
  tabs.panels.raw.append(toolbar, raw);
  page.append(tabs.list, tabs.panels.plan, tabs.panels.raw);
  root.replaceChildren(page);
  return { body, raw, copy };
}

/** The plan tree. Bars compare each step to the most expensive one (time with Analyze, cost otherwise). */
function tree(plan: PlanNode, analyze: boolean): HTMLElement {
  const metric = (n: PlanNode) => (analyze ? n.actualMs : n.cost) ?? 0;
  let max = 0;
  const visit = (n: PlanNode) => {
    max = Math.max(max, metric(n));
    n.children.forEach(visit);
  };
  visit(plan);
  const list = el('ul', 'plan-tree');
  list.setAttribute('role', 'tree');
  list.append(node(plan, metric, max, analyze, 0));
  return list;
}

function node(n: PlanNode, metric: (n: PlanNode) => number, max: number, analyze: boolean, depth: number): HTMLElement {
  const item = el('li', 'plan-node');
  item.setAttribute('role', 'treeitem');
  const row = el('div', `plan-row${n.hint ? ' hinted' : ''}`);
  const toggle = el('button', 'plan-toggle');
  toggle.type = 'button';
  const expandable = n.children.length > 0 || n.details.length > 0;
  toggle.disabled = !expandable;
  toggle.setAttribute('aria-label', 'Expand or collapse');
  const open = (on: boolean) => {
    item.classList.toggle('collapsed', !on);
    item.setAttribute('aria-expanded', String(on));
    toggle.replaceChildren(icon(on ? 'down' : 'play'));
  };
  toggle.addEventListener('click', () => open(item.classList.contains('collapsed')));
  const label = el('span', 'plan-label', n.label);
  label.title = n.label;
  const numbers = el('span', 'plan-numbers');
  const parts: string[] = [];
  if (analyze && n.actualMs !== undefined) parts.push(`${n.actualMs.toLocaleString()} ms`);
  if (n.cost !== undefined) parts.push(`cost ${n.cost.toLocaleString()}`);
  if (n.rows !== undefined) parts.push(`${n.rows.toLocaleString()} rows est.`);
  if (n.actualRows !== undefined) parts.push(`${(n.actualRows * (n.loops ?? 1)).toLocaleString()} actual${n.loops && n.loops > 1 ? ` (${n.loops} loops)` : ''}`);
  numbers.textContent = parts.join(' · ');
  const bar = el('span', 'plan-bar');
  const fill = el('span', 'plan-bar-fill');
  // Width through a class step, not an inline style (CSP): 0–20 in 5% steps.
  const share = max > 0 ? Math.round((metric(n) / max) * 20) : 0;
  fill.classList.add(`w${share}`);
  bar.append(fill);
  bar.title = analyze ? 'Time compared with the slowest step' : 'Cost compared with the most expensive step';
  row.append(toggle, label, numbers, bar);
  item.append(row);
  if (n.hint) item.append(note('alert', n.hint, 'warning'));
  if (n.details.length) {
    const details = el('ul', 'plan-details');
    for (const d of n.details) details.append(el('li', undefined, d));
    item.append(details);
  }
  if (n.children.length) {
    const children = el('ul', 'plan-children');
    children.setAttribute('role', 'group');
    for (const c of n.children) children.append(node(c, metric, max, analyze, depth + 1));
    item.append(children);
  }
  // Details start folded below the first levels, so big plans stay readable.
  open(depth < 4);
  if (!n.children.length && n.details.length) item.classList.add('details-only');
  return item;
}
