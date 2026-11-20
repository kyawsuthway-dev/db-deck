---
paths:
    - '**/*'
---

# Debugging Discipline

## Rule

Gather evidence before changing code. One measurement beats ten guesses. If a fix doesn't produce the expected measurement, **revert it before trying the next hypothesis** — never stack guesses.

## Iteration loop

1. **Measure.** Never hypothesize in the void.
2. **Form ONE hypothesis** consistent with the evidence.
3. **Make ONE minimal change.**
4. **Verify with a fresh measurement.**
5. If not fixed → **revert the change**, return to step 1.

## What counts as "measurement"

| Domain                        | Evidence source                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Build                         | `task logs -- node`, `task typecheck`                                                                                   |
| Extension runtime error       | Debug Console of the window that pressed F5; Output → "Extension Host" in the dev window. Ask the user to paste it.              |
| Command / menu not showing    | `package.json` `contributes` + `when` clause vs the item's `contextValue`; Developer: Inspect Context Keys in the dev window       |
| Results webview               | Developer: Open Webview Developer Tools in the dev window (console errors, CSP violations, DOM)                                   |
| Driver / SQL behavior         | A plain-Node smoke script against the Docker DBs (`verification.md`) — reproduces without VS Code                                 |
| Database state                | `task psql`, `task mysql` (read-only queries)                                                                                      |
| Container / permissions       | `docker compose ps -a`, `docker compose logs <service>`, `id`, `stat -c '%u:%g' <path>`                                           |

If you don't know what to measure, stop and ask.

## Red flags (you're guessing, not debugging)

- "Let me also try X" while a previous attempt is still in the code.
- Assuming the build is stale instead of checking the watcher output and `dist/` timestamps.
- Changing a driver to fix what may be a tree or webview bug (or the reverse) before finding which layer is wrong.

## Cross-boundary bugs — measure at every boundary first

Data flows **database → driver (`RawResult`) → `runEach`/`toCell` (`StatementResult`) → `ResultsPanel.postMessage` → webview render**. Before diagnosing any layer's internals, find which layer first shows the wrong value: run the driver alone in Node, then check the posted message in the webview devtools.

## When the first fix fails

1. Stop adding fixes.
2. Read the diff — confirm the change is what you think it is.
3. Take a fresh measurement. Nothing moved → the fix isn't reaching the runtime (watcher not rebuilding, dev window not reloaded with `Ctrl+R`, `package.json` change needing a debug restart). Investigate delivery before another fix.
