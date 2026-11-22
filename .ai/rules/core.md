---
paths:
    - '**/*'
---

# Core rules — apply to every change

These are the project's hard constraints. A change that breaks one is not merged, however useful it is.

1. **No native modules.** `node_modules` is installed in Linux Docker, but the extension runs in VS Code's own Node on Windows, macOS, and Linux. Every runtime dependency must be pure JavaScript or WebAssembly (e.g. `sql.js`, not `better-sqlite3`). See `drivers.md` for the checklist.
2. **Passwords live only in VS Code's SecretStorage.** Saved connections (`globalState`, `workspaceState`) never contain a password. Passwords from a project's `.env` or compose file are read when connecting and kept only in memory. Never log, display, or put a password in an error message or result.
3. **The webview never renders data as HTML.** Strict CSP, no inline script or style, values inserted with `textContent` only. See `webview.md`.
4. **The extension never changes a user's database on its own.** Only SQL the user typed and ran, or an action they explicitly confirmed, may write. Browsing, previews, and metadata queries are read-only. Table edits count as confirmed only when the user clicks **Apply** in the save confirmation; pending edits never write. A read-only connection never offers or applies table edits, and the extension checks that itself, not only the grid.
5. **Show values faithfully.** Don't convert database values in ways that lose precision or change them (big integers, decimals, timestamps). Drivers return text as the database sends it.
6. **No telemetry, no network calls** other than to the databases the user configured.
7. **Dependencies must be MIT-compatible** (MIT, BSD, ISC, Apache-2.0), and new ones are discussed in the issue or pull request first.
8. **Don't run Node on the host.** All `npm`/`node`/`tsc` commands run in the Docker `node` service (`task npm -- …`). Installing on the host would put host-platform files into the shared `node_modules`.
9. **Never run destructive commands against databases without the maintainer's approval** — `DROP`, `TRUNCATE`, mass `DELETE`/`UPDATE`, `task db:reset`, `docker compose down -v` — not even against the Docker test databases.

## Design for extension

When behavior branches on a finite set (database type, SSL mode, tree node kind), put the branch in one place — the driver registry in `src/drivers/index.ts`, a `Driver` method, a `switch` over a union type — so a new case opts in without hunting down call sites. Heavier abstractions (a new interface, a framework, a UI library) need a trade-off discussion first.

## Follow existing patterns

Before adding something new, find an existing example of the same kind (a driver, a command, a tree node, a webview message) and follow its structure and naming. If there's no precedent, ask in the issue or pull request.
