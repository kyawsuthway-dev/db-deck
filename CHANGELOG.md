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
- Value detail pane (Details / F4): the selected cell's full value, JSON indented without changing any value, Copy, and editing long values as pending changes in editable tables.
- Hide columns (header right-click or Columns…), remembered per table; copy and export leave them out.
- Count rows in table views (SELECT COUNT(*) with the WHERE filter).
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
- Add Connection and Edit Connection… open a connection form in an editor tab (database type chips with logos; name and folder; Connection, SSH Tunnel and Options tabs), replacing the step-by-step quick picks. Paste a connection string to fill in the fields. Save tests the connection first and offers Save Anyway; Test Connection only tests. When editing, empty password fields keep the stored passwords.
- SSH tunnel for PostgreSQL and MySQL connections: password or private key file (with an optional passphrase), secrets in SecretStorage, no local port opened. The SSH host's key is trusted on first use and checked on every later connection (`ssh2`).
- Connection folders (one level): Move to Folder… and Rename Folder….
- Connections for this workspace only ("Available in: This workspace" in the connection form), stored privately in VS Code's workspace storage.
- Connections from the project's `.env` (like DevDb): Laravel `DB_*` keys and `DATABASE_URL`, read live and shown in a `<folder> · .env` group; a `DB_HOST` that names a Docker Compose service (Laravel Sail's `pgsql`, `mysql`) connects to the port Docker publishes (`yaml`); databases only the compose file describes (postgres / mysql / mariadb images with a published port) appear in a `<folder> · docker-compose.yml` group, unless a `.env` connection already reaches them; Open Source File, Save as Connection…, Toggle Read-only; setting `dbDeck.envFiles`.
- The Connections view shows each database's logo, with a green dot on open connections.
- Read-only connections: the database session is read-only (PostgreSQL, MySQL; SQLite with `query_only` and no write-back), and table editing is off.
- DB Deck's Ctrl/Cmd+Enter and Ctrl/Cmd+Shift+Enter now apply only in SQL editors linked to a DB Deck connection, so other SQL extensions keep theirs.
- Fixed: MySQL `JSON` values are shown exactly as the server sends them. They used to be re-printed, which turned `1.0` into `1` and large integers into quoted strings or rounded numbers.
- Fixed: saving an edited `json` cell (MySQL `JSON`, PostgreSQL `json`) no longer fails. The conflict check compares the cell's text with the loaded text; `jsonb` keeps comparing values.
- Dump to SQL File (connection or table), in a form like the connection form: pick tables and views; structure and data, structure only, or data only. Restorable order per database (PostgreSQL foreign keys and sequence values after the data, MySQL and SQLite foreign-key checks off), generated columns left out, binary columns in full.
- Compare Structure (connection or schema): compare the tables of two schemas of the same database type (across connections too), tick what to sync (drops unticked), link renamed columns, see the SQL, Open in Editor or Apply on the target after checking it didn't change meanwhile; one transaction where the database allows. Server-generated index / FK / check names aren't counted as differences.
- PostgreSQL Design Table: `serial` columns show as Auto-increment (like identity columns) instead of a `nextval(…)` default; turning it off drops the default and keeps the sequence.
- MySQL Design Table: foreign keys of tables outside the connection's database now keep their database name.
- ER Diagram (connection, schema or Tables folder): tables as cards with column types, primary and foreign keys; curved lines with crow's-foot ends between the actual columns; automatic layout (dagre) on first open, then drag to arrange with positions saved per connection and schema; pan, zoom, Fit; highlight on hover / click; double-click for rows, right-click for Design Table and Show DDL; header colors per table (hover colors a table's lines with it); named, colored groups; Re-arrange with Undo; export as SVG or PNG (whole diagram or current view).
- Explain and Explain Analyze (SQL editor right-click, Explain CodeLens, Command Palette): the plan as a collapsible tree with cost / time bars, estimated vs actual rows, details and hints, plus the raw output with Copy. Explain Analyze only for read-only statements, in a read-only transaction rolled back on a separate connection (PostgreSQL, MySQL 8).
- Server panel (right-click a connection → Server…): Status, Processes (Refresh, Auto-refresh, Cancel Query / End Session with confirmation, off on read-only connections) and Settings with a filter.
- New Table (connection, schema or Tables folder): Table Designer form with columns, indexes, foreign keys, check constraints and comments, live SQL preview, Create Table in one transaction; the new table is shown in the tree.
- Design Table (alter an existing table) in the Table Designer: changes are detected (renames kept as renames), shown as SQL with data-loss warnings, and applied in one transaction after checking the table didn't change meanwhile. MySQL: a single ALTER TABLE; PostgreSQL: type changes with USING; SQLite: ALTER where possible, otherwise the documented rebuild keeping rows, indexes and triggers.
- Rename Table…, Truncate Table… and Drop… (tables and views): Truncate and Drop in a form that shows the row count, referencing tables and the SQL, and asks you to type the name to confirm. Never CASCADE.
- Import CSV (right-click a table, or a .csv / .tsv file in the Explorer), in a form: file check (rows, broken lines, UTF-8), delimiter (auto-detected), header row, empty fields as NULL (mirrors DB Deck's CSV export), a preview with a table column per CSV column (matched by name), optional "Delete existing rows first". One transaction with progress and Cancel; a failing row is reported by its CSV line and nothing is kept.
- Run SQL File (Explorer, SQL editor, Command Palette), in a form: pick the connection, see what will happen, then run; on its own connection in one transaction with progress and Cancel, rolls back on error and shows the failing line. Warns about MySQL's DDL commits; files with their own transactions run as written.
- Contributor setup: `Taskfile.yml` (`task setup`), pre-commit check, `CONTRIBUTING.md`, shared rules in `.ai/rules/` and `AGENTS.md`.

## 0.0.1

- Project scaffold with Docker dev container and test databases.
