# Transceiver Bridge Lab 中文手册

[English](README-BRIDGE-LAB.md) | [简体中文](README-BRIDGE-LAB-CN.md)

将 ChatGPT 的任务编排与本机 Codex 的项目工作连接起来，并保留项目授权、任务状态和可独立检查的结果。

首次使用请从 [Windows 六步快速开始](QuickStart-BRIDGE-LAB-CN.md) 开始。本文介绍系统、安全边界和工具；其他资料按用途查阅：

- [Windows 配置参考](docs/Windows-Setup-BRIDGE-LAB-CN.md)：准备依赖和理解配置条件。
- [Windows 控制器参考](docs/Windows-Controller-BRIDGE-LAB-CN.md)：进程、状态、日志清理和排障。
- [协同工作指南](docs/GPT-Codex-Collaboration-Workflow-v1.0-CN.md)：了解人和工具的分工；[协同指令](docs/GPT-Codex-Collaboration-Instructions-CN.md)可复制到 GPT Project Instructions。
- [维护者架构指南](docs/Maintainer-Architecture-BRIDGE-LAB-CN.md)：源码装配、升级和验证。

本机默认布局为根目录 `bridge.env`、`config.json`，以及 `runtime/{state,tunnel-profiles,control,logs}/`。首次从根目录两个 `.example` 模板复制并填写（不要覆盖现有实际配置）；凭据只从受保护的 Windows 环境读取。配置优先级：显式参数 > `bridge.env` > 默认值。旧运行记录迁移前请阅读 [目录迁移说明](docs/Windows-Controller-BRIDGE-LAB-CN.md#bridgeenv-与目录迁移)，用显式 `ControlDir` 保持原进程可识别。

## 为什么需要 Bridge Lab

在 ChatGPT 中讨论需求，在本机 Codex 中检查或修改仓库，往往需要手工复制上下文、命令和结果。任务持续较久、跨多轮进行或连接中断时，也难以判断工作是否仍在运行。Bridge Lab 探索通过 MCP 连接两端：ChatGPT 发送明确的任务，Bridge 在授权范围内交给本机 Codex，并提供状态和只读检查工具，让结果可以被独立核验。

目标是减少人工转录，提供可追踪的任务、会话和受控的项目选择。它不是通用远程桌面，不会自动授权整个电脑，不会自动同步两端全部历史或记忆，也不能保证每次任务正确完成。用户仍须决定授权范围、审查结果和批准项目要求的敏感操作。

## 来源与范围

本仓库是 [mark9804/transceiver](https://github.com/mark9804/transceiver) 的 fork。上游 Transceiver 是双向交接层：Codex 可通过已有 Web transport 向 ChatGPT 发送带来源的交接；ChatGPT 可通过 Tunnel 调用本地 reverse Bridge。上游说明和贡献归属保留在 [英文 README](README.md) 与 [中文 README](README.zh-CN.md)。

本手册侧重 fork 的 Windows 源码运行方式及 reverse Bridge 的开发实践。上游 README 中的 macOS/Linux 安装、打包入口和原有只读描述不自动等同于本 fork 的有效配置。Codex 发往 ChatGPT 的前向交接还需单独安装并登录可用的 Web transport；它不是下述 reverse 链路正常工作的前提。

## 能做什么

- 使用 `read_project_file`、`git_status`、`git_diff` 直接检查已授权项目，不为这些操作创建 Codex 任务。
- 使用 `codex_task` 启动或继续任务，通过 `codex_status` 查询 Job；按工具提供的能力引导、停止或检查任务。
- 用 Activity 组织工作和验证，用 Thread 保存连续工作上下文，用 Job 跟踪一次执行。
- 查询模型目录和持久化 Settings；新 Thread 可使用默认配置或显式指定支持的模型及 effort。
- 在 Windows 上用控制器启动、检查和停止受管 Bridge 与 Tunnel；启动时尽量保留健康的现有组件。

典型场景包括：先只读检查仓库和现有改动；让 Codex 分析一个范围明确的问题；在用户授权后实施修改；再由 ChatGPT 使用独立读取和 Git 工具核验结果。

## 架构和数据流

```text
用户 ↔ ChatGPT 对话 / 已启用的 MCP 连接器
                  │ MCP 请求与结果
                  ▼
        OpenAI Secure MCP Tunnel
                  │ 出站连接
                  ▼
        Windows tunnel-client
                  │ 本地 HTTP
                  ▼
   reverse MCP Bridge：127.0.0.1:8876/mcp
         │                       │
         │ 确定性文件/Git读取     │ 任务、状态与会话
         ▼                       ▼
    授权项目目录           Codex CLI app-server
                                  │
                                  ▼
                         授权 cwd / Git 工作区
```

Windows 控制器在本机管理 Bridge 和 Tunnel 进程；它不是请求经过的另一层云服务。Bridge 的 `healthz` 检查本地服务，MCP 工具调用才验证从 ChatGPT 经 Tunnel 到本机的实际链路。Bridge 保存会话、Job、Settings 等状态；ChatGPT 历史、Codex Desktop 和这些状态不是同一份记忆。

项目配置只把同时开启 `sync` 和 `allowCodexTasks` 的根目录纳入 reverse 任务。Bridge 将任务、续接与引导消息加上 `|from_chatgpt|:` 来源标记。模型结果仍需审查；文件内容、工具结果和外部提示中可能包含不可信指令，不应因此扩大用户授权。

### 安全边界

1. 源码入口绑定 `127.0.0.1`，默认关闭本地 HTTP 认证，依靠 loopback 与 Tunnel 访问边界；不要把它暴露到局域网或公网。Tunnel 身份、工作区关联和用户权限必须正确配置。
2. 允许根目录用于限制任务的 `cwd` 和选择项目，**不是操作系统级读取白名单**。确定性文件工具另有路径校验；不能把其限制推广为 Codex 进程的完整文件隔离。
3. 源码默认 sandbox 与 access strategy 为 `read-only`，默认不允许写入或 `danger-full-access`。环境变量可以覆盖默认值，实际执行仍受上游校验与运行环境约束。只读任务明确选择 `read-only`；仅在用户授权且有效配置允许时使用 `workspace-write`。
4. 不应断言所有 reverse 任务都禁网：网络限制取决于实际 sandbox 和环境。源码入口设置的审批策略为 `never`，不要假定运行时会弹出交互式审批；需要额外授权的操作应在任务开始前由用户明确决定。
5. 上游按文件名识别秘密的扫描在此入口被关闭。凭据必须置于仓库及授权项目之外；不要把密钥写入聊天、命令历史、提交、配置示例或日志。受限目录和系统权限仍需由管理员配置。

## 当前默认运行布局和配置角色

以下是默认布局，运行文件按需生成。模板供公开使用；实际配置和 `runtime/` 被 Git 忽略。

```text
<repo>\
├── bridge.env.example       控制器非秘密参数模板
├── bridge.env               本机控制器参数，不放秘密
├── config.json.example      项目策略示例模板
├── config.json              本机项目策略，不放秘密
├── scripts\bridge-lab.ps1  控制器
└── runtime\
    ├── state\              Bridge 状态及 SQLite
    ├── control\            进程记录 processes.json
    ├── logs\               Bridge/Tunnel 日志和启动诊断
    └── tunnel-profiles\    Tunnel profile
```

首次在仓库根目录复制模板，避免覆盖已有配置：

```powershell
if (-not (Test-Path -LiteralPath .\bridge.env)) { Copy-Item .\bridge.env.example .\bridge.env }
if (-not (Test-Path -LiteralPath .\config.json)) { Copy-Item .\config.json.example .\config.json }
```

Git 忽略规则不是访问边界：当仓库本身是允许的工作区时，其范围包含 `runtime/`。根目录配置不得存放秘密；凭据放在受保护的仓库及授权项目之外。Tunnel profile 可能包含敏感信息，绝不发布；限制日志和 profile 的访问。

## 目录和实现选择

```text
transceiver/
├── README.md、README.zh-CN.md       上游说明
├── README-BRIDGE-LAB-CN.md          本手册
├── QuickStart-BRIDGE-LAB-CN.md      首次配置和日常操作
├── docs/                            工作规范和历史设计记录
├── scripts/bridge-lab.ps1           Windows 进程控制器
└── plugins/transceiver/
    ├── scripts/reverse-runtime.mjs  本 fork 的源码运行入口
    ├── scripts/reverse-http.mjs     MCP HTTP 和共享状态组装
    ├── scripts/deterministic/       项目文件及 Git 只读工具
    ├── scripts/transceiver.mjs       项目策略和前向交接 CLI
    ├── dist/reverse-bridge/         上游安装流程使用的打包入口
    ├── skills/transceiver/          Codex 插件技能及参考
    ├── tests/                       自动测试
    └── package.json                 Node 依赖、构建和测试命令
```

源码入口使用 Node.js、MCP SDK、Codex app-server 和上游 `codex-mcp-bridge-for-chatgpt` 组件；项目策略、确定性工具和统一 HTTP 组装位于本 fork。源码依赖上游组件的特定内部构建，升级时需检查兼容性。

**入口区别：**控制器执行 `plugins/transceiver/scripts/reverse-runtime.mjs`，需要源码依赖可解析。上游文档中的 `plugins/transceiver/dist/reverse-bridge/index.mjs` 是打包入口；`npm run reverse:start` 也指向打包入口。不要仅凭一个入口工作就推断另一个入口行为相同。源码开发依赖和锁文件位于 `plugins/transceiver/`；按该目录的 `package.json`、锁文件和本机许可准备依赖，安装会访问软件源并改变本地依赖树。上游打包安装明确不要求重新构建，两条路径不要混用。

## 准备条件

以下是从空环境走到可操作状态所需的清单；账号、组织和二进制安装须由使用者完成，本仓库不自动配置这些服务。

1. Windows PowerShell 5.1 或更高版本，Node.js 22+，Git，以及包含本 fork 的稳定 checkout。目标项目应是明确授权、存在的本地目录；Git 工具需要可用的 Git 仓库。
2. 可运行 `app-server` 的 Codex CLI、已完成所需登录及访问权限。控制器默认使用固定的 Desktop 管理 CLI 目录，预期版本默认为空；须提供经验证的 CLI 目录和匹配版本。不会自动从 PATH 选择新版本。
3. 已安装 `tunnel-client`，具有 Tunnel 访问权限的 OpenAI Platform organization，以及可使用 Developer Mode 的 ChatGPT 账号或工作区。创建/编辑 Tunnel 需要 Tunnels Read + Manage；运行客户端及在 ChatGPT 中选择它需要 Tunnels Read + Use。将 Tunnel 关联到正确的组织和 ChatGPT 工作区。
4. 源码依赖已在 checkout 中准备好；默认配置位于仓库根目录，状态和 Tunnel profile 位于 `<repo>\runtime`。控制器要求配置文件、Git 和 Tunnel 可执行文件存在，状态及 profile 目录预先存在。
5. 已创建指向本地 `http://127.0.0.1:8876/mcp` 的 Tunnel profile，profile 名称和目录与控制器参数一致。参考上游 [Tunnel 配置步骤](README.md#7-configure-and-run-tunnel-client) 和 [Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。上游示例使用 `sample_mcp_remote_no_auth`；已有 profile 应先检查，不要未经确认覆盖。实际界面与客户端版本可能变化。

在 PowerShell 中可先检查本机基本工具，替换为实际路径：

```powershell
node --version
& 'C:\Path\To\Git\mingw64\bin\git.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' app-server --help
& 'C:\Path\To\tunnel-client.exe' help quickstart
```

路径是示意，不是需要原样复制的安装位置。确认 CLI 版本和依赖兼容后再配置控制器；不要为通过版本检查随意修改版本参数。

## 授权项目与配置

`bridge.env` 保存控制器的非秘密参数，`config.json` 保存项目策略；凭据保存在受保护的 Windows 环境中。首次复制模板、参数说明和 CLI 命令见 [快速开始第 4 步](QuickStart-BRIDGE-LAB-CN.md#4-配置控制器并授权项目)，凭据与 profile 见 [第 3 步](QuickStart-BRIDGE-LAB-CN.md#3-安全设置凭据及-profile)。

只授权用户明确选定的真实项目目录。`sync` 与 `allowCodexTasks` 同时为 true 时，项目才进入 reverse Bridge 的允许根目录；写权限仍由实际 sandbox、Bridge 策略与系统权限决定。配置变更须在任务空闲时重启 Bridge 才生效。`codex_settings` 的 `capabilities.allowedRoots` 反映当前 Bridge 配置，不是操作系统读取白名单。

Codex Desktop 中打开项目、ChatGPT Project 和 Bridge 项目授权相互独立。Git 忽略也不是访问控制；当 checkout 本身位于允许根目录时，其 `runtime/` 也在该范围内，应保护可能敏感的状态、profile 和日志。

## Windows 控制器：启动、状态和停止

配置完成后，控制器从根目录 `bridge.env` 读取本机设置。用 `status` 检查受管状态、监听 PID 和本地健康，用 `start` 启动缺失组件，用 `stop` 停止身份匹配的受管进程。首次配置和日常命令见 [快速开始第 5 步](QuickStart-BRIDGE-LAB-CN.md#5-启动检查停止和日志维护)；使用自定义目录、迁移旧记录和处理异常的细节见 [控制器参考](docs/Windows-Controller-BRIDGE-LAB-CN.md)。

清理日志前可用 `cleanup-logs -DryRun` 预览；`-All -DryRun` 预览不按年龄筛选的范围。`-All` 仍保护活动日志，且不能与显式 `-LogRetentionDays` 同用。记录缺失等无法确认安全的情况会保守跳过，详见 [日志清理](docs/Windows-Controller-BRIDGE-LAB-CN.md#日志清理)。

Tunnel 存活只说明进程还在，本地健康检查也不能证明云端连通。配置变更后，运行中的 Bridge 不会因再次执行 `start` 自动重载；任务空闲时须重启受管组件。

## 连接 Tunnel 和 ChatGPT

1. 在 Platform 中创建或选择 Tunnel，配置所需组织、工作区和最小权限；本机准备好与之匹配的 profile、凭据及客户端。profile 必须指向实际 Bridge MCP URL。
2. 启动 Bridge 和 tunnel-client，先确认本地 `status` 与健康状态。受管 Tunnel 存活只证明进程还在；必要时使用客户端的 doctor 检查 profile 和本地 MCP 可达性。
3. 在 ChatGPT 设置中启用 Developer Mode，然后在连接器/应用设置中创建 MCP 连接，连接方式选择 **Tunnel**，选择同一个 Tunnel，并查看发现的工具。界面名称和位置可能变化，以当前界面及 [连接指南](https://developers.openai.com/plugins/deploy/connect-chatgpt) 为准。
4. 新建对话，在对话的工具/应用选择器中启用刚创建的连接器。该连接器名称由创建时设定，不一定叫 Transceiver。不要把 OpenAI 托管网关 URL 当作 OAuth MCP 服务器；本地 Bridge 不实现该 OAuth 流程。

ChatGPT 连接器与安装在 Codex 中的本地插件是两个不同操作。需要前向交接技能时，上游说明使用 `codex plugin marketplace add` 和 `codex plugin add transceiver@mark9804`，之后在新 Codex 会话检查 `/hooks` 并由用户决定是否信任。仅使用已运行的 reverse MCP 连接，不应把本地插件安装误称为 ChatGPT 连接器创建步骤。详情见 [上游安装说明](README.md#3-install-the-local-plugin)。

### 设置 ChatGPT Project 协同指令

如果使用 ChatGPT Project，可将 [GPT 协同指令](docs/GPT-Codex-Collaboration-Instructions-CN.md) 的内容复制到目标 Project 的 Instructions 中。它不会因存在于仓库而自动加载，也不会自行授权项目或启用连接器。背景和协作方式见 [协同工作指南](docs/GPT-Codex-Collaboration-Workflow-v1.0-CN.md)。

## MCP 工具实用指南

工具名和 schema 以连接器实际发现的版本为准；以下对象表示工具参数，不是 PowerShell 命令。

### 确定性读取和 Git

`project` 是授权配置中的**准确名称**，不是路径。`read_project_file` 的 `path` 是项目内相对路径，只接受受限的 UTF-8 文本；拒绝路径穿越和链接路径。可指定从 1 开始的 `startLine` 与 `lineCount`，单次最多 500 行；文件大小上限 1 MiB，返回结果有 64 KiB 上限。检查 `ok`、`truncated` 和行范围，必要时分页。

```json
{"project":"example-project","path":"README.md","startLine":1,"lineCount":80}
```

`git_status` 使用 `{"project":"example-project"}`；`git_diff` 还需 `mode`，取 `unstaged` 或 `staged`。结果可能被截断或超时，检查 `ok`、`complete`、`truncated`、`timedOut` 等返回字段。未跟踪文件不会包含在普通 diff 中，需要单独读取。以上工具均不创建 Codex 任务。

确定性 MCP 工具 `git_add`、`git_commit`、`git_push` 需要用户授权以及分别配置的服务端 `gitWrite` 权限，默认均为 false。提交需要仓库本地身份并拒绝活动 hooks；推送须精确授权 remote URL/branch，GitHub HTTPS 可额外选择启用 Windows GCM，不支持 SSH。提交前审查整个暂存区。配置、示例和恢复方法见[受控 Git 写入工具](docs/Git-Write-Tools-BRIDGE-LAB-CN.md)。

### 任务、模型和生命周期

先通过 `codex_settings` 和 `codex_models` 检查当前默认值与可用模型。新任务使用 `codex_task`，选择授权的绝对 `cwd`、`read-only` sandbox 和 `sessionMode: new`；为一个逻辑请求使用唯一 UUID 格式 `requestId`。提交后记录返回的 Job、Thread 和 Activity 标识，并用 `codex_status` 查询至终态。任务仍运行时不要仅凭工具调用超时认定失败。

需要继续同一 Thread 时使用 `sessionMode: continue` 和准确的 `threadId`，沿用同一工作目录及权限边界。当前 Bridge 拒绝在继续时更改 model 或 reasoning effort；需要调整时新建 Thread，交接必要上下文。默认模型和 effort 来自持久化 Settings，新 Thread 可显式覆盖；Bridge 保存的参数不等于模型侧执行与 Token 数据已被独立证明。

Activity 管理工作的验证和完成；Job 跟踪一次执行；Thread 保存连续上下文。按照当前工具 schema 执行 Activity 状态转换；验证通过可能已经使 Activity 完成，避免重复完成。中断后先查 Job/Thread 的权威状态；重试同一逻辑请求应复用同一 `requestId` 和完全相同的参数，不能用旧 ID 发送不同内容。

Codex Desktop 可按 `cwd` 将外部 Thread 归入已添加的对应本地项目。历史测试中需要重启 Desktop 才看到新 Thread，实时刷新不能保证；以 MCP 状态为准。ChatGPT Project、Desktop Project 与 Bridge 项目标识并不自动等同。

## 从检查到验收：示例工作流

1. 用户明确一个项目和只读目标。确认准确项目名、`cwd`、sandbox、禁止事项和预期结果。
2. 在 ChatGPT 启用连接器，调用 `git_status`、`read_project_file` 和必要的 `git_diff`，记录已有变更。
3. 如果仅靠确定性工具不足，让 `codex_task` 以 `read-only` 分析问题；通过 `codex_status` 等待终态，保存 Thread 和 Job ID。
4. 若用户随后明确授权修改，先核对有效权限是否允许 `workspace-write`，明确允许文件和测试。不要将之前的只读授权解释为写入许可。
5. 用独立读取和 Git 检查核实结果、原有改动及未跟踪文件；审阅测试报告和未验证事项。提交、推送、删除及其他敏感操作依项目规则与用户授权进行。

## 维护和排障

| 现象 | 检查方向 |
| --- | --- |
| `project_not_configured` 或找不到项目 | 核对 CLI 与控制器是否使用同一配置、项目真实路径、两个授权标志和唯一名称；不要随意扩大根目录。 |
| Bridge 不健康或端口被占 | 看 `status` 指出的监听者和受管状态；核对实际端口及本地日志。未知进程应先识别，不要强制停止。 |
| 版本不匹配 | 校验 `CodexBin` 目录及 `ExpectedCodexVersion`；Desktop 更新后先验证兼容性，不要盲目绕过固定版本。 |
| Tunnel 存活但 ChatGPT 不通 | 检查 profile 的 URL、Tunnel ID、组织/工作区关联、权限及客户端诊断；再做实际 MCP 调用。 |
| 连接器报 OAuth 错误 | 确认选择 Tunnel 连接，而非把网关 URL 当作 OAuth 服务器。 |
| 任务超时或连接中断 | 恢复连接后先查 Job/Thread，再判断是否重试或停止；不要假设任务已取消。 |
| Desktop 看不到 Thread | 核对相同 `cwd` 和本地项目；历史环境重启后出现，实时刷新未保证。 |

升级 Node、Codex、上游 Bridge 或 Tunnel 客户端后，先检查依赖和内部 API 兼容性，再做小范围只读验证。保护配置、状态和日志；保留恢复所需的备份，避免发布原始日志。源码入口的 `--doctor` 可检查 app-server、授权项目及本地 Bridge 可达性，但不替代 ChatGPT 实际调用；使用与控制器相同的配置和已验证 CLI 环境运行。

## 已验证与未验证

[协同工作指南](docs/GPT-Codex-Collaboration-Workflow-v1.0-CN.md) 解释工作流程，并保留特定 T4–T5 环境的权限、幂等、恢复、Thread、模型与 Desktop 测试记录。这些历史结果不代表任意新机器或新版本已通过；控制器阶段沿革和验证限制见 [Windows 控制器参考](docs/Windows-Controller-BRIDGE-LAB-CN.md)。

尚未充分验证或解决：模型侧实际执行参数的独立证明、完整 Token 统计、Desktop 外部 Thread 实时刷新、真实运行中任务的强制断源恢复，以及所有控制器异常保护的动态故障注入。本文档修订没有启动服务或重新执行端到端测试。

## 参考和许可

- [维护者架构与验证指南](docs/Maintainer-Architecture-BRIDGE-LAB-CN.md)：源码装配、确定性工具边界、构建与维护验证。
- [快速开始](QuickStart-BRIDGE-LAB-CN.md)：首次配置、日常操作和只读验证的主入口。
- [Windows 配置指南](docs/Windows-Setup-BRIDGE-LAB-CN.md)：Windows 依赖和环境参考。
- [GPT–Codex 协同工作指南](docs/GPT-Codex-Collaboration-Workflow-v1.0-CN.md)：面向人的流程解释、示例和历史证据。
- [GPT 协同指令](docs/GPT-Codex-Collaboration-Instructions-CN.md)：可复制到 ChatGPT Project Instructions 的规则，不会从仓库自动加载。
- [Windows 控制器参考](docs/Windows-Controller-BRIDGE-LAB-CN.md)：参数、进程识别、恢复行为及历史验证范围。
- [reverse Bridge 技能参考](plugins/transceiver/skills/transceiver/references/reverse-bridge.md)、[第三方声明](plugins/transceiver/THIRD_PARTY_NOTICES.md)。

本 fork 保留上游作者及贡献归属，项目采用 [AGPL-3.0](LICENSE)；使用、修改及分发时请同时遵守相关第三方许可。
