// Autocomplete for the table view's WHERE box. Runs in the webview (browser); text goes in with textContent only.
// suggestionsAt() is pure (no DOM), so it can be tested in plain Node.
import type { FilterHints } from '../types';

export interface Suggestion {
  label: string;
  /** Shown dimmed after the label: a column's type. */
  detail?: string;
  insert: string;
  /** Caret position within `insert`; the end when absent. */
  caret?: number;
}

/** Suggestions replace text[from, caret). */
export interface SuggestionList {
  from: number;
  items: Suggestion[];
}

const KEYWORDS: Suggestion[] = ['AND', 'OR', 'NOT'].map((k) => ({ label: k, insert: `${k} ` }));
const MAX_ITEMS = 50;

/**
 * What to suggest with the caret at `caret`:
 * - after a column name and a space: the operators, narrowed by any partial word;
 * - while typing a word: matching columns (prefix matches first) and AND / OR / NOT;
 * - inside a string literal, or with nothing typed: nothing, unless `forced` (Ctrl+Space).
 */
export function suggestionsAt(text: string, caret: number, hints: FilterHints, forced: boolean): SuggestionList | undefined {
  const before = text.slice(0, caret);
  if (insideString(before)) return undefined;
  const word = /[A-Za-z0-9_$"`]*$/.exec(before)![0];
  const from = caret - word.length;
  const typed = unquote(word).toLowerCase();

  const previous = /("(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z0-9_$]+)\s+$/.exec(before.slice(0, from));
  const afterColumn = previous !== null && hints.columns.some((c) => sameName(previous[1], c.name, c.insert));

  let items: Suggestion[];
  if (afterColumn) {
    items = hints.operators
      .filter((o) => o.label.toLowerCase().startsWith(typed))
      .map((o) => ({ label: o.label, insert: o.insert, caret: o.caret }));
  } else if (word === '' && !forced) {
    return undefined;
  } else if (/^[0-9]/.test(word)) {
    return undefined; // a number being typed, not a name
  } else {
    const columns = hints.columns.map((c) => ({ label: c.name, detail: c.type, insert: `${c.insert} ` }));
    const starts = columns.filter((c) => c.label.toLowerCase().startsWith(typed));
    const contains = typed ? columns.filter((c) => !starts.includes(c) && c.label.toLowerCase().includes(typed)) : [];
    items = [...starts, ...contains, ...KEYWORDS.filter((k) => k.label.toLowerCase().startsWith(typed))];
  }

  // A word that's already complete (the only match is exactly what's typed) needs no list.
  if (items.length === 1 && word && unquote(items[0].insert.trim()).toLowerCase() === typed) return undefined;
  return items.length ? { from, items: items.slice(0, MAX_ITEMS) } : undefined;
}

/** True when the text ends inside a '…' literal. A doubled '' is an escaped quote, which keeps the count even. */
function insideString(before: string): boolean {
  return (before.match(/'/g)?.length ?? 0) % 2 === 1;
}

function unquote(token: string): string {
  const q = token[0];
  if (q !== '"' && q !== '`') return token;
  const inner = token.endsWith(q) && token.length > 1 ? token.slice(1, -1) : token.slice(1);
  return inner.split(q + q).join(q);
}

function sameName(token: string, name: string, insert: string): boolean {
  if (token === insert) return true;
  // Bare names match case-insensitively; quoted ones exactly.
  return token[0] === '"' || token[0] === '`' ? unquote(token) === name : token.toLowerCase() === name.toLowerCase();
}

/**
 * Wires a suggestion list to the WHERE input. Opens as you type, Ctrl+Space opens on demand.
 * While open: ↑ / ↓ move, Enter or Tab accept, Escape closes. Returns a keydown handler that
 * reports whether it used the key, so the caller's own Enter / Escape only run when the list is closed.
 */
export function attachAutocomplete(
  input: HTMLInputElement,
  list: HTMLUListElement,
  hints: FilterHints,
  onChange: (value: string) => void,
): (event: KeyboardEvent) => boolean {
  let current: SuggestionList | undefined;
  let active = 0;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  const close = () => {
    current = undefined;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const show = () => {
    if (!current) return close();
    list.replaceChildren(
      ...current.items.map((item, i) => {
        const li = document.createElement('li');
        li.id = `${list.id}-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        if (i === active) li.className = 'active';
        const label = document.createElement('span');
        label.className = 'suggestion-label';
        label.textContent = item.label;
        li.append(label);
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'suggestion-detail';
          detail.textContent = item.detail;
          li.append(detail);
        }
        // mousedown, not click, so the input keeps focus.
        li.addEventListener('mousedown', (event) => {
          event.preventDefault();
          accept(i);
        });
        return li;
      }),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  const update = (forced: boolean) => {
    if (input.readOnly) return close();
    current = suggestionsAt(input.value, input.selectionStart ?? input.value.length, hints, forced);
    active = 0;
    show();
  };

  const accept = (i: number) => {
    if (!current) return;
    const item = current.items[i];
    const caret = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, current.from) + item.insert + input.value.slice(caret);
    const at = current.from + (item.caret ?? item.insert.length);
    input.setSelectionRange(at, at);
    onChange(input.value);
    // After a column, this opens the operators.
    update(false);
  };

  input.addEventListener('input', () => update(false));
  input.addEventListener('blur', close);
  input.addEventListener('click', close);

  return (event) => {
    if (event.key === ' ' && event.ctrlKey) {
      event.preventDefault();
      update(true);
      return true;
    }
    if (!current) return false;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + current.items.length) % current.items.length;
        show();
        return true;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        accept(active);
        return true;
      case 'Escape':
        event.preventDefault();
        close();
        return true;
      default:
        return false;
    }
  };
}
