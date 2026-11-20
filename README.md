# DB Deck

A free, open-source database explorer for VS Code. Browse local and remote databases and run SQL without leaving the editor.

**SQLite · PostgreSQL · MySQL · MariaDB**

> **Status:** early development. The first version (Phase 1) works; it isn't on the Marketplace yet.

## Features

- **Connections sidebar** — a database icon in the activity bar lists your saved connections. Add, remove, refresh, and disconnect.
- **Add Connection wizard** — pick a database type, then a file (SQLite) or host, port, user, password, and database. The connection is tested before it's saved.
- **Browse your schema** — Connection → Tables / Views → Columns, with each column's type and primary keys marked.
- **Click a table** to see its rows, 100 per page. Use **Previous** / **Next** to page through, and click a column header to sort (ascending, descending, then back to the default). Pages are ordered by primary key unless you sort.
- **Filter a table** — type a SQL condition in the **WHERE** box above the rows, such as `(id = 1) AND (name = 'Hotel')` or `total > 100 OR status IS NULL`, and press **Enter**. **Escape** or **✕** clears it. Paging and sorting keep the filter. As you type, the box suggests column names (with their types) and, after a column, operators. Use **↑**/**↓** and **Tab** or **Enter** to insert one, and **Ctrl+Space** to open the list on demand.
- **Run SQL** — **New Query** opens a SQL editor tied to a connection. Press **Ctrl+Enter** (**Cmd+Enter** on macOS), or click ▶, to run the selection, or the whole editor if nothing is selected. Several `;`-separated statements each get their own result. Click a column header to sort the loaded rows; your SQL isn't run again.
- **Pick the connection per editor** — the status bar shows which connection a SQL editor uses; click it to change. Saved `.sql` files remember their connection.
- **Export** — click **Export…** on a result and choose CSV, JSON, or SQL INSERT statements (table views only). For a table you can export the current page or all rows matching the WHERE filter, with progress and Cancel.
- **Copy** — click a cell, Shift+click or drag for a range, click row numbers for whole rows, or press **Ctrl+A** (**Cmd+A**) for everything. **Ctrl+C** (**Cmd+C**) copies tab-separated text that pastes into spreadsheets. Right-click for **Copy with Headers**, **Copy as CSV**, and **Copy as JSON**.
- **Works everywhere VS Code does** — no native modules, so it runs the same on Windows, macOS, Linux, WSL, and remote hosts.

## Install

The extension isn't published yet. To try it, build a `.vsix` (see [CONTRIBUTING.md](CONTRIBUTING.md)) with `task package`, then in VS Code run **Extensions: Install from VSIX…** and choose the file.

## Usage

1. Click the **database icon** in the activity bar, then **Add Connection**.
2. Choose the database type and fill in the details. If the test fails you can edit the settings or save anyway.
3. Expand the connection to browse tables, views, and columns. Click a table to see its rows.
4. Click the **New Query** icon on a connection, write SQL, and press **Ctrl+Enter** / **Cmd+Enter**.

| Command | Where |
| --- | --- |
| Add Connection | Connections view toolbar, Command Palette |
| New Query | Connections toolbar, connection or table (inline / right-click) |
| Show Rows | Click a table, or right-click it |
| Run Query | `Ctrl+Enter` / `Cmd+Enter` in a SQL editor, ▶ in the editor title |
| Select Connection for This Editor | Status bar, Command Palette |
| Refresh / Disconnect / Remove Connection | Right-click a connection |

All commands are in the Command Palette under **DB Deck**.

## Security and privacy

- Passwords are stored only in VS Code's **SecretStorage** (your OS keychain), never in settings files.
- Browsing and table previews only read. The extension writes to a database only when you run SQL that does.
- No telemetry. The extension only talks to the databases you configure.

## Good to know

- Results keep up to 10,000 rows per statement.
- **SQLite** runs in WebAssembly on an in-memory copy of the file. The file is reloaded when it changes on disk, and written back after each run that might change it. A transaction left open at the end of a run is not kept open.
- **PostgreSQL and MySQL** keep one connection open per saved connection, so `BEGIN` … `COMMIT` across several runs works.
- Encrypted connections: choose **SSL** (verifies the certificate) or **SSL, allow self-signed** in the wizard.
- MySQL `DELIMITER` scripts aren't supported yet.
- The **WHERE** filter is plain SQL for your database, with its own rules. For example, `LIKE` is case-sensitive in PostgreSQL (use `ILIKE`), but usually not in MySQL. It must be a single condition: anything after a `;` is rejected, not run.
- **Export and copy** write values exactly as shown. NULL is an empty field in CSV and copied text (an empty string is `""`), and `null` in JSON. JSON values stay text, so large numbers keep every digit. CSV files start with a UTF-8 byte order mark so Excel reads non-English text correctly.
  - Binary columns export as the shortened hex the grid shows, not the original bytes.
  - SQL INSERT statements for MySQL escape backslashes, which is wrong if the server runs with `NO_BACKSLASH_ESCAPES`.
  - Values starting with `=`, `+`, `-` or `@` are kept as they are. Be careful opening exports of untrusted data in a spreadsheet, which may treat them as formulas.
  - Exporting all rows of a table with no primary key and no sort may repeat or skip rows.

## Contributing

Contributions are welcome. You only need Docker, [Task](https://taskfile.dev) and VS Code — no local Node.js. See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up in one command (`task setup`).

## License

[MIT](LICENSE)
