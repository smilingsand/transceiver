# Transceiver Bridge Lab Handbook

[English](README-BRIDGE-LAB.md) | [简体中文](README-BRIDGE-LAB-CN.md)

Bridge Lab connects task orchestration in ChatGPT with local Codex project work while retaining project authorization, task status, and independently inspectable results.

For first-time use, begin with the [Windows six-step quick start](QuickStart-BRIDGE-LAB.md). This handbook describes the system, its security boundaries, and its tools. Consult the following resources as needed:

- [Windows setup reference](docs/Windows-Setup-BRIDGE-LAB.md): prepare dependencies and understand configuration requirements.
- [Windows controller reference](docs/Windows-Controller-BRIDGE-LAB.md): processes, status, log cleanup, and troubleshooting.
- [Collaboration workflow](docs/GPT-Codex-Collaboration-Workflow-v1.0.md): understand the roles of people and tools; the [GPT collaboration instructions](docs/GPT-Codex-Collaboration-Instructions-CN.md) can be copied into GPT Project Instructions.
- [Maintainer architecture guide](docs/Maintainer-Architecture-BRIDGE-LAB-CN.md): source assembly, upgrades, and verification.

The default local layout consists of `bridge.env` and `config.json` at the repository root, together with `runtime/{state,tunnel-profiles,control,logs}/`. On first setup, copy and fill in the two root `.example` templates (never overwrite existing real configuration). Credentials must be read only from a protected Windows environment. Configuration precedence is: explicit parameters > `bridge.env` > defaults. Before migrating old runtime records, read the [directory migration instructions](docs/Windows-Controller-BRIDGE-LAB.md#bridgeenv-and-directory-migration) and retain an explicit `ControlDir` so existing managed processes can still be identified.

## Why Bridge Lab?

Discussing requirements in ChatGPT and inspecting or modifying repositories in local Codex often involves manually copying context, commands, and results. For long-running tasks, multi-turn work, or interrupted connections, it can also be hard to tell whether the work is still running. Bridge Lab explores connecting the two through MCP: ChatGPT submits a clearly defined task, the Bridge hands it to local Codex within an authorized scope, and status and read-only inspection tools make the results independently verifiable.

The goals are to reduce manual transcription, provide traceable tasks and sessions, and control project selection. Bridge Lab is not a general-purpose remote desktop. It does not automatically authorize access to the entire computer, synchronize all history or memory between the two systems, or guarantee that every task completes correctly. The user must still determine the authorization scope, review results, and approve sensitive operations as required by the project.

## Origin and scope

This repository is a fork of [mark9804/transceiver](https://github.com/mark9804/transceiver). Upstream Transceiver provides a bidirectional handoff layer: Codex can use an existing Web transport to send provenance-bearing handoffs to ChatGPT, while ChatGPT can call a local reverse Bridge through a Tunnel. Upstream documentation and attribution are preserved in the [English README](README.md) and [Chinese README](README.zh-CN.md).

This handbook focuses on the fork's Windows source-based runtime and reverse Bridge development workflow. The upstream README's macOS/Linux installation steps, bundled entry point, and original read-only descriptions should not automatically be treated as applicable configuration for this fork. Forward handoffs from Codex to ChatGPT additionally require a separately installed and signed-in Web transport. That transport is not a prerequisite for the reverse path described below.

## What can it do?

- Inspect authorized projects directly through `read_project_file`, `git_status`, and `git_diff`, without creating Codex tasks for those operations.
- Start or continue work using `codex_task`, query a Job with `codex_status`, and steer, stop, or inspect work within the capabilities exposed by the tools.
- Organize work and verification through Activities, preserve continuous work context in Threads, and track individual executions through Jobs.
- Query the model catalog and persisted Settings; new Threads can use defaults or explicitly select a supported model and reasoning effort.
- Start, inspect, and stop managed Bridge and Tunnel processes with the Windows controller, preserving healthy running components when possible.

A typical scenario is to inspect a repository and its existing modifications in read-only mode, ask Codex to analyze a clearly bounded problem, implement changes after user authorization, and then use independent file and Git tools from ChatGPT to verify the results.

## Architecture and data flow

```text
User ↔ ChatGPT conversation / enabled MCP connector
                         │ MCP requests and results
                         ▼
               OpenAI Secure MCP Tunnel
                         │ outbound connection
                         ▼
                 Windows tunnel-client
                         │ local HTTP
                         ▼
         reverse MCP Bridge: 127.0.0.1:8876/mcp
                    │                    │
                    │ deterministic      │ tasks, status,
                    │ file/Git reads     │ and sessions
                    ▼                    ▼
         Authorized project       Codex CLI app-server
             directory                   │
                                         ▼
                              Authorized cwd / Git workspace
```

The Windows controller manages the Bridge and Tunnel processes locally; it is not another cloud service on the request path. The Bridge's `healthz` endpoint checks the local service, whereas an actual MCP tool call verifies the path from ChatGPT through the Tunnel to the local machine. The Bridge persists sessions, Jobs, Settings, and other state; ChatGPT history, Codex Desktop, and that state are not one shared memory.

Only roots with both `sync` and `allowCodexTasks` enabled in project configuration are eligible for reverse tasks. The Bridge marks tasks, continuations, and steering messages with the `|from_chatgpt|:` provenance prefix. Model results still require review. Files, tool results, and external prompts may contain untrusted instructions and must not expand user authorization.

### Security boundaries

1. The source entry point binds to `127.0.0.1` and disables local HTTP authentication by default, relying on loopback and Tunnel access boundaries. Never expose it directly to a LAN or the public internet. Tunnel identity, workspace association, and user permissions must be configured correctly.
2. Allowed roots restrict task `cwd` selection and project selection; **they are not an operating-system-level file-read allowlist**. Deterministic file tools have separate path validation, but their restrictions do not establish complete isolation for the Codex process.
3. Source defaults for sandbox and access strategy are `read-only`, with writing and `danger-full-access` disabled by default. Environment variables may override defaults, while actual execution remains subject to upstream validation and runtime restrictions. Explicitly use `read-only` for read-only tasks; use `workspace-write` only when the user has authorized it and effective configuration permits it.
4. Do not assume every reverse task has network access disabled: network restrictions depend on the actual sandbox and environment. The source entry point sets the approval policy to `never`; do not expect an interactive approval prompt. Additional authorization must be decided explicitly before starting an operation that requires it.
5. Upstream filename-based secret scanning is disabled at this entry point. Keep credentials outside the repository and authorized projects. Do not put secrets in chats, shell history, commits, configuration examples, or logs. Restricted directories and operating-system permissions must still be configured by the administrator.

## Default runtime layout and configuration roles

The following is the default layout; runtime files are generated as needed. Templates are intended for public distribution, while real configuration and `runtime/` are Git-ignored.

```text
<repo>\
├── bridge.env.example       Non-secret controller settings template
├── bridge.env               Local controller settings; no secrets
├── config.json.example      Example project policy template
├── config.json              Local project policy; no secrets
├── scripts\bridge-lab.ps1   Controller
└── runtime\
    ├── state\               Bridge state and SQLite
    ├── control\             Process records: processes.json
    ├── logs\                Bridge/Tunnel logs and startup diagnostics
    └── tunnel-profiles\     Tunnel profiles
```

On first setup, copy the templates at the repository root without overwriting existing configuration:

```powershell
if (-not (Test-Path -LiteralPath .\bridge.env)) { Copy-Item .\bridge.env.example .\bridge.env }
if (-not (Test-Path -LiteralPath .\config.json)) { Copy-Item .\config.json.example .\config.json }
```

Git ignore rules are not an access boundary: if the repository itself is an authorized workspace, that workspace includes `runtime/`. Root configuration must not contain secrets; credentials belong in a protected location outside the repository and authorized projects. Tunnel profiles may contain sensitive information and must never be published. Restrict access to profiles and logs.

## Repository layout and implementation choices

```text
transceiver/
├── README.md, README.zh-CN.md          Upstream documentation
├── README-BRIDGE-LAB-CN.md             This handbook (Chinese edition)
├── QuickStart-BRIDGE-LAB-CN.md         First-time setup and daily operations
├── docs/                                Work rules and historical design records
├── scripts/bridge-lab.ps1              Windows process controller
└── plugins/transceiver/
    ├── scripts/reverse-runtime.mjs     Fork's source runtime entry point
    ├── scripts/reverse-http.mjs        MCP HTTP and shared-state assembly
    ├── scripts/deterministic/          Project-file and read-only Git tools
    ├── scripts/transceiver.mjs         Project policy and forward-handoff CLI
    ├── dist/reverse-bridge/            Bundled entry used by upstream installation
    ├── skills/transceiver/             Codex plugin skill and references
    ├── tests/                           Automated tests
    └── package.json                    Node dependencies, build, and test commands
```

The source entry point uses Node.js, the MCP SDK, the Codex app-server, and upstream `codex-mcp-bridge-for-chatgpt` components. Project policy, deterministic tools, and unified HTTP assembly belong to this fork. The source relies on a particular internal build of an upstream component, so compatibility must be checked when upgrading.

**Entry-point distinction:** The controller runs `plugins/transceiver/scripts/reverse-runtime.mjs`, which requires source dependencies to be resolvable. The `plugins/transceiver/dist/reverse-bridge/index.mjs` described in upstream documentation is the bundled entry point; `npm run reverse:start` also uses that bundled entry point. Do not assume that successfully running one entry point proves the other behaves identically. Source-development dependencies and the lockfile are in `plugins/transceiver/`; prepare them according to that directory's `package.json`, lockfile, and local permissions. Installation accesses package registries and changes the local dependency tree. Upstream's bundled installation explicitly does not require a rebuild; do not conflate the two routes.

## Prerequisites

The following list covers what is required to go from an empty environment to an operational one. The user must provision accounts, organizations, and installed binaries; this repository does not configure those services automatically.

1. Windows PowerShell 5.1 or later, Node.js 22+, Git, and a stable checkout of this fork. The target project must be an existing local directory explicitly authorized by the user. Git tools require a usable Git repository.
2. A Codex CLI capable of running `app-server`, with the required login and access rights. The controller defaults to a fixed Desktop-managed CLI directory and an empty expected-version setting. Supply a verified CLI directory and matching version; it will not automatically pick a new version from `PATH`.
3. An installed `tunnel-client`, an OpenAI Platform organization with Tunnel permissions, and a ChatGPT account or workspace with Developer Mode available. Creating or editing a Tunnel requires Tunnels Read + Manage; running the client and selecting it in ChatGPT requires Tunnels Read + Use. Associate the Tunnel with the correct organization and ChatGPT workspace.
4. Prepared source dependencies in the checkout. Default configuration resides at the repository root, with state and Tunnel profiles under `<repo>\runtime`. The controller expects the configuration file, Git and Tunnel executables, and pre-existing state and profile directories.
5. A Tunnel profile that points to the local `http://127.0.0.1:8876/mcp`, with a profile name and directory matching the controller parameters. See the upstream [Tunnel setup steps](README.md#7-configure-and-run-tunnel-client) and the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). The upstream example uses `sample_mcp_remote_no_auth`. Inspect an existing profile before replacing it. Actual UI and client versions may vary.

You can first check the basic tools in PowerShell, replacing paths with the actual ones:

```powershell
node --version
& 'C:\Path\To\Git\mingw64\bin\git.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' app-server --help
& 'C:\Path\To\tunnel-client.exe' help quickstart
```

These paths are illustrative, not installation locations to copy verbatim. Verify the CLI version and dependency compatibility before configuring the controller; do not change version settings merely to bypass a version check.

## Authorized projects and configuration

`bridge.env` holds non-secret controller parameters, while `config.json` stores project policy; credentials remain in a protected Windows environment. For first-time template copying, parameter explanations, and CLI commands, see [quick-start step 4](QuickStart-BRIDGE-LAB.md#4-configure-the-controller-and-authorize-projects). For credentials and profiles, see [step 3](QuickStart-BRIDGE-LAB.md#3-set-up-credentials-and-the-profile-securely).

Authorize only real project directories explicitly selected by the user. A project enters the reverse Bridge's allowed roots only when both `sync` and `allowCodexTasks` are true. Write permission is still governed by the effective sandbox, Bridge policy, and operating-system permissions. Restart the Bridge when tasks are idle to apply configuration changes. `codex_settings` → `capabilities.allowedRoots` reflects current Bridge configuration, not an OS-level file-read allowlist.

Opening a project in Codex Desktop, choosing a ChatGPT Project, and authorizing a Bridge project are independent actions. Git ignore rules do not provide access control. If the checkout itself is an authorized root, `runtime/` falls within its scope; protect potentially sensitive state, profiles, and logs.

## Windows controller: start, status, and stop

Once configured, the controller reads local settings from root `bridge.env`. Use `status` to inspect managed state, listener PID, and local health; `start` to launch missing components; and `stop` to terminate managed processes with matching identities. For initial setup and everyday commands, see [quick-start step 5](QuickStart-BRIDGE-LAB.md#5-start-check-stop-and-maintain-logs). For custom directories, migration of old records, and exceptional situations, consult the [controller reference](docs/Windows-Controller-BRIDGE-LAB.md).

Preview log cleanup with `cleanup-logs -DryRun`; use `-All -DryRun` to preview cleanup without age filtering. `-All` still protects active logs and cannot be combined with an explicitly supplied `-LogRetentionDays`. Missing records or situations where safety cannot be established are skipped conservatively. See [log cleanup](docs/Windows-Controller-BRIDGE-LAB.md#log-cleanup).

A running Tunnel process proves only that the process is alive; a local health check does not establish cloud connectivity. After configuration changes, invoking `start` again does not reload an already running Bridge. Restart managed components when tasks are idle.

## Connect the Tunnel and ChatGPT

1. Create or select a Tunnel in the Platform, with the required organization, workspace, and least-privilege permissions. Prepare a matching local profile, credentials, and client. The profile must point to the actual Bridge MCP URL.
2. Start the Bridge and `tunnel-client`, then verify local `status` and health first. A running managed Tunnel only demonstrates process liveness; if needed, use the client's `doctor` command to check the profile and local MCP reachability.
3. Enable Developer Mode in ChatGPT settings, then create an MCP connection in the connectors/apps settings using **Tunnel** as the connection method. Select the same Tunnel and inspect the discovered tools. UI terminology and placement may change; consult the current [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
4. Start a new conversation and enable the newly created connector from the conversation's tool/app selector. Its name is whatever you chose during setup; it need not be “Transceiver.” Do not treat the OpenAI-hosted gateway URL as an OAuth MCP server: the local Bridge does not implement that OAuth flow.

The ChatGPT connector and the local plugin installed in Codex are separate installations. For forward-handoff skills, the upstream instructions use `codex plugin marketplace add` and `codex plugin add transceiver@mark9804`; then inspect `/hooks` in a new Codex session and decide whether to trust them. Do not describe local plugin installation as a required step for creating the ChatGPT connector when only the running reverse MCP connection is needed. See the [upstream installation instructions](README.md#3-install-the-local-plugin).

### Set up ChatGPT Project collaboration instructions

If using a ChatGPT Project, copy the contents of the [GPT collaboration instructions](docs/GPT-Codex-Collaboration-Instructions-CN.md) into that Project's Instructions. The file is not loaded automatically just because it exists in the repository; it does not authorize projects or enable connectors by itself. See the [collaboration workflow](docs/GPT-Codex-Collaboration-Workflow-v1.0.md) for context and work practices.

## Practical MCP tool guide

The tools and schemas actually discovered by the connector are authoritative. The objects below represent tool arguments, not PowerShell commands.

### Deterministic file reads and Git

`project` is the **exact name** in the authorization configuration, not a path. The `path` for `read_project_file` is relative to the project, accepts restricted UTF-8 text only, and rejects traversal and symlinked paths. You may specify one-based `startLine` and `lineCount`, up to 500 lines per request. The maximum file size is 1 MiB, and the response limit is 64 KiB. Check `ok`, `truncated`, and the returned line range; paginate if necessary.

```json
{"project":"example-project","path":"README.md","startLine":1,"lineCount":80}
```

`git_status` takes `{"project":"example-project"}`. `git_diff` also needs `mode`, either `unstaged` or `staged`. Results may be truncated or time out; check `ok`, `complete`, `truncated`, `timedOut`, and related fields. Untracked files are not included in an ordinary diff and must be read separately. These tools do not create Codex tasks.

The deterministic MCP tools `git_add`, `git_commit`, and `git_push` require user authorization and their own server-side `gitWrite` permissions, each false by default. Commits require repository-local identity and reject active hooks. Push requires an exact remote URL/branch grant; GitHub HTTPS can separately opt into Windows GCM, while SSH is unsupported. Review the entire staging index before committing. See [controlled Git write tools](docs/Git-Write-Tools-BRIDGE-LAB.md) for settings, examples, and recovery.

### Tasks, models, and lifecycle

First use `codex_settings` and `codex_models` to inspect current defaults and available models. Start a new task with `codex_task`, an authorized absolute `cwd`, a `read-only` sandbox, and `sessionMode: new`; use a unique UUID-format `requestId` for each logical request. Record the Job, Thread, and Activity identifiers, and query `codex_status` until the terminal state is reached. Do not infer that a still-running task has failed merely because a tool call times out.

To continue the same Thread, use `sessionMode: continue` and its exact `threadId`, retaining a compatible working directory and permission boundary. The current Bridge rejects changes to model or reasoning effort during continuation; to change them, start a new Thread and hand over essential context. Default model and effort come from persisted Settings; a new Thread can override them explicitly. Parameters stored by the Bridge are not independent proof of model-side execution or Token consumption.

Activities organize verification and completion; Jobs track individual executions; Threads preserve continuous context. Follow the current tool schema for Activity state transitions. Successful verification may already have completed an Activity, so avoid duplicate completion attempts. After an interruption, query authoritative Job/Thread status first. Retry the same logical request only with the same `requestId` and exactly the same arguments; do not send changed content under an old ID.

Codex Desktop may group externally created Threads under an added local project based on `cwd`. In historical testing, restarting Desktop was necessary before a new Thread appeared; real-time refresh is not guaranteed. Treat MCP status as authoritative. ChatGPT Projects, Desktop Projects, and Bridge project identifiers are not automatically equivalent.

See [status scanning and security limits](docs/Execution-Permissions-BRIDGE-LAB.md#git-status-scanning-and-timeouts), including the optional tracked-only scope.

## Example workflow: from inspection to acceptance

1. The user identifies a project and a read-only goal. Confirm the exact project name, `cwd`, sandbox, prohibited actions, and expected result.
2. Enable the connector in ChatGPT, call `git_status`, `read_project_file`, and `git_diff` as needed, and record pre-existing changes.
3. If deterministic tools are insufficient, ask `codex_task` to analyze the problem in `read-only` mode. Use `codex_status` until terminal, retaining Thread and Job IDs.
4. If the user subsequently authorizes modifications, first verify that effective permissions allow `workspace-write`; identify allowed files and tests. Do not interpret earlier read-only authorization as permission to write.
5. Use independent file and Git inspection to verify the outcome, pre-existing changes, and untracked files. Review test reports and unresolved verification gaps. Commits, pushes, deletions, and other sensitive operations follow project policy and user authorization.

## Maintenance and troubleshooting

| Symptom | What to check |
| --- | --- |
| `project_not_configured` or project not found | Check whether the CLI and controller use the same configuration, the project's real path, both authorization flags, and unique project name. Do not broaden allowed roots casually. |
| Bridge unhealthy or port in use | Inspect the listener and managed state reported by `status`, the actual port, and local logs. Identify unknown processes before attempting to stop them. |
| Version mismatch | Verify `CodexBin` directory and `ExpectedCodexVersion`. After Desktop updates, test compatibility instead of bypassing the pinned-version check. |
| Tunnel running but ChatGPT cannot connect | Check profile URL, Tunnel ID, organization/workspace association, permissions, and client diagnostics; then perform a real MCP call. |
| Connector reports an OAuth error | Confirm that the connection uses Tunnel instead of treating the gateway URL as an OAuth server. |
| Task timeout or lost connection | After reconnecting, inspect Job/Thread status before deciding whether to retry or stop; do not presume the task was canceled. |
| Thread missing from Desktop | Check matching `cwd` and local project. It appeared after a restart in the historical environment; live refresh is not guaranteed. |

After upgrading Node, Codex, the upstream Bridge, or the Tunnel client, first check dependency and internal API compatibility, then run a limited read-only verification. Protect configurations, state, and logs; retain backups needed for recovery and avoid publishing raw logs. The source entry point's `--doctor` can check app-server, authorized projects, and local Bridge reachability, but it does not replace a real call from ChatGPT. Run it with the same configuration and verified CLI environment as the controller.

## Verified and not yet verified

The [collaboration workflow](docs/GPT-Codex-Collaboration-Workflow-v1.0.md) explains the working process and retains historical T4–T5 evidence for permissions, idempotency, recovery, Threads, models, and Desktop in particular environments. Those results do not prove that every new machine or version is verified. For the controller's development history and validation limits, see the [Windows controller reference](docs/Windows-Controller-BRIDGE-LAB.md).

The following remain insufficiently verified or unresolved: independent proof of actual model-side execution parameters, complete Token accounting, real-time Desktop refresh for external Threads, forced source-disconnection recovery during a running task, and dynamic fault injection for all controller exception safeguards. This documentation revision did not start services or rerun end-to-end testing.

## References and license

- [Maintainer architecture and verification guide](docs/Maintainer-Architecture-BRIDGE-LAB-CN.md): source assembly, deterministic-tool boundaries, builds, and maintainer verification.
- [Quick start](QuickStart-BRIDGE-LAB.md): the main entry point for first-time setup, daily operation, and read-only verification.
- [Windows setup guide](docs/Windows-Setup-BRIDGE-LAB.md): Windows dependencies and environment reference.
- [GPT–Codex collaboration workflow](docs/GPT-Codex-Collaboration-Workflow-v1.0.md): human-oriented process explanations, examples, and historical evidence.
- [GPT collaboration instructions](docs/GPT-Codex-Collaboration-Instructions-CN.md): rules that can be copied into ChatGPT Project Instructions, but are not loaded automatically from the repository.
- [Windows controller reference](docs/Windows-Controller-BRIDGE-LAB.md): parameters, process identity, recovery behavior, and scope of historical validation.
- [Reverse Bridge skill reference](plugins/transceiver/skills/transceiver/references/reverse-bridge.md) and [third-party notices](plugins/transceiver/THIRD_PARTY_NOTICES.md).

Bridge Lab is an independently maintained enhanced version of the original [Transceiver](https://github.com/mark9804/transceiver). It retains the original core architecture while adding Windows environment support, writable Codex development tasks, independent MCP file and Git tools, and automatic GitHub push capabilities.

We thank the original Transceiver author and contributors for their work. This project retains upstream copyright notices and attribution and continues to be distributed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). Use, modification, and distribution must also comply with applicable third-party licenses.
