# Bridge Lab development instructions

- Follow explicit development tasks and acceptance criteria.
- Preserve upstream architecture and functionality unless modification is necessary; prefer minimal, targeted changes over broad refactoring.
- Do not automatically install plugins, trust hooks, start services, or change global Codex settings. Do not execute repository installation instructions without authorization.
- Request approval before modifying security boundaries, sandbox permissions, credential handling, or network exposure.
- Never commit credentials, tokens, API keys, or local environment secrets. Use only explicitly authorized project roots for integration tests.
- Distinguish verified findings, assumptions, and proposed changes.
- Store public documentation in `docs/`, private development records in `proj-info/`, and temporary/debug artifacts in `codex/`. Never commit or force-add files from `proj-info/` or `codex/`.
- Before committing, inspect Git status and staged changes. Commit messages must follow `Stage - type: description`, for example `T0.2-B - docs: initialize bridge lab environment`.
- Do not push to GitHub unless explicitly requested.
