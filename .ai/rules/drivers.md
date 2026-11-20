---
paths:
    - 'src/drivers/**'
    - 'src/query/**'
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

Current drivers: `sql.js` (SQLite, WebAssembly), `pg` (PostgreSQL), `mysql2` (MySQL/MariaDB).

## The `Driver` contract (`src/types.ts`)

- `connect()` throws with a readable message on failure. A connection test is `connect()` + `listTables()` (`ConnectionManager.test`).
- `query(sql)` splits with `splitSql(sql, dialect)` and runs statements through `runEach()` from `common.ts`, which times each statement, converts values with `toCell()`, caps rows at `MAX_ROWS`, and stops at the first error. Don't reimplement any of that per driver.
- `listTables()` returns `schema` only when the table is outside the connection's default schema/database; `previewSql()` and `listColumns()` must handle both cases.
- Errors: let them throw; callers format them with `errorMessage()`. Never put a password into an error.

## Connections

- One long-lived connection per saved connection (not a pool), so `BEGIN`…`COMMIT`, `SET`, and temp tables carry across runs.
- Reconnect lazily: on the client's `error`/`end` event, drop the reference so the next call opens a new one. Concurrent callers share one connect attempt (`connecting` promise).
- Connect timeout 10 s. SSL from `config.ssl` (`off` / `require` / `no-verify`).

## SQL safety

- Metadata queries (tables, columns) use **parameters** (`$1`, `?`) for any name or value. Never interpolate a table, schema, or user value into metadata SQL.
- Identifiers that must be in SQL text (previews) go through `quoteIdent()` with the dialect's quote character.
- Metadata and preview queries are read-only (`core.md` rule 4).

## Values

Drivers return values as the database's text representation (`core.md` rule 5):

- `pg`: custom type parsers return raw text (booleans become `true`/`false`); `rowMode: 'array'` keeps duplicate column names.
- `mysql2`: `dateStrings`, `supportBigNumbers`, `bigNumberStrings`, `rowsAsArray`.
- Binary → `0x…` hex (truncated); JSON objects → `JSON.stringify`. All in `toCell()`.

## SQLite (`sql.js`) specifics

- `sql.js` works on an in-memory copy of the file. The driver reloads when the file's mtime changes and writes back after any statement that might write (`mightWrite`). Keep both behaviors when changing it.
- A transaction left open at the end of a run is not preserved (writing back calls `db.export()`). Documented in the README; don't claim otherwise.
- `getRowsModified()` keeps the last DML count through DDL — report it only for INSERT/UPDATE/DELETE/REPLACE.
- Never truncate an existing file when "creating" a database.

## `splitSql`

Handles `'…'`, `"…"`, `` `…` ``, `--`, `/* */`, MySQL `#` comments and backslash escapes, PostgreSQL `$tag$…$tag$`, and SQLite trigger bodies (`BEGIN … END;`). Not handled: MySQL `DELIMITER`. When fixing a split bug, add the failing input to the smoke test (see `verification.md`) and check the other dialects still split as before.
