# Bridge Lab on Windows: Six-Step Quick Start

[English](QuickStart-BRIDGE-LAB.md) | [简体中文](QuickStart-BRIDGE-LAB-CN.md)

Start from this fork's `dev/bridge-lab` branch, complete the configuration, and then make a real read-only MCP call from ChatGPT. Run the commands in Windows PowerShell; replace paths and project names with your own. For detailed requirements, see the [Windows setup reference](docs/Windows-Setup-BRIDGE-LAB.md); for process and log behavior, see the [controller reference](docs/Windows-Controller-BRIDGE-LAB.md).

## 1. Get the fork and select the branch

The fork URL currently recorded for this repository is shown below. Do not use the upstream URL or the default `master` branch. If you are using your own mirror, replace the URL. When downloading a ZIP, first select `dev/bridge-lab` on the fork page before downloading and extracting it.

```powershell
git clone --branch dev/bridge-lab https://github.com/smilingsand/transceiver.git
Set-Location .\transceiver
git branch --show-current
```

Confirm that the output is `dev/bridge-lab`. If you already have a checkout of this fork, protect any existing changes before running `git switch dev/bridge-lab`. Run subsequent commands from the checkout root.

## 2. Prepare dependencies and create a Tunnel

### 2.1 Confirm prerequisites

You need Windows PowerShell 5.1 or later, Node.js 22 or later, Git for Windows, a signed-in Codex CLI capable of running App Server, and the OpenAI `tunnel-client`. Confirm that you have permission to use the intended Platform organization, ChatGPT workspace, and local project. Select the trusted native Git executable at `mingw64/bin/git.exe`, and note the directory containing `codex.exe` and the Codex version verified on your machine. For detailed checks, see the [Windows setup reference](docs/Windows-Setup-BRIDGE-LAB.md#1-prepare-the-environment).

Downloading and installing dependencies requires internet access. When the Tunnel runs, the client needs outbound HTTPS access to `api.openai.com:443` and access to the local Bridge. An offline environment must be prepared with the necessary dependencies and networking; it cannot complete online connectivity verification.

### 2.2 Install project dependencies

Open PowerShell at the checkout root from step 1. First check the Node version, then install the source dependencies according to the lockfile. The second command accesses the npm registry and writes to the local dependency directory:

```powershell
node --version
npm --prefix .\plugins\transceiver ci
```

### 2.3 Download and check the Tunnel client

Open the [latest OpenAI tunnel-client release](https://github.com/openai/tunnel-client/releases/latest). Under Assets, select the complete Windows client archive, not the source code or a runtime-only package. In Windows **Settings → System → About**, check the system type: choose `amd64` for x64 or `arm64` for ARM64. Extract the entire archive to the folder you choose, retain the accompanying files, and note the full path to `tunnel-client.exe`.

In PowerShell, replace the following path with the actual location and run the command. A version number indicates that the program can start. Use the same full path for `TUNNEL_EXE` in step 4.

```powershell
$tunnelExe = 'C:\Path\To\tunnel-client.exe'
& $tunnelExe --version
```

### 2.4 Confirm user permissions

Anyone creating or editing a Tunnel needs **Tunnels Read + Manage** in the intended Platform organization. Anyone running the client and selecting the Tunnel in ChatGPT needs **Read + Use**. Someone performing both roles needs all three permissions. An organization Owner or RBAC administrator can assign roles; ChatGPT workspace permission to add and use custom MCP connections is managed separately. If an operation is unavailable, ask the relevant administrator to check permissions; newly assigned roles may take some time to take effect. See the [OpenAI permissions documentation](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md).

### 2.5 Create or select a Tunnel

Sign in to the [Platform Tunnel management page](https://platform.openai.com/settings/organization/tunnels), switch to the intended organization, and select a suitable existing Tunnel or create one as instructed on the page. Associate the Tunnel with both its managing Platform organization and the ChatGPT workspace where the connection will later be created. Organization association alone does not guarantee that the Tunnel will appear in the workspace. If an Enterprise account cannot be associated automatically, contact your OpenAI account team. Follow the fields and capabilities of the current interface.

Securely save the full **Tunnel ID** beginning with `tunnel_`; you will use it in the next step. It identifies the cloud Tunnel, not a password or a local profile, and should not be shared casually. See the [official OpenAI guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

### 2.6 Create a runtime API key

On the [Platform API keys page](https://platform.openai.com/settings/organization/api-keys), create a restricted runtime key for the intended organization. Where the interface offers these permissions, grant Tunnel **Read + Use**; the key creator or service account must also have the appropriate permissions. This key is used to run the client; it is not a Tunnel administration key. If the interface does not permit the required grant, ask the organization administrator for help. Store the new key securely as instructed by the page; do not include it in chat, screenshots, scripts, command history, or logs.

## 3. Securely configure credentials and a profile

There are three distinct items: the **Tunnel ID** identifies the cloud Tunnel; the **runtime API key** authorizes the client to use it; and the local **profile** is a YAML file recording connection settings. The controller uses them together.

### 3.1 Save two Windows user environment variables

Search the Start menu for **Edit environment variables for your account** and open it. In the upper **User variables** section, select **New** for each entry, enter the following variable name and its real value, and click **OK** to save:

| Variable name | Variable value |
| --- | --- |
| `OpenAI_Tunnel_API_KEY` | Runtime API key from step 2.6 |
| `Tunnel_ID` | Complete Tunnel ID from step 2.5, including `tunnel_` |

These are persistent settings for the current Windows user, not system variables. Protect access to the Windows account and computer; do not put the key in the repository, configuration files, commands, or chat. After saving, open a **new** PowerShell window and return to the checkout root; existing windows do not automatically refresh. The controller reads the process environment before the user environment, so an outdated value in an old process can override the user variable.

### 3.2 Check whether the variables exist

These commands output only `True` or `False`, not the values. Proceed only if both return `True`. Otherwise, check the user environment variables in Windows settings and reopen PowerShell.

```powershell
[bool][Environment]::GetEnvironmentVariable('OpenAI_Tunnel_API_KEY', 'User')
[bool][Environment]::GetEnvironmentVariable('Tunnel_ID', 'User')
```

### 3.3 Determine the controller settings first

In step 4, you will copy and edit `bridge.env`. This guide uses `TUNNEL_PROFILE=transceiver-t2`; at that point, change the template's `transceiver` value to `transceiver-t2`. It must exactly match the profile name used below. Set `TUNNEL_EXE` to the real path from step 2.3 and `PORT` to 8876. Store the profile under `runtime\tunnel-profiles` at the checkout root, matching the controller's default directory. If you change the port, update the URL in the profile as well.

### 3.4 Check client help and existing profiles

In a new PowerShell window at the checkout root, set `$tunnelExe` again to the actual path from step 2.3. `help quickstart` shows the installed version's getting-started instructions; `profiles list` shows existing configurations in the selected directory. First use the help output to confirm that `init`, `--sample`, `--profile`, `--tunnel-id`, `--mcp-server-url`, and the directory setting are supported. If the version does not support them, consult the [client configuration reference](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md) rather than guessing at flags.

```powershell
$tunnelExe = 'C:\Path\To\tunnel-client.exe'
& $tunnelExe help quickstart
& $tunnelExe init --help
$env:TUNNEL_CLIENT_PROFILE_DIR = Join-Path (Get-Location) 'runtime\tunnel-profiles'
& $tunnelExe profiles list
```

This environment variable selects the profile directory only for the current PowerShell process. Listing may fail if the directory does not yet exist; the next step creates it. If `transceiver-t2` already exists, first check its directory, Tunnel, and local URL. Do not overwrite an existing file.

### 3.5 Create the local profile

Run this only if no suitable profile with the same name exists. The commands first create the directory, then generate `transceiver-t2` from the official HTTP sample that does not require local authentication. `--tunnel-id` reads the identifier from the Windows user variable, `--mcp-server-url` points to the local Bridge, and `--profile` sets the name. This creates local YAML; it does not create a cloud Tunnel. The Tunnel ID may appear in local process arguments and generated files, so restrict access. The runtime key does not need to appear in the command or YAML.

```powershell
New-Item -ItemType Directory -Force -Path $env:TUNNEL_CLIENT_PROFILE_DIR | Out-Null
& $tunnelExe init --sample sample_mcp_remote_no_auth --profile transceiver-t2 --tunnel-id ([Environment]::GetEnvironmentVariable('Tunnel_ID', 'User')) --mcp-server-url http://127.0.0.1:8876/mcp
& $tunnelExe profiles list
Remove-Item Env:TUNNEL_CLIENT_PROFILE_DIR
```

Confirm that `transceiver-t2` appears in the list and that the generated file is under `runtime\tunnel-profiles`. The final command clears only the temporary directory selection in this window; it does not delete the profile. Protect the profile and logs, and do not publish them.

### 3.6 Understand how the controller reads the key

In normal use, you do not need to run `$env:CONTROL_PLANE_API_KEY = ...` or set `CONTROL_PLANE_TUNNEL_ID` manually. When starting the Tunnel, the controller reads the variables above, temporarily maps them to the names required by the client for the child process, and then restores the original values in the current process. If you previously set these temporary variables in the current window for manual diagnosis, clear them with `Remove-Item Env:CONTROL_PLANE_API_KEY, Env:CONTROL_PLANE_TUNNEL_ID -ErrorAction SilentlyContinue`. This does not delete the saved user variables from step 3.1.

## 4. Configure the controller and authorize a project

From the checkout root, create the Bridge state directory before copying the templates. Existing configuration files will not be overwritten. The controller requires the state directory to exist before startup:

```powershell
New-Item -ItemType Directory -Force -Path .\runtime\state | Out-Null
if (-not (Test-Path -LiteralPath .\bridge.env)) { Copy-Item .\bridge.env.example .\bridge.env }
if (-not (Test-Path -LiteralPath .\config.json)) { Copy-Item .\config.json.example .\config.json }
```

Edit `bridge.env` with non-secret machine-specific values. It is a UTF-8 data file and does not expand variables or commands. Explicit parameters take precedence over the file, and the file takes precedence over script defaults.

| Template parameter | Meaning |
| --- | --- |
| `TUNNEL_PROFILE`, `TUNNEL_EXE` | Profile name and path to the client executable; the name must match step 3. |
| `GIT_EXE`, `NODE_EXE` | Absolute path to the trusted native Git executable and the Node executable. |
| `CODEX_BIN`, `CODEX_VERSION` | Directory containing `codex.exe` and the exact version verified locally. |
| `PORT` | Local listening port, 8876 by default; must match the MCP URL port in the profile. |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX`, `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | Default sandbox and access strategy; both are `read-only` in the template. |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE`, `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | Whether writing or full access is permitted; both are `0` in the template. Confirm authorization before changing them. |
| `BRIDGE_STARTUP_TIMEOUT_SECONDS`, `LOG_RETENTION_DAYS` | Bridge readiness budget (30 seconds by default) and log retention (7 days by default). |

The `config.json.example` template uses `version: 1`, `unknownProject: "ask"`, and an empty `projects` object. Inspect the configuration before use and authorize only explicitly approved projects. Choose an authorized **real project directory** and a unique name; the CLI resolves its real path. The following commands write to the root `config.json` and then inspect the result:

```powershell
$env:TRANSCEIVER_CONFIG = Join-Path (Get-Location) 'config.json'
$projectRoot = 'C:\Projects\example-project'
$projectName = 'example-project'
node .\plugins\transceiver\scripts\transceiver.mjs project-set --root $projectRoot --sync true --allow-codex-tasks true --name $projectName
node .\plugins\transceiver\scripts\transceiver.mjs project-get --root $projectRoot
```

Check the resolved real root, name, and both flags. A project enters the reverse Bridge's allowed roots only when both `sync` and `allowCodexTasks` are true. This does not grant write access or replace the Codex sandbox or OS permissions. A running Bridge does not automatically reload changed configuration; stop and restart it when tasks are idle. Codex Desktop projects and ChatGPT Projects are managed separately and do not automatically confer Bridge permissions.

The root `bridge.env`, `config.json`, and `runtime/` are ignored by `.gitignore`, but ignore rules are not access controls. If the checkout itself is within `allowedRoots`, its `runtime/` directory is also within that scope. Profiles, state, and logs may be sensitive; restrict access and do not store or commit credentials there. `allowedRoots` limits project selection and task cwd; it is not an operating-system-level allowlist of readable files.

## 5. Start, inspect, stop, and maintain logs

Step 3 uses the controller's default profile directory. The following commands load settings from `bridge.env`:

```powershell
.\scripts\bridge-lab.ps1 -Action status
.\scripts\bridge-lab.ps1 -Action start
.\scripts\bridge-lab.ps1 -Action status
```

Confirm that the Bridge is managed, that the listener PID and `/healthz` are healthy, and that the Tunnel is managed with a live process. The default readiness budget is 30 seconds; a running Tunnel process does not establish cloud connectivity. Do not forcibly terminate unknown processes. Preview log maintenance first:

```powershell
.\scripts\bridge-lab.ps1 -Action cleanup-logs -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs
```

Deletion requires `y` or `Y` confirmation; unavailable or redirected input cancels. Use `-Force` for automation; `-DryRun` never prompts or deletes. The default retention is 7 days based on last write time. `-All` ignores age, `-DryRun` deletes nothing, active logs are protected, and unverifiable identities cause conservative skips. `-All` cannot be combined with an explicit `-LogRetentionDays`. For details and limitations, see [log cleanup](docs/Windows-Controller-BRIDGE-LAB.md#log-cleanup). Keep the components running to complete step 6. Only after you finish using them and tasks are idle, run:

```powershell
.\scripts\bridge-lab.ps1 -Action stop
.\scripts\bridge-lab.ps1 -Action status
```

Only identity-matched managed processes are stopped.

## 6. Connect ChatGPT and verify a real MCP call

Enable Developer Mode in ChatGPT. In the app/connector settings, create an MCP connection, select **Tunnel** and the same Tunnel from step 2, then enable that connection in a new conversation and review the discovered tools. UI names may change; see the [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Installing the local Codex plugin is a separate operation.

In the conversation, ask for `codex_settings` and check `capabilities.allowedRoots`. Then submit the following using the configured **project name**:

```text
Using the enabled Bridge connector, inspect example-project read-only: call git_status,
then use read_project_file to read the first 80 lines of README.md. Report the call results,
any truncation, and the Git status. Do not modify files.
```

Confirm that the tool calls actually succeed against the intended project. Tool discovery, local health, and a live Tunnel process are not substitutes for this end-to-end call. If you also need to verify task execution, request a `codex_task` with the real absolute path as cwd and `read-only` sandbox to summarize the directory, then use `codex_status` until the task reaches a terminal state. After a disconnection or timeout, check Job status first; do not assume the task was cancelled or blindly resend it.

If local health succeeds but the call fails, check the profile URL, Tunnel organization and workspace, permissions, and connector selection. If necessary, run doctor according to the client's help and review redacted logs. You may optionally use the [GPT collaboration instructions](docs/GPT-Codex-Collaboration-Instructions-CN.md); the repository file is not automatically loaded into ChatGPT.

Controller help: `./scripts/bridge-lab.ps1 help` (also supports `-Action help`, `--Action help`, `-H`, or `/?`). Help does not start services or read configuration.

## Optional: controlled Git writes

After a successful read-only call, use the discovered MCP tools only when the user has authorized the relevant operation and the operator has enabled the corresponding project `gitWrite` permission (false by default). First check `git_status` and unstaged `git_diff`, and read untracked files. Then use `git_add` with explicit paths, review the diff for the entire staging area, and finally call `git_commit` with an explicit message. Commit requires repository-local `user.name` and `user.email` and refuses active hooks. `git_push` additionally requires an exact remote URL/branch authorization; GitHub HTTPS can optionally use Windows GCM, while SSH is unsupported. Configuration grants do not imply user approval. See [configuration, MCP examples, and limitations](docs/Git-Write-Tools-BRIDGE-LAB.md).
