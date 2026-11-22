// Building blocks shared by DB Deck's form webviews (connection, dump, run file, CSV import), so they look
// and behave the same. Plain DOM, text only through textContent (webview.md). Styles: ./form.css.
import { icon, type IconName } from '../icons';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
let api: { postMessage(message: unknown): void } | undefined;

/** The webview's channel to the extension (acquireVsCodeApi may only be called once per page). */
export function vscodeApi<Request>(): { postMessage(message: Request): void } {
  api ??= acquireVsCodeApi();
  return api;
}

export type Span = 2 | 3 | 4 | 6;
export type StatusState = 'busy' | 'ok' | 'error' | 'info';

const STATUS_ICONS: Record<StatusState, IconName> = { busy: 'spinner', ok: 'checkCircle', error: 'alert', info: 'info' };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Page header: a badge (an icon or a database logo), the title and a subtitle. */
export function header(badge: Element, title: string, subtitle: string): HTMLElement {
  const head = el('header', 'header');
  const box = el('div', 'badge');
  box.append(badge);
  const text = el('div');
  const sub = el('p', 'subtitle', subtitle);
  text.append(el('h1', undefined, title), sub);
  head.append(box, text);
  return head;
}

/** A section with an uppercase title; `aside` (e.g. "3 of 4 selected") sits at the title's right. */
export function section(id: string, title?: string, aside?: HTMLElement): { section: HTMLElement; titleId: string } {
  const s = el('section', 'section');
  const titleId = `s-${id}`;
  if (title) {
    const row = el('div', 'section-head');
    const h = el('h2', 'section-title', title);
    h.id = titleId;
    row.append(h);
    if (aside) row.append(aside);
    s.append(row);
  }
  return { section: s, titleId };
}

/** A labelled field: label above, the control, then `error` (an error span) below. */
export function fieldShell(controlId: string, label: string, opts: { span: Span; required?: boolean }, control: HTMLElement, error?: HTMLElement) {
  const field = el('div', `field span-${opts.span}`);
  const l = el('label', 'field-label');
  l.htmlFor = controlId;
  const text = el('span', 'label-text', label);
  const required = el('span', 'required', '*');
  required.setAttribute('aria-hidden', 'true');
  required.hidden = !opts.required;
  l.append(text, required);
  field.append(l, control);
  if (error) field.append(error);
  return { field, text, required };
}

export interface InputOptions {
  icon: IconName;
  type?: 'text' | 'password';
  placeholder?: string;
  inputMode?: 'numeric';
  value?: string;
}

/** An input with a leading icon; password inputs get a show/hide button. */
export function inputControl(id: string, opts: InputOptions): { control: HTMLElement; input: HTMLInputElement } {
  const input = el('input', 'input');
  input.type = opts.type ?? 'text';
  input.id = id;
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.inputMode) input.inputMode = opts.inputMode;
  input.value = opts.value ?? '';
  const control = el('div', 'control has-icon');
  control.append(icon(opts.icon, 'leading'), input);
  if (opts.type === 'password') control.append(revealButton(input));
  return { control, input };
}

export function selectControl(id: string, options: { value: string; label: string }[], iconName: IconName, value: string) {
  const select = el('select', 'input select');
  select.id = id;
  for (const o of options) {
    const option = el('option', undefined, o.label);
    option.value = o.value;
    select.append(option);
  }
  select.value = value;
  const control = el('div', 'control has-icon');
  control.append(icon(iconName, 'leading'), select);
  return { control, select };
}

export interface Choice {
  value: string;
  button: HTMLButtonElement;
}

/**
 * Radio-group keyboard handling shared by segmented controls and chips: arrow keys move the choice
 * (skipping disabled ones), Tab leaves the group.
 */
function radioKeys(choices: Choice[], choose: (value: string) => void, vertical: boolean): void {
  choices.forEach((c, i) => {
    c.button.addEventListener('keydown', (e) => {
      const forward = e.key === 'ArrowRight' || (vertical && e.key === 'ArrowDown');
      const back = e.key === 'ArrowLeft' || (vertical && e.key === 'ArrowUp');
      if (!forward && !back) return;
      e.preventDefault();
      for (let n = 1; n < choices.length; n++) {
        const next = choices[(i + (forward ? n : -n) + choices.length) % choices.length];
        if (next.button.disabled) continue;
        choose(next.value);
        next.button.focus();
        return;
      }
    });
  });
}

/** A segmented control (radio group) in a field: e.g. SSH login, scope, dump content. */
export function segmented(
  id: string,
  label: string,
  options: readonly { value: string; label: string; icon: IconName }[],
  span: Span,
  choose: (value: string) => void,
  error?: HTMLElement,
): { field: HTMLElement; choices: Choice[] } {
  const field = el('div', `field span-${span}`);
  const title = el('span', 'field-label');
  title.id = `l-${id}`;
  title.append(el('span', 'label-text', label));
  const group = el('div', 'segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', title.id);
  const choices = options.map((c) => {
    const b = el('button', 'segment');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.append(icon(c.icon), el('span', undefined, c.label));
    b.addEventListener('click', () => choose(c.value));
    return { value: c.value, button: b };
  });
  radioKeys(choices, choose, false);
  group.append(...choices.map((c) => c.button));
  field.append(title, group);
  if (error) field.append(error);
  return { field, choices };
}

/** Chips (radio group) with a picture and a label: database types, connections. They wrap. */
export function chips(
  labelledBy: string,
  items: { value: string; label: string; title?: string; picture: Element }[],
  choose: (value: string) => void,
): { group: HTMLElement; choices: Choice[] } {
  const group = el('div', 'chips');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', labelledBy);
  const choices = items.map((item) => {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    if (item.title) b.title = item.title;
    b.append(item.picture, el('span', 'chip-label', item.label));
    b.addEventListener('click', () => choose(item.value));
    return { value: item.value, button: b };
  });
  radioKeys(choices, choose, true);
  group.append(...choices.map((c) => c.button));
  return { group, choices };
}

/** Marks the chosen segment or chip; only it is in the Tab order. */
export function paintChoices(choices: Choice[], value: string): void {
  for (const c of choices) {
    const on = c.value === value;
    c.button.setAttribute('aria-checked', String(on));
    c.button.tabIndex = on ? 0 : -1;
  }
}

/** A switch row: title and description on the left, the switch on the right. */
export function switchRow(id: string, title: string, description: string, checked: boolean, change: (checked: boolean) => void, error?: HTMLElement) {
  const input = el('input', 'switch');
  input.type = 'checkbox';
  input.id = id;
  input.setAttribute('role', 'switch');
  input.checked = checked;
  input.addEventListener('change', () => change(input.checked));
  const row = el('label', 'switch-row');
  row.htmlFor = input.id;
  const text = el('span', 'switch-text');
  const desc = el('span', 'switch-description', description);
  desc.id = `d-${id}`;
  input.setAttribute('aria-describedby', desc.id);
  text.append(el('span', 'switch-title', title), desc);
  row.append(text, input);
  const wrap = el('div', 'switch-wrap');
  wrap.append(row);
  if (error) wrap.append(error);
  return { row: wrap, input };
}

export function button(label: string, iconName: IconName, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', primary ? 'button primary' : 'button');
  b.type = 'button';
  b.append(icon(iconName), el('span', undefined, label));
  b.addEventListener('click', onClick);
  return b;
}

/** The form's main button: submits the form (Enter in a field), with a label that can change. */
export function submitButton(label: string, iconName: IconName): { button: HTMLButtonElement; label: HTMLElement } {
  const b = el('button', 'button primary');
  b.type = 'submit';
  const text = el('span', undefined, label);
  b.append(icon(iconName), text);
  return { button: b, label: text };
}

/** A small icon-only button inside an input (trailing). */
export function iconButton(label: string, iconName: IconName, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(iconName));
  b.addEventListener('click', onClick);
  return b;
}

/** Shows or hides what's typed in a password field. Stored passwords never reach a form, so only typed text shows. */
export function revealButton(input: HTMLInputElement): HTMLButtonElement {
  const b = iconButton('Show password', 'eye', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    b.title = show ? 'Hide password' : 'Show password';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(show));
  });
  b.setAttribute('aria-pressed', 'false');
  return b;
}

export function note(iconName: IconName, text: string, tone: 'info' | 'warning' | 'error' = 'info'): HTMLElement {
  const p = el('p', `note ${tone}`);
  p.append(icon(iconName), el('span', undefined, text));
  return p;
}

/** A database logo: light and dark images (CSS shows the one for the theme), or a generic icon. */
export function logo(uris: { light: string; dark: string } | undefined): Element {
  if (!uris) return icon('database', 'logo');
  const span = el('span', 'logo');
  for (const variant of ['light', 'dark'] as const) {
    const img = el('img', `logo-${variant}`);
    img.src = uris[variant];
    img.alt = '';
    span.append(img);
  }
  return span;
}

/** The sticky bar at the bottom: status on the left, buttons on the right. */
export function actionBar(...buttons: HTMLButtonElement[]): { footer: HTMLElement; status: HTMLElement } {
  const footer = el('footer', 'action-bar');
  const status = el('div', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'actions');
  actions.append(...buttons);
  footer.append(status, actions);
  return { footer, status };
}

/** Status text with its icon; errors are announced (role alert). `extra`: buttons like Save Anyway or Show Line. */
export function showStatus(status: HTMLElement, state: StatusState, text: string, ...extra: HTMLElement[]): void {
  status.className = `status ${state}`;
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
  status.replaceChildren(icon(STATUS_ICONS[state]), el('span', 'status-text', text), ...extra);
}

export function clearStatus(status: HTMLElement): void {
  status.className = 'status';
  status.replaceChildren();
}

/** A <form> that never navigates: Enter in a field calls `submit`. */
export function formElement(submit: () => void): HTMLFormElement {
  const form = el('form', 'form');
  form.noValidate = true;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  return form;
}
