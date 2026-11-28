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
| UI                   | `connectionFolders.ts`, `logos.ts`, `treeIcons.ts`, `tree/`, `views/` | Talk to the user (quick picks, tree items, webview panels). Call services; never call a database client directly. `views/FormPanel.ts` is the base of every form; `views/ConnectionForm.ts`, `DumpForm.ts`, `RunScriptForm.ts`, `ImportForm.ts`, `TableDesignForm.ts` and `DangerForm.ts` are the forms; `ExplainPanel.ts` (Explain, one reused panel), `ServerPanel.ts` (Server…, one per connection) and `DiagramPanel.ts` (ER Diagram, one per connection + schema) are panels on the same base; `CompareForm.ts` (Compare Structure, one per source connection) and `MockForm.ts` (Generate Mock Data, one per connection + table) are forms; `logos.ts` finds the database logo files (`media/logos`); `treeIcons.ts` gives the Connections tree's own icons (`media/icons`). Trees: `ConnectionsTree`, `SavedQueriesTree`, `HistoryTree`; `tree/objectCommands.ts` (Show DDL, Generate SQL, Copy Name, Find Object…, Switch Database…). |
| Drivers              | `src/drivers/`                           | Everything database-specific: connecting, metadata queries, running SQL, identifier quoting. **Never import `vscode`.** `sqlserver.ts` loads tedious only through `sqlserverLib.ts`, which esbuild bundles as its own `dist/sqlserver.js` (`LIBRARY_BUNDLES`); `sqlserverValues.ts` is a pure helper (exact value text). `oracle.ts` loads node-oracledb only through `oracleLib.ts` (`dist/oracle.js`); `oracleValues.ts` is a pure helper (exact value text); `oracledb.d.ts` declares the part of node-oracledb DB Deck uses (the package ships no types). |
| Pure helpers         | `src/query/splitSql.ts`, `query/completion.ts`, `query/formatSql.ts`, `drivers/common.ts`, `connectionForm/fields.ts` (the connection form's checks) | No `vscode`, no I/O. Testable in plain Node. (`query/schemaCache.ts` caches driver metadata and doesn't import `vscode` either.) |
| Export               | `src/export/`                            | `formats.ts` is a pure helper (no `vscode`, no I/O). `readAll.ts` (batched reads through `Driver.selectPage`) and `fileOut.ts` (streamed file writes) don't import `vscode`, so they're smoke-tested in plain Node. `exportResults.ts` is a service: dialogs, progress, clipboard. |
| Edit                 | `src/edit/`                              | `changes.ts` is a pure helper: validates the webview's pending edits and builds `RowChange`s, taking originals and keys from the extension's own copy of the page. `applyEdits.ts` is a service: prepares the statements, asks for confirmation in the grid, then calls `Driver.applyChanges`. |
| History              | `src/history/`                           | `entries.ts` is a pure helper (building, capping and grouping entries). `queryHistory.ts` is a service: records `QueryController.onDidRun` in `workspaceState`, and opens, re-runs, searches and clears entries. |
| Saved queries        | `src/saved/`                             | `names.ts` is a pure helper (name rules, path ↔ connection). `savedQueries.ts` is a service: `.sql` files under `globalStorageUri/queries/<connectionId>/`, through `vscode.workspace.fs`. |
| Data transfer        | `src/transfer/`                          | `script.ts` is a pure helper (statements with line numbers, own transactions, schema changes, `DELIMITER`, Oracle SQL*Plus commands). `dumpWriter.ts` writes a driver's `DumpPlan` in pages and doesn't import `vscode`, so dump → restore round trips are smoke-tested in plain Node. The forms that use them are `views/DumpForm.ts` and `views/RunScriptForm.ts`. |
| Design               | `src/design/`                            | `model.ts` (the `TableDesign` model, `checkDesign` with errors by field path, `parseDesign` for form input, `withServerFields`) `diff.ts` (`diffDesign`: columns matched by key, so renames stay renames) and `notes.ts` (`changeNotes`: what a change may do to the data, shared by Design Table and Compare Structure) are pure helpers. The DDL itself is built in the drivers (`drivers/ddl.ts`). The forms are `views/TableDesignForm.ts` and `views/DangerForm.ts` (Truncate, Drop). |
| Import               | `src/import/`                            | `csv.ts` (streaming RFC 4180 parser, delimiter detection) and `mapping.ts` (targets, auto-match, checks) are pure helpers. `csvFile.ts` reads the file once to check it and again as a stream to import, without `vscode`. The form is `views/ImportForm.ts`. |
| Tools                | `src/tools/`                             | `plan.ts` is a pure helper: the EXPLAIN parsers (PostgreSQL JSON, MySQL TREE and tabular, SQLite rows → one `PlanNode` tree with hints) and `readOnlyStatement`, the check Explain Analyze needs before it runs a statement. The panels are `views/ExplainPanel.ts` and `views/ServerPanel.ts`. |
| Diagram              | `src/diagram/`                           | `model.ts` is a pure helper: relationships with their ends (one / many, optional), merging a saved layout with the schema as it is now, and `checkLayout`, which rejects a layout from the webview (positions, groups, per-table colors, view) unless every field is valid. Layout, drawing and export run in the webview (`src/webview/diagram/`, with `@dagrejs/dagre`). The panel is `views/DiagramPanel.ts`. |
| Compare              | `src/compare/`                           | `compare.ts` is a pure helper: aligns a source table with the target (target schema, FKs into the source schema re-pointed, column keys by name or a linked rename, server-made index / FK / check names adopted by content), lists the differences as items with stable ids, builds the target design from the ticked items only, orders creates and drops, and builds the SQL through the target driver's pure builders after `checkDesign`. The form is `views/CompareForm.ts`. |
| Mock data            | `src/mock/`                              | `generators.ts` (a seeded random source and the built-in value generators, English word lists) and `plan.ts` (types read from type names, the generator picked per column, `CHECK … IN` lists, `checkMock` for the form's settings, `generateRows` with unique keys checked against existing values and foreign keys from parent samples) are pure helpers. The extension reads the design, `columnChoices`, existing unique values and parent keys (`dumpRows`), then inserts through `importRows`. The form is `views/MockForm.ts`. |
| SSH                  | `src/ssh/`                               | `sshTunnel.ts` wraps `ssh2`: one SSH session per open connection, a forwarded channel per database connection (no local port), host-key check through a callback. No `vscode` import; `ConnectionManager` supplies secrets and the trust prompt. |
| Project connections  | `src/env/`                               | `dotenv.ts` (`.env` parsing), `detect.ts` (Laravel `DB_*`, `DB_URL`, `DATABASE_URL`) and `compose.ts` (compose published ports and database services, `yaml`) are pure helpers. `envConnections.ts` is a service: reads the root `.env` and compose files of each workspace folder live (watchers), keeps passwords in memory only, and never runs project code or `docker`. |
| Shared               | `src/shared/`                            | Code used by both the extension and the webviews (`connectionString.ts`). No `vscode`, no Node built-ins, no DOM. |
| Webview (browser)    | `src/webview/`                           | Runs in the webview's browser context. Never imports Node or `vscode` modules; only `import type` from extension code, plus runtime imports from `src/shared/`. |
| Shared types         | `src/types.ts`                           | Types used across layers. Types used by one file stay in that file.                                                                     |

Dependency direction: `extension.ts → UI / services → drivers → common helpers`. A driver never calls a service; the webview never imports runtime code from the extension (except `src/shared/`).

## Why drivers don't import `vscode`

Drivers and pure helpers must run in plain Node so they can be smoke-tested against the Docker databases from the `node` container (see `verification.md`). Anything that needs the `vscode` API belongs in a service or UI file.

## Libraries load from their own file

Every database and helper library (pg, mysql2, ssh2, sql.js, yaml, the sql-formatter module, tedious, oracledb) is bundled as its own file next to `dist/extension.js` (`LIBRARY_BUNDLES` in `esbuild.mjs`) and read only when the code that lazily imports it first runs, so startup loads only DB Deck's own code (about 0.3 MB). A new library is imported lazily (`await import('x')` where it's first needed) and added to `LIBRARY_BUNDLES`; the extension build turns that import into `require('./x.js')`. The files are flat in `dist/` (sql.js finds its `.wasm` there). Smoke tests that bundle the source run the same code. Downloading libraries at runtime is out (`core.md` rule 6).

## Database-specific behavior lives in the driver

If code is about to `switch` on `config.type` outside `src/drivers/`, stop: that behavior belongs on the `Driver` interface, so a new database opts in without hunting down call sites. The only `DbType` branches outside drivers are:

- `src/drivers/index.ts` — the registry (`createDriver`, `DB_KINDS`).

## Adding a database

1. Add the type to `DbType` in `src/types.ts`.
2. Write `src/drivers/<name>.ts` implementing `Driver`, following `postgres.ts` / `mysql.ts`.
3. Register it in `createDriver`, `DB_KINDS` (with its `logo`, and `laravel` names / `docker` images (and `docker.ssl`) if .env and compose detection should find it; `defaultSsl`, `databaseRequired`, `instances`, `signIns`, `readOnlyNote`, `urlExample`, `sslModes` (encryption choices), `databaseLabel`, `sid` (service name or SID), `privileges` (Connect as) and `sshLocalPort` where the connection form needs them; `docker.databaseByImage` for a default database per image; `hidden` while it's being built, so `offeredKinds()` offers it only in the Extension Development Host), `SQL_DIALECTS` (formatter language, extra keywords, `rowLimit` for Generate SQL's SELECT), `DATABASE_SCOPE` (none / required / optional database setting), `TREE_LAYOUT` (objects / schemas / database: what the tree shows under a connection), `USES_NETWORK` (can go through an SSH tunnel) and `TRANSACTIONAL_DDL` (can roll back CREATE / ALTER / DROP) and `TABLE_FEATURES` (type suggestions, comments, auto-increment, referential actions, Truncate / Drop notes, whether NULLs clash in unique keys: `uniqueNullsDistinct`, and `updateActions` where ON UPDATE differs) in `src/drivers/index.ts` (with `DdlDialect.defaultFirst` / `referentialActions` where the DDL syntax differs), and implement `databaseName`, `dumpPlan`, `dumpRows`, `runScript`, `importRows` and the table-design methods (`createTableSql`, `renameTableSql`, `truncateTableSql`, `dropSql`, `referencingTables`, `readDesign`, `alterTableSql`) and the quick tools (`explain`, `serverStatus`, `serverSettings`, `listProcesses`, `endProcess`, `schemaDiagram`, `listSchemas`, `columnChoices`, with `SERVER_TOOLS` saying whether it has sessions, EXPLAIN ANALYZE and Cancel Query (`cancelQuery`)); `TABLE_FEATURES.reorder` says whether existing columns can move. For the tree, implement `listTreeSchemas`, `listSchemaObjects`, `isSystemSchema` and `objectKinds`. Add `media/logos/<logo>-light.svg`, `-dark.svg` and the `-connected` variants, or it gets a generic icon. The connection form reads all of this from the registry, so it needs no change. TypeScript's exhaustive `switch` and the `Record<DbType, …>` flag anything missed.
4. Add a dialect to `splitSql` if its quoting or comments differ.
5. Add a test database to `docker-compose.yml` with a seed in `docker/seed/`, mirroring the existing `customers` / `orders` / `paid_orders` shape.
6. Update the README features and `CHANGELOG.md`.

## Commands and state

- Every command is registered in `extension.ts` and declared in `package.json` `contributes.commands`, with its menus and `when` clauses there (see `vscode-api.md`).
- Global, cross-workspace data → `context.globalState` (saved connections). Per-workspace → `context.workspaceState` (SQL file ↔ connection). Secrets → `context.secrets` only.
- Query history → `workspaceState` (`dbDeck.queryHistory`). Saved queries → files under `globalStorageUri/queries/`, with last-known connection names in `globalState` (`dbDeck.savedQueryConnections`). Settings → `dbDeck.*` in `contributes.configuration`, read with `workspace.getConfiguration()`. Other ways to find an editor's connection go through `QueryController.registerLinkResolver()`.
- Hidden table-view columns → `workspaceState` (`dbDeck.hiddenColumns`, keyed by connection and table).
- ER diagram layouts (positions, groups, table colors, view) → `globalState` (`dbDeck.diagramLayouts`, keyed by connection id + database + schema), never a project file; removed with Remove Connection.
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
