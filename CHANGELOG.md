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
- Edit table data (tables with a primary key): edit cells, add and delete rows, set NULL. Changes stay pending until Save…, which shows a summary and Review SQL, then applies everything in one transaction on a separate connection, with a conflict check against the loaded values.
- Select cells, ranges and rows in the grid; Ctrl/Cmd+C copies them as tab-separated text, and the right-click menu copies with headers, as CSV or as JSON.
- New Query editor with Run Query (Ctrl/Cmd+Enter), multi-statement results grid.
- SQL editor: Ctrl/Cmd+Enter now runs the statement at the cursor when nothing is selected (it used to run the whole editor); **Run All** (Ctrl/Cmd+Shift+Enter, ▶ in the editor title) runs everything; a **▶ Run** link above each statement runs just that one.
- SQL editor autocomplete for tables, columns (including aliases) and keywords, once the connection is open.
- Format SQL with Format Document / Format Selection, in the connection's dialect (`sql-formatter`).
- Query History view: runs from SQL editors per workspace, grouped by day, with open, Run Again, Copy SQL, Delete, Search and Clear; setting `dbDeck.history.enabled`.
- Saved Queries view: Save Query… (editor title, right-click, view toolbar, or Ctrl/Cmd+S in a New Query editor) keeps a SQL editor's query as a `.sql` file under its connection; open, run, rename and delete from the view.
- Tree: schema/database folders (when there's more than one); functions, procedures and sequences; indexes and triggers under tables.
- Show DDL for every object; Generate SQL (SELECT, INSERT, UPDATE, DELETE) for tables, safe if run unedited; Copy Name / Copy Qualified Name.
- Find Object… searches objects in open connections and reveals the one you pick.
- Switch Database… for PostgreSQL and MySQL connections.
- DB Deck's Ctrl/Cmd+Enter and Ctrl/Cmd+Shift+Enter now apply only in SQL editors linked to a DB Deck connection, so other SQL extensions keep theirs.
- Contributor setup: `Taskfile.yml` (`task setup`), pre-commit check, `CONTRIBUTING.md`, shared rules in `.ai/rules/` and `AGENTS.md`.

## 0.0.1

- Project scaffold with Docker dev container and test databases.
