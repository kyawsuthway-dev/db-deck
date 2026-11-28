# Contributing to DB Deck

Thanks for helping! Bug reports, feature ideas, and pull requests are all welcome. For anything bigger than a small fix, please open an issue first so we can agree on the approach before you spend time on it.

## What you need

- **Docker** (Docker Desktop on macOS/Windows, or Docker Engine on Linux)
- **[Task](https://taskfile.dev/installation/)** — a small command runner (`brew install go-task`, `snap install task --classic`, …)
- **VS Code**
- **Windows:** use WSL2 and keep the project inside the WSL filesystem (e.g. `~/code`, not `/mnt/c`). Open it with the WSL extension.

You do **not** need Node.js. Node, npm and TypeScript run inside a Docker container, so everyone builds with the same versions and nothing native from your OS ends up in `node_modules`. Please don't run `npm` on your host.

## First-time setup

```bash
git clone https://github.com/kyawsuthway-dev/db-deck.git
cd db-deck
task setup
```

`task setup`:

1. writes `.env` with your user and group ids, so files the container creates belong to you;
2. runs `npm install` in the container;
3. starts the watch build, two test databases (PostgreSQL 16 and MySQL 8.4, seeded from `docker/seed/`) and a test SSH server;
4. enables the pre-commit hook and links `.claude/rules` to `.ai/rules` (for Claude Code users; harmless otherwise).

Then open the folder in VS Code and press **F5**. A second window, the **Extension Development Host**, opens with the extension loaded. Click the database icon in the activity bar.

## Everyday commands

| Command | What it does |
| --- | --- |
| `task` | List all tasks |
| `task up` / `task down` | Start / stop the watch build, test databases and test SSH server |
| `task logs -- node` | Follow build output (`[watch] build finished`, errors) |
| `task check` | Type check and build — run before committing (the hook does) |
| `task npm -- install <pkg>` | Run npm in the container |
| `task restart` | Restart the watcher — needed after editing `esbuild.mjs` |
| `task psql` / `task mysql` / `task mssql` | Open a SQL shell on a test database |
| `task up:sqlserver` | Also start the SQL Server test database (opt-in: about 2 GB of RAM, x86-64 only) |
| `task db:reset` | Delete and reseed the test databases |
| `task package` | Build a production `.vsix`; try it with **Extensions: Install from VSIX…** in a normal VS Code window |
| `task notices` | Rewrite `THIRD_PARTY_NOTICES.md` from the packages actually bundled — run after adding or upgrading a runtime dependency, and commit the file |

The watcher rebuilds on save. Press `Ctrl+R` (`Cmd+R`) in the Extension Development Host to reload it. If you change `contributes` in `package.json`, stop and restart the debug session (F5).

### Test databases

| Database | Host (from VS Code) | User | Password | Database |
| --- | --- | --- | --- | --- |
| PostgreSQL 16 | `localhost:5432` | `postgres` | `postgres` | `sample` |
| MySQL 8.4 | `localhost:3306` | `root` | `mysql` | `sample` |
| SQL Server 2022 (`task up:sqlserver`) | `localhost:1433` | `sa` | `DbDeck-sa-2026` | `sample` |

All contain `customers` and `orders` tables and a `paid_orders` view. SQL Server's also has `value_types`, with values a driver easily gets wrong (large decimals, money, `datetime2(7)`, `datetimeoffset`). Its certificate is self-signed: use **Trust Server Certificate** when the connection form offers it.

To try the SSH tunnel, edit a PostgreSQL or MySQL connection and set **SSH Tunnel** to host `localhost`, port `2222`, user `dbdeck`, password `dbdeck`. The database host is then as seen from the SSH server: `postgres` port `5432`, `mysql` port `3306`, or `sqlserver` port `1433`. The SSH server makes new host keys whenever its container is recreated, so DB Deck then asks you to trust the new key. If a port is already taken on your machine, change the left side of its `ports` entry in `docker-compose.yml` (don't commit that change).

## Project rules

The rules every change must follow live in [`.ai/rules/`](.ai/rules/), starting with [`core.md`](.ai/rules/core.md). The short version:

- **No native modules** — runtime dependencies must be pure JavaScript or WebAssembly.
- **Passwords only in VS Code's SecretStorage**, never in settings, logs, or messages.
- **The results webview never renders data as HTML.**
- **The extension never writes to a user's database on its own.**
- **Values are shown exactly as the database returns them.**
- **No telemetry.** MIT-compatible dependencies only.

[`index.md`](.ai/rules/index.md) lists which rule file covers which part of the code: architecture, drivers, webview, VS Code API, verification, debugging, and git workflow. They're written to be useful for humans and for coding agents alike; [`AGENTS.md`](AGENTS.md) is the entry point for agents.

## Code layout

```
src/
  extension.ts           activation and command registration
  types.ts               shared types, including the Driver interface
  connectionManager.ts   saved connections, passwords, open drivers
  connectionFolders.ts   Move to Folder… / Rename Folder… quick picks
  connectionForm/        the connection form's field checks (no vscode)
  ssh/                   the SSH tunnel (ssh2)
  env/                   connections from the project's .env and compose files
  shared/                code used by both the extension and the webviews
  drivers/               one file per database + index.ts registry
  query/                 statement splitting, running queries from SQL editors
  tree/                  the Connections sidebar
  views/                 the Results panel and the connection form (extension side)
  webview/               the Results grid and the connection form (browser side)
```

Adding a database? Follow the checklist in [`.ai/rules/architecture.md`](.ai/rules/architecture.md#adding-a-database).

## Branches, commits and pull requests

- Branch from `main`: `feature/…`, `bugfix/…`, `change/…`, `refactor/…`, `maintenance/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(tree): show primary key icon`, `fix(sqlite): …`.
- In the pull request, explain what changed, why, and how you tested it. Include a screenshot for UI changes. Add user-visible changes to `CHANGELOG.md` under `## Unreleased`.

Details: [`.ai/rules/git-workflow.md`](.ai/rules/git-workflow.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
