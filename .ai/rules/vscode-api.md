---
paths:
    - 'src/**'
    - 'package.json'
---

# VS Code API & `package.json` contributions

## Engine

`engines.vscode` is `^1.90.0` and `@types/vscode` matches it. Don't use an API newer than the engine; if a feature needs one, raise the engine version deliberately and say so.

## Commands

- IDs are `dbDeck.<camelCase>`, category `DB Deck`, with a codicon `icon` when shown in a toolbar.
- Every command in `contributes.commands` is registered in `extension.ts`, and vice versa.
- Commands that need a tree node argument are hidden from the Command Palette (`commandPalette` with `"when": "false"`) unless they fall back to a quick pick when called without one.
- `activationEvents` stays empty: VS Code derives activation from contributed views and commands.
- Language features (completion, CodeLens, formatting) are registered for `{ language: 'sql' }` in `query/sqlEditor.ts`. Table and column suggestions never open a connection. CodeLens commands take the document URI and an offset, and re-read the text when clicked.

## Menus and `when` clauses

- Tree item menus key off `contextValue`. Connection items are `connection[.connected][.server]` (match with regexes, e.g. `/^connection\.connected/`); objects use their kind: `schema`, `table`, `view`, `function`, `procedure`, `sequence`, `index`, `trigger`, `column`. If you add a `contextValue`, check every `when` clause that matches by regex.
- Inline actions use `group: "inline@N"`; context-menu groups are `1_query`, `2_manage`, `3_remove`, `4_copy`. Generate SQL is the submenu `dbDeck.generateSql` (in `1_query`).
- SQL editor actions use `editorLangId == sql`.
- The results grid's right-click menu is `webview/context`, matched with `webviewId == 'dbDeck.results' && webviewSection == 'grid'`; the grid element sets `data-vscode-context`. Those commands are hidden from the Command Palette.
- Grid edit commands (Set to NULL, Delete Rows, Add Row) also require `dbDeckEditable`, which the grid sets in `data-vscode-context` only for editable table views; they use group `3_edit`.
- View toolbars use `view/title` with `group: "navigation@N"`. Item `contextValue`s: `savedQuery`, `historyEntry`, and `historyEntry.shortened` (no Run Again).
- DB Deck's keybindings in SQL editors (`Ctrl/Cmd+Enter`, `Ctrl/Cmd+Shift+Enter`, `Ctrl/Cmd+S` in untitled editors) require `dbDeck.editorLinked`, a context key `QueryController` sets for the active editor, so other SQL extensions keep their keys in their own editors.

## Tree

- VS Code remembers expansion by `TreeItem.id`. Ids are path-like (`<connectionId>#<generation>/tables/<name>`), and must stay stable across refreshes. Disconnect bumps the generation on purpose so the node collapses instead of reconnecting. Nodes implement `getParent` so `TreeView.reveal` works (Find Object…).
- Errors while loading children become an error node plus a notification — never an unhandled rejection.

## UX conventions

- Multi-step input uses `showQuickPick`/`showInputBox` with a `title` and `ignoreFocusOut: true`; Escape at any step cancels without side effects.
- Destructive actions (remove connection) use a modal confirmation that says what is and isn't affected.
- Long operations use `withProgress`.
- Results open beside the editor for queries (`ViewColumn.Beside`, `preserveFocus`), in the active group for table previews.
