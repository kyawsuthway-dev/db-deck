---
paths:
    - '**/*'
---

# Git workflow — branches, PRs, commit messages

## Branches

- **`main`** — always releasable. Protected once the repo is on GitHub. Nothing is committed to it directly — everything arrives via pull request.

Branch from `main`, open a pull request back into `main`:

```
<type>/<kebab-case-description>
```

Types: `feature`, `bugfix`, `change`, `refactor`, `maintenance`.

- `feature/table-filter`
- `bugfix/sqlite-trigger-split`
- `maintenance/update-packages`

Pick the type by intent: `feature` adds capability, `bugfix` corrects broken behavior, `change` alters existing behavior that isn't a bug, `refactor` changes structure with no behavior change, `maintenance` is upkeep (dependencies, tooling, cleanup).

## Commit messages: Conventional Commits

```
<type>[optional scope]: <description>
```

Types: `feat`, `fix`, `change`, `refactor`, `chore`, `docs`, `test`, `perf`, `style`, `build`, `ci`. Scopes: `drivers`, `sqlite`, `postgres`, `mysql`, `tree`, `query`, `results`, `connections`, `transfer`, `design`, `tools`, `docker`, `build`.

```
feat(tree): show primary key icon on columns
fix(sqlite): don't report affected rows for DDL
chore: update pg to 8.24
```

The commit type describes the change itself, not the branch prefix.

## Before committing

- `task check` passes (`verification.md`). `task setup` installs a pre-commit hook that runs it; use `git commit --no-verify` only in an emergency, and say so in the pull request.
- User-visible changes are in `CHANGELOG.md` under `## Unreleased`, and in the README's Features section if relevant.
- Never commit `.env`, `node_modules/`, `dist/`, `*.vsix`, or personal agent files (`CLAUDE.md`, `.claude/`).

## Pull requests

- One topic per pull request. Describe what changed, why, and how you verified it (`verification.md`); include a screenshot for UI changes.
- Agents: never push, open pull requests, or merge without the maintainer asking.

## Releases

Version bumps (`package.json` `version`, `CHANGELOG.md` heading) follow semver and happen in their own `chore: release vX.Y.Z` commit. Tagging, `vsce publish`, and GitHub releases happen only when the maintainer asks. Coding agents never push, tag, or publish on their own.

## Related rules

- `verification.md` — what to run before committing
