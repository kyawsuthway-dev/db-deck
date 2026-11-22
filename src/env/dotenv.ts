// A small .env parser (the dotenv format Laravel, Prisma, Rails and Node projects use). No `vscode`, no I/O,
// so it can be tested in plain Node.
//
//   KEY=value            # comment after unquoted values
//   export KEY=value
//   KEY="double \"quoted\" with ${OTHER} and \n escapes"
//   KEY='single quoted, taken literally'
//
// `${VAR}` in unquoted and double-quoted values refers to a key earlier in the same file. A bare `$VAR` is
// kept as written: Laravel (phpdotenv) doesn't expand it, so passwords like `pa$word` stay intact.
// Multi-line quoted values are supported. Lines that aren't KEY=value are ignored.

export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let i = 0;
  while (i < src.length) {
    // One entry per iteration; skip blank lines and comments.
    const lineEnd = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    const line = src.slice(i, lineEnd);
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*/.exec(line);
    if (!m) {
      i = lineEnd + 1;
      continue;
    }
    const key = m[1];
    let j = i + m[0].length;
    const quote = src[j];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A quoted value may span lines; it ends at the next unescaped matching quote.
      let k = j + 1;
      let raw = '';
      while (k < src.length && src[k] !== quote) {
        if (src[k] === '\\' && quote === '"' && k + 1 < src.length) {
          raw += src[k] + src[k + 1];
          k += 2;
        } else {
          raw += src[k++];
        }
      }
      // `\$` keeps a literal `$`: protect it from expansion, then unescape.
      const value =
        quote === '"' ? unescape(expand(raw.replace(/\\\$/g, '\u0000'), values)).replace(/\u0000/g, '$') : raw;
      values.set(key, value);
      const next = src.indexOf('\n', k);
      i = next === -1 ? src.length : next + 1;
      continue;
    }
    // Unquoted: up to the end of the line, without an inline comment (" #"), trimmed.
    let value = src.slice(j, lineEnd);
    const hash = value.search(/\s#/);
    if (hash !== -1) value = value.slice(0, hash);
    else if (value.startsWith('#')) value = '';
    values.set(key, expand(value.trim(), values));
    i = lineEnd + 1;
  }
  return values;
}

function unescape(raw: string): string {
  return raw.replace(/\\([nrt"\\])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/** ${VAR} (or ${VAR:-default}) from keys defined earlier; unknown ones become empty, as dotenv-expand does. */
function expand(value: string, values: Map<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const v = values.get(name);
    return v !== undefined && v !== '' ? v : (fallback ?? '');
  });
}
