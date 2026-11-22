---
paths:
    - 'src/webview/**'
    - 'src/views/**'
    - 'src/connectionForm/**'
    - 'src/shared/**'
    - 'media/logos/**'
---

# Webviews — results grid and forms

The results grid is plain TypeScript + CSS (no framework). Moving to React/Svelte needs a trade-off discussion with the maintainer first, not a drive-by change.

## Security (`core.md` rule 3)

Query results are untrusted: a cell can contain `<script>` or anything else.

- CSP stays strict: `default-src 'none'; style-src ${cspSource}; script-src ${cspSource}`. Never add `'unsafe-inline'`, `'unsafe-eval'`, or remote origins.
- No inline `<script>`, `<style>`, `style="…"`, or `on…=` attributes. Styles go in `src/webview/*.css`; behavior in `src/webview/*.ts`.
- Insert data with `textContent` or `document.createElement` only. Never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` with anything derived from data.
- `localResourceRoots` stays limited to `dist/webview` (forms add `media/logos`, nothing else).
- The table-edit save confirmation is rendered in the webview, so the strict CSP and `textContent`-only rules are what keep that confirmation trustworthy. Never relax them.
- The detail pane may indent JSON only by changing whitespace between tokens (`jsonText.ts`); never re-print values through `JSON.parse`. Copy always copies the value as stored (or as edited), never the indented form.
- Values cross the boundary as `Cell` (`string | null`) — already converted in the driver layer. The webview never changes how a value is displayed; client-side sorting may compare them as numbers, but always shows the original text.

## Build

- `src/webview/results.ts` (Results grid) and the forms `connectionForm.ts`, `dumpForm.ts`, `runScriptForm.ts`, `importForm.ts` are esbuild entries (browser, IIFE) → `dist/webview/<name>.js` + `<name>.css` (imported from the TS file).
- They run in a browser: no Node built-ins, no `vscode` module, only `import type` from extension code (`types.ts`, `ResultsPanel.ts`, the form panels in `src/views/`, `connectionForm/fields.ts`, `transfer/dumpWriter.ts`). Forms don't import extension helpers at runtime, so a form may repeat a small check the extension also does (Import CSV's mapping warnings); the extension's check is the one that counts. Runtime imports come only from `src/webview/` and `src/shared/`.
- Other `src/webview/*.ts` modules (e.g. `autocomplete.ts`, `icons.ts`) and `src/shared/*.ts` are imported by an entry and bundled into it. Keep their logic DOM-free where possible so it can be smoke-tested in plain Node.

## Forms (connection, dump, run file, CSV import)

- Every form is built from `src/webview/forms/kit.ts` (header, sections, fields, segmented controls, chips, switches, checklists, notes, action bar, status) and `src/webview/forms/form.css`, with `src/views/FormPanel.ts` on the extension side (`FormPanel`: the CSP below, roots, `retainContextWhenHidden`, `post`, `logo()`; `FormTabs`: one tab per key). New forms reuse them instead of adding their own styles or panel code, so all forms look and behave the same.
- The page posts `{ type: 'ready' }`; the panel replies with `init`. Everything a form sends is untrusted: the panel checks each field (enums, keys into its own lists, absolute paths) before acting.
- Long work (dump, run file, import) reports progress through the form's status, with Close turning into Cancel while it runs.
- A form's main button may be the confirmation for a write (Run N Statements) when the form first shows what will happen; the extension re-reads and re-checks its input when the button is clicked.

### Connection form

- Same CSP and `textContent`-only rules as the grid, plus `img-src ${cspSource}` for the database logos; `localResourceRoots` is `dist/webview` and `media/logos`, nothing wider.
- It never receives a stored password: password fields start empty ("Unchanged — type to replace"). Every field it sends is checked in the extension (`readValues`, `checkForm` in `src/connectionForm/fields.ts`), never only in the form.
- It gets the database kinds (labels, defaults, `USES_NETWORK`, `DATABASE_SCOPE`, logo URIs) from the registry in its `init` message, so it never branches on database type.
- Connection strings are parsed in the webview (`src/shared/connectionString.ts`, also used for `.env` URLs) only to fill fields; the box is cleared afterwards, since it may hold a password.
- Icons are DB Deck's own SVG paths (`icons.ts`, constants built with `createElementNS`). Database logos are files in `media/logos` (Simple Icons, CC0): the only fixed colors in the UI, with `-light` / `-dark` variants.

## Messaging

- Message shapes are the `ResultsMessage` union in `src/views/ResultsPanel.ts`. Add new messages there so both sides share the type.
- The webview posts `{ type: 'ready' }` when its script loads; the panel replies with the last message. This covers first load and reload after the panel was hidden — keep the handshake when changing either side.
- `ResultsPanel` tokens (`showLoading` → `showResults`) drop results from an older run. Keep that guarantee for anything asynchronous.
- Messages from the webview are the `ResultsRequest` union in the same file. They are untrusted: the service checks every field (offsets, column names) before using it. Paging uses `startRun()` instead of `showLoading()`, so the grid stays on screen while the webview shows its own busy state.
- One-off commands to the webview (`copyRequest`) are the `ResultsCommand` union: posted directly, never stored as the panel's `last` message, so they're not replayed on reload.
- A save is two steps: `save` (the extension validates and sends `confirmSave` with a one-time token) and `applySave` with that token. The extension runs only the change set it prepared under the token, once, and only if the same page is still shown.
- Export and copy formatting happens in the extension (`src/export/formats.ts`). The webview sends which result, which rows (original indexes, in display order) and which columns (original indexes, in display order, leaving hidden ones out); the grid maps screen positions through `columns.ts`.
- `QueryController` acts only on the requests it owns and ignores the rest, so adding a request type can't reload the table page by accident.

## Look and feel

- Use VS Code theme CSS variables (`--vscode-foreground`, `--vscode-editor-background`, `--vscode-panel-border`, `--vscode-errorForeground`, …) — never hard-coded colors, so light, dark, and high-contrast themes all work.
- `NULL` is visibly different from the text `'NULL'` and from an empty string.
- Long values are truncated with an ellipsis and shown in full on hover.
