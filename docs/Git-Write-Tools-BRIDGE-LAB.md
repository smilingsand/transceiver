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

- Reuses trusted absolute Git, root identity checks, ordinary in-project `.git`, strict local config, no shell interpolation and a minimal environment. Global/system configuration, inherited `GIT_*`, PATH and credential environment are excluded. Includes, aliases, filters, external diff/textconv, signing commands and credential-helper settings are rejected rather than rewritten.
- Writes reject active `.git/hooks` files (`*.sample` files are inert), returning `HOOKS_NOT_SUPPORTED` before mutation. A failing pre-commit hook is rejected before execution or commit; hooks are neither trusted nor silently bypassed. Run hook-dependent workflows locally. Linked worktrees, nested repos, submodules, shallow/promisor/shared metadata and links remain unsupported.
- Commit checks the **whole staged set**, independently of `.gitignore`. Add also checks selected directory descendants. Sensitive names such as `.env*`, `bridge.env`, `config.json`, credentials/secrets files, private keys, `.npmrc`, `.pypirc`, `.aws`, `.ssh`, `proj-info` and `codex` are blocked (`SENSITIVE_STAGED_PATH`). This conservative filename rule may block benign examples and is not content-based secret detection. Review staged diff and new files before commit/push.
- Push supports canonical credential-free HTTPS without query, fragment or redirects. SSH, custom transports and credential helpers are unsupported. **Authenticated private GitHub pushes are outside T5.7 scope**, generally returning `AUTHENTICATION_FAILED`. Never embed tokens in URLs or inputs. Future credential integration needs separate review.
- Explicitly granted local absolute bare directories support offline workflows. Their config, metadata, links and active hooks are checked before receive-pack; UNC and ordinary non-bare targets are rejected. A URL grant permits writing that destination. HTTPS servers may enforce their own receive policy.
- Requests share a 10-second deadline and 1 MiB stdout/stderr budget across subprocesses; responses are at most 64 KiB and scans at most 20,000 entries. Global concurrency is at most four; in-process project writes exclude overlapping tool access. Raw Git stderr/transport text is never returned. Errors classify authorization, arguments/paths, unsupported repositories, authentication, network, non-fast-forward, remote rejection, timeout and output overflow.
- This is not a process-tree sandbox or atomic protection against hostile concurrent local writers. Use trusted, quiescent repositories; OS permissions remain the outer boundary. Remote HTTPS hooks execute under remote policy, not the local grant.
- Check `ok`, `complete`, `truncated`, `timedOut`. After an attempted mutation, errors carry `mutationMayHaveOccurred: true`: timeout, overflow, failed post-checks or disconnects do not imply rollback. Inspect status, staged diff, local HEAD and remote state before retrying.

## Workflow, tests and rollout

1. `git_status` to inspect existing changes, including pre-existing staging.
2. `git_diff` with `mode: "unstaged"`; read untracked files separately.
3. `git_add` with explicit intended paths. Check `stagedPaths` and `status`.
4. `git_diff` with `mode: "staged"`; review the **whole index**. Call `git_commit` with a reviewed explicit message. Check the returned hash/statistics; locally verify with `git log -1 --stat` if needed.
5. If authorization and transport permit, `git_push` with explicit remote/branch. Check target/result and independently verify the remote branch when uncertain.

Offline checks: run `npm test` in `plugins/transceiver` (rebuilds the distribution, then all Node tests); run `pwsh -NoProfile -File ./scripts/bridge-lab.Tests.ps1` and `git diff --check` from the repository root. Temporary fixtures/bare remotes stay inside the repository; no GitHub push. Real HTTP MCP write tests assert zero model calls. Live services, real configuration and private runtime are untouched.

Source/controller users need a **Bridge-only restart** to load new code. Bundle users (`npm run reverse:start`) also need `npm run build:reverse` first. Do not restart Tunnel. After an operator-scheduled restart, refresh connector discovery, verify the three strict schemas, test default denials, then enable only a disposable project and explicit local bare target to repeat the workflow. Production authenticated push needs future work; do not disable helper/config checks to make it pass.

The controller's `stop` action stops **both** components, so do not use it for this rollout. Run `./scripts/bridge-lab.ps1 -Action status` with the same configuration/runtime arguments as the existing instance, verify the recorded Bridge PID, executable, command line and creation time, then have the operator run `Stop-Process -Id <verified-Bridge-PID>` followed by `./scripts/bridge-lab.ps1 -Action start` with those same arguments. The controller preserves a verified running Tunnel and starts only the missing Bridge. These commands are guidance only; development and offline tests do not execute them against the real instance.
