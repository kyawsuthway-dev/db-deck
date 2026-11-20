# Changelog

## Unreleased

- Connections sidebar with Add / Remove / Refresh / Disconnect.
- SQLite (sql.js), PostgreSQL (pg) and MySQL/MariaDB (mysql2) drivers.
- Add-connection wizard with a connection test; passwords stored in SecretStorage.
- Tree of tables, views and columns (type and primary key).
- Click a table to show its rows, 100 per page with Previous / Next, ordered by primary key by default.
- Click a column header to sort: table views sort in the database; query results sort the rows already loaded.
- New Query editor with Run Query (Ctrl/Cmd+Enter), multi-statement results grid.
- Contributor setup: `Taskfile.yml` (`task setup`), pre-commit check, `CONTRIBUTING.md`, shared rules in `.ai/rules/` and `AGENTS.md`.

## 0.0.1

- Project scaffold with Docker dev container and test databases.
