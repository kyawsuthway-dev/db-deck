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
- Language features (completion, CodeLens, formatting) are registered for `{ language: 'sql' }` in `query/sqlEditor.ts`. Table and column suggestions never open a connection. CodeLens commands (▶ Run, Explain) take the document URI and an offset, and re-read the text when clicked.

## Menus and `when` clauses

- Tree item menus key off `contextValue`. Connection items are `connection[.connected][.server]` (match with regexes, e.g. `/^connection\.connected/`); objects use their kind: `schema`, `table`, `view`, `function`, `procedure`, `sequence`, `index`, `trigger`, `column`. Connection folders are `folder`. Object folders in a connection are `objects.<kind>` (the Tables folder is `objects.table`; Indexes / Triggers under a table have none). `.env` / compose connections are `connection[.connected][.server].env` inside an `envGroup`; menus for saved connections only (Edit, Move to Folder, Remove) match `/^connection(\.connected)?(\.server)?$/`. Never start a new context value with `connection`, since connection menus match `/^connection/`. If you add a `contextValue`, check every `when` clause that matches by regex.
- Inline actions use `group: "inline@N"`; context-menu groups are `1_query`, `2_design` (Design Table, New Table, Rename, Truncate), `2_manage`, `2_transfer` (Dump, Import CSV), `3_remove` (Remove Connection, Drop…), `4_copy`; `explorer/context` and `editor/context` use `1_dbDeck`. Generate SQL is the submenu `dbDeck.generateSql` (in `1_query`). Server… is in the connection menu's `2_manage`; ER Diagram is `2_design@2` on connections, schemas and the Tables folder; Explain / Explain Analyze are in `editor/context` `1_dbDeck`.
- SQL editor actions use `editorLangId == sql`.
- The results grid's right-click menu is `webview/context`, matched with `webviewId == 'dbDeck.results' && webviewSection == 'grid'`; the grid element sets `data-vscode-context`. Those commands are hidden from the Command Palette.
- The ER diagram's table cards have a right-click menu (`webviewId == 'dbDeck.diagram' && webviewSection == 'table'`: Open Rows, Design Table…, Show DDL). Each card's `data-vscode-context` holds the panel key and table name; the commands check both against the panel's own table list.
- The results header's right-click menu is `webviewSection == 'header'` (Hide Column); the header sets its own `data-vscode-context`, which takes precedence over the grid's.
- Grid edit commands (Set to NULL, Delete Rows, Add Row) also require `dbDeckEditable`, which the grid sets in `data-vscode-context` only for editable table views; they use group `3_edit`.
- View toolbars use `view/title` with `group: "navigation@N"`. Item `contextValue`s: `savedQuery`, `historyEntry`, and `historyEntry.shortened` (no Run Again).
- DB Deck's keybindings in SQL editors (`Ctrl/Cmd+Enter`, `Ctrl/Cmd+Shift+Enter`, `Ctrl/Cmd+S` in untitled editors) require `dbDeck.editorLinked`, a context key `QueryController` sets for the active editor, so other SQL extensions keep their keys in their own editors.

## Tree

- VS Code remembers expansion by `TreeItem.id`. Ids are path-like (`<connectionId>#<generation>/tables/<name>`), and must stay stable across refreshes. Disconnect bumps the generation on purpose so the node collapses instead of reconnecting. Nodes implement `getParent` so `TreeView.reveal` works (Find Object…).
- Errors while loading children become an error node plus a notification — never an unhandled rejection.

## UX conventions

- Add Connection, Edit Connection…, New Table…, Design Table…, Truncate Table…, Drop…, Dump to SQL File…, Run SQL File… and Import CSV… open forms; Rename Table… is an input box (`webview.md`); Add / Edit Connection opens the connection form (`views/ConnectionForm.ts`), one editor tab per connection. Its Save tests first and offers Save Anyway; file pickers and the SSH host-key prompt stay native dialogs.
- Connection tree items show the database logo (`logos.ts`, `{ light, dark }` files); open connections use the `-connected` variant (green dot). Not a file decoration: that would color the name.
- Multi-step input uses `showQuickPick`/`showInputBox` with a `title` and `ignoreFocusOut: true`; Escape at any step cancels without side effects.
- Destructive actions (remove connection) use a modal confirmation that says what is and isn't affected.
- Long operations use `withProgress`.
- Results open beside the editor for queries (`ViewColumn.Beside`, `preserveFocus`), in the active group for table previews.
