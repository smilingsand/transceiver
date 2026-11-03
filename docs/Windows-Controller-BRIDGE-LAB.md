# Bridge Lab Windows Controller Reference

[English](Windows-Controller-BRIDGE-LAB.md) | [简体中文](Windows-Controller-BRIDGE-LAB-CN.md)

The [Windows controller](../scripts/bridge-lab.ps1) starts, inspects and stops the reverse Bridge and Tunnel client processes that it manages locally. This document describes the behavior of the script in the repository. For first-time dependency preparation, project authorization and Tunnel profiles, see the [Windows setup guide](Windows-Setup-BRIDGE-LAB.md); for operational templates in an existing environment, see the [quick start](../QuickStart-BRIDGE-LAB.md).

## Components and responsibilities

```text
PowerShell controller
  ├─ Node → plugins/transceiver/scripts/reverse-runtime.mjs → Codex app-server
  └─ tunnel-client run → configured Tunnel profile → local Bridge
```

The controller requires Windows PowerShell 5.1 or later. It uses this fork's **source entry point**, not the upstream bundled `dist/reverse-bridge/index.mjs`; source dependencies must be prepared in advance. By default, Bridge listens only on `127.0.0.1:8876` and serves `/mcp` and `/healthz`. Tunnel forwards ChatGPT MCP requests to the local Bridge. The local HTTP endpoint has no authentication; do not expose it on a LAN or the public internet.

The controller does not create project grants, Tunnels, profiles or account permissions. A running Bridge will not reload changed project configuration merely because `start` is run again. When tasks are idle, restart the managed components in an appropriate maintenance window and then inspect `codex_settings` → `capabilities.allowedRoots`. This list expresses Bridge cwd policy, not an OS read whitelist.

Deterministic Git writes use the project policy selected by `ConfigPath`. Every `gitWrite` flag defaults to false; pushing also requires an exact remote/URL/branch grant. Windows GitHub GCM additionally requires the separately enabled, default-off `githubGcm` option. Permission changes for existing authorized roots are reloaded before subprocesses; new or rebound roots require recreating host policy. Configuration or connector prompts do not replace user authorization. See [Git write configuration, transport limits and Bridge-only rollout instructions](Git-Write-Tools-BRIDGE-LAB.md).

## Parameters and prerequisites

The script determines the repository root from its own location rather than the current working directory. The root `bridge.env` can provide nonsecret settings. Explicit command-line arguments take precedence, followed by the file and then controller defaults. On a new installation, specify tool paths, the profile and a verified Codex version. See the [quick-start configuration step](../QuickStart-BRIDGE-LAB.md#4-configure-the-controller-and-authorize-a-project) for settings and the [controller operations step](../QuickStart-BRIDGE-LAB.md#5-start-inspect-stop-and-maintain-logs) for common commands.

| Parameter | Purpose and cautions |
| --- | --- |
| `Action` | `status`, `start`, `stop` or `cleanup-logs`; default is `status`. |
| `All` | Only for `cleanup-logs`; ignores file age. May be combined with `-DryRun`, but not with an explicit `-LogRetentionDays`. Any `LOG_RETENTION_DAYS` in the file must still be valid; 0 is invalid. |
| `DryRun` | Previews proposed deletions with `cleanup-logs` without deleting files. |
| `LogRetentionDays` | Retention for historical logs; default 7, valid range 1–3650; corresponds to `LOG_RETENTION_DAYS`. |
| `ConfigPath` | Transceiver project-policy file; must match the project CLI's `TRANSCEIVER_CONFIG`. Default `<repo>/config.json`; records and logs do not depend on this file's location. |
| `RuntimeDir` | Runtime root, default `<repo>/runtime`; unaffected by `ConfigPath`. |
| `ControlDir`, `LogDir` | Default to `RuntimeDir/control` and `RuntimeDir/logs`; may be overridden explicitly, including to access old records. |
| `StateDir` | Bridge state directory, default `RuntimeDir/state`; must exist before `start`. |
| `ProfileDir`, `TunnelProfile` | Profile directory (default `RuntimeDir/tunnel-profiles`) and the name of an existing Tunnel profile; directory must exist and profile must point to the local MCP URL. |
| `TunnelExe` | Path to an installed `tunnel-client.exe`. |
| `GitExe` | Absolute path to a trusted native Git executable, for example Git for Windows `mingw64/bin/git.exe`; deterministic Git does not fall back to PATH. |
| `CodexBin` | Directory containing `codex.exe`, **not** the path to the executable; an empty value selects the fixed Desktop-managed directory coded in the script. |
| `ExpectedCodexVersion` | Exact verified CLI version; default empty, so a verified version must be supplied. Starting a new Bridge requires an exact match of `codex --version`. |
| `NodeExe` | Node executable path or resolvable command; source dependencies require Node 22+. |
| `Port` | Port used to inspect listeners and `/healthz`; default 8876. |
| `BridgeStartupTimeoutSeconds` | Readiness time budget for a new Bridge; default 30 seconds, valid range 1–3600; maps to `BRIDGE_STARTUP_TIMEOUT_SECONDS`. Fails early if the process exits. |

Before starting, the configuration file, Tunnel and Git executables, source entry point, state directory and profile directory must exist. You also need a compatible Codex CLI, prepared dependencies and valid project authorization. Pinning a CLI version improves reproducibility, but Desktop updates can replace it. Verify compatibility and explicitly specify the directory and version after an upgrade; do not automatically scan for or select the newest version, and do not delete Desktop-managed executables.

`PORT` or `-Port` sets both the health-check port and child `TRANSCEIVER_REVERSE_PORT`, overriding an inherited source-port environment variable. The Tunnel profile must use the same port.

## Environment, credentials and state

When starting Bridge, the controller maps `ConfigPath`, `StateDir` and `GitExe` to `TRANSCEIVER_CONFIG`, `TRANSCEIVER_STATE_DIR` and `TRANSCEIVER_GIT_EXECUTABLE`, respectively, and temporarily adds the selected Codex directory to the child process PATH. It restores the calling process's original environment variables afterward.

When starting Tunnel, the controller reads `OpenAI_Tunnel_API_KEY` and `Tunnel_ID` from the current process first, then the Windows user environment, and maps them to `CONTROL_PLANE_API_KEY` and `CONTROL_PLANE_TUNNEL_ID`. The Tunnel ID must include the `tunnel_` prefix. Set these values securely; never paste them into documents, chat, repositories or public logs. PID records contain no credentials, but logs may contain sensitive information. Git ignore rules are not an access boundary: if the repository is an authorized workspace, it includes `runtime/`. Root configuration must not contain secrets. Profiles may also contain sensitive information; never publish them and restrict access.

The controller saves managed process PIDs, creation times, configuration paths, selected Codex paths and log paths in `RuntimeDir/control/processes.json` (or an explicitly configured `ControlDir`). It separately redirects each component's stdout/stderr to `RuntimeDir/logs/` (or `LogDir`). These records are not Bridge's own SQLite or other state files, which reside in `StateDir`. Inspect and redact logs and paths before sharing diagnostics.

## bridge.env and directory migration

Root templates are [bridge.env.example](../bridge.env.example) and [config.json.example](../config.json.example). Actual files and `runtime/` are not committed. The example project's `projects` map is empty; add only explicitly authorized projects. Templates do not contain runtime state.

The parser accepts UTF-8 with or without BOM, blank lines, full-line `#` comments, trailing comments preceded by whitespace, and single- or double-quoted values. Windows paths containing spaces can be quoted; backslashes remain literal. Variables are not expanded and expressions are not executed. Unknown or duplicate keys, malformed input, invalid ports and permission toggles other than `0`/`1` cause errors without echoing their values. Secret keys are not allowlisted.

| `bridge.env` key | PowerShell parameter |
| --- | --- |
| `TUNNEL_PROFILE`, `TUNNEL_EXE`, `GIT_EXE` | `TunnelProfile`, `TunnelExe`, `GitExe` |
| `CODEX_BIN`, `CODEX_VERSION`, `NODE_EXE`, `PORT` | `CodexBin`, `ExpectedCodexVersion`, `NodeExe`, `Port` |
| `BRIDGE_STARTUP_TIMEOUT_SECONDS` | `BridgeStartupTimeoutSeconds` |
| `LOG_RETENTION_DAYS` | `LogRetentionDays` |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX` | `DefaultSandbox` |
| `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | `DefaultAccessStrategy` |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE` | `AllowWrite` |
| `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | `AllowDangerFullAccess` |

Precedence is explicit parameters > `bridge.env` > script defaults. All four permission parameters use the same precedence; inherited permission environment variables do not replace controller defaults. Defaults are `read-only`, `read-only`, `0` and `0`. Child process environment settings are temporary and restored after success or failure. Already-running components are not automatically restarted when configuration changes. Path parameters and relative tool paths in the file resolve relative to the repository root; a bare `NODE_EXE=node.exe` is still resolved through PATH.

Old directories are not automatically deleted or migrated. **If there are existing managed processes from an old directory, pass the old `-ControlDir '<old>/control'` explicitly on every `status`, `start` and `stop`, and preserve the original `ConfigPath`, `StateDir`, `ProfileDir`, port and other settings.** Merely selecting the old `ConfigPath` does not select the old PID records. PID, command line and creation time are still checked; missing records do not authorize adopting unknown processes. Once tasks are idle, safely stop processes using the old records, manually migrate configuration, state and profiles, and only then switch to the new runtime directory. Do not copy PID records to adopt running processes or start components simultaneously using two control directories.

## Managed process identity and operation

The controller queries a process by its recorded PID, then checks for the expected command-line marker and a creation timestamp within a five-second tolerance. This reduces accidental actions on reused PIDs. It does not adopt or terminate unknown listeners, nor does it bulk-kill processes by the generic name `node.exe`. It is not a complete process-tree manager or graceful-shutdown framework.

At the repository root, using machine-specific settings from `bridge.env`:

```powershell
.\scripts\bridge-lab.ps1 -Action status
.\scripts\bridge-lab.ps1 -Action start
.\scripts\bridge-lab.ps1 -Action status
```

`status` reports whether managed Bridge/Tunnel identities match, the Bridge `/healthz` result, port-listener PID and recorded log paths. Health checks are HTTP requests to a specified loopback port; interpret them together with the managed process state and listener PID. Health alone does not prove that the responder is the managed Bridge. A listener without a matching record generates an unmanaged-listener warning. `status` is not a full inventory of all unknown Tunnel processes.

At startup, the script checks the listener, process identities and Bridge health, then coordinates missing components. A new Bridge gets a default 30-second readiness budget; it must own the listening port and pass `/healthz`. A new Tunnel still receives only about a two-second process-liveness check. **`Tunnel managed = True` does not establish cloud Tunnel connectivity.** Check client diagnostics and make a real read-only MCP call from ChatGPT.

Set `BRIDGE_STARTUP_TIMEOUT_SECONDS=60` in `bridge.env` or pass `-BridgeStartupTimeoutSeconds 60` for a one-off override; command-line parameters take precedence. The budget begins before `Start-Process`, covers process creation and readiness checks, but excludes earlier dependency and Codex-version checks and subsequent Tunnel startup. A monotonic timer polls at intervals no longer than 500 ms. Health requests take at most two seconds and shrink to the remaining whole seconds; no new request is started when fewer than one second remains. Windows process creation, port queries and scheduling cannot be forcibly interrupted by this budget. The child process is checked for exit before and after each request; an in-flight request may consume its remaining request time limit.

The controller writes startup diagnostics both to the terminal and to an additional `.startup.log` file appended to the Bridge stdout log path, even when child stdout/stderr are empty. Diagnostics include PID, elapsed milliseconds, exit status and code (`n/a` if still alive), listener PID, most recent health response and request count, and timeout state. `process-exited` means the child terminated; `port-not-listening` means no listener appeared before the budget expired; `health-check-failed` means this process was listening but health failed; `wait-timeout` means the budget expired without a verified ready result. A timeout also displays `timedOut=True`. `listener-pid-mismatch` means the listener is not the expected process; it is neither accepted as Bridge nor cleaned up. Failure diagnostics describe the pre-cleanup state. On failure, rollback still applies only to processes started by that invocation, preserving existing managed components and records.

The earlier version used 20 iterations of “sleep 500 ms, inspect the port, and if necessary run a health request lasting up to two seconds.” This was **not** a strict 10-second ceiling: sleeps plus HTTP waits alone could total approximately 50 seconds, plus OS-command overhead. Cold-start timeout was a hypothesis requiring verification; empty stdout/stderr alone cannot distinguish process exit, no listener yet or failed health. The new diagnostics provide evidence for subsequent actual cold-start investigations.

Before stopping, make sure no ongoing task needs to be preserved and use the same parameters:

```powershell
.\scripts\bridge-lab.ps1 -Action stop
.\scripts\bridge-lab.ps1 -Action status
```

`stop` terminates identity-matched managed Tunnel and then Bridge, and removes PID records. It does not terminate processes whose identity does not match. If records are missing, it does not adopt or stop unknown processes. Configuration, profiles and Bridge state are not removed by an ordinary stop.

## Four startup and recovery cases

The following describes intended source behavior, assuming valid configuration and dependencies and no unknown-process conflicts:

| Pre-start state | What `start` does |
| --- | --- |
| Both components stopped, possibly with only stale PID records remaining | Starts Bridge and Tunnel and writes new records after success. |
| Both components managed and Bridge healthy | Preserves both without restarting; Tunnel is checked only for process liveness. |
| Bridge managed and healthy, Tunnel exited | Preserves Bridge and starts only Tunnel. |
| Tunnel managed and alive, Bridge exited | Preserves Tunnel and starts only Bridge. |

If an unknown process occupies the port, an unmanaged `tunnel-client.exe` is present, or a managed Bridge is alive but fails health checks, `start` refuses to blindly adopt or forcibly terminate it. If any new component fails during startup, error handling attempts to terminate only the processes started during this invocation, preserving previously managed processes and records. Inspect actual state and logs afterward. Coordination has no cross-process lock; do not invoke multiple `start` operations concurrently.

## Log cleanup

If the running instance uses custom `ConfigPath`, `ControlDir` or `LogDir`, pass the same parameters in these commands. They maintain logs only; they do not start or stop services or change PID records, Bridge state or SQLite:

```powershell
.\scripts\bridge-lab.ps1 -Action cleanup-logs -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs
.\scripts\bridge-lab.ps1 -Action cleanup-logs -LogRetentionDays 14
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All
```

Retention precedence is explicit `-LogRetentionDays` > `LOG_RETENTION_DAYS` in root `bridge.env` > default seven days; valid range is 1–3650. The cutoff is computed once at the start of cleanup. Only files with `LastWriteTime` strictly earlier than the cutoff can be deleted; neither file size nor creation time is used.

`-All` ignores age but preserves other safety checks and active-log protection; `-All -DryRun` only previews. `-All` cannot be combined with explicit `-LogRetentionDays`. Any `LOG_RETENTION_DAYS` in `bridge.env` must still be valid; zero is an error. Parameters and Action names are case-insensitive.

Only direct children of the resolved `LogDir` are examined. Filenames must match `bridge-*-out.log`, `bridge-*-err.log`, `tunnel-*-out.log` or `tunnel-*-err.log`, with a nonempty `*` component. Cleanup is nonrecursive and excludes `.startup.log`, other patterns and other directories. Hidden files are checked, but directories, symbolic links, junctions, all reparse points and hard links are retained. A reparse point in the log root or any ancestor rejects the entire cleanup.

Cleanup first reads `ControlDir/processes.json`, validates the configuration path, and reuses PID, command-line marker and creation-time identity checks. Each live Bridge/Tunnel protects its recorded stdout and stderr files, even if those four files are old or empty. If a recorded PID is confirmed absent, that component may be treated as exited. If a PID has been reused, the record is incomplete, an active log path is missing or relative, process queries fail, Node/Tunnel command lines cannot be read, or an unrecorded Bridge/Tunnel is found, the files are conservatively retained. Missing or corrupt records also cause the entire cleanup to retain files. Consequently, after a normal `stop` removes the record, cleanup does not guess which logs can safely be deleted.

Before deleting each candidate, cleanup rereads state, revalidates identities and active log paths, then checks filename, location, type and last-write time. Windows native-handle checks lock ancestor directories against path replacement, exclusively open the candidate to reject busy files, recheck type, hard-link count and last-write time through the same handle, and then delete via that handle rather than performing a bulk wildcard deletion. Busy, inaccessible, vanished or changed candidates are reported separately without preventing checks of other safe candidates. This path requires Windows and usable `Add-Type`/Win32 calls. If policy restricts those calls or ancestor directories are inaccessible, files are retained and failures reported; checks are not weakened. Avoid running cleanup concurrently with other controller configuration or state changes.

Output contains filenames, reasons and counts only; it does not read log contents or expose credentials. `Eligible` counts files that pass the initial candidate check and enter handle processing, including candidates that fail opening or deletion. A type or timestamp mismatch at handle recheck is counted as `Skipped`. `Deleted` is the number successfully deleted; `Protected active` is the number of actually inspected, protected files; `Skipped` covers nonmatching files, directories, links, files within retention and conservative skips. `Failed` counts failures, including one operation-level failure if the entire `LogDir` cannot be accessed safely. Unverifiable state does not lead to an invented protected-active estimate. `-DryRun` performs the same safety checks, reports each `Would delete` and totals, sets `Deleted` to zero and explicitly says nothing was deleted.

Offline tests cover actual temporary-file deletion, retention periods, four zero-byte active logs, one component alive, both components exited, dry-run nonmodification, parameter parsing/precedence/validation, unmatched and nested files, junctions and hard links, missing/corrupt state, identity mismatch/query failures, busy-file failure and state changes just before deletion. Real file-symlink tests require local creation privileges and are explicitly skipped when unavailable; junction and replacement-with-reparse-point defenses still run.

## Safe troubleshooting and validation

1. Run `status` with the same `ConfigPath` and port, and check managed state, listening PID and health result. Do not forcibly stop unknown processes; first identify their identity, purpose and owner.
2. Check configuration, authorized real project roots, state/profile directories, Node, trusted native Git and verified Codex version. Bridge authorization is separate from Desktop project association. See the [full handbook](../README-BRIDGE-LAB.md#layout-and-operation).
3. If local health works but ChatGPT cannot connect, check the profile MCP URL, Tunnel/workspace association, permissions and client diagnostics. Protect credentials when inspecting logs. Do not infer connectivity solely from a live PID.
4. Once connected, check allowed roots with `codex_settings`, and make a real read-only `git_status` or `read_project_file` call for an authorized project. For task verification, use `read-only` and `codex_status` as described in the [quick start](../QuickStart-BRIDGE-LAB.md#6-connect-chatgpt-and-verify-a-real-mcp-call).
5. A disconnect or timeout is not cancellation. Once connected, check the Job/Thread state and potential side effects before deciding what to do next; do not blindly repeat a request with side effects.

To check PowerShell syntax without starting the controller, run the following parser at the repository root:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\scripts\bridge-lab.ps1).Path, [ref]$tokens, [ref]$errors) | Out-Null
$errors
```

For offline regression, use `pwsh -NoProfile -File .\scripts\bridge-lab.Tests.ps1`, or Windows PowerShell 5.1 via `powershell` where supported and permitted by the local execution policy. Tests use temporary configuration and simulated processes, ports, HTTP responses and clocks. They cover normal and slow startup, readiness timeout, immediate or later exits, process exits during health checks, unhealthy responses, unrelated listeners and failed-start rollback. They do not start or stop real services or read actual runtime configuration or SQLite. They do not replace cold-start verification after a real Windows restart.

## Phase history and scope of verification

T4.1-B V3 focused on a fixed, verified Codex CLI, credential environment mapping, separate logs and protection using PID, creation time and command-line markers. T4.4-E added filling in missing managed components according to current state and rolling back only newly started processes on failure. The two phase documents were consolidated into this reference; their originals and phase changes are available in Git history.

The [collaboration workflow guide](GPT-Codex-Collaboration-Workflow-v1.0.md) records historical tests of ordinary startup and single-component recovery in a specific T4–T5 environment. Those results do not automatically apply to other machines or newer versions. Not every exceptional safeguard has undergone dynamic fault injection, and forced loss of connectivity while a task is running has not been sufficiently tested. This consolidation compared source and historical records; it did not start services or repeat live runtime tests.

Controller help: `./scripts/bridge-lab.ps1 help` (also `-Action help`, `--Action help`, `-H` or `/?`). Help does not start services or read configuration.
