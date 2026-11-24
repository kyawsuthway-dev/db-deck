---
paths:
    - 'src/drivers/**'
    - 'src/query/**'
    - 'src/ssh/**'
    - 'package.json'
    - 'esbuild.mjs'
---

# Drivers — database access

## Dependencies: no native modules

`node_modules` is built in Linux Docker; the extension runs in VS Code's Node on Windows, macOS, and Linux. A native addon (`.node` file, `node-gyp`, `prebuild`) would load on one platform and crash on the others.

Before adding a runtime dependency, check and report to the user:

- No `binding.gyp`, `.node` files, or `install`/`postinstall` scripts that compile anything (`npm view <pkg> scripts`, look in `node_modules/<pkg>`).
- It bundles with esbuild. If it lazily requires an optional native or platform module, mark that module `external` in `esbuild.mjs` with a comment saying why (as with `pg-native` and `cloudflare:sockets`).
- Files it loads at runtime (like `sql-wasm.wasm`) are copied into `dist/` by `esbuild.mjs`; `.vscodeignore` excludes `node_modules/`.
- License is MIT-compatible.

Current drivers: `sql.js` (SQLite, WebAssembly), `pg` (PostgreSQL), `mysql2` (MySQL/MariaDB). SSH tunnels: `ssh2`; its optional native parts (`sshcrypto.node`, `cpu-features`) are `external` in `esbuild.mjs`, so it uses its pure-JavaScript crypto. Compose files: `yaml` (pure JavaScript). ER diagram layout: `@dagrejs/dagre` (pure JavaScript, MIT), bundled into the diagram webview only, never the extension.

## The `Driver` contract (`src/types.ts`)

- `connect()` throws with a readable message on failure. A connection test is `connect()` + `listTables()` (`ConnectionManager.test`).
- `query(sql)` splits with `splitSql(sql, dialect)` and runs statements through `runEach()` from `common.ts`, which times each statement, converts values with `toCell()`, caps rows at `MAX_ROWS`, and stops at the first error. Don't reimplement any of that per driver.
- `listTables()` returns `schema` only when the table is outside the connection's default schema/database; `previewSql()` and `listColumns()` must handle both cases.
- `selectPage(table, page, where?)` runs one table-view page as a single statement through `runEach`. It's read-only; SQLite must not write the file back. `previewSql()` builds the same SQL as text, without a filter, for opening in an editor.
- `filterIdentifier(name)` returns a column name as it should be typed in that database — bare when safe, quoted otherwise (use `identifierFor()` with the database's safe pattern; PostgreSQL's excludes uppercase). `filterOperators()` returns `FILTER_OPERATORS`, plus any operators only that database has.
- `countRows(table, where)` is read-only, uses `buildCountQuery` and the same `filterCondition` guard as `selectPage`, and returns the count as text.
- `listObjects` / `listIndexes` / `listTriggers` / `objectDdl` / `listDatabases` / `defaultSchemaLabel` are read-only catalog queries with parameters; identifiers in `SHOW CREATE` / `PRAGMA` text go through `quoteIdent()`. PostgreSQL table and sequence DDL is rebuilt from the catalog and says so; all other DDL comes from the database itself. Shown DDL is never run by DB Deck.
- `dumpPlan` / `dumpRows` are read-only and build a dump in restorable order per database (PostgreSQL: foreign keys and indexes after the data, sequences set with `setval`, `OVERRIDING SYSTEM VALUE` for identity; MySQL and SQLite: foreign-key checks off or deferred). Rows are read with `toDumpCell`, so binary values stay complete (`{ hex }`), and generated columns are left out. In MySQL match them with `/\b(VIRTUAL|STORED) GENERATED\b/`: `EXTRA` is also `DEFAULT_GENERATED` for `DEFAULT CURRENT_TIMESTAMP`, which must stay in.
- `runScript` runs on its own short-lived connection like `applyChanges` (SQLite: a separate copy, written to the file once), through `runScriptStatements` in `common.ts`, and throws `ScriptError` (with the statement index) or `ScriptCancelled`.
- `importRows` runs on its own short-lived connection in one transaction through `importRowsWith`: a savepoint per batch, a row-by-row retry when a batch fails so `ImportError` names the file line, parameters only (MySQL `conn.execute`), batch sizes from the database's parameter limit (`importBatchRows`). `deleteFirst` is a `DELETE` in the same transaction, never `TRUNCATE`.
- Table DDL is built by `createTableStatements` in `drivers/ddl.ts` from a `TableDesign`, with the driver's `DdlDialect` (quoting, auto-increment form, comment style). `createTableSql`, `renameTableSql`, `truncateTableSql` (SQLite: `DELETE FROM`) and `dropSql` (never `CASCADE`) only build SQL, so the designer previews them with an unconnected driver; they run through `runScript`. `referencingTables` is read-only. User-typed fragments (types, defaults, CHECK conditions) must pass `checkDesign` (`singleFragment`: no `;` outside quotes) before they're built into SQL.
- `readDesign` must read the same unchanged table identically every time: Design Table's and Compare Structure's Apply compare a fresh read with the earlier one (`JSON.stringify`) and refuse on any difference. `refSchema` is left out only for the connection's own default schema / database (PostgreSQL `public`, MySQL `config.database`), never for "the table's own schema". PostgreSQL `serial` columns (a nextval() default of a sequence the column owns) read as `autoIncrement` with no default and `ownedSequence: true` (server-kept through `withServerFields`), so they equal identity columns; `alterTableSql` turns them off with `DROP DEFAULT`.
- `listSchemas()` is read-only: schemas Compare Structure can pick, empty ones included (PostgreSQL user schemas; MySQL the connection's database, or every non-system one; SQLite none).
- `readDesign` is read-only and fills the same `TableDesign` the designer creates; parts it can't show (expression or partial indexes, SQLite triggers) go to `preserved`, untouched by the designer. PostgreSQL lists come back as `json_agg(...)::text` and are parsed: DB Deck's pg type parsers return every value as text, so `array_agg` would give `{a,b}`.
- `alterTableSql` only builds SQL from `diffDesign`'s changes: PostgreSQL type changes use `USING col::type`; MySQL writes one `ALTER TABLE` (all or nothing, despite its per-statement commits); SQLite uses direct `ALTER TABLE` where it can, otherwise the documented rebuild (copy into a new table, drop, rename, recreate indexes, `preserved` indexes and triggers), and refuses tables with generated columns.
- `listColumns` also reports `hasDefault` (default, identity, auto-increment) and `generated`, which Import CSV uses to offer targets and warn about required columns.
- `schemaDiagram(schema?)` is read-only and reads a whole schema in a few catalog queries (never `readDesign` per table): base tables only, columns with type, nullability and primary key, unique keys on plain columns, and foreign keys with `refSchema` set only for another schema. Rows go through `assembleDiagram` in `common.ts`. SQLite numbers its unnamed foreign keys and resolves `REFERENCES parent` without columns to the parent's primary key.
- `explain(sql, analyze)` returns a `PlanNode` tree (parsed in `tools/plan.ts`) and the raw output. Plain Explain runs on the editor's connection and never executes the statement; Analyze runs on its own short-lived connection inside `BEGIN READ ONLY` / `START TRANSACTION READ ONLY`, always rolled back, and throws where the database has none (SQLite, MariaDB). `serverStatus`, `serverSettings` and `listProcesses` are read-only; `listProcesses` marks DB Deck's own sessions (`own`). `endProcess` checks the id is digits and uses the database's own cancel / kill (`pg_cancel_backend` / `pg_terminate_backend`, `KILL QUERY` / `KILL`).
- Errors: let them throw; callers format them with `errorMessage()`. Never put a password into an error.

## Connections

- One long-lived connection per saved connection (not a pool), so `BEGIN`…`COMMIT`, `SET`, and temp tables carry across runs.
- Exception: `applyChanges()` (table-view edits) opens its own short-lived connection (SQLite: a separate in-memory copy) so its `BEGIN … COMMIT` never mixes with a transaction the user left open in the query editor. Close it in `finally`. MySQL edit connections set `FOUND_ROWS` so affected counts mean rows matched.
- Reconnect lazily: on the client's `error`/`end` event, drop the reference so the next call opens a new one. Concurrent callers share one connect attempt (`connecting` promise).
- Connect timeout 10 s. SSL from `config.ssl` (`off` / `require` / `no-verify`).
- SSH tunnel: when `createDriver` gets a `StreamOpener`, every connection the driver opens (including the edit connection) uses it instead of TCP. Pass the real `host` anyway, so TLS checks the certificate against it.
- `config.readOnly`: PostgreSQL startup option `-c default_transaction_read_only=on`; MySQL `SET SESSION TRANSACTION READ ONLY` right after connecting; SQLite `PRAGMA query_only = ON`, no write-back, and `applyChanges` refuses. Applies to every connection, including the edit one. A guard against mistakes, not a security boundary (README).

## SQL safety

- Metadata queries (tables, columns) use **parameters** (`$1`, `?`) for any name or value. Never interpolate a table, schema, or user value into metadata SQL.
- Identifiers that must be in SQL text (previews) go through `quoteIdent()` with the dialect's quote character.
- Metadata and preview queries are read-only (`core.md` rule 4).
- The table-view filter (`where`) is SQL the user typed. Pass it through `filterCondition()` (rejects a second statement) and `buildPageQuery()` (wraps it in `(\n…\n)` so a `--` comment can't remove ORDER BY/LIMIT). Never add it to SQL any other way.
- Table edits are parameterized statements from `buildChangeStatements()`. UPDATE and DELETE match the primary key (`=`) and the original values of the edited cells (null-safe); any statement not affecting exactly one row rolls back the whole save. Columns of a type with no equality against text (`json`; see `isTextComparedType`) are checked by their text through `WriteDialect.asText()`. A statement's `display` text has literals for Review SQL only and is never executed.
- MySQL: run parameterized SQL with `conn.execute()`, not `conn.query(sql, values)` — the latter substitutes `?` on the client and doesn't skip quoted identifiers.

## Values

Drivers return values as the database's text representation (`core.md` rule 5):

- `pg`: custom type parsers return raw text (booleans become `true`/`false`); `rowMode: 'array'` keeps duplicate column names.
- `mysql2`: `dateStrings`, `supportBigNumbers`, `bigNumberStrings`, `jsonStrings`, `rowsAsArray`.
- Binary → `0x…` hex (truncated); JSON objects → `JSON.stringify`. All in `toCell()`.

## SQLite (`sql.js`) specifics

- `sql.js` works on an in-memory copy of the file. The driver reloads when the file's mtime changes and writes back after any statement that might write (`mightWrite`). Keep both behaviors when changing it.
- A transaction left open at the end of a run is not preserved (writing back calls `db.export()`). Documented in the README; don't claim otherwise.
- `getRowsModified()` keeps the last DML count through DDL — report it only for INSERT/UPDATE/DELETE/REPLACE.
- Never truncate an existing file when "creating" a database.

## `splitSql`

Handles `'…'`, `"…"`, `` `…` ``, `--`, `/* */`, MySQL `#` comments and backslash escapes, PostgreSQL `$tag$…$tag$`, and SQLite trigger bodies (`BEGIN … END;`). Not handled: MySQL `DELIMITER`. When fixing a split bug, add the failing input to the smoke test (see `verification.md`) and check the other dialects still split as before.
