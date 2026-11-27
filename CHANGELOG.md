# Changelog

## Unreleased

### Changed

- Queries that return more than 10,000 rows no longer hold every row in memory (PostgreSQL, MySQL, MariaDB): a 1,000,000-row result now uses about 17 MB instead of about 190 MB. The grid still shows the first 10,000 rows with the truncated note.

## 0.1.0 — 2026-11-26

The first public version: a database client for SQLite, PostgreSQL, MySQL and MariaDB (`sql.js`, `pg`, `mysql2`; no native modules).

### Connections

- Connections sidebar with database logos (a green dot while connected), Refresh, Disconnect, Remove, and one-level folders (Move to Folder…, Rename Folder…).
- Connection form in an editor tab (Add Connection, Edit Connection…): database type, name and folder; Connection, SSH Tunnel and Options tabs; paste a connection string to fill in the fields. Save tests the connection first and offers Save Anyway. Passwords are stored in SecretStorage and never sent back to the form.
- SSH tunnel for PostgreSQL and MySQL (`ssh2`): password or private key file with an optional passphrase, no local port opened, host key trusted on first use and checked afterwards.
- Read-only connections: a read-only database session (SQLite with `query_only` and no write-back), and no editing or writing forms.
- Connections for this workspace only, stored privately in VS Code's workspace storage.
- Connections from the project's `.env`: Laravel `DB_*` keys, `DB_URL` and `DATABASE_URL`, read live; a `DB_HOST` that names a Docker Compose service connects to the port Docker publishes (`yaml`), and compose-only database services are listed too. Open Source File, Save as Connection…, Toggle Read-only; setting `dbDeck.envFiles`.
- Switch Database… for PostgreSQL and MySQL connections.

### Browsing

- Tree of schemas (when there's more than one), tables, views, functions, procedures and sequences; tables expand to columns (type, primary key), indexes and triggers.
- Show DDL for every object (PostgreSQL tables and sequences rebuilt from the catalog); Generate SQL (SELECT, INSERT, UPDATE, DELETE), safe if run unedited; Copy Name / Copy Qualified Name.
- Find Object… searches the open connections and reveals the object in the tree.

### Table data

- Table rows 100 per page with Previous / Next, ordered by primary key; click a header to sort in the database. Query results sort the loaded rows.
- WHERE filter above table rows: one SQL condition, with column and operator suggestions as you type.
- Count rows with the filter (`SELECT COUNT(*)`).
- Edit tables with a primary key: cells, new and deleted rows, Set to NULL. Save… confirms in the grid (with Review SQL) and applies everything in one transaction on a separate connection, refusing if any row changed since it was loaded (`json` cells compared by their text).
- Value detail pane (Details / F4): the full value, JSON indented without changing any value, Copy, and editing long values as pending changes.
- Hide columns (remembered per table); copy and export leave them out.
- Select cells, ranges and rows; copy as tab-separated text, with headers, as CSV or as JSON.
- Export a result as CSV, JSON or SQL INSERT; for tables, the current page or all matching rows, with progress and Cancel.
- Values are shown exactly as the database sends them, including MySQL `JSON` and large numbers.

### SQL editor

- New Query editor linked to a connection (status bar to change it). Ctrl/Cmd+Enter runs the selection or the statement at the cursor, ▶ Run above each statement runs that one, Run All (Ctrl/Cmd+Shift+Enter) runs everything; each statement gets its own result. The shortcuts apply only in editors linked to DB Deck, so other SQL extensions keep theirs.
- Autocomplete for tables, columns (including aliases) and keywords, once the connection is open.
- Format SQL in the connection's dialect (`sql-formatter`).
- Query History view (per workspace, grouped by day; Run Again, Copy SQL, Delete, Search, Clear; setting `dbDeck.history.enabled`).
- Saved Queries view: Save Query… keeps a query as a `.sql` file under its connection; open, run, rename, delete.

### Table design

- New Table and Design Table in the Table Designer: columns, indexes, foreign keys, checks and comments, with live SQL and data-loss warnings. Design Table keeps renames as renames and applies in one transaction after checking the table didn't change (MySQL: one ALTER TABLE; PostgreSQL: type changes with USING; SQLite: ALTER where possible, otherwise a rebuild keeping rows, indexes and triggers). PostgreSQL `serial` columns show as auto-increment.
- Rename Table…, Truncate Table… and Drop…: Truncate and Drop show the row count, referencing tables and the SQL, and ask you to type the name. Never CASCADE.

### Data transfer

- Dump to SQL File (connection or table): tables and views, structure and / or data, in a restorable order per database, binary columns in full.
- Run SQL File (Explorer, SQL editor, Command Palette): see what will happen, then run on its own connection in one transaction with progress and Cancel; a failure rolls back and shows the line. Warns about MySQL's DDL commits.
- Import CSV (table or Explorer): UTF-8 check, delimiter detection, header row, empty fields as NULL, preview with column mapping, optional Delete existing rows first; one transaction, a failing row named by its CSV line.

### Tools

- ER Diagram (connection, schema or Tables folder): table cards with curved crow's-foot lines between the actual columns, automatic layout (`@dagrejs/dagre`) then drag with saved positions, pan / zoom / Fit, highlight, header colors, named groups, Re-arrange with Undo, export as SVG or PNG.
- Compare Structure (connection or schema): compare two schemas of the same database type, tick what to sync (drops unticked), link renamed columns, see the SQL, Open in Editor or Apply on the target after a re-check. Server-generated index / FK / check names aren't differences. MySQL CHECK constraints with text values and foreign keys to other databases are read as valid SQL.
- Generate Mock Data (table): a generator per column picked from its name and type, foreign keys from existing parent rows, unique columns kept unique against existing rows, a seed and an exact preview; up to 10,000 rows in one transaction.
- Explain and Explain Analyze: the plan as a tree with cost / time bars, estimates and hints, plus the raw output. Analyze only for reading statements, in a rolled-back read-only transaction (PostgreSQL, MySQL 8).
- Server panel: Status, Processes (Cancel Query / End Session with confirmation, off on read-only connections) and Settings.

### Project

- Contributor setup: Docker and Task (`task setup`), pre-commit check, `CONTRIBUTING.md`, shared rules in `.ai/rules/` and `AGENTS.md`.
- Extension icon, Marketplace metadata, and `THIRD_PARTY_NOTICES.md` (`task notices`).

## 0.0.1

- Project scaffold with Docker dev container and test databases.
