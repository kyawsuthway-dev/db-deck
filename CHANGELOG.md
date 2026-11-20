# Changelog

## Unreleased

- Connections sidebar with Add / Remove / Refresh / Disconnect.
- SQLite (sql.js), PostgreSQL (pg) and MySQL/MariaDB (mysql2) drivers.
- Add-connection wizard with a connection test; passwords stored in SecretStorage.
- Tree of tables, views and columns (type and primary key).
- Click a table to show its rows, 100 per page with Previous / Next, ordered by primary key by default.
- Click a column header to sort: table views sort in the database; query results sort the rows already loaded.
- Filter table views with a SQL condition in the WHERE box above the rows (Enter applies, Escape or ✕ clears). It works with paging and sorting, and only a single condition is accepted. Column names (with types) and operators are suggested as you type.
- Export a result as CSV, JSON or SQL INSERT statements; for table views, the current page or all matching rows (with progress and Cancel).
- Select cells, ranges and rows in the grid; Ctrl/Cmd+C copies them as tab-separated text, and the right-click menu copies with headers, as CSV or as JSON.
- New Query editor with Run Query (Ctrl/Cmd+Enter), multi-statement results grid.
- Contributor setup: `Taskfile.yml` (`task setup`), pre-commit check, `CONTRIBUTING.md`, shared rules in `.ai/rules/` and `AGENTS.md`.

## 0.0.1

- Project scaffold with Docker dev container and test databases.
