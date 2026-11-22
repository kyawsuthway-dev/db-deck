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
| UI                   | `connectionFolders.ts`, `logos.ts`, `tree/`, `views/` | Talk to the user (quick picks, tree items, webview panels). Call services; never call a database client directly. `views/FormPanel.ts` is the base of every form; `views/ConnectionForm.ts`, `DumpForm.ts`, `RunScriptForm.ts` and `ImportForm.ts` are the forms; `logos.ts` finds the database logo files (`media/logos`). Trees: `ConnectionsTree`, `SavedQueriesTree`, `HistoryTree`; `tree/objectCommands.ts` (Show DDL, Generate SQL, Copy Name, Find Object…, Switch Database…). |
| Drivers              | `src/drivers/`                           | Everything database-specific: connecting, metadata queries, running SQL, identifier quoting. **Never import `vscode`.**                 |
| Pure helpers         | `src/query/splitSql.ts`, `query/completion.ts`, `query/formatSql.ts`, `drivers/common.ts`, `connectionForm/fields.ts` (the connection form's checks) | No `vscode`, no I/O. Testable in plain Node. (`query/schemaCache.ts` caches driver metadata and doesn't import `vscode` either.) |
| Export               | `src/export/`                            | `formats.ts` is a pure helper (no `vscode`, no I/O). `readAll.ts` (batched reads through `Driver.selectPage`) and `fileOut.ts` (streamed file writes) don't import `vscode`, so they're smoke-tested in plain Node. `exportResults.ts` is a service: dialogs, progress, clipboard. |
| Edit                 | `src/edit/`                              | `changes.ts` is a pure helper: validates the webview's pending edits and builds `RowChange`s, taking originals and keys from the extension's own copy of the page. `applyEdits.ts` is a service: prepares the statements, asks for confirmation in the grid, then calls `Driver.applyChanges`. |
| History              | `src/history/`                           | `entries.ts` is a pure helper (building, capping and grouping entries). `queryHistory.ts` is a service: records `QueryController.onDidRun` in `workspaceState`, and opens, re-runs, searches and clears entries. |
| Saved queries        | `src/saved/`                             | `names.ts` is a pure helper (name rules, path ↔ connection). `savedQueries.ts` is a service: `.sql` files under `globalStorageUri/queries/<connectionId>/`, through `vscode.workspace.fs`. |
| Data transfer        | `src/transfer/`                          | `script.ts` is a pure helper (statements with line numbers, own transactions, schema changes, `DELIMITER`). `dumpWriter.ts` writes a driver's `DumpPlan` in pages and doesn't import `vscode`, so dump → restore round trips are smoke-tested in plain Node. The forms that use them are `views/DumpForm.ts` and `views/RunScriptForm.ts`. |
| Import               | `src/import/`                            | `csv.ts` (streaming RFC 4180 parser, delimiter detection) and `mapping.ts` (targets, auto-match, checks) are pure helpers. `csvFile.ts` reads the file once to check it and again as a stream to import, without `vscode`. The form is `views/ImportForm.ts`. |
| SSH                  | `src/ssh/`                               | `sshTunnel.ts` wraps `ssh2`: one SSH session per open connection, a forwarded channel per database connection (no local port), host-key check through a callback. No `vscode` import; `ConnectionManager` supplies secrets and the trust prompt. |
| Project connections  | `src/env/`                               | `dotenv.ts` (`.env` parsing), `detect.ts` (Laravel `DB_*`, `DB_URL`, `DATABASE_URL`) and `compose.ts` (compose published ports and database services, `yaml`) are pure helpers. `envConnections.ts` is a service: reads the root `.env` and compose files of each workspace folder live (watchers), keeps passwords in memory only, and never runs project code or `docker`. |
| Shared               | `src/shared/`                            | Code used by both the extension and the webviews (`connectionString.ts`). No `vscode`, no Node built-ins, no DOM. |
| Webview (browser)    | `src/webview/`                           | Runs in the webview's browser context. Never imports Node or `vscode` modules; only `import type` from extension code, plus runtime imports from `src/shared/`. |
| Shared types         | `src/types.ts`                           | Types used across layers. Types used by one file stay in that file.                                                                     |

Dependency direction: `extension.ts → UI / services → drivers → common helpers`. A driver never calls a service; the webview never imports runtime code from the extension (except `src/shared/`).

## Why drivers don't import `vscode`

Drivers and pure helpers must run in plain Node so they can be smoke-tested against the Docker databases from the `node` container (see `verification.md`). Anything that needs the `vscode` API belongs in a service or UI file.

## Database-specific behavior lives in the driver

If code is about to `switch` on `config.type` outside `src/drivers/`, stop: that behavior belongs on the `Driver` interface, so a new database opts in without hunting down call sites. The only `DbType` branches outside drivers are:

- `src/drivers/index.ts` — the registry (`createDriver`, `DB_KINDS`).

## Adding a database

1. Add the type to `DbType` in `src/types.ts`.
2. Write `src/drivers/<name>.ts` implementing `Driver`, following `postgres.ts` / `mysql.ts`.
3. Register it in `createDriver`, `DB_KINDS` (with its `logo`, and `laravel` names / `docker` images if .env and compose detection should find it), `SQL_DIALECTS` (formatter language, extra keywords), `DATABASE_SCOPE` (none / required / optional database setting) `USES_NETWORK` (can go through an SSH tunnel) and `TRANSACTIONAL_DDL` (can roll back CREATE / ALTER / DROP) in `src/drivers/index.ts`, and implement `dumpPlan`, `dumpRows`, `runScript` and `importRows`. Add `media/logos/<logo>-light.svg`, `-dark.svg` and the `-connected` variants, or it gets a generic icon. The connection form reads all of this from the registry, so it needs no change. TypeScript's exhaustive `switch` and the `Record<DbType, …>` flag anything missed.
4. Add a dialect to `splitSql` if its quoting or comments differ.
5. Add a test database to `docker-compose.yml` with a seed in `docker/seed/`, mirroring the existing `customers` / `orders` / `paid_orders` shape.
6. Update the README features and `CHANGELOG.md`.

## Commands and state

- Every command is registered in `extension.ts` and declared in `package.json` `contributes.commands`, with its menus and `when` clauses there (see `vscode-api.md`).
- Global, cross-workspace data → `context.globalState` (saved connections). Per-workspace → `context.workspaceState` (SQL file ↔ connection). Secrets → `context.secrets` only.
- Query history → `workspaceState` (`dbDeck.queryHistory`). Saved queries → files under `globalStorageUri/queries/`, with last-known connection names in `globalState` (`dbDeck.savedQueryConnections`). Settings → `dbDeck.*` in `contributes.configuration`, read with `workspace.getConfiguration()`. Other ways to find an editor's connection go through `QueryController.registerLinkResolver()`.
- Hidden table-view columns → `workspaceState` (`dbDeck.hiddenColumns`, keyed by connection and table).
- Connections for this workspace only → `workspaceState` (`dbDeck.workspaceConnections`), never a file in the project. `ConnectionConfig.source` (`workspace` / `env`) is derived by `ConnectionManager.list()` and never stored.
- `.env` and compose connections are never written anywhere: settings and passwords are re-read from the files. Only their read-only marks are stored (`workspaceState`, `dbDeck.envReadOnly`). Their ids are `env:` + a hash of folder, file and source, so links, history and saved queries survive reloads.
- SSH passwords and key passphrases → `context.secrets` (`dbDeck.sshSecret.<id>`). Trusted SSH host keys → `globalState` (`dbDeck.sshHostKeys`, `host:port` → fingerprint), per host, so they outlive a removed connection.
- State keys are prefixed `dbDeck.` and defined as constants at the top of the file that owns them.
- Everything with a `dispose()` goes into `context.subscriptions`.

## Style

- TypeScript strict. No `any` except at VS Code's untyped command-argument boundary.
- 2-space indent, single quotes, semicolons, trailing commas — match the existing files.
- Comments explain *why* (a constraint, a gotcha), not what the next line does.
- User-facing messages are plain and actionable; driver errors go through `errorMessage()` from `drivers/common.ts`.
