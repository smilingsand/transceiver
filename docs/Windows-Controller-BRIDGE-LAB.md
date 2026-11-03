# Bridge Lab Windows Controller Reference

[English](Windows-Controller-BRIDGE-LAB.md) | [简体中文](Windows-Controller-BRIDGE-LAB-CN.md)

The [controller](../scripts/bridge-lab.ps1) starts, inspects and stops its managed reverse Bridge and Tunnel client on Windows PowerShell 5.1+. For first-time preparation see [Windows setup](Windows-Setup-BRIDGE-LAB.md) and the [quick start](../QuickStart-BRIDGE-LAB.md). It runs `plugins/transceiver/scripts/reverse-runtime.mjs`, not the upstream bundled entry. The Bridge defaults to loopback `127.0.0.1:8876`, with `/mcp` and `/healthz`; local HTTP has no authentication. Do not expose it to a LAN or internet.

The controller does not create projects, Tunnels, profiles or account permissions. A running Bridge does not reload changed project configuration on another `start`: restart managed components when tasks are idle and check `codex_settings` `capabilities.allowedRoots`. This is a cwd policy, not an OS read whitelist.

## Parameters and prerequisites

The script resolves the repository root from its own location. Explicit arguments override root `bridge.env`, then script defaults. Paths and relative tool paths resolve against the repository root; bare `NODE_EXE=node.exe` resolves through PATH.

| Parameter | Purpose |
| --- | --- |
| `Action` | `status` (default), `start`, `stop`, `cleanup-logs`. |
| `All`, `DryRun` | Cleanup only: ignore age, or preview without deletion. `-All -DryRun` is valid; `-All` cannot accompany explicit `-LogRetentionDays`. |
| `LogRetentionDays` | 1–3650; default 7. Even with `-All`, a configured `LOG_RETENTION_DAYS` must be valid; zero is invalid. |
| `ConfigPath` | Project policy, default `<repo>/config.json`; must match the project CLI's `TRANSCEIVER_CONFIG`. |
| `RuntimeDir` | Default `<repo>/runtime`, independent of `ConfigPath`. |
| `ControlDir`, `LogDir` | Default to `control` and `logs` under `RuntimeDir`; can be overridden. |
| `StateDir`, `ProfileDir` | Default to `state` and `tunnel-profiles` under runtime; both directories must exist before start. |
| `TunnelProfile`, `TunnelExe` | Existing profile name and tunnel-client executable; profile must point to the local MCP URL. |
| `GitExe` | Trusted absolute native Git path, e.g. `mingw64/bin/git.exe`; deterministic Git does not fall back to PATH. |
| `CodexBin` | Directory containing `codex.exe`, not the executable itself. Empty selects the script's fixed Desktop-managed directory. |
| `ExpectedCodexVersion` | Exact verified version number, default empty; new Bridge startup requires `codex --version` to equal `codex-cli <version>`. For output `codex-cli 0.123.0`, supply `0.123.0` without the prefix. |
| `NodeExe`, `Port` | Node executable (source requires Node 22+) and local port (default 8876). |
| `BridgeStartupTimeoutSeconds` | New Bridge readiness budget, 1–3600 seconds, default 30. |
| `DefaultSandbox`, `DefaultAccessStrategy`, `AllowWrite`, `AllowDangerFullAccess` | Defaults `read-only`, `read-only`, `0`, `0`. Use changes only with appropriate authorization. |

Before starting, the config file, Tunnel and Git executables, source entry, state and profile directories must exist, with compatible Codex, source dependencies and valid project authorization. Do not automatically select a newer CLI or delete Desktop-managed executables after an update; verify compatibility and specify its directory and version. `PORT` or `-Port` also sets child `TRANSCEIVER_REVERSE_PORT`, overriding its inherited value; the profile URL must match.

## Environment and state

On Bridge start, `ConfigPath`, `StateDir` and `GitExe` map to `TRANSCEIVER_CONFIG`, `TRANSCEIVER_STATE_DIR` and `TRANSCEIVER_GIT_EXECUTABLE`; the selected Codex directory is temporarily added to the child PATH. For Tunnel start, process then Windows user environment supplies `OpenAI_Tunnel_API_KEY` and `Tunnel_ID`, mapped to `CONTROL_PLANE_API_KEY` and `CONTROL_PLANE_TUNNEL_ID`. The ID includes `tunnel_`. The client is invoked with `run --profile <TunnelProfile> --profile-dir <ProfileDir>`, so an inherited `TUNNEL_CLIENT_PROFILE_DIR` does not select the controller's profile directory. The calling environment is restored afterward. Never place credentials in root configs, chat or public logs. Restrict profiles, state and logs; Git ignore is not access control.

`ControlDir/processes.json` records managed PIDs, creation times, config and Codex paths and log paths, without credentials. Each component has redirected stdout/stderr under `LogDir`; Bridge SQLite and other state belong to `StateDir`. Review and redact diagnostics before sharing.

## bridge.env and directory migration

The [bridge.env.example](../bridge.env.example) and [config.json.example](../config.json.example) are templates; actual files and runtime are not committed. The config example starts with an empty `projects` object; add only explicitly authorized projects. `bridge.env` accepts UTF-8 with or without BOM, blank lines, full-line comments, whitespace-prefixed trailing comments and single- or double-quoted values. Backslashes are literal; variables and expressions are not expanded. Unknown or duplicate keys, malformed input, invalid port and non-`0`/`1` permission switches fail without echoing values. Secret keys are not allowed.

| File keys | Parameters |
| --- | --- |
| `TUNNEL_PROFILE`, `TUNNEL_EXE`, `GIT_EXE` | `TunnelProfile`, `TunnelExe`, `GitExe` |
| `CODEX_BIN`, `CODEX_VERSION`, `NODE_EXE`, `PORT` | `CodexBin`, `ExpectedCodexVersion`, `NodeExe`, `Port` |
| `BRIDGE_STARTUP_TIMEOUT_SECONDS`, `LOG_RETENTION_DAYS` | `BridgeStartupTimeoutSeconds`, `LogRetentionDays` |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX`, `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | `DefaultSandbox`, `DefaultAccessStrategy` |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE`, `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | `AllowWrite`, `AllowDangerFullAccess` |

Explicit arguments override file values and script defaults, including all four permission settings; inherited permission environment values do not replace controller defaults. Child settings are temporary and restored even on failure. Running components are not restarted automatically.

Old directories are not migrated or deleted automatically. With old managed processes, pass the old `-ControlDir '<old>/control'` on every `status`, `start` and `stop`, retaining the original `ConfigPath`, `StateDir`, `ProfileDir`, port and other settings. `ConfigPath` alone does not select old PID records. Identity checks still apply; missing records do not adopt unknown processes. When tasks are idle, safely stop using old records, manually migrate config, state and profiles, then switch to the new runtime. Do not copy records to adopt live processes or start simultaneously with two control directories.

## Process management and readiness

The controller checks recorded PID, command-line marker and creation time within five seconds to reduce PID reuse errors. It does not adopt or kill unknown listeners or bulk-kill `node.exe`; it is not a full process-tree or graceful-shutdown manager.

```powershell
.\scripts\bridge-lab.ps1 -Action status
.\scripts\bridge-lab.ps1 -Action start
.\scripts\bridge-lab.ps1 -Action status
```

`status` reports managed identities, loopback health, listener PID and recorded logs. Health alone does not prove the responder is the managed Bridge. A listener without a record generates a warning; status is not a complete inventory of unknown Tunnel processes. `start` preserves healthy managed components and fills missing ones: both stopped starts both; both healthy preserves both; healthy Bridge plus stopped Tunnel starts only Tunnel; live Tunnel plus stopped Bridge starts only Bridge. Unknown listeners, unmanaged tunnel-client or live unhealthy managed Bridge cause refusal to blindly adopt or kill. Failure rolls back only newly started processes, retaining prior components and records. There is no cross-process lock: do not run concurrent starts.

A new Bridge must own the listener and pass `/healthz` within the readiness budget. The default is 30 seconds; set `BRIDGE_STARTUP_TIMEOUT_SECONDS=60` or pass `-BridgeStartupTimeoutSeconds 60`. Timing starts before `Start-Process`, includes process creation and readiness, but excludes earlier dependency and version checks and subsequent Tunnel startup. A monotonic timer polls at most every 500 ms; health requests last at most two seconds and shrink to remaining whole seconds; none starts with under one second remaining. OS process creation, port queries and scheduling cannot be hard-interrupted by this budget. Exit is checked before and after requests; an in-flight request can consume its remaining timeout. New Tunnel startup checks only roughly two seconds of process liveness; managed status does not prove cloud connectivity.

Startup diagnostics are written to the terminal and a separate `.startup.log` appended to the Bridge stdout path. They report PID, elapsed milliseconds, exit state/code, listener PID, latest health result and count, and timeout. `process-exited`, `port-not-listening`, `health-check-failed`, `wait-timeout` and `listener-pid-mismatch` distinguish failures; mismatch is not adopted or cleaned up. Failure diagnostics describe pre-cleanup state. The older 20-iteration loop could spend roughly 50 seconds in sleeps and HTTP waits plus system overhead; a cold-start timeout was a hypothesis, not a proven cause.

When tasks are idle, use the same settings:

```powershell
.\scripts\bridge-lab.ps1 -Action stop
.\scripts\bridge-lab.ps1 -Action status
```

Stop handles identity-matched Tunnel then Bridge and removes PID records. Unknown or mismatched processes are not killed. Configuration, profiles and Bridge state are retained.

## Log cleanup

Use the same custom `ConfigPath`, `ControlDir` and `LogDir` as the running instance. Cleanup does not start or stop services or alter PID records, Bridge state or SQLite.

```powershell
.\scripts\bridge-lab.ps1 -Action cleanup-logs -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs
.\scripts\bridge-lab.ps1 -Action cleanup-logs -LogRetentionDays 14
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All
```

Retention precedence is explicit argument, `LOG_RETENTION_DAYS`, then seven days; range 1–3650. The cutoff is calculated once; only `LastWriteTime` strictly before it is eligible. `-All` ignores age but retains other protections. Parameters and actions are case-insensitive.

Only direct children of resolved `LogDir` matching `bridge-*-out.log`, `bridge-*-err.log`, `tunnel-*-out.log` or `tunnel-*-err.log` with nonempty wildcard are considered, including hidden files. No recursion or `.startup.log` cleanup. Directories, symlinks, junctions, reparse points and hard links are retained. A reparse point in the log root or any ancestor rejects the whole cleanup.

Cleanup reads `ControlDir/processes.json`, checks config path and process identity, and protects each live component's recorded stdout and stderr regardless of age or size. Confirmed absent PIDs can be treated as exited. Reused PID, incomplete record, missing or relative active path, failed process query, unreadable Node/Tunnel command line, or unrecorded Bridge/Tunnel results in conservative retention. Missing or corrupt records also retain everything; after normal stop removes the record, cleanup does not guess.

Before each deletion it rechecks state, identity, active paths, filename, location, type and time. Windows native handles lock ancestors against replacement, exclusively open each candidate, recheck type, link count and time and delete through that handle. Busy, inaccessible, vanished or changed files are reported individually. Windows and working `Add-Type`/Win32 calls are required; restricted policy or inaccessible ancestors cause retention and failure reporting. Avoid concurrent controller configuration or state changes.

Output contains filenames, reasons and counts, not log contents or credentials. `Eligible` includes candidates sent to handle processing, including open/delete failures; handle recheck mismatches become `Skipped`. `Deleted` counts successful deletions; `Protected active` counts actually inspected protected files; `Skipped` includes nonmatching files, directories, links, retained-age and conservative skips; `Failed` counts failures, including one operation failure if the entire LogDir cannot be safely accessed. No estimated active count is invented. Dry run performs the same safety checks and previews without deletion.

## Troubleshooting and validation

Check `status` with the same config and port, managed identities, listener and health. Identify unknown processes before acting. Check authorized real root, state/profile paths, Node, trusted Git and tested Codex version. If local health works but ChatGPT does not, check profile URL, Tunnel/workspace association, permissions and client diagnostics; redact logs. Verify `allowedRoots` and make a real read-only `git_status` or `read_project_file` call. For task validation use `read-only` and `codex_status`. Timeout is not cancellation; inspect state and side effects before retrying.

PowerShell syntax can be checked without starting the controller:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\scripts\bridge-lab.ps1).Path, [ref]$tokens, [ref]$errors) | Out-Null
$errors
```

Offline regression can use `pwsh -NoProfile -File .\scripts\bridge-lab.Tests.ps1` or Windows PowerShell 5.1 subject to execution policy. It uses temporary configuration and mocked processes, ports, HTTP and clocks; it does not start real services or read actual runtime config or SQLite. It exercises startup, timeout, exit, health, listener, rollback and cleanup safeguards. Real symlink tests may be skipped without permission; junction and reparse defenses still run. It does not replace a real cold start after Windows reboot.

## History and validation

T4.1-B V3 focused on a verified Codex CLI, environment mapping, separate logs and PID identity; T4.4-E added filling missing managed components and rollback of newly started processes. Historical originals are in Git history. The [workflow guide](GPT-Codex-Collaboration-Workflow-v1.0.md) describes historical T4–T5 tests on a particular setup, not guarantees for other systems or versions. Not all exceptional protections have dynamic fault-injection coverage, and forced disconnection during a running task remains insufficiently verified. Documentation consolidation did not restart services or rerun live tests.

Controller help: `./scripts/bridge-lab.ps1 help` (also `-Action help`, `--Action help`, `-H`, or `/?`). It exits without starting services or reading configuration.
