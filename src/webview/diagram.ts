// The ER diagram page: toolbar, group popover and messaging around the SVG canvas (diagram/canvas.ts).
// Names come from the database or the user: textContent only.
import { GROUP_COLORS, type DiagramLayout, type GroupColor } from '../diagram/model';
import type { DiagramMessage, DiagramRequest } from '../views/DiagramPanel';
import { icon, type IconName } from './icons';
import { el, logo, note, vscodeApi } from './forms/kit';
import { Canvas } from './diagram/canvas';
import { svgSize, toPng, toSvg } from './diagram/export';
import './forms/form.css';
import './diagram.css';

const vscode = vscodeApi<DiagramRequest>();
const root = document.getElementById('root')!;
root.className = 'diagram-root';

const COLOR_LABELS: Record<GroupColor, string> = { blue: 'Blue', green: 'Green', orange: 'Orange', purple: 'Purple', red: 'Red', yellow: 'Yellow' };

// Layout.
const bar = el('div', 'diagram-bar');
const titleBox = el('div', 'diagram-title');
const tools = el('div', 'diagram-tools');
bar.append(titleBox, tools);
const notices = el('div', 'diagram-notices');
notices.setAttribute('role', 'status');
notices.setAttribute('aria-live', 'polite');
const stage = el('div', 'diagram-stage');
const overlay = el('div', 'diagram-overlay');
stage.append(overlay);
root.append(bar, notices, stage);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let loadedOnce = false;
let undo: DiagramLayout['positions'] | undefined;

const canvas = new Canvas(stage, {
  changed(viewOnly) {
    if (!viewOnly) undo = undefined;
    if (!viewOnly && notices.dataset.kind === 'undo') clearNotice();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.postMessage({ type: 'save', layout: canvas.layout() }), viewOnly ? 1000 : 300);
  },
  open: (table) => vscode.postMessage({ type: 'open', table, how: 'rows' }),
  selection: () => paintTools(),
  zoomed: (zoom) => (zoomLabel.textContent = `${Math.round(zoom * 100)}%`),
});

function toolButton(label: string, iconName: IconName, onClick: () => void, text = true): HTMLButtonElement {
  const b = el('button', `tool${text ? '' : ' icon-only'}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(iconName));
  if (text) b.append(el('span', undefined, label));
  b.addEventListener('click', onClick);
  return b;
}

const refresh = toolButton('Refresh', 'spinner', () => vscode.postMessage({ type: 'refresh' }));
const rearrange = toolButton('Re-arrange', 'structure', () => confirmRearrange());
const groupButton = toolButton('Group…', 'folder', () => openPopover());
const colorButton = toolButton('Color…', 'palette', () => toggleColors());
const zoomOut = toolButton('Zoom out', 'down', () => canvas.zoomBy(1 / 1.2), false);
const zoomLabel = el('button', 'tool zoom-label', '100%');
zoomLabel.type = 'button';
zoomLabel.title = 'Zoom to 100%';
zoomLabel.addEventListener('click', () => canvas.zoomTo(1));
const zoomIn = toolButton('Zoom in', 'up', () => canvas.zoomBy(1.2), false);
const fit = toolButton('Fit', 'eye', () => canvas.fit());
const exportButton = toolButton('Export', 'save', () => toggleMenu());
exportButton.setAttribute('aria-haspopup', 'menu');
const zoomGroup = el('div', 'tool-group');
zoomGroup.append(zoomOut, zoomLabel, zoomIn, fit);
const exportWrap = el('div', 'menu-wrap');
const menu = el('div', 'menu');
menu.setAttribute('role', 'menu');
menu.hidden = true;
for (const [format, whole, label] of [
  ['svg', true, 'SVG · whole diagram'],
  ['svg', false, 'SVG · current view'],
  ['png', true, 'PNG · whole diagram'],
  ['png', false, 'PNG · current view'],
] as const) {
  const item = el('button', 'menu-item', label);
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  item.addEventListener('click', () => {
    menu.hidden = true;
    void exportImage(format, whole);
  });
  menu.append(item);
}
exportWrap.append(exportButton, menu);
tools.append(refresh, rearrange, colorButton, groupButton, zoomGroup, exportWrap);
document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !exportWrap.contains(e.target as Node)) menu.hidden = true;
  if (!colorPop.hidden && !colorPop.contains(e.target as Node) && !colorButton.contains(e.target as Node) && !stage.contains(e.target as Node)) colorPop.hidden = true;
  if (!popover.hidden && !popover.contains(e.target as Node) && e.target !== groupButton && !groupButton.contains(e.target as Node) && !stage.contains(e.target as Node)) closePopover();
});

function toggleMenu(): void {
  menu.hidden = !menu.hidden;
  if (!menu.hidden) menu.querySelector<HTMLButtonElement>('.menu-item')?.focus();
}
menu.addEventListener('keydown', (e) => {
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.menu-item'));
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'Escape') {
    menu.hidden = true;
    exportButton.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});

function paintTools(): void {
  groupButton.disabled = !canvas.selected.size && !canvas.selectedGroup;
  colorButton.disabled = !canvas.selected.size;
  if (!colorPop.hidden) {
    if (canvas.selected.size) paintColors();
    else colorPop.hidden = true;
  }
  rearrange.disabled = !canvas.tableCount;
  if (canvas.selectedGroup) openPopover(true);
  else if (!popover.hidden && popoverMode === 'edit') closePopover();
  else if (!popover.hidden) paintPopover();
}

// Notices: messages, the Re-arrange confirmation, Undo.
function showNotice(content: HTMLElement, kind = 'message'): void {
  notices.dataset.kind = kind;
  notices.replaceChildren(content);
}

function clearNotice(): void {
  delete notices.dataset.kind;
  notices.replaceChildren();
}

function noticeWith(iconName: IconName, text: string, tone: 'info' | 'warning' | 'error', ...buttons: HTMLButtonElement[]): HTMLElement {
  const n = note(iconName, text, tone);
  const actions = el('span', 'notice-actions');
  actions.append(...buttons);
  n.append(actions);
  return n;
}

function linkButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'link-button', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function confirmRearrange(): void {
  const go = linkButton('Re-arrange', () => {
    undo = canvas.rearrange();
    // rearrange() reports a change, which clears Undo: keep the positions from before it.
    const before = undo;
    showNotice(
      noticeWith('info', 'Tables re-arranged.', 'info', linkButton('Undo', () => {
        canvas.restore(before);
        clearNotice();
      })),
      'undo',
    );
    undo = before;
  });
  showNotice(noticeWith('warning', 'Re-arrange replaces your table positions. Groups stay.', 'warning', go, linkButton('Cancel', clearNotice)), 'confirm');
  go.focus();
}

// Group popover: create a group from the selection, add to / remove from a group, or edit a clicked group.
const popover = el('div', 'popover');
popover.hidden = true;
popover.setAttribute('role', 'dialog');
popover.setAttribute('aria-label', 'Group');
stage.append(popover);
let popoverMode: 'create' | 'edit' = 'create';
let chosenColor: GroupColor = 'blue';

function openPopover(edit = false): void {
  colorPop.hidden = true;
  popoverMode = edit && canvas.selectedGroup ? 'edit' : 'create';
  const group = popoverMode === 'edit' ? canvas.groupList.find((g) => g.id === canvas.selectedGroup) : undefined;
  chosenColor = group?.color ?? GROUP_COLORS[canvas.groupList.length % GROUP_COLORS.length];
  popover.hidden = false;
  paintPopover(group?.name ?? '');
}

function closePopover(): void {
  popover.hidden = true;
}

function paintPopover(initialName?: string): void {
  const group = popoverMode === 'edit' ? canvas.groupList.find((g) => g.id === canvas.selectedGroup) : undefined;
  const existing = canvas.groupList;
  const selected = [...canvas.selected];
  const grouped = selected.filter((t) => canvas.groupOf(t));
  popover.replaceChildren();
  const heading = el('div', 'popover-title', group ? 'Edit Group' : `Group ${selected.length} table${selected.length === 1 ? '' : 's'}`);
  popover.append(heading);

  // Target: a new group, or one that exists.
  let target = 'new';
  const targetSelect = el('select', 'select');
  if (!group && existing.length) {
    targetSelect.append(new Option('New group', 'new'));
    for (const g of existing) targetSelect.append(new Option(`Add to “${g.name}”`, g.id));
    targetSelect.addEventListener('change', () => {
      target = targetSelect.value;
      fields.hidden = target !== 'new';
      submit.textContent = target === 'new' ? 'Create Group' : 'Add to Group';
    });
    popover.append(targetSelect);
  }

  const fields = el('div', 'popover-fields');
  const name = el('input', 'input');
  name.type = 'text';
  name.placeholder = 'Group name';
  name.maxLength = 60;
  name.value = initialName ?? group?.name ?? (fields.querySelector('input') as HTMLInputElement | null)?.value ?? '';
  name.setAttribute('aria-label', 'Group name');
  const swatches = el('div', 'swatches');
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Color');
  const paintSwatches = () => {
    for (const b of Array.from(swatches.querySelectorAll<HTMLButtonElement>('button'))) {
      const on = b.dataset.color === chosenColor;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  for (const color of GROUP_COLORS) {
    const b = el('button', `swatch c-${color}`);
    b.type = 'button';
    b.dataset.color = color;
    b.title = COLOR_LABELS[color];
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', COLOR_LABELS[color]);
    b.addEventListener('click', () => {
      chosenColor = color;
      paintSwatches();
    });
    swatches.append(b);
  }
  paintSwatches();
  fields.append(name, swatches);
  popover.append(fields);

  const actions = el('div', 'popover-actions');
  const submit = el('button', 'button primary', group ? 'Save' : 'Create Group');
  submit.type = 'button';
  const apply = () => {
    const text = name.value.trim();
    if (group) {
      if (!text) return name.focus();
      canvas.editGroup(group.id, text, chosenColor);
    } else if (target !== 'new') {
      canvas.addToGroup(target);
      closePopover();
    } else {
      if (!text) return name.focus();
      canvas.createGroup(text, chosenColor);
      closePopover();
    }
  };
  submit.addEventListener('click', apply);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  });
  actions.append(submit);
  if (group) {
    const ungroup = el('button', 'button', 'Ungroup');
    ungroup.type = 'button';
    ungroup.title = 'Removes the group; its tables stay where they are';
    ungroup.addEventListener('click', () => {
      canvas.ungroup(group.id);
      closePopover();
    });
    actions.append(ungroup);
  } else if (grouped.length) {
    const remove = el('button', 'button', 'Remove from Group');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      canvas.removeFromGroup();
      closePopover();
    });
    actions.append(remove);
  }
  const close = el('button', 'button', 'Close');
  close.type = 'button';
  close.addEventListener('click', closePopover);
  actions.append(close);
  popover.append(actions);
  if (!group && !selected.length) {
    popover.replaceChildren(heading, el('p', 'hint', 'Select tables first: click one, Shift+click to add more.'), actions);
    heading.textContent = 'Group';
    submit.remove();
  }
  popover.onkeydown = (e) => {
    if (e.key === 'Escape') closePopover();
  };
  if (popoverMode === 'create') setTimeout(() => name.focus(), 0);
}

// Header color popover: a color for the selected tables (wins over their group's), or Default.
const colorPop = el('div', 'popover color-popover');
colorPop.hidden = true;
colorPop.setAttribute('role', 'dialog');
colorPop.setAttribute('aria-label', 'Header color');
stage.append(colorPop);
colorPop.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    colorPop.hidden = true;
    colorButton.focus();
  }
});

function toggleColors(): void {
  colorPop.hidden = !colorPop.hidden;
  if (colorPop.hidden) return;
  closePopover();
  paintColors();
  colorPop.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}

function paintColors(): void {
  const selected = [...canvas.selected];
  const own = new Set(selected.map((t) => canvas.layout().colors?.[t]));
  const current = own.size === 1 ? [...own][0] : null;
  colorPop.replaceChildren(el('div', 'popover-title', `Header color · ${selected.length} table${selected.length === 1 ? '' : 's'}`));
  const swatches = el('div', 'swatches');
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Header color');
  const choose = (color: GroupColor | undefined) => {
    canvas.setColor(color);
    paintColors();
  };
  const def = el('button', 'swatch swatch-default');
  def.type = 'button';
  def.title = 'Default: the group’s color, or the theme’s';
  def.setAttribute('role', 'radio');
  def.setAttribute('aria-label', 'Default');
  def.setAttribute('aria-checked', String(current === undefined));
  def.addEventListener('click', () => choose(undefined));
  swatches.append(def);
  for (const color of GROUP_COLORS) {
    const b = el('button', `swatch c-${color}`);
    b.type = 'button';
    b.title = COLOR_LABELS[color];
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', COLOR_LABELS[color]);
    b.setAttribute('aria-checked', String(current === color));
    b.addEventListener('click', () => choose(color));
    swatches.append(b);
  }
  colorPop.append(swatches, el('p', 'hint', 'Hovering a table colors its lines with this color.'));
}

// Export.
async function exportImage(format: 'svg' | 'png', whole: boolean): Promise<void> {
  const area = whole ? canvas.contentBounds() : canvas.visibleBounds();
  if (!area) return;
  try {
    const background = getComputedStyle(document.body).backgroundColor || '#ffffff';
    const svg = canvas.plain(() => toSvg(canvas.worldElement, area, background));
    if (format === 'svg') vscode.postMessage({ type: 'export', format, data: svg });
    else {
      const { width, height } = svgSize(svg);
      vscode.postMessage({ type: 'export', format, data: await toPng(svg, width, height) });
    }
  } catch (err) {
    showNotice(note('alert', `Couldn’t export: ${err instanceof Error ? err.message : String(err)}`, 'error'));
  }
}

// Messages.
window.addEventListener('message', (event: MessageEvent<DiagramMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loading':
      refresh.disabled = true;
      overlay.replaceChildren(note('spinner', 'Reading the schema…'));
      overlay.hidden = false;
      break;
    case 'error':
      refresh.disabled = false;
      overlay.replaceChildren(note('alert', msg.text, 'error'));
      overlay.hidden = false;
      break;
    case 'notice':
      showNotice(note(msg.tone === 'error' ? 'alert' : 'checkCircle', msg.text, msg.tone));
      break;
    case 'data': {
      refresh.disabled = false;
      titleBox.replaceChildren(logo(msg.logo), el('span', 'diagram-name', msg.title), el('span', 'diagram-detail', msg.detail));
      overlay.hidden = true;
      closePopover();
      const placed = canvas.load(msg.panelKey, msg.tables, msg.relations, msg.layout, msg.unplaced, loadedOnce);
      loadedOnce = true;
      if (!msg.tables.length) {
        overlay.replaceChildren(note('info', 'This schema has no tables.'));
        overlay.hidden = false;
      }
      // New tables were placed: keep their spots.
      if (placed) vscode.postMessage({ type: 'save', layout: canvas.layout() });
      paintTools();
      break;
    }
  }
});
vscode.postMessage({ type: 'ready' });
