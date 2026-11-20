---
paths:
    - 'src/**'
---

# Architecture — layering & placement

Put new code where the layer dictates, not where it's convenient.

## The layers

| Layer                | Files                                    | Responsibility                                                                                                                         |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Activation / wiring  | `src/extension.ts`                       | Create the services, register commands, push disposables. Small command handlers that only route to a service. No database logic.     |
| Services             | `connectionManager.ts`, `query/runQuery.ts`, `query/sqlEditor.ts` | State and orchestration: saved connections, secrets, open drivers, editor ↔ connection binding; SQL editor completion, CodeLens and formatting providers. May use the `vscode` API. |
| UI                   | `connectionWizard.ts`, `tree/`, `views/` | Talk to the user (quick picks, tree items, webview panel). Call services; never call a database client directly. Trees: `ConnectionsTree`, `SavedQueriesTree`, `HistoryTree`; `tree/objectCommands.ts` (Show DDL, Generate SQL, Copy Name, Find Object…, Switch Database…). |
| Drivers              | `src/drivers/`                           | Everything database-specific: connecting, metadata queries, running SQL, identifier quoting. **Never import `vscode`.**                 |
| Pure helpers         | `src/query/splitSql.ts`, `query/completion.ts`, `query/formatSql.ts`, `drivers/common.ts` | No `vscode`, no I/O. Testable in plain Node. (`query/schemaCache.ts` caches driver metadata and doesn't import `vscode` either.) |
| Export               | `src/export/`                            | `formats.ts` is a pure helper (no `vscode`, no I/O). `readAll.ts` (batched reads through `Driver.selectPage`) and `fileOut.ts` (streamed file writes) don't import `vscode`, so they're smoke-tested in plain Node. `exportResults.ts` is a service: dialogs, progress, clipboard. |
| Edit                 | `src/edit/`                              | `changes.ts` is a pure helper: validates the webview's pending edits and builds `RowChange`s, taking originals and keys from the extension's own copy of the page. `applyEdits.ts` is a service: prepares the statements, asks for confirmation in the grid, then calls `Driver.applyChanges`. |
| History              | `src/history/`                           | `entries.ts` is a pure helper (building, capping and grouping entries). `queryHistory.ts` is a service: records `QueryController.onDidRun` in `workspaceState`, and opens, re-runs, searches and clears entries. |
| Saved queries        | `src/saved/`                             | `names.ts` is a pure helper (name rules, path ↔ connection). `savedQueries.ts` is a service: `.sql` files under `globalStorageUri/queries/<connectionId>/`, through `vscode.workspace.fs`. |
| Webview (browser)    | `src/webview/`                           | Runs in the webview's browser context. Never imports Node or `vscode` modules; only `import type` from extension code.                |
| Shared types         | `src/types.ts`                           | Types used across layers. Types used by one file stay in that file.                                                                     |

Dependency direction: `extension.ts → UI / services → drivers → common helpers`. A driver never calls a service; the webview never imports runtime code from the extension.

## Why drivers don't import `vscode`

Drivers and pure helpers must run in plain Node so they can be smoke-tested against the Docker databases from the `node` container (see `verification.md`). Anything that needs the `vscode` API belongs in a service or UI file.

## Database-specific behavior lives in the driver

If code is about to `switch` on `config.type` outside `src/drivers/`, stop: that behavior belongs on the `Driver` interface, so a new database opts in without hunting down call sites. The only `DbType` branches outside drivers are:

- `src/drivers/index.ts` — the registry (`createDriver`, `DB_KINDS`).
- `src/connectionWizard.ts` — SQLite asks for a file, servers ask for host/port. New server databases reuse the server steps via `DB_KINDS` defaults.

## Adding a database

1. Add the type to `DbType` in `src/types.ts`.
2. Write `src/drivers/<name>.ts` implementing `Driver`, following `postgres.ts` / `mysql.ts`.
3. Register it in `createDriver`, `DB_KINDS`, `SQL_DIALECTS` (formatter language, extra keywords) and `DATABASE_SCOPE` (none / required / optional database setting) in `src/drivers/index.ts`. TypeScript's exhaustive `switch` and the `Record<DbType, …>` flag anything missed.
4. Add a dialect to `splitSql` if its quoting or comments differ.
5. Add a test database to `docker-compose.yml` with a seed in `docker/seed/`, mirroring the existing `customers` / `orders` / `paid_orders` shape.
6. Update the README features and `CHANGELOG.md`.

## Commands and state

- Every command is registered in `extension.ts` and declared in `package.json` `contributes.commands`, with its menus and `when` clauses there (see `vscode-api.md`).
- Global, cross-workspace data → `context.globalState` (saved connections). Per-workspace → `context.workspaceState` (SQL file ↔ connection). Secrets → `context.secrets` only.
- Query history → `workspaceState` (`dbDeck.queryHistory`). Saved queries → files under `globalStorageUri/queries/`, with last-known connection names in `globalState` (`dbDeck.savedQueryConnections`). Settings → `dbDeck.*` in `contributes.configuration`, read with `workspace.getConfiguration()`. Other ways to find an editor's connection go through `QueryController.registerLinkResolver()`.
- State keys are prefixed `dbDeck.` and defined as constants at the top of the file that owns them.
- Everything with a `dispose()` goes into `context.subscriptions`.

## Style

- TypeScript strict. No `any` except at VS Code's untyped command-argument boundary.
- 2-space indent, single quotes, semicolons, trailing commas — match the existing files.
- Comments explain *why* (a constraint, a gotcha), not what the next line does.
- User-facing messages are plain and actionable; driver errors go through `errorMessage()` from `drivers/common.ts`.
