# Project Rules Index

Shared rules for contributors and coding agents. Before planning or editing a file, find the rows whose globs match its path and read those rule files. (Agents that understand the `paths:` frontmatter in each file load them automatically.)

| Applies to | Rule file |
| --- | --- |
| `**/*` | `.ai/rules/core.md` |
| `src/**` | `.ai/rules/architecture.md` |
| `src/drivers/**`, `src/query/**`, `package.json`, `esbuild.mjs` | `.ai/rules/drivers.md` |
| `src/webview/**`, `src/views/**` | `.ai/rules/webview.md` |
| `src/**`, `package.json` | `.ai/rules/vscode-api.md` |
| `**/*` | `.ai/rules/verification.md` |
| `**/*` | `.ai/rules/debugging.md` |
| `**/*` | `.ai/rules/git-workflow.md` |

If a rule is missing, wrong, or out of date, say so in your pull request and propose the exact change — rules are maintained like code.
