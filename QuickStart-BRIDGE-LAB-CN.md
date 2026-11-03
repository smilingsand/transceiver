# Bridge Lab Windows 首次使用：六步快速开始

[English](QuickStart-BRIDGE-LAB.md) | [简体中文](QuickStart-BRIDGE-LAB-CN.md)

从本 fork 的 `dev/bridge-lab` 分支开始，完成配置后，在 ChatGPT 发起真实只读 MCP 调用。命令在 Windows PowerShell 中运行；路径和项目名须替换。详细条件见 [Windows 配置参考](docs/Windows-Setup-BRIDGE-LAB-CN.md)，进程和日志行为见 [控制器参考](docs/Windows-Controller-BRIDGE-LAB-CN.md)。

## 1. 获取本 fork 并选择分支

当前仓库记录的 fork 地址如下；不要使用上游地址或默认的 master 分支。如果使用自己的镜像，替换 URL。下载 ZIP 时也要先在 fork 页面选择 `dev/bridge-lab` 再下载并解压。

```powershell
git clone --branch dev/bridge-lab https://github.com/smilingsand/transceiver.git
Set-Location .\transceiver
git branch --show-current
```

确认输出为 `dev/bridge-lab`。已有本 fork checkout 时先保护现有改动，再执行 `git switch dev/bridge-lab`；后续命令在 checkout 根目录执行。

## 2. 准备依赖并创建 Tunnel

### 2.1 确认开始条件

需要 Windows PowerShell 5.1 或更新版本、Node.js 22 或更新版本、Git for Windows、已登录且可运行 App Server 的 Codex CLI，以及 OpenAI `tunnel-client`。确认有权使用目标 Platform 组织、ChatGPT 工作区和本机项目。选择可信的原生 Git `mingw64/bin/git.exe`，记下包含 `codex.exe` 的目录和本机验证过的 Codex 版本。详细检查见 [Windows 配置参考](docs/Windows-Setup-BRIDGE-LAB-CN.md#1-准备环境)。

下载和安装依赖需要联网；运行 Tunnel 时客户端需要出站 HTTPS 连接 `api.openai.com:443`，并能访问本机 Bridge。离线环境需先准备依赖和网络条件，无法完成在线连接验证。

### 2.2 安装项目依赖

在第 1 步的仓库根目录打开 PowerShell。先查看 Node 版本，再按锁文件安装源码依赖；第二条命令会访问 npm 软件源并写入本地依赖目录：

```powershell
node --version
npm --prefix .\plugins\transceiver ci
```

### 2.3 下载并检查 Tunnel 客户端

打开 [OpenAI tunnel-client 最新发布页](https://github.com/openai/tunnel-client/releases/latest)，在 Assets 中选择完整客户端的 Windows 压缩包，而非 source code 或仅 runtime 版本。在 Windows“设置 → 系统 → 关于”查看系统类型，x64 选 `amd64`，ARM64 选 `arm64`。将整个压缩包解压到选定的文件夹，保留随包文件，记下其中 `tunnel-client.exe` 的完整路径。

在 PowerShell 中将下面路径改为实际位置后运行；输出版本号表示程序可以启动。第 4 步的 `TUNNEL_EXE` 也要填同一完整路径。

```powershell
$tunnelExe = 'C:\Path\To\tunnel-client.exe'
& $tunnelExe --version
```

### 2.4 确认人员权限

创建或编辑 Tunnel 的人员需要目标 Platform 组织的 **Tunnels Read + Manage**；运行客户端和在 ChatGPT 中选择 Tunnel 的人员需要 **Read + Use**。同一人兼任两者时需要三项。组织 Owner 或 RBAC 管理员可分配角色；ChatGPT 添加和使用自定义 MCP 的工作区权限另行管理。无法操作时请相应管理员检查权限，新角色生效可能需要一段时间。详见 [OpenAI 权限说明](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md)。

### 2.5 创建或选择 Tunnel

登录 [Platform Tunnel 管理页面](https://platform.openai.com/settings/organization/tunnels)，切换到目标组织，选择已有合适的 Tunnel，或按页面提示创建。关联管理该 Tunnel 的 Platform 组织，以及之后要创建 ChatGPT 连接的工作区；仅关联组织不保证它出现在工作区。企业账户无法自动关联时，请联系 OpenAI 账户团队。界面字段和可用性以当前页面为准。

安全保存完整的 `tunnel_` 开头的 **Tunnel ID**，下一步要用。它是云端 Tunnel 的标识，不是密码，也不是本机 profile；不要随意公开。详见 [OpenAI 官方指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 2.6 创建运行用 API key

在 [Platform API keys 页面](https://platform.openai.com/settings/organization/api-keys)为目标组织创建受限的运行用 key，按界面提供的权限选项赋予 Tunnel **Read + Use**；创建者或服务账号本身也须具备相应权限。此 key 用于客户端运行，不是管理 Tunnel 的 admin key。若界面无法授予所需权限，请组织管理员协助。按页面提示安全保存新 key，不要发到聊天、截图、脚本、命令历史或日志。

## 3. 安全设置凭据及 profile

这里有三样不同的东西：**Tunnel ID** 指向云端 Tunnel；**运行用 API key** 证明客户端有权使用它；本机 **profile** 是记录连接设置的 YAML 文件。控制器需要三者配合。

### 3.1 保存两个 Windows 用户变量

在开始菜单搜索并打开“编辑账户的环境变量”。在上半部分“用户变量”分别选择“新建”，填写以下变量名和对应的真实值，然后逐层点“确定”保存：

| 变量名 | 变量值 |
| --- | --- |
| `OpenAI_Tunnel_API_KEY` | 第 2.6 步的运行用 API key |
| `Tunnel_ID` | 第 2.5 步的完整 Tunnel ID，包含 `tunnel_` |

这是持久的当前 Windows 用户设置，不是系统变量。保护该账户及电脑的访问权限；不要将 key 写入仓库、配置文件、命令或聊天。保存后打开**新的** PowerShell 并回到仓库根目录，旧窗口不会自动刷新。控制器先读进程环境，再读用户环境；旧进程中的过期值可能覆盖用户变量。

### 3.2 检查变量是否存在

以下命令只输出 `True` 或 `False`，不显示值；两项均为 `True` 才继续。若为 `False`，回到用户环境变量界面检查并重新打开 PowerShell。

```powershell
[bool][Environment]::GetEnvironmentVariable('OpenAI_Tunnel_API_KEY', 'User')
[bool][Environment]::GetEnvironmentVariable('Tunnel_ID', 'User')
```

### 3.3 先确定控制器设置

第 4 步会复制并编辑 `bridge.env`。本指南使用 `TUNNEL_PROFILE=transceiver-t2`，届时请把模板中的 `transceiver` 改为 `transceiver-t2`；它必须与下方 profile 名称完全一致。`TUNNEL_EXE` 填第 2.3 步的实际路径，`PORT` 使用 8876。profile 放在仓库根目录下 `runtime\tunnel-profiles`，与控制器默认目录一致；如改端口，profile 中的 URL 也须同步修改。

### 3.4 查看客户端帮助和已有 profile

在新 PowerShell 的仓库根目录重新设置 `$tunnelExe` 为第 2.3 步的实际路径。`help quickstart` 显示该版本的入门用法；`profiles list` 列出指定目录中的已有配置。先按帮助确认 `init`、`--sample`、`--profile`、`--tunnel-id`、`--mcp-server-url` 和目录设置受支持。若版本不支持，查阅 [客户端配置参考](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)，不要猜测参数。

```powershell
$tunnelExe = 'C:\Path\To\tunnel-client.exe'
& $tunnelExe help quickstart
& $tunnelExe init --help
$env:TUNNEL_CLIENT_PROFILE_DIR = Join-Path (Get-Location) 'runtime\tunnel-profiles'
& $tunnelExe profiles list
```

此环境变量仅为当前 PowerShell 选择 profile 目录。若目录尚不存在，列表可能报错；下一步会创建它。若已有 `transceiver-t2`，先核对其目录、Tunnel 和本地 URL，不要覆盖已有文件。

### 3.5 创建本机 profile

仅在没有合适的同名 profile 时执行。以下先创建目录，再用官方无本地认证 HTTP 示例生成 `transceiver-t2`：`--tunnel-id` 从用户变量读取标识，`--mcp-server-url` 指向本机 Bridge，`--profile` 指定名称。此操作生成本机 YAML，不会创建云端 Tunnel；Tunnel ID 可能出现在本机进程参数和生成文件中，请限制访问。运行用 key 不需要写入命令或 YAML。

```powershell
New-Item -ItemType Directory -Force -Path $env:TUNNEL_CLIENT_PROFILE_DIR | Out-Null
& $tunnelExe init --sample sample_mcp_remote_no_auth --profile transceiver-t2 --tunnel-id ([Environment]::GetEnvironmentVariable('Tunnel_ID', 'User')) --mcp-server-url http://127.0.0.1:8876/mcp
& $tunnelExe profiles list
Remove-Item Env:TUNNEL_CLIENT_PROFILE_DIR
```

确认列表中有 `transceiver-t2`，且生成文件位于 `runtime\tunnel-profiles`。最后一条只清除本窗口临时目录选择，不删除 profile。保护 profile 和日志，勿公开。

### 3.6 了解控制器如何读取 key

正常使用时无需手动执行 `$env:CONTROL_PLANE_API_KEY = ...` 或设置 `CONTROL_PLANE_TUNNEL_ID`：控制器启动 Tunnel 时从上述变量读取，并临时映射为客户端所需名称供子进程继承，然后恢复当前进程原值。若曾在当前窗口为手动诊断设置过这两个临时变量，可用 `Remove-Item Env:CONTROL_PLANE_API_KEY, Env:CONTROL_PLANE_TUNNEL_ID -ErrorAction SilentlyContinue` 清除；这不会删除第 3.1 步保存的用户变量。


## 4. 配置控制器并授权项目

在 checkout 根目录先创建 Bridge 状态目录，再复制模板；已有配置不会被覆盖。控制器要求状态目录在启动前存在：

```powershell
New-Item -ItemType Directory -Force -Path .\runtime\state | Out-Null
if (-not (Test-Path -LiteralPath .\bridge.env)) { Copy-Item .\bridge.env.example .\bridge.env }
if (-not (Test-Path -LiteralPath .\config.json)) { Copy-Item .\config.json.example .\config.json }
```

编辑 `bridge.env`，填写非秘密的本机值；它是 UTF-8 数据文件，不展开变量或命令。显式参数优先于文件，文件优先于脚本默认值。

| 模板参数 | 含义 |
| --- | --- |
| `TUNNEL_PROFILE`、`TUNNEL_EXE` | profile 名称及客户端可执行文件路径；名称与第 3 步一致。 |
| `GIT_EXE`、`NODE_EXE` | 可信原生 Git 绝对路径及 Node 可执行文件。 |
| `CODEX_BIN`、`CODEX_VERSION` | 包含 `codex.exe` 的目录及本机验证过的精确版本。 |
| `PORT` | 本地监听端口，默认 8876；profile 的 MCP URL 端口须一致。 |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX`、`CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | 默认 sandbox 和访问策略；模板均为 `read-only`。 |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE`、`CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | 是否允许写入或完整访问；模板均为 `0`，改变前先确认授权。 |
| `BRIDGE_STARTUP_TIMEOUT_SECONDS`、`LOG_RETENTION_DAYS` | Bridge 就绪预算（默认 30 秒）和日志保留期（默认 7 天）。 |

`config.json.example` 模板使用 `version: 1`、`unknownProject: "ask"` 和空的 `projects` 对象；使用前检查配置，只授权明确允许的项目。选择已明确授权的**真实项目目录**及唯一名称，CLI 会解析真实路径。以下命令写入根目录 `config.json`，并检查结果：

```powershell
$env:TRANSCEIVER_CONFIG = Join-Path (Get-Location) 'config.json'
$projectRoot = 'C:\Projects\example-project'
$projectName = 'example-project'
node .\plugins\transceiver\scripts\transceiver.mjs project-set --root $projectRoot --sync true --allow-codex-tasks true --name $projectName
node .\plugins\transceiver\scripts\transceiver.mjs project-get --root $projectRoot
```

核对输出的真实根目录、名称及两个标志。`sync` 和 `allowCodexTasks` 同时为 true 才纳入 reverse Bridge 的允许根目录；这不等于允许写入，也不替代 Codex sandbox 和系统权限。配置改变后运行中的 Bridge 不自动重载，须在任务空闲时停止并重启。Desktop 项目和 ChatGPT Project 分别管理，不会自动授予 Bridge 权限。

根目录 `bridge.env`、`config.json` 和 `runtime/` 已被 `.gitignore` 忽略，但忽略规则不是访问控制。如果 checkout 自身位于 `allowedRoots`，其中的 `runtime/` 也在该范围内；profile、状态和日志可能敏感，限制访问，勿放凭据或提交。`allowedRoots` 限制项目选择和任务 cwd，并非操作系统级读取白名单。

## 5. 启动、检查、停止和日志维护

第 3 步使用控制器默认 profile 目录；以下命令从 `bridge.env` 读取配置。

```powershell
.\scripts\bridge-lab.ps1 -Action status
.\scripts\bridge-lab.ps1 -Action start
.\scripts\bridge-lab.ps1 -Action status
```

确认 Bridge 受管、监听 PID 和 `/healthz` 健康，Tunnel 受管且进程存活。默认就绪预算为 30 秒；Tunnel 存活不能证明云端连通。不要强杀未知进程。日志维护先预览：

```powershell
.\scripts\bridge-lab.ps1 -Action cleanup-logs -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs
```

默认按最后写入时间保留 7 天；`-All` 忽略年龄，`-DryRun` 不删除，活动日志受保护，无法验证身份时保守跳过。`-All` 不可与显式 `-LogRetentionDays` 同用。详细范围和限制见[日志清理](docs/Windows-Controller-BRIDGE-LAB-CN.md#日志清理)。请保持组件运行以完成第 6 步；完成使用且任务空闲后才运行：

```powershell
.\scripts\bridge-lab.ps1 -Action stop
.\scripts\bridge-lab.ps1 -Action status
```

只停止身份匹配的受管进程。

## 6. 连接 ChatGPT 并验证真实 MCP

在 ChatGPT 开启 Developer Mode，在应用/连接器设置中创建 MCP 连接，选择 **Tunnel** 和第 2 步的同一个 Tunnel；在新对话启用该连接并检查发现的工具。界面名称可能变化，参考 [OpenAI 连接指南](https://developers.openai.com/plugins/deploy/connect-chatgpt)。本地 Codex 插件安装是另一项操作。

在对话中请求 `codex_settings` 并核对 `capabilities.allowedRoots`，然后使用配置中的项目**名称**发送：

```text
请使用已启用的 Bridge 连接器，只读检查 example-project：调用 git_status，
再用 read_project_file 读取 README.md 前 80 行。报告调用结果、截断情况和 Git 状态；不要修改文件。
```

确认实际工具调用成功及项目正确；工具发现、本地健康和 Tunnel 进程存活各自不能替代这次端到端调用。需要任务验证时，可请求 `codex_task` 以该真实绝对路径为 cwd、`read-only` sandbox 概述目录，并用 `codex_status` 查询终态。断线或超时后先查 Job 状态，勿假定任务已取消或盲目重发。

本地健康但调用失败时，检查 profile URL、Tunnel 组织与工作区、权限及连接器选择；必要时按客户端帮助运行 doctor 并检查脱敏日志。协同规则可选用 [GPT 协同指令](docs/GPT-Codex-Collaboration-Instructions-CN.md)，仓库文件不会自动加载到 ChatGPT。

控制器帮助：`./scripts/bridge-lab.ps1 help`（也支持 `-Action help`, `--Action help`、`-H` 或 `/?`）。帮助命令不会启动服务或读取配置。
