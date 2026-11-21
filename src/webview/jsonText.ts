// JSON text for the value detail pane. DOM-free, so it can be tested in plain Node.
// Values are never re-printed through JSON.parse: that would turn 12345678901234567890 into
// 12345678901234567000 (core.md rule 5). Indenting only changes the whitespace between tokens.

/** True when the text is a JSON object or array. JSON.parse only checks validity; its result is thrown away. */
export function isJsonContainer(text: string): boolean {
  const t = text.trim();
  const object = t.startsWith('{') && t.endsWith('}');
  const array = t.startsWith('[') && t.endsWith(']');
  if (!object && !array) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Indents valid JSON text (check with isJsonContainer first). Strings, numbers and keywords are copied
 * exactly as written; only whitespace between tokens changes. Empty objects and arrays stay `{}` / `[]`.
 */
export function indentJson(text: string, indent = '  '): string {
  const t = text.trim();
  let out = '';
  let depth = 0;
  let i = 0;
  const newline = () => `\n${indent.repeat(depth)}`;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j + 1;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      let j = i + 1;
      while (j < t.length && /[ \t\n\r]/.test(t[j])) j++;
      if (t[j] === close) {
        out += c + close;
        i = j + 1;
      } else {
        depth++;
        out += c + newline();
        i++;
      }
    } else if (c === '}' || c === ']') {
      depth--;
      out += newline() + c;
      i++;
    } else if (c === ',') {
      out += `,${newline()}`;
      i++;
    } else if (c === ':') {
      out += ': ';
      i++;
    } else {
      // A number, true, false or null: copied up to the next delimiter.
      let j = i;
      while (j < t.length && !/[ \t\n\r,:\]}[{"]/.test(t[j])) j++;
      out += t.slice(i, j);
      i = j;
    }
  }
  return out;
}
