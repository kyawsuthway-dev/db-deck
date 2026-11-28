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

Version bumps (`package.json` `version`, `CHANGELOG.md` heading) follow semver and happen in their own `chore: release vX.Y.Z` commit. Tagging, GitHub releases, and publishing happen only when the maintainer asks. Coding agents never push, tag, create a GitHub release, or publish on their own: publishing a GitHub release publishes to the Marketplace.

Before a release:

- `task notices` if dependencies changed since the last release, and commit `THIRD_PARTY_NOTICES.md`.
- `npx vsce ls` (in the container) lists only runtime files: `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `dist/**` without maps, `media/icon.png`, `media/database.svg`, `media/logos/*.svg`, `media/icons/*.svg`. If `vsce` fails with a missing module, reinstall with `task npm -- ci`.
- `task package` builds the `.vsix` without warnings, and it's installed and tried in a normal VS Code window (connect, browse, run a query, open a form and the ER diagram).
- README images are PNG in `media/screenshots/` (the Marketplace rejects SVG in READMEs; `vsce` rewrites relative links to the GitHub repository).

Publishing (`.github/workflows/publish.yml`, trusted publishing, no token):

1. Merge the release commit, then tag it on `main`: `git tag -a vX.Y.Z -m "DB Deck X.Y.Z"`, `git push origin vX.Y.Z`.
2. `gh release create vX.Y.Z --verify-tag --title "DB Deck X.Y.Z" --notes-file <notes>`, plus `--prerelease` while `package.json` has `"preview": true`. Don't attach a `.vsix`; the workflow does.
3. Approve the **Publish** run (environment `marketplace`). It checks the tag matches `package.json`, packages, publishes with `vsce publish --oidc`, then attaches `db-deck-X.Y.Z.vsix` to the release.
4. Check the Marketplace shows the new version (it can take a few minutes).

If the job fails before publishing, fix the cause and use **Run workflow** from `main` with the tag. If the Marketplace refuses the publish, upload a `.vsix` built with `task package` at the tag by hand on the Marketplace's Manage Publishers page. `@vscode/vsce` is pinned exactly (≥ 4.1 for `--oidc`), and actions are pinned to commit SHAs with the version in a comment; update them deliberately.

## Related rules

- `verification.md` — what to run before committing
