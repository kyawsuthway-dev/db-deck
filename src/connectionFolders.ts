import * as vscode from 'vscode';
import { MAX_FOLDER } from './connectionForm/fields';

/** Picks a folder for a connection: an existing one, a new one, or none. Undefined when cancelled; `value` undefined means no folder. */
export async function pickFolder(title: string, folders: string[], current: string | undefined): Promise<{ value?: string } | undefined> {
  const items: (vscode.QuickPickItem & { value?: string; create?: boolean })[] = [
    ...folders.map((f) => ({ label: `$(folder) ${f}`, description: f === current ? 'Current' : undefined, value: f })),
    { label: '$(new-folder) New Folder…', create: true },
    ...(current ? [{ label: '$(close) Remove from Folder', value: undefined }] : []),
  ];
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Folder in the Connections view', ignoreFocusOut: true });
  if (!picked) return undefined;
  if (!picked.create) return { value: picked.value };
  const name = await askFolderName(title, '');
  return name === undefined ? undefined : { value: name };
}

export async function askFolderName(title: string, value: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title,
    prompt: 'Folder name',
    value,
    ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? 'Required' : v.trim().length > MAX_FOLDER ? `Use at most ${MAX_FOLDER} characters` : undefined),
  });
  return name?.trim();
}
