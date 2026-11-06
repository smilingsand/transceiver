# Windows execution permissions

[English](Execution-Permissions-BRIDGE-LAB.md) | [简体中文](Execution-Permissions-BRIDGE-LAB-CN.md)

This reference separates Codex Shell permissions from the controller and dedicated Git MCP tools. The local diagnostic changes no policy, configuration, ACL, service or project file. It adds no MCP endpoint or client capability.

## Run the local diagnostic

From this checkout, in an operator PowerShell whose existing execution policy permits local scripts:

```powershell
.\scripts\diagnose-execution.ps1 -Project transceiver -RequestedSandbox workspace-write
# Optional read-only observations; replace every placeholder with an approved path.
.\scripts\diagnose-execution.ps1 -Project demo -Cwd 'D:\Approved\demo' `
  -CheckPython -PythonPath 'D:\ApprovedTools\Python312\python.exe' `
  -UvPath 'D:\ApprovedTools\uv.exe' -VenvPath 'D:\Approved\demo\.venv'
```

Output is JSON; `-AsObject` returns a PowerShell object. `-ConfigPath`, `-BridgeEnvPath` and `-RuntimeDir` select local diagnostic inputs, relative to the checkout. They do not change the controller's configuration. Custom state/control paths and launch-time controller overrides are not automatically discovered. No Python/uv checks occur unless requested through `-CheckPython` or a Python/uv/venv path.

The script does not execute Python, uv, Codex or Node, query a live service, open SQLite, read rollout history, inspect credentials, or dump environment variables. It reads bounded UTF-8 configuration files and returns only whitelisted settings and path observations. Unsupported settings and parse errors do not echo their raw values. Reparse-point paths, UNC/device paths and alternate data streams are rejected. Inspect output before sharing: authorized local paths and the observing account name are included.

If PowerShell blocks `.ps1` loading, stop and report that limitation. Do not relax execution policy or bypass the Codex sandbox to make diagnostics/tests run.

## Interpret the sources

| Output | Meaning |
| --- | --- |
| `controllerConfiguration` | Controller defaults resolved with the selected `bridge.env`; each setting includes its source and validity. |
| `sandboxCandidate` | Conditional new-task calculation. `read-only` strategy forces read-only; `adaptive` accepts the requested sandbox or configured default; `always-full` requires the separate full-access grant. Missing/inaccessible/invalid input is not reported as permitted. |
| `repositoryApprovalPolicy` | Observes the source entry point's explicit `never` assignment. This describes repository implementation, not the running process. Inherited environment cannot override that assignment. |
| `savedStrategy` | Unknown: persistent SQLite preferences are not opened. They can override controller strategy. |
| `appServerActual` | Unknown: no live RPC/thread state is observed. Disk settings, a previous rollout and a configured candidate are not actual current-turn permissions. |
| `codexExecutables` | Configured directory, controller-recorded executable and PATH candidate, separately. The record may be stale; the controller does not use a PATH fallback. Its built-in pinned fallback is not resolved by this diagnostic. |
| `projectAuthorization` | Checks only the selected configuration candidate and cwd containment, flags and ordinary paths. It is not a grant: the server independently validates the entire allowlist, overlapping roots, identity and revocation. |
| `pythonChecks` | Optional file/ACL readability observations under the account running this script, not necessarily the Codex sandbox account. |

Controller launch parameters take precedence over `bridge.env`. Saved strategy can then change task selection. New tasks pass `cwd`, `sandbox` and `approvalPolicy` to App Server `thread/start`. Continuation uses the existing thread; it does not re-send sandbox settings in `turn/start`. A source/config change therefore does not demonstrate that an existing thread changed permissions. A live `config/read` result alone would also not establish thread/turn overrides.

Implementation references: `scripts/bridge-lab.ps1` parameter/env resolution; `plugins/transceiver/scripts/reverse-permissions.mjs`; `reverse-runtime.mjs` explicit approval assignment; pinned upstream `dist/tools.js` task selection and `dist/appServerUpstream.js` request mapping. The diagnostic reports the source checkout, not an arbitrary deployed bundle.

## Verified diagnosis and limits

The 2026-11-06 investigation observed a native Windows `codexsandboxoffline` Shell account and an on-disk elevated sandbox selection. `uv 0.11.9` could not read the interactive user's managed Python directory, `C:\Users\<user>\AppData\Roaming\uv\python` (`os error 5`). In an offline disposable fixture, a machine-installed Python 3.14.2, its child process, and uv-created venv worked across separate Shell calls. Requesting 3.12.13 failed during managed installation discovery. This supports a location/account access problem; it does not prove a uv bug or a blanket Python child-process prohibition.

The original Python 3.12.13 executable path, venv base configuration and effective ACL were not obtained; the original interpreter-query/trampoline messages were not reproduced exactly. No affected application repository was read or modified. Python 3.14.2 was a diagnostic control, not a replacement for a project's required 3.12.13.

The checkout-root `.git` had explicit deny-write ACL entries; a nested disposable repository did not, and its `git add` succeeded. That nested fixture did not reproduce the root `index.lock` failure. Codex documents `.git` below a writable root as protected read-only, even under workspace-write. `approval_policy=never` removes approval prompts; it does not grant full access. See [official permissions](https://learn.chatgpt.com/docs/agent-approvals-security) and [Windows sandbox behavior](https://learn.chatgpt.com/docs/windows/windows-sandbox).

## Python 3.12 toolchain repair

1. Request path observations for the intended interpreter and uv, plus the existing venv. The script examines `pyvenv.cfg` fields `home`, `base-executable` and `executable`, and the venv launcher. A readable launcher can still reference an inaccessible base interpreter.
2. `fileReadable=true` only proves opening/reading that file. `aclReadable=true` only proves reading its ACL; neither proves effective execute access, DLL availability or successful interpreter startup. Execution stays `unknown-not-executed`. Missing and inaccessible paths may be indistinguishable.
3. Have the operator approve and provision the exact required CPython 3.12.13 from a trusted distribution into a narrowly approved toolchain location accessible to the sandbox account. Verify provenance, version and required read/execute access. Do not grant write access to the whole user profile, change ACLs broadly, disable Defender, or enable full access by default.
4. With separate authorization, rebuild the project's venv to reference that installation. Moving/copying only a venv can preserve the inaccessible base reference. Do not edit an unrelated application's configuration as part of Transceiver diagnostics.
5. First validate interpreter startup, a child process, venv startup and offline `uv run --locked` in a disposable fixture across two Shell calls. Only then, with explicit project authorization, run its tests. A normal operator-shell success does not prove sandbox-user success.

## Dedicated Git and GPT review

Keep code editing in Codex workspace-write. For authorized Git writes, use the dedicated tools: inspect complete `git_status`/`git_diff`, review the change with GPT/user, then use explicit project-relative `git_add` paths, inspect the staged diff and perform only the authorized commit. Push needs separate authorization plus the pinned remote/branch grant. A task's completion is not permission to commit/push.

These tools spawn trusted native Git directly with a fixed cwd/environment and no shell. Server configuration independently grants add/commit/push and revalidates projects; they do not inherit Codex Shell's `.git` restriction. Conversation/Activity scope is routing, not a per-conversation Git project grant. Existing HTTP/tunnel access control remains required. The diagnostic adds no unauthenticated access.

Check `ok`, `complete`, `truncated`, `timedOut` and `mutationMayHaveOccurred`. Do not treat a timeout as a permissions error, or blindly retry a possibly completed commit. Hooks, unsafe configuration, sensitive staged paths, unsupported links and shared Git metadata remain rejected.

Do not add an arbitrary `pytest`/shell runner to the elevated MCP server as a workaround. Test collection executes project code; fixed argv is not OS isolation. Such a runner would need a separately reviewed, explicitly granted execution boundary.

## Git status scanning and timeouts

`git_status` checks the project and `.git` control plane before and after Git runs, without recursively scanning the worktree. Git applies its native index and `.gitignore` rules; there is no additional exclusion configuration. The default `full` scope includes untracked files and reports `complete: true` on success. Optional `scope: "tracked"` omits untracked files and reports `complete: false` and `untrackedIncluded: false`; it cannot establish that the worktree is clean.

This is a narrower safety check: ignored paths, links and nested repositories in the worktree are not independently screened by status. Git ignore is not a security boundary. `git_diff` and Git write tools (`git_add`, `git_commit`, `git_push`) retain their full worktree safety scans, including ignored paths; they can reject a repository that status can inspect. Keep disposable repositories outside authorized project trees. The total deadline is 60 seconds for ordinary Git operations and 120 seconds for push, including authorization, scans and subprocesses.

## Offline validation

With existing dependencies, from `plugins/transceiver`:

```powershell
node --test tests/execution-permissions.test.mjs tests/reverse-permissions.test.mjs tests/git-tools.test.mjs tests/git-write-tools.test.mjs
# Only when the operator's existing policy already permits local scripts:
# From the checkout root:
.\scripts\diagnose-execution.Tests.ps1
```

Node tests use real disposable Git fixtures and a fake stdio App Server; no model, network, real Python 3.12 or production Git writes. They cover start/continuation permission mapping, allowlists/revocation/cwd isolation, ignored-tree safety and bounded scan budgets. The Windows AST test parses the diagnostic without executing it. PowerShell runtime tests use invalid synthetic executables, test redaction/read-only behavior and configuration candidates, and never change execution policy. A blocked runtime suite must be reported as blocked, not passed.
