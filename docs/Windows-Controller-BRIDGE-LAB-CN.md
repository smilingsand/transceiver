# Bridge Lab Windows 控制器参考

[English](Windows-Controller-BRIDGE-LAB.md) | [简体中文](Windows-Controller-BRIDGE-LAB-CN.md)

[Windows 控制器](../scripts/bridge-lab.ps1) 在本机启动、检查和停止受其管理的 reverse Bridge 与 Tunnel 客户端。本文描述仓库中脚本的行为；首次准备依赖、项目授权和 Tunnel profile 见 [Windows 配置指南](Windows-Setup-BRIDGE-LAB-CN.md)，已有环境的操作模板见 [快速开始](../QuickStart-BRIDGE-LAB-CN.md)。

## 组成与职责

```text
PowerShell 控制器
  ├─ Node → plugins/transceiver/scripts/reverse-runtime.mjs → Codex app-server
  └─ tunnel-client run → 已配置的 Tunnel profile → 本地 Bridge
```

控制器需要 Windows PowerShell 5.1 或更高版本。它使用 fork 的**源码入口**，不是上游打包的 `dist/reverse-bridge/index.mjs`；源码依赖须预先准备。Bridge 默认仅监听 `127.0.0.1:8876`，提供 `/mcp` 和 `/healthz`。Tunnel 将 ChatGPT 的 MCP 请求传给本机 Bridge；本地 HTTP 无认证，不能据此开放公网或局域网监听。

控制器不创建项目授权、Tunnel、profile 或账号权限。修改项目配置后，已运行的 Bridge 不会因重复 `start` 自动重新加载；应确认任务空闲，在合适的维护窗口重启受管组件，再通过 `codex_settings` 核对 `capabilities.allowedRoots`。该列表是 Bridge 的 cwd 策略，不是 OS 读取白名单。

确定性 Git 写入使用 `ConfigPath` 指向的项目策略：各项 `gitWrite` 默认 false，推送还需精确 URL/branch 授权。已有授权根目录的权限在子进程前重新加载；新增或重新绑定根目录需要重建 host policy。配置或连接器提示都不能代替用户授权。参见 [Git 写入配置、传输限制和仅重启 Bridge 的部署说明](Git-Write-Tools-BRIDGE-LAB-CN.md)。

## 参数与前提

脚本根据自身位置确定仓库根目录，不依赖当前工作目录；根目录 `bridge.env` 可提供非秘密参数，命令行优先，其次文件，最后 Controller 默认值。新环境应填写工具路径、profile 和已验证 Codex 版本；参数说明见 [快速开始](../QuickStart-BRIDGE-LAB-CN.md#4-配置控制器并授权项目)，常用命令见 [控制器操作](../QuickStart-BRIDGE-LAB-CN.md#5-启动检查停止和日志维护)。

| 参数 | 用途和注意事项 |
| --- | --- |
| `Action` | `status`、`start`、`stop` 或 `cleanup-logs`；默认 `status`。 |
| `All` | 仅用于 `cleanup-logs`，忽略文件年龄；可与 `-DryRun` 组合，不能与显式 `-LogRetentionDays` 组合。文件中的 `LOG_RETENTION_DAYS` 仍须有效，0 无效。 |
| `DryRun` | 配合 `cleanup-logs` 预览拟删除文件，不删除任何文件。 |
| `LogRetentionDays` | 历史日志保留天数，默认 7，范围 1–3650；对应 `LOG_RETENTION_DAYS`。 |
| `ConfigPath` | Transceiver 项目配置文件；与项目 CLI 的 `TRANSCEIVER_CONFIG` 必须一致。默认 `<repo>/config.json`；记录和日志独立于该文件的位置。 |
| `RuntimeDir` | 运行根目录，默认 `<repo>/runtime`；不受 `ConfigPath` 影响。 |
| `ControlDir`、`LogDir` | 默认 `RuntimeDir/control` 和 `RuntimeDir/logs`；可显式覆盖以读取旧记录。 |
| `StateDir` | 默认 `RuntimeDir/state`；Bridge 状态目录；`start` 前须已存在。 |
| `ProfileDir`、`TunnelProfile` | 默认目录为 `RuntimeDir/tunnel-profiles`；已准备的 Tunnel profile 目录和名称；目录须已存在，profile 须指向本地 MCP URL。 |
| `TunnelExe` | 已安装的 `tunnel-client.exe` 文件路径。 |
| `GitExe` | 可信的原生 Git 可执行文件绝对路径，例如 Git for Windows 的 `mingw64/bin/git.exe`；确定性 Git 服务不回退到 PATH。 |
| `CodexBin` | 含 `codex.exe` 的目录，**不是** exe 文件路径；空值使用脚本中固定的 Desktop 管理目录。 |
| `ExpectedCodexVersion` | 精确的已验证 CLI 版本；默认值为空，须提供已验证版本，启动新 Bridge 时要求 `codex --version` 精确匹配。 |
| `NodeExe` | Node 可执行文件路径或可解析的命令；源码依赖要求 Node 22+。 |
| `Port` | 控制器检查监听者与 `/healthz` 的端口，默认 8876。 |
| `BridgeStartupTimeoutSeconds` | 新 Bridge 就绪等待预算，默认 30 秒，范围 1–3600；对应 `BRIDGE_STARTUP_TIMEOUT_SECONDS`。进程退出时提前失败。 |

启动前，配置文件、Tunnel 可执行文件、Git 可执行文件、源码入口、状态目录和 profile 目录必须存在；还需兼容的 Codex CLI、已准备的依赖及有效项目授权。CLI 固定版本有助于可重复性，但 Desktop 更新可能替换它；升级时应验证兼容性后显式指定目录及版本，不自动扫描或选择最新版本，也不要删除 Desktop 管理的可执行文件。

`PORT` 或 `-Port` 同时设置健康检查端口和子进程 `TRANSCEIVER_REVERSE_PORT`，覆盖继承的源码端口环境变量；Tunnel profile 必须指向同一端口。

## 环境、凭据和状态

启动 Bridge 时，控制器把 `ConfigPath`、`StateDir` 和 `GitExe` 分别映射为 `TRANSCEIVER_CONFIG`、`TRANSCEIVER_STATE_DIR` 和 `TRANSCEIVER_GIT_EXECUTABLE`，并临时将选定的 Codex 目录加入子进程 PATH。它在结束后恢复调用进程原有环境变量。

启动 Tunnel 时，控制器先从当前进程、再从 Windows 用户环境读取 `OpenAI_Tunnel_API_KEY` 和 `Tunnel_ID`，映射为 `CONTROL_PLANE_API_KEY` 和 `CONTROL_PLANE_TUNNEL_ID`。Tunnel ID 须包含 `tunnel_` 前缀。由用户以受保护方式设置，绝不将值粘贴到文档、聊天、仓库或公开日志。PID 记录不包含凭据，但日志可能包含敏感信息。Git 忽略不是访问边界：仓库作为允许的工作区时包含 `runtime/`；根目录配置不得存放秘密。profile 可能包含敏感信息，绝不发布，并须限制访问。

控制器在 `RuntimeDir/control/processes.json`（或显式 `ControlDir`） 保存受管进程 PID、创建时间、配置路径、所选 Codex 路径和日志路径；每次启动组件时分别重定向其 stdout/stderr 到 `RuntimeDir/logs/`（或显式 `LogDir`）。这不是 Bridge 本身的 SQLite 等状态文件，后者由 `StateDir` 指定。分享诊断前应审查并脱敏日志和路径。

## bridge.env 与目录迁移

根目录模板为 [bridge.env.example](../bridge.env.example) 和 [config.json.example](../config.json.example)。实际文件和 `runtime/` 均不提交。示例配置的 `projects` 为空；仅添加已明确授权的项目。模板不包含运行状态。

支持 UTF-8（有无 BOM）、空行、`#` 整行注释、空白后行尾注释和单/双引号值；含空格的 Windows 路径可加引号，反斜杠保持原样。不会展开变量或执行表达式。未知键、重复键、格式错误、非法端口及非 `0`/`1` 的权限开关会报错，不回显值。秘密键不在白名单中。

| bridge.env 键 | PowerShell 参数 |
| --- | --- |
| `TUNNEL_PROFILE`、`TUNNEL_EXE`、`GIT_EXE` | `TunnelProfile`、`TunnelExe`、`GitExe` |
| `CODEX_BIN`、`CODEX_VERSION`、`NODE_EXE`、`PORT` | `CodexBin`、`ExpectedCodexVersion`、`NodeExe`、`Port` |
| `BRIDGE_STARTUP_TIMEOUT_SECONDS` | `BridgeStartupTimeoutSeconds` |
| `LOG_RETENTION_DAYS` | `LogRetentionDays` |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX` | `DefaultSandbox` |
| `CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY` | `DefaultAccessStrategy` |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE` | `AllowWrite` |
| `CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS` | `AllowDangerFullAccess` |

优先级为显式参数 > `bridge.env` > 脚本默认值；这四个权限参数也遵循该顺序，不使用继承环境的权限值代替 Controller 默认值。默认 `read-only`、`read-only`、`0`、`0`。仅在启动新 Bridge 时临时设置子进程环境，并在成功或失败后恢复调用进程原值。已运行组件不会因配置改变而自动重启。路径参数和文件中的相对工具路径均相对于仓库根目录，裸 `NODE_EXE=node.exe` 仍通过 PATH 解析。

旧目录不会自动删除或迁移。**已有旧受管进程时，先对每次 `status`、`start`、`stop` 显式传入旧 `-ControlDir '<old>/control'`，并保留原 `ConfigPath`、`StateDir`、`ProfileDir`、端口等参数**。只设置旧 `ConfigPath` 不会选中旧 PID 记录。仍按 PID、命令行和创建时间核验；缺失记录不会接管未知进程。确认任务空闲后用旧记录安全停机，再人工迁移配置、状态和 profile；下一次才切换默认运行目录。不要在进程运行时复制记录来尝试接管，也不要同时使用两个控制目录启动组件。

## 受管进程识别与操作

控制器用记录的 PID 查询进程，再核对命令行是否包含对应标记及创建时间是否在五秒误差内，以降低 PID 重用导致误操作的风险。它不接管或终止未知监听者，也不按通用 `node.exe` 名称批量杀进程。此机制不是完整进程树或优雅关闭管理器。

在仓库根目录、使用 `bridge.env` 中的本机设置时：

```powershell
.\scripts\bridge-lab.ps1 -Action status
.\scripts\bridge-lab.ps1 -Action start
.\scripts\bridge-lab.ps1 -Action status
```

`status` 显示受管 Bridge/Tunnel 是否匹配、Bridge `/healthz` 结果、端口监听 PID 和已记录的日志路径。`health` 是对指定 loopback 端口的 HTTP 检查，应与受管状态及监听 PID 一起判断；它不单独证明响应者就是受管 Bridge。无记录但有监听者会显示未托管警告。`status` 也不是对所有未知 Tunnel 进程的完整清单。

启动时脚本检查监听端口、进程身份和 Bridge 健康，再协调缺失组件。新 Bridge 默认有 30 秒就绪预算，必须由本次子进程独占对应监听端口并通过 `/healthz`；新 Tunnel 仍只做约两秒进程存活检查。**Tunnel managed 为 True 不证明云端 Tunnel 已连通**；还需检查客户端诊断，并通过 ChatGPT 发起实际 MCP 只读调用。

可在 `bridge.env` 设置 `BRIDGE_STARTUP_TIMEOUT_SECONDS=60`，或临时传入 `-BridgeStartupTimeoutSeconds 60`；命令行优先。预算从调用 `Start-Process` 前开始，包含进程创建及就绪检查，不包含此前的依赖和 Codex 版本检查，也不包含随后 Tunnel 启动。使用单调计时器，轮询间隔至多 500ms；Health 请求至多 2 秒，并按剩余整秒缩短，不足 1 秒时不再发起请求。Windows 进程创建、端口查询和调度自身的耗时不能被此预算硬中断。每次请求前后检查子进程退出；退出立即失败，正在进行的请求可能先消耗剩余请求时限。

控制器向终端及 Bridge stdout 路径附加 `.startup.log` 的独立文件写入启动诊断，即使子进程 stdout/stderr 为空也可排障。结果包含 PID、耗时毫秒、是否退出、退出码（存活时为 `n/a`）、监听 PID、Health 最近结果及请求次数、是否超时。`process-exited` 表示子进程退出；`port-not-listening` 表示预算到期仍无监听；`health-check-failed` 表示本进程监听但 Health 失败；`wait-timeout` 表示预算耗尽且尚未获得有效就绪结果。超时同时显示 `timedOut=True`；`listener-pid-mismatch` 表示监听者不匹配，不会认作 Bridge 或对其执行清理。失败诊断反映清理前状态，异常仍只回滚本次新进程，保留原有受管组件及记录。

旧版采用 20 次“先睡 500ms、再查端口、必要时执行最长 2 秒 Health”，并非严格十秒上限：单计睡眠与 HTTP 等待最多约 50 秒，另有系统命令开销。冷启动超时只是待验证假设；空 stdout/stderr 本身不能区分退出、尚未监听或 Health 失败。新诊断用于提供下一次真实冷启动的证据。

停止前先确认不会中断需要保留的任务，使用同一套参数：

```powershell
.\scripts\bridge-lab.ps1 -Action stop
.\scripts\bridge-lab.ps1 -Action status
```

`stop` 依次停止身份匹配的受管 Tunnel 和 Bridge，然后删除 PID 记录；不匹配的进程不会被终止。若记录缺失，它不会尝试接管或停止未知进程。服务配置、profile 和 Bridge 状态不会因常规 `stop` 被清理。

## 四种启动与恢复情形

以下描述源码意图，前提是配置和依赖有效、没有未知进程冲突：

| 启动前状态 | `start` 的处理 |
| --- | --- |
| 两个组件均停止，包括仅剩旧 PID 记录 | 启动 Bridge 和 Tunnel，成功后写入新记录。 |
| 两个组件均受管且 Bridge 健康 | 保留两者，不重启；Tunnel 判断仅为进程存活。 |
| Bridge 受管且健康，Tunnel 已退出 | 保留 Bridge，只启动 Tunnel。 |
| Tunnel 受管且存活，Bridge 已退出 | 保留 Tunnel，只启动 Bridge。 |

如果未知进程占用端口、存在未托管的 `tunnel-client.exe`，或受管 Bridge 存活但健康检查失败，`start` 拒绝盲目接管或强行终止。若任一新组件启动失败，异常处理只尝试终止本次新启动的进程，保留原有受管进程和先前记录；随后应检查实际状态和日志。该协调过程没有跨进程锁，避免并发运行多个 `start`。

## 日志清理

如运行实例使用了自定义 `ConfigPath`、`ControlDir` 或 `LogDir`，请在以下命令中传入相同参数。以下命令只维护日志，不启停服务，不修改 PID 记录、Bridge 状态或 SQLite：

```powershell
.\scripts\bridge-lab.ps1 -Action cleanup-logs -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs
.\scripts\bridge-lab.ps1 -Action cleanup-logs -LogRetentionDays 14
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All -DryRun
.\scripts\bridge-lab.ps1 -Action cleanup-logs -All
```

保留天数优先级为显式 `-LogRetentionDays` > 根目录 `bridge.env` 中的 `LOG_RETENTION_DAYS` > 默认 7 天，合法范围 1–3650。清理开始时计算一次截止时间，只有 `LastWriteTime` 严格早于截止时间的文件才可能删除，不按文件大小或创建时间判断。

`-All` 忽略年龄，其他安全检查及活动日志保护仍生效；`-All -DryRun` 只预览。它不能与显式 `-LogRetentionDays` 同用，`bridge.env` 中的 `LOG_RETENTION_DAYS` 仍须有效，0 会报错。参数和 Action 不区分大小写。

仅检查解析后 `LogDir` 的直接子项，文件名须匹配 `bridge-*-out.log`、`bridge-*-err.log`、`tunnel-*-out.log` 或 `tunnel-*-err.log`（`*` 部分非空）。不递归，不清理 `.startup.log`、其他格式或其他目录。隐藏文件也会检查；目录、符号链接、目录联接、所有 Reparse Point 和硬链接均保留。日志根路径及其任意祖先包含重解析点时，整轮拒绝清理。

清理先读取 `ControlDir/processes.json`，核对配置路径，并复用 PID、命令行标记和创建时间的身份验证。正在运行的 Bridge/Tunnel 各自保护记录中的 stdout/stderr，四个文件即使超过保留期、大小为零也保留。已记录 PID 确认不存在时，可视该组件已退出；PID 被复用、记录不完整、活动日志路径缺失/相对、进程查询失败、Node/Tunnel 命令行不可读，或发现未记录的 Bridge/Tunnel 时，均保守保留。记录不存在或 JSON 损坏也整轮保留；因此正常 `stop` 已移除记录后，本操作不会猜测哪些日志可删。

每个候选文件在删除前重新读取状态、核验身份及活动日志路径，再检查文件名、位置、类型和最后写入时间。Windows 原生句柄检查会锁定祖先目录以阻止路径替换，独占打开候选文件以拒绝占用者，并通过同一个句柄复查类型、硬链接数量和写入时间后删除，不按通配符批量删除。占用、权限不足、文件消失或文件条件改变会单独报告，不影响其他安全候选文件。此路径需要 Windows 和可用的 `Add-Type`/Win32 调用；受限策略或祖先目录不可访问时保留文件并报告失败，不放宽检查。避免与其他 Controller 配置/状态变更操作并发执行。

输出只包含文件名、原因和计数，不读取日志正文或输出凭据。`Eligible` 是复查后符合候选条件并进入句柄处理的文件数（包含打开/删除失败的候选）；句柄复查发现类型或时间不符时改记为 `Skipped`。`Deleted` 为成功删除数，`Protected active` 为实际检查到且受保护的文件数，`Skipped` 包含非匹配文件、目录、链接、保留期内文件及保守跳过项，`Failed` 为失败项数（无法安全访问整个 LogDir 时记录一项操作失败）。状态无法核验时不会凭估算增加活动保护数。`-DryRun` 执行相同安全检查，逐项显示 `Would delete` 及总数，`Deleted` 为 0，并明确没有删除文件。

离线测试覆盖实际临时文件删除、保留期、四个零字节活动日志、单组件存活、双方已退出、预览无修改、参数解析/优先级/校验、非匹配和嵌套文件、目录联接/硬链接、状态缺失/损坏/身份不匹配/查询失败、占用失败及删除前状态变化。真实文件符号链接测试需要本机具备创建权限，无法创建时明确跳过；目录联接和替换为 Reparse Point 的防护测试仍执行。

## 安全排障与验证

1. 使用相同的 `ConfigPath` 与端口运行 `status`，确认受管状态、监听 PID 和健康结果。不要强制停止不明进程；先查明其身份、用途及所属用户。
2. 检查配置、已授权的真实项目目录、状态/profile 位置、Node、可信原生 Git 和经过验证的 Codex 版本。项目授权与 Desktop 项目归属是两件事；详情见 [完整手册](../README-BRIDGE-LAB-CN.md#授权项目与配置)。
3. 若本地健康但 ChatGPT 不通，核对 profile 的 MCP URL、Tunnel 和工作区关联、权限及客户端诊断；检查日志时防止泄露凭据。不要仅凭 PID 存活断言连接成功。
4. 实际连接后，用 `codex_settings` 核对允许根目录，并用授权项目的 `git_status` 或 `read_project_file` 做一次只读调用；需要任务验证时使用 `read-only` 和 `codex_status`，步骤见 [快速开始](../QuickStart-BRIDGE-LAB-CN.md#6-连接-chatgpt-并验证真实-mcp)。
5. 断线或超时不等于任务取消。恢复后先查询 Job/Thread 状态和可能的副作用，再判断下一步；不要盲目重复有副作用的请求。

需要仅检查 PowerShell 语法时，可在仓库根目录执行下列解析，不会启动控制器：

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\scripts\bridge-lab.ps1).Path, [ref]$tokens, [ref]$errors) | Out-Null
$errors
```

离线回归可执行 `pwsh -NoProfile -File .\scripts\bridge-lab.Tests.ps1`（支持 Windows PowerShell 5.1 时也可使用 `powershell`，须符合本机执行策略）。测试使用临时配置、模拟进程、端口、HTTP 与时钟，覆盖正常及慢启动、等待超时、立即/稍后退出、Health 期间退出、不健康响应、无关监听者和失败回滚；不启动或停止真实服务，不读取实际运行配置或 SQLite。它不替代 Windows 重启后的真实冷启动验证。

## 阶段沿革和验证范围

T4.1-B V3 的设计重点是固定已验证的 Codex CLI、凭据环境映射、分离日志，以及 PID、创建时间和命令行标记保护；T4.4-E 增加了按现有受管状态补齐缺失组件和失败时只回滚本次新进程的设计。两份阶段文档已合并到本文；原文及阶段变更可在 Git 历史中查阅。

[协同工作指南](GPT-Codex-Collaboration-Workflow-v1.0-CN.md) 记录了特定 T4–T5 环境中正常启动及单组件恢复等历史测试；这些结果不自动适用于其他机器或新版本。异常保护尚未全部动态故障注入，运行中任务的强制断源恢复也未充分验证。本次文档合并仅对照源码和历史记录，没有启动服务或重新执行运行测试。

控制器帮助：`./scripts/bridge-lab.ps1 help`（也支持 `-Action help`, `--Action help`、`-H` 或 `/?`）。帮助命令不会启动服务或读取配置。
