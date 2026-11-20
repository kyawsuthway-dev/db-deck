---
paths:
    - 'src/webview/**'
    - 'src/views/**'
---

# Webview — results grid

The results grid is plain TypeScript + CSS (no framework). Moving to React/Svelte needs a trade-off discussion with the maintainer first, not a drive-by change.

## Security (`core.md` rule 3)

Query results are untrusted: a cell can contain `<script>` or anything else.

- CSP stays strict: `default-src 'none'; style-src ${cspSource}; script-src ${cspSource}`. Never add `'unsafe-inline'`, `'unsafe-eval'`, or remote origins.
- No inline `<script>`, `<style>`, `style="…"`, or `on…=` attributes. Styles go in `src/webview/*.css`; behavior in `src/webview/*.ts`.
- Insert data with `textContent` or `document.createElement` only. Never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` with anything derived from data.
- `localResourceRoots` stays limited to `dist/webview`.
- Values cross the boundary as `Cell` (`string | null`) — already converted in the driver layer. The webview never changes how a value is displayed; client-side sorting may compare them as numbers, but always shows the original text.

## Build

- `src/webview/results.ts` is a separate esbuild entry (browser, IIFE) → `dist/webview/results.js` + `results.css` (imported from the TS file).
- It runs in a browser: no Node built-ins, no `vscode` module, only `import type` from extension code (`types.ts`, `ResultsPanel.ts`).
- Other `src/webview/*.ts` modules (e.g. `autocomplete.ts`) are imported by `results.ts` and bundled into it. Keep their logic DOM-free where possible so it can be smoke-tested in plain Node.

## Messaging

- Message shapes are the `ResultsMessage` union in `src/views/ResultsPanel.ts`. Add new messages there so both sides share the type.
- The webview posts `{ type: 'ready' }` when its script loads; the panel replies with the last message. This covers first load and reload after the panel was hidden — keep the handshake when changing either side.
- `ResultsPanel` tokens (`showLoading` → `showResults`) drop results from an older run. Keep that guarantee for anything asynchronous.
- Messages from the webview are the `ResultsRequest` union in the same file. They are untrusted: the service checks every field (offsets, column names) before using it. Paging uses `startRun()` instead of `showLoading()`, so the grid stays on screen while the webview shows its own busy state.
- One-off commands to the webview (`copyRequest`) are the `ResultsCommand` union: posted directly, never stored as the panel's `last` message, so they're not replayed on reload.
- Export and copy formatting happens in the extension (`src/export/formats.ts`). The webview only sends which result, which rows (original indexes, in display order) and which columns.

## Look and feel

- Use VS Code theme CSS variables (`--vscode-foreground`, `--vscode-editor-background`, `--vscode-panel-border`, `--vscode-errorForeground`, …) — never hard-coded colors, so light, dark, and high-contrast themes all work.
- `NULL` is visibly different from the text `'NULL'` and from an empty string.
- Long values are truncated with an ellipsis and shown in full on hover.
