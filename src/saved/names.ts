// Saved query names and where their files live. Pure: no vscode, no I/O.

const MAX_NAME_LENGTH = 100;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Why a saved query name can't be used, or undefined when it can. The file is `<name>.sql`. */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed !== name) return 'The name can’t start or end with spaces.';
  if (name.length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters.`;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return 'The name can’t contain \\ / : * ? " < > | or control characters.';
  if (name.startsWith('.')) return 'The name can’t start with a dot.';
  if (name.endsWith('.')) return 'The name can’t end with a dot.';
  if (RESERVED.test(name)) return 'That name is reserved on Windows.';
  return undefined;
}

export const fileNameOf = (name: string) => `${name}.sql`;

/** The query name of a `.sql` file name, or undefined for other files. */
export function queryNameOf(fileName: string): string | undefined {
  return /\.sql$/i.test(fileName) && fileName.length > 4 ? fileName.slice(0, -4) : undefined;
}

/**
 * The connection a saved query belongs to, from its path: `<root>/<connectionId>/<name>.sql`.
 * Paths are URI paths (forward slashes). Undefined for anything else.
 */
export function connectionOfPath(rootPath: string, path: string): string | undefined {
  const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  if (!path.startsWith(prefix)) return undefined;
  const parts = path.slice(prefix.length).split('/');
  if (parts.length !== 2 || !parts[0] || !queryNameOf(parts[1])) return undefined;
  return parts[0];
}

/** Two names are the same file on case-insensitive file systems (Windows, macOS). */
export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
