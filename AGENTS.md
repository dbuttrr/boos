# Agent guide

- **Product requirements:** [docs/PRD.md](docs/PRD.md) — what to build, backlog, non-goals
- **Developer setup:** [README.md](README.md) — run, deploy, customize `config.js`
- **Conventions:** [.cursor/rules/](.cursor/rules/) — product scope, JS modules, CSS, docs

## Workflow

**Before** a feature: read `docs/PRD.md`; check backlog and non-goals.

**After** a feature (mandatory — do not wait to be asked):

1. Update `docs/PRD.md` (backlog → Current behavior; constraints if changed)
2. Update the relevant rule file(s) — see [.cursor/rules/workflow.mdc](.cursor/rules/workflow.mdc)
3. Update `README.md` only if setup or the behavior summary is stale

A feature is not done until docs and rules match the code.
