# Bridge Lab on Windows: Six-Step Quick Start

[English](QuickStart-BRIDGE-LAB.md) | [简体中文](QuickStart-BRIDGE-LAB-CN.md)

This guide takes a new Windows user from the fork's `dev/bridge-lab` branch to a real, read-only ChatGPT MCP call. Run the commands in Windows PowerShell 5.1 or later, substituting your own paths and project name. See the [Windows setup guide](docs/Windows-Setup-BRIDGE-LAB.md) and [controller reference](docs/Windows-Controller-BRIDGE-LAB.md) for details.

## 1. Get the fork and select the branch

The verified `origin` of this checkout is shown below. Substitute your own mirror if appropriate. For a ZIP download, select `dev/bridge-lab` on the fork page first.

```powershell
git clone --branch dev/bridge-lab https://github.com/smilingsand/transceiver.git
Set-Location .\transceiver
git branch --show-current
```

The last command should print `dev/bridge-lab`. If you already have a checkout, protect existing changes before `git switch dev/bridge-lab`. Run the remaining commands from the checkout root.

## 2. Install prerequisites and create a Tunnel

Install [Node.js 22 or later](https://nodejs.org/), [Git for Windows](https://git-scm.com/install/windows), and the [Codex CLI](https://developers.openai.com/codex/cli/). Sign in to Codex and confirm that its `app-server` works. You also need an authorized local project, an OpenAI Platform organization with Tunnel access, and a ChatGPT account or workspace with Developer Mode. Record the absolute path to a trusted native Git executable (typically `mingw64\bin\git.exe`), the directory containing a tested `codex.exe`, and its exact verified version. See [Windows setup](docs/Windows-Setup-BRIDGE-LAB.md).

The controller runs the source entry point and needs its dependencies. The following accesses npm and writes the local dependency tree:

```powershell
node --version
npm --prefix .\plugins\transceiver ci
```

Download the complete Windows client archive, not source code or the runtime-only package, from [tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest). In Windows Settings → System → About, check system type: choose `amd64` for x64 or `arm64` for ARM64. Extract the entire archive, keep its accompanying files, and note the executable path. Replace the placeholder and check that it starts:

```powershell
$tunnelExe = 'C:\Path\To\tunnel-client.exe'
& $tunnelExe --version
```

Installation needs network access. The running client needs outbound HTTPS to `api.openai.com:443` and access to the local Bridge. Offline preparation alone cannot verify the online connection.

The person creating or editing a Tunnel needs **Tunnels Read + Manage**; the person running the client and selecting the Tunnel in ChatGPT needs **Read + Use**. One person doing both needs all three permissions. An organization Owner or RBAC administrator can assign roles; ChatGPT workspace permission to use custom MCP is separate. See [Tunnel permissions](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md).

In [Platform Tunnel settings](https://platform.openai.com/settings/organization/tunnels), select the intended organization and create or choose a Tunnel. Associate it with the intended ChatGPT workspace as well as the organization; organization association alone does not ensure visibility in that workspace. Enterprise users may need their OpenAI account team. Save the full `tunnel_...` ID securely. It identifies the cloud Tunnel; it is not the local profile or a password.

Create a restricted runtime key in [Platform API keys](https://platform.openai.com/settings/organization/api-keys), with Tunnel Read + Use where the UI permits; the creating principal or service account also needs those permissions. Ask the organization administrator if necessary. It is not an admin key. Never paste it into chat, screenshots, scripts, command history or logs. UI labels and availability may change; consult the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## 3. Secure credentials and create a profile

The Tunnel ID identifies the cloud resource, the runtime key authorizes the client, and a local YAML profile holds connection settings. Protect access to all three.

Open Windows **Edit environment variables for your account**. Under User variables create `OpenAI_Tunnel_API_KEY` with the runtime key and `Tunnel_ID` with the full ID including `tunnel_`. Save and open a **new** PowerShell window in the checkout root. These are persistent user variables, not system variables. The controller checks the process environment first, so an outdated value in an old shell can override the user value. Check presence without printing values:

```powershell
[bool][Environment]::GetEnvironmentVariable('OpenAI_Tunnel_API_KEY', 'User')
[bool][Environment]::GetEnvironmentVariable('Tunnel_ID', 'User')
```

Both must be `True`. If not, check the Windows settings and reopen PowerShell. These checks do not detect a conflicting process value; if an old shell has one, reopen it or remove that process variable without printing it.

This guide uses profile `transceiver-t2`, port 8876, and the default `runtime\tunnel-profiles` directory. In step 4 set `TUNNEL_PROFILE` to that exact name (the template uses `transceiver`) and `TUNNEL_EXE` to the path above. If you change the port, change the profile URL too. The controller passes its `ProfileDir` explicitly when starting the client; the client's usual profile directory or a separately inherited directory setting does not override it. First inspect the installed client's help and existing profiles; check that it supports the shown flags and directory setting. If not, consult its [configuration reference](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md), rather than guessing.

```powershell
$tunnelExe = 'C:\Path\To\tunnel-client.exe'
& $tunnelExe help quickstart
& $tunnelExe init --help
$env:TUNNEL_CLIENT_PROFILE_DIR = Join-Path (Get-Location) 'runtime\tunnel-profiles'
& $tunnelExe profiles list
```

The listing can fail if the directory does not yet exist. Setting `TUNNEL_CLIENT_PROFILE_DIR` above replaces any value in this PowerShell process; save and restore your previous value if you need it. If `transceiver-t2` already exists, inspect its directory, Tunnel and URL; do not overwrite it. Only if no suitable profile exists, create one. Run the native commands individually and check `$LASTEXITCODE` immediately after each:

```powershell
New-Item -ItemType Directory -Force -Path $env:TUNNEL_CLIENT_PROFILE_DIR | Out-Null
& $tunnelExe init --sample sample_mcp_remote_no_auth --profile transceiver-t2 --tunnel-id ([Environment]::GetEnvironmentVariable('Tunnel_ID', 'User')) --mcp-server-url http://127.0.0.1:8876/mcp
& $tunnelExe profiles list
Remove-Item Env:TUNNEL_CLIENT_PROFILE_DIR
```

Check each native command's exit status (`$LASTEXITCODE`) before proceeding and confirm the profile is listed in `runtime\tunnel-profiles`. If initialization fails, resolve the error before starting the controller. This creates local YAML, not a cloud Tunnel. The ID may appear in process arguments and the file; restrict access. The key need not be placed in the command or YAML. The last command clears only this shell's directory selection; also clear or restore it if you reuse an existing profile and skip this block.

Normally you need not set `CONTROL_PLANE_API_KEY` or `CONTROL_PLANE_TUNNEL_ID` manually: the controller temporarily maps the two user/process variables to those names for its child, then restores the calling environment. If you set them for manual diagnosis, remove them with `Remove-Item Env:CONTROL_PLANE_API_KEY, Env:CONTROL_PLANE_TUNNEL_ID -ErrorAction SilentlyContinue`; this does not delete the saved user variables. Protect profiles and logs and never publish them.

## 4. Configure the controller and authorize a project

Create the required state directory and copy templates only if the actual files do not exist:

```powershell
New-Item -ItemType Directory -Force -Path .\runtime\state | Out-Null
if (-not (Test-Path -LiteralPath .\bridge.env)) { Copy-Item .\bridge.env.example .\bridge.env }
if (-not (Test-Path -LiteralPath .\config.json)) { Copy-Item .\config.json.example .\config.json }
```

Edit `bridge.env` as UTF-8 data, never as a secret store. Set `TUNNEL_PROFILE=transceiver-t2`, `TUNNEL_EXE` to the actual client, `GIT_EXE` to the trusted native Git absolute path, `NODE_EXE` to Node, `CODEX_BIN` to the directory containing your verified CLI, and `CODEX_VERSION` to its exact tested version. Set `PORT` to 8876 unless the profile uses another port. The template defaults both sandbox and access strategy to `read-only`, and both write/full-access switches to `0`; change security boundaries only with appropriate authorization. Startup timeout defaults to 30 seconds and log retention to 7 days. Explicit arguments override the file, which overrides controller defaults; values do not expand variables or commands.

For example, if `codex.exe --version` prints `codex-cli 0.123.0`, set `CODEX_VERSION=0.123.0`, without the `codex-cli ` prefix. The controller adds that prefix when comparing the complete output.

**Inspect `config.json` before use.** The template starts with an empty `projects` object, `version: 1` and `unknownProject: "ask"`. Preserve existing actual configuration and authorize only intended projects. Choose one real directory and unique name, then write and inspect its policy:

```powershell
$env:TRANSCEIVER_CONFIG = Join-Path (Get-Location) 'config.json'
$projectRoot = 'C:\Projects\example-project'
$projectName = 'example-project'
node .\plugins\transceiver\scripts\transceiver.mjs project-set --root $projectRoot --sync true --allow-codex-tasks true --name $projectName
node .\plugins\transceiver\scripts\transceiver.mjs project-get --root $projectRoot
```

Check the resolved root, name and both flags. Only projects with both `sync` and `allowCodexTasks` true enter the Bridge's allowed roots. This does not grant writing or replace sandbox and OS permissions. A running Bridge does not reload changed configuration: restart managed components when tasks are idle. ChatGPT Project, Codex Desktop project, and Bridge authorization are independent.

Git ignores actual root configs and `runtime/`, but ignore rules are not access control. If the checkout is an allowed workspace, `runtime/` is within it. Restrict access to state, profiles and logs; keep credentials outside the repository and all authorized projects. Allowed roots restrict project selection and task cwd, not all OS reads.

## 5. Start, inspect, stop and maintain logs

```powershell
.\scripts\bridge-lab.ps1 -Action status
.\scripts\bridge-lab.ps1 -Action start
.\scripts\bridge-lab.ps1 -Action status
```

Check managed Bridge status, listener PID and `/healthz`, and that the managed Tunnel process is alive. A live process does not establish cloud connectivity. Do not kill an unknown process. Preview log cleanup first:

```powershell
.\scripts\bridge-lab.ps1 -Action cleanup-logs -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs
```

The default retention is seven days by last write time. `-All` ignores age, `-DryRun` deletes nothing, active logs remain protected, and uncertain identities cause conservative skips. In particular, missing or corrupt process records cause cleanup to retain logs; a normal `stop` removes the record. `-All` cannot be combined with an explicit `-LogRetentionDays`. See [log cleanup](docs/Windows-Controller-BRIDGE-LAB.md#log-cleanup). Keep the components running for step 6; only after finishing and when tasks are idle, run:

```powershell
.\scripts\bridge-lab.ps1 -Action stop
.\scripts\bridge-lab.ps1 -Action status
```

Only identity-matched managed processes are stopped.

## 6. Connect ChatGPT and verify a real MCP call

Enable Developer Mode in ChatGPT, create an MCP app/connector using **Tunnel**, select the same Tunnel, and enable that connection in a new conversation. Review discovered tools. Names and locations in the web UI can change; follow the current [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Installing the local Codex plugin is a separate operation.

Ask for `codex_settings` and check `capabilities.allowedRoots`. Then substitute your configured project **name**:

```text
Using the enabled Bridge connection, inspect example-project read-only: call
 git_status, then read the first 80 lines of README.md with read_project_file.
Report the results, any truncation, and Git status. Do not modify files.
```

Verify the actual calls succeeded for the intended project. Tool discovery, local health and a live Tunnel process do not substitute for this end-to-end check. If task execution also needs verification, request a `codex_task` with the real absolute cwd and `read-only` sandbox, and use `codex_status` to reach a terminal state. After a disconnect or timeout, check Job status before retrying; do not assume cancellation.

If local health succeeds but the call fails, check the profile URL, organization/workspace association, permissions, connector selection and client doctor output; redact logs. The optional [GPT collaboration instructions](docs/GPT-Codex-Collaboration-Instructions-CN.md) are in Chinese and are not automatically loaded into ChatGPT.

Controller help: `./scripts/bridge-lab.ps1 help` (also `-Action help`, `--Action help`, `-H`, or `/?`). It exits without starting services or reading configuration.
