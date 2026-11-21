import * as fs from 'fs';
import * as vscode from 'vscode';
import { DB_KINDS } from './drivers';
import type { DbType } from './types';

/**
 * Database logo files (media/logos, from Simple Icons, CC0): `<name>-light.svg` in the brand color and
 * `<name>-dark.svg` lighter for dark themes. Names come from `DbKind.logo`. Undefined when there's no file,
 * so a database without a logo gets a generic icon.
 */
export function logoUris(
  extensionUri: vscode.Uri,
  name: string,
  /** The `-connected` files add a green dot (the Connections view's "connected" sign). */
  connected = false,
): { light: vscode.Uri; dark: vscode.Uri } | undefined {
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  const dir = vscode.Uri.joinPath(extensionUri, 'media', 'logos');
  const suffix = connected ? '-connected' : '';
  const light = vscode.Uri.joinPath(dir, `${name}-light${suffix}.svg`);
  const dark = vscode.Uri.joinPath(dir, `${name}-dark${suffix}.svg`);
  return fs.existsSync(light.fsPath) && fs.existsSync(dark.fsPath) ? { light, dark } : undefined;
}

/** The logo of a saved connection's type (MariaDB connections share MySQL's type, so they show its logo). */
export function logoForType(type: DbType): string | undefined {
  return DB_KINDS.find((k) => k.type === type)?.logo;
}
