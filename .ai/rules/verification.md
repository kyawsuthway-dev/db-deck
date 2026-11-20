---
paths:
    - '**/*'
---

# Verification — what "done" means

There is no automated test suite yet. Adding one (e.g. `@vscode/test-electron`, or plain Node tests for drivers and `splitSql`) is welcome, but discuss the approach first.

## Every change

1. `task check` — type check plus a full build. Must pass. The pre-commit hook runs it too.
2. `task logs -- node` — the watcher's last build finished with no `✘ [ERROR]`. After an `esbuild.mjs` change, `task restart` first.

## Driver, `splitSql`, or value-conversion changes

Drivers don't import `vscode`, so smoke-test them in plain Node against the Docker databases:

- Write the script in a scratch directory **outside the repo** (e.g. `mktemp -d`) and mount it into a one-off container:
  ```bash
  docker compose run --rm -T -v "$SCRATCH":/scratch node sh -c \
    'npx esbuild /scratch/smoke.ts --bundle --platform=node --outfile=/tmp/smoke/smoke.js --external:pg-native \
     && cp node_modules/sql.js/dist/sql-wasm.wasm /tmp/smoke/ && node /tmp/smoke/smoke.js'
  ```
- Import from `/app/src/...`. Inside the container the databases are `postgres:5432` and `mysql:3306`, not `localhost`.
- Cover: `listTables`, `listColumns` (PK flags), `previewSql` + `query`, multi-statement runs including one that errors, and the specific case you changed. For SQLite use a throwaway file under `/tmp`.
- Seed data must end the test as it started: only no-op writes (`UPDATE orders SET status = status`) or writes to throwaway tables/files (`core.md` rule 9).

## Bundle loads

After adding or upgrading a dependency, run `task check:bundle` to check the bundle loads outside VS Code. It should print `[ 'activate', 'deactivate' ]`.

## UI changes

Check them in the Extension Development Host (F5). Coding agents that can't drive VS Code must finish with exact manual steps (what to click, what should appear) and say plainly which parts were verified and which weren't. Pull requests that change UI include a screenshot.
