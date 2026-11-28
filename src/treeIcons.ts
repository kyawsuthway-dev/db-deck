import * as vscode from 'vscode';

/** The Connections tree's own icons (media/icons, from Tabler Icons, MIT; see media/icons/README.md). */
export type TreeIconName =
  | 'database'
  | 'schemas'
  | 'schema'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'index'
  | 'trigger'
  | 'column'
  | 'key';

/**
 * `<name>-light.svg` / `<name>-dark.svg`: tree icons are images, so they can't take the theme's text color;
 * each kind has a fixed color, darker for light themes and lighter for dark ones.
 */
export function treeIcon(extensionUri: vscode.Uri, name: TreeIconName): { light: vscode.Uri; dark: vscode.Uri } {
  const dir = vscode.Uri.joinPath(extensionUri, 'media', 'icons');
  return { light: vscode.Uri.joinPath(dir, `${name}-light.svg`), dark: vscode.Uri.joinPath(dir, `${name}-dark.svg`) };
}
