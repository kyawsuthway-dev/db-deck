# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Copilot, …) working on DB Deck. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md) — this file assumes it.

## What this is

A free, open-source (MIT) VS Code extension for browsing SQLite, PostgreSQL, MySQL and MariaDB databases and running SQL inside VS Code. TypeScript (strict), bundled with esbuild. Drivers: `sql.js` (WebAssembly), `pg`, `mysql2`. The results grid is a plain TypeScript webview.

## Read first

1. [`.ai/rules/core.md`](.ai/rules/core.md) — hard constraints. Every change must respect them.
2. [`.ai/rules/index.md`](.ai/rules/index.md) — which rule file applies to which paths. Read the matching rules before editing a file.

## Environment

- **Never run `node`, `npm`, `npx`, or `tsc` on the host.** Everything runs in the Docker Compose `node` service, through [Task](https://taskfile.dev): `task --list` shows every command.
- `task up` starts the watch build and the test databases. `task check` type checks and builds. `task npm -- <args>` runs npm in the container.
- Test databases: PostgreSQL at `localhost:5432` (from the container: `postgres:5432`), user `postgres`/`postgres`; MySQL at `localhost:3306` (container: `mysql:3306`), user `root`/`mysql`; both with database `sample`.
- The extension itself runs in the Extension Development Host (F5 in VS Code). If you can't drive VS Code, give the person exact manual steps to check UI changes, and say what you did and didn't verify.

## Working rules

- Follow existing patterns: find a sibling of what you're adding (driver, command, tree node, webview message) and match it.
- Database-specific code lives in `src/drivers/`. Don't branch on database type elsewhere.
- Ask before adding a dependency, changing the build, or introducing a framework.
- Never run destructive SQL or delete Docker volumes without explicit approval.
- Never push, open pull requests, tag, or publish unless asked.
- Before finishing: `task check` passes, `CHANGELOG.md` (`## Unreleased`) lists user-visible changes, and anything you verified or couldn't verify is stated plainly.
- If a rule in `.ai/rules/` turns out to be missing or wrong, point it out and propose the exact change rather than silently working around it.
