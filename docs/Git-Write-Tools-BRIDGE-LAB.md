# Controlled Git writes — T5.7

[中文](Git-Write-Tools-BRIDGE-LAB-CN.md)

`git_status` and `git_diff` retain their read-only interfaces. New independent MCP tools use the shared deterministic Git executor without starting Codex, creating Activities/Threads or consuming model inference. **All write permissions default to disabled.**

## Inputs and results

Every object is strict (`additionalProperties: false`); all shown fields are required. `project` is the exact authorized name (1–200 characters), never a path. There are no command, root, environment, force, amend, delete or arbitrary refspec parameters.

The exact schemas exported from MCP tool discovery are in [Git-Write-Tools-Schema.json](Git-Write-Tools-Schema.json).

| Tool | Input example | Result |
| --- | --- | --- |
| `git_add` | `{"project":"transceiver","paths":["README.md","scripts/bridge-lab.ps1"]}` | Requested `paths`, actual `stagedPaths` for the entire index, parsed `status` |
| `git_commit` | `{"project":"transceiver","message":"T5.7 - feat: add controlled Git write operations"}` | `created`, verified 40-character `hash`, actual `message`, short `stats` |
| `git_push` | `{"project":"transceiver","remote":"origin","branch":"dev/bridge-lab"}` | `remote`, `branch`, `result`: `created`, `updated` or `up-to-date` |

- Add accepts 1–100 explicit relative paths, each 1–1024 characters. Files, directories and deletions are supported. Paths are literal: spaces, Unicode, brackets and leading hyphens are safe. Absolute paths, traversal, `.`, `.git`, glob/pathspec magic and ambiguous Windows/device paths are rejected. No implicit whole-project mode. Directory descendants are checked before staging. The result includes pre-existing staged changes.
- Commit accepts an explicit message of 1–8192 characters, rejecting blank messages, NUL and CR. It commits only the current index, without automatic add, amend, empty commits, configuration changes or hook bypass. Empty staging returns `ok: true`, `created: false`, `reason: "NO_STAGED_CHANGES"`. Stage numbering is a project convention, not a generic tool restriction. Existing **repository-local** `user.name` and `user.email` are required because the executor does not read global/system configuration; it never writes identity settings.
- Push requires explicit remote/branch strings of 1–200 characters. Remote names start with an ASCII letter/digit and use letters, digits, dots, underscores or hyphens. Branches use a conservative ASCII subset plus Git ref validation; options, wildcards, deletion syntax and user refspecs are rejected. The local branch must exist. Only a normal same-name branch push is supported. No tags, releases, PRs, upstream-tracking changes or credential configuration changes.


When identity is missing, `git_commit` returns `GIT_IDENTITY_MISSING` before attempting a commit. In the authorized repository, set `git config --local user.name "Your Name"` and `git config --local user.email "you@example.com"`. Identity belongs in repository-local Git configuration, not Transceiver configuration or startup; global Git identity is not injected.

## Server authorization

Inspection of the current unified MCP path found endpoint authentication but no verifiable per-write user approval channel. Connector confirmations and MCP annotations are client hints, not the server authorization boundary; a prompt promise to ask consent is insufficient. An operator must opt in using the existing server project configuration (`TRANSCEIVER_CONFIG` / controller `-ConfigPath`):

```json
{
  "version": 1,
  "projects": {
    "D:/MyWorks/transceiver": {
      "name": "transceiver",
      "sync": true,
      "allowCodexTasks": true,
      "gitWrite": {
        "add": true,
        "commit": true,
        "push": true,
        "githubGcm": true,
        "pushTargets": [
          {
            "remote": "origin",
            "url": "https://github.com/OWNER/REPO.git",
            "branches": ["dev/bridge-lab"]
          }
        ]
      }
    }
  }
}
```

This example is documentation, not automatically applied configuration. Omitted flags grant nothing; malformed policies fail closed. Each operation needs its own `true` flag. `pushTargets` alone grants nothing. Exactly one grant must match the remote/branch, and the repository's single push URL must exactly match the grant. No wildcard grants. The actual push uses the pinned URL and a constructed same-name branch refspec, so changing local remote defaults cannot redirect or broaden it. URL-based push does not update local remote-tracking refs.

Policy reloads before subprocesses; revocation blocks later steps, not already-started commands. New/rebound roots require recreating the host policy; flags on already authorized roots reload. Grants apply to all callers of this Bridge, not separately to ChatGPT users. Protect the configuration and endpoint. Write annotations differ from read-only tools; upstream Codex sandbox settings neither grant nor gate these deterministic operations.

## Safety scope

- Reuses trusted absolute Git, root identity checks, ordinary in-project `.git`, strict local config and a minimal environment. Git is spawned without a shell; the opted-in helper is invoked by Git's helper shell as described below. Global/system configuration and inherited `GIT_*`, PATH and credential environment are excluded. Includes, aliases, filters, external diff/textconv, signing commands and local credential-helper settings are rejected rather than rewritten.
- Writes reject active `.git/hooks` files (`*.sample` files are inert), returning `HOOKS_NOT_SUPPORTED` before mutation. A failing pre-commit hook is rejected before execution or commit; hooks are neither trusted nor silently bypassed. Run hook-dependent workflows locally. Linked worktrees, nested repos, submodules, shallow/promisor/shared metadata and links remain unsupported.
- Commit checks the **whole staged set**, independently of `.gitignore`. Add also checks selected directory descendants. Sensitive names such as `.env*`, `bridge.env`, `config.json`, credentials/secrets files, private keys, `.npmrc`, `.pypirc`, `.aws`, `.ssh`, `proj-info` and `codex` are blocked (`SENSITIVE_STAGED_PATH`). This conservative filename rule may block benign examples and is not content-based secret detection. Review staged diff and new files before commit/push.
- Push supports canonical HTTPS without embedded credentials, query, fragment or redirects. SSH and custom transports remain unsupported. `githubGcm` defaults to false; when true, only an exactly granted `https://github.com/...` push may use the Git for Windows GCM executable alongside the configured trusted native Git. Other HTTPS hosts get no helper. The Git installation and its dependencies must be trusted and protected from local modification. Git executes the fixed, validated helper path through its helper shell; no config-supplied helper is accepted. GCM uses `GCM_INTERACTIVE=0`, `GIT_TERMINAL_PROMPT=0`, the GitHub provider and Windows Credential Manager; the helper may get, store or erase credential entries. Never embed tokens in URLs or inputs.
- For this opted-in push only, `PATH` is the trusted Git bin directory and `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` are passed when absolute; `HOME` stays isolated and system/global Git config and inherited Git/GCM variables remain disabled. Authentication depends on the Bridge's Windows account, credential availability, permissions, network and GCM installation. `CREDENTIAL_UNAVAILABLE` means the fixed executable is unavailable or unsupported; `AUTHENTICATION_REQUIRED` means credentials or interaction are needed; `AUTHENTICATION_FAILED` means authentication/access was rejected (including HTTP 401/403). These classifications do not establish the state of the credential store.
- Explicitly granted local absolute bare directories support offline workflows. Their config, metadata, links and active hooks are checked before receive-pack; UNC and ordinary non-bare targets are rejected. A URL grant permits writing that destination. HTTPS servers may enforce their own receive policy.
- Each `git_push` request has a 120-second total deadline, including authorization, scans and all subprocesses; other Git operations have a 60-second total deadline. Each request shares a 1 MiB stdout/stderr budget across subprocesses; responses are at most 64 KiB and scans at most 20,000 entries. Global concurrency is at most four; in-process project writes exclude overlapping tool access. Raw Git stderr/transport text is never returned. Errors classify authorization, arguments/paths, unsupported repositories, authentication, network, non-fast-forward, remote rejection, timeout and output overflow.
- Client and intermediary timeouts are separate from the server deadline. The installed MCP SDK client defaults to 60 seconds; clients under your control must allow more than 120 seconds plus transport overhead (for example 130 seconds). The ChatGPT connector and Tunnel timeout is not established here and may be shorter. A client disconnect or timeout does not prove cancellation or rollback; inspect the remote before retrying. GCM interaction remains disabled.
- This is not a process-tree sandbox or atomic protection against hostile concurrent local writers. Use trusted, quiescent repositories; OS permissions remain the outer boundary. Remote HTTPS hooks execute under remote policy, not the local grant.
- Check `ok`, `complete`, `truncated`, `timedOut`. After an attempted mutation, errors carry `mutationMayHaveOccurred: true`: timeout, overflow, failed post-checks or disconnects do not imply rollback. Inspect status, staged diff, local HEAD and remote state before retrying.

## Workflow, tests and rollout

After a scheduled Bridge-only restart, refresh MCP discovery and test the exact authorized branch with `git_push`. Check `ok` and `result`; on failure inspect local and remote state before retrying. The Bridge account must already have usable non-interactive GitHub credentials; sign in separately through the normal local workflow if necessary. The offline tests use synthetic helpers and do not demonstrate authentication against GitHub.

During the T5.8 rollout, an authenticated GitHub push was successfully completed using the deterministic `git_push` MCP tool with Windows Git Credential Manager. The tool returned `ok: true` and `result: "updated"`, confirming that the authorized remote branch was updated without invoking Codex. This verifies the end-to-end GitHub push workflow in the tested Windows environment; it does not guarantee equivalent behavior in other environments.

1. `git_status` to inspect existing changes, including pre-existing staging.
2. `git_diff` with `mode: "unstaged"`; read untracked files separately.
3. `git_add` with explicit intended paths. Check `stagedPaths` and `status`.
4. `git_diff` with `mode: "staged"`; review the **whole index**. Call `git_commit` with a reviewed explicit message. Check the returned hash/statistics; locally verify with `git log -1 --stat` if needed.
5. If authorization and transport permit, `git_push` with explicit remote/branch. Check target/result and independently verify the remote branch when uncertain.

Offline checks: run `npm test` in `plugins/transceiver` (rebuilds the distribution, then all Node tests); run `pwsh -NoProfile -File ./scripts/bridge-lab.Tests.ps1` and `git diff --check` from the repository root. Temporary fixtures/bare remotes stay inside the repository; no GitHub push. Real HTTP MCP write tests assert zero model calls. Live services, real configuration and private runtime are untouched.

Source/controller users need a **Bridge-only restart** to load new code. Bundle users (`npm run reverse:start`) also need `npm run build:reverse` first. Do not restart Tunnel. After an operator-scheduled restart, refresh connector discovery, verify the three strict schemas and test default denials before enabling the intended grants.

The controller's `stop` action stops **both** components, so do not use it for this rollout. Run `./scripts/bridge-lab.ps1 -Action status` with the same configuration/runtime arguments as the existing instance, verify the recorded Bridge PID, executable, command line and creation time, then have the operator run `Stop-Process -Id <verified-Bridge-PID>` followed by `./scripts/bridge-lab.ps1 -Action start` with those same arguments. The controller preserves a verified running Tunnel and starts only the missing Bridge. These commands are guidance only; development and offline tests do not execute them against the real instance.
