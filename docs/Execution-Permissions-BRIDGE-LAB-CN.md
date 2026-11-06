# Windows 执行权限

[English](Execution-Permissions-BRIDGE-LAB.md) | [简体中文](Execution-Permissions-BRIDGE-LAB-CN.md)

本参考区分 Codex Shell、控制器和专用 Git MCP 工具的权限。本地诊断不修改策略、配置、ACL、服务或项目文件，不新增 MCP 端点或客户端能力。

## 运行本地诊断

在现有执行策略允许加载本地脚本的操作者 PowerShell 中，从本 checkout 执行：

```powershell
.\scripts\diagnose-execution.ps1 -Project transceiver -RequestedSandbox workspace-write
# 可选的只读观察；将所有占位符换成已批准路径。
.\scripts\diagnose-execution.ps1 -Project demo -Cwd 'D:\Approved\demo' `
  -CheckPython -PythonPath 'D:\ApprovedTools\Python312\python.exe' `
  -UvPath 'D:\ApprovedTools\uv.exe' -VenvPath 'D:\Approved\demo\.venv'
```

默认输出 JSON；`-AsObject` 返回 PowerShell 对象。`-ConfigPath`、`-BridgeEnvPath`、`-RuntimeDir` 选择本地诊断输入，相对路径以 checkout 为基准，不改变控制器配置。自定义 state/control 路径及控制器启动参数不会自动发现。只有传入 `-CheckPython` 或 Python/uv/venv 路径时才进行相关检查。

脚本不执行 Python、uv、Codex 或 Node，不查询 live 服务、打开 SQLite、读取 rollout、检查凭据或枚举环境变量。它有界读取 UTF-8 配置文件，只返回白名单设置和路径观察。未知设置与解析错误不回显原始值。拒绝重解析点路径、UNC/device 路径和备用数据流。输出包含授权的本地路径与观察者账户名，分享前请检查。

如果 PowerShell 禁止加载 `.ps1`，停止并报告限制；不要为运行诊断或测试放宽执行策略，也不要绕过 Codex 沙盒。

## 理解配置来源

| 输出 | 含义 |
| --- | --- |
| `controllerConfiguration` | 根据选定 `bridge.env` 解析控制器默认设置；各项包含来源与有效性。 |
| `sandboxCandidate` | 有条件的新任务计算：read-only 策略固定只读；adaptive 使用请求的 sandbox 或配置默认值；always-full 要求单独的 full-access 授权。输入缺失、不可访问或无效时不报告为允许。 |
| `repositoryApprovalPolicy` | 观察源码入口显式设置 never 的行为；描述仓库实现，不代表运行中进程。继承环境不能覆盖该赋值。 |
| `savedStrategy` | 未知：不打开保存偏好的 SQLite；保存策略可能覆盖控制器策略。 |
| `appServerActual` | 未知：不观察 live RPC 或线程状态。磁盘设置、旧 rollout 和配置候选值都不等于当前 turn 的实际权限。 |
| `codexExecutables` | 分别展示配置目录、控制器记录路径与 PATH 候选；记录可能过时，控制器不回退到 PATH。本诊断不解析其内置固定备用目录。 |
| `projectAuthorization` | 只检查选中配置候选、cwd 包含关系、标志和普通路径，不构成授权；服务端独立校验完整 allowlist、根目录重叠、身份与撤销。 |
| `pythonChecks` | 可选的文件/ACL 可读性观察，适用于运行此脚本的账户，不一定是 Codex 沙盒账户。 |

控制器启动参数优先于 `bridge.env`，之后保存的策略还可能改变任务选择。新任务将 cwd、sandbox、approvalPolicy 传给 App Server 的 thread/start；续接沿用原线程，不在 turn/start 重传 sandbox。因此源码或配置变化不能证明旧线程权限已改变。单独取得 live config/read 也不能证明 thread/turn 覆盖后的值。

实现参考：`scripts/bridge-lab.ps1` 参数和环境解析；`plugins/transceiver/scripts/reverse-permissions.mjs`；`reverse-runtime.mjs` 显式审批策略赋值；固定上游依赖的 `dist/tools.js` 任务选择与 `dist/appServerUpstream.js` 请求映射。诊断描述源码 checkout，不描述任意已部署 bundle。

## 已验证诊断与限制

2026-11-06 调查观察到原生 Windows Shell 账户 codexsandboxoffline，以及磁盘上的 elevated 沙盒选择。uv 0.11.9 无法读取交互用户的 managed Python 目录 `C:\Users\<user>\AppData\Roaming\uv\python`，返回 os error 5。离线 disposable fixture 中，系统安装的 Python 3.14.2、其子进程和 uv 创建的 venv 在不同 Shell 调用间均可运行；请求 3.12.13 时在发现 managed 安装阶段失败。这支持路径/账户访问问题，不能证明 uv 缺陷或所有 Python 子进程被禁止。

未取得原 Python 3.12.13 的准确可执行路径、venv 基础配置及有效 ACL，也没有逐字复现原 interpreter-query/trampoline 错误。未读写受影响的应用仓库。Python 3.14.2 只是诊断对照，不替代项目要求的 3.12.13。

checkout 根 `.git` 有显式拒绝写入 ACL；内部 disposable 仓库没有同样的拒绝项，其 git add 成功。内部 fixture 没有复现根 index.lock 失败。Codex 官方说明 workspace-write 下可写根目录的 `.git` 仍受只读保护；approval_policy=never 取消审批提示，不授予 full access。参见[官方权限说明](https://learn.chatgpt.com/docs/agent-approvals-security)和 [Windows 沙盒行为](https://learn.chatgpt.com/docs/windows/windows-sandbox)。

## Python 3.12 工具链修复

1. 请求观察指定解释器、uv 路径及已有 venv。脚本检查 pyvenv.cfg 的 home、base-executable、executable 字段和 venv launcher；可读 launcher 仍可能引用不可访问的基础解释器。
2. fileReadable=true 仅证明能打开读取文件；aclReadable=true 仅证明能读取 ACL，均不证明有效执行权限、DLL 可用或解释器能启动。executionAccess 保持 unknown-not-executed；路径缺失与无权访问可能无法区分。
3. 由操作者批准，从可信发行源将准确版本 CPython 3.12.13 预置到对沙盒账户可访问的、范围受限的工具链目录。核验来源、版本与所需读/执行权限。不要授予整个用户目录写权限、广泛改 ACL、关闭 Defender 或默认启用 full access。
4. 经单独授权后重建项目 venv，使其引用该安装。只移动/复制 venv 可能保留不可访问的基础路径。不要在 Transceiver 诊断中修改无关应用配置。
5. 先在 disposable fixture 中跨两次 Shell 调用验证基础解释器、子进程、venv 与离线 uv run --locked，再在明确授权的项目中运行测试。普通操作者 Shell 成功不证明沙盒用户成功。

## 专用 Git 与 GPT 评审

代码编辑继续使用 Codex workspace-write。已授权的 Git 写入使用专用工具：检查完整 git_status/git_diff，与 GPT/用户评审改动，再对明确的项目相对路径调用 git_add，检查 staged diff，仅执行已授权的 commit。push 还需单独授权及固定 remote/branch grant。任务完成不等于获准 commit/push。

工具以固定 cwd/环境直接启动可信原生 Git，不经过 shell。服务端配置分别授权 add/commit/push 并重新校验项目；它们不继承 Codex Shell 的 `.git` 限制。Conversation/Activity scope 是路由，不是逐聊天的 Git 项目授权。仍需已有 HTTP/tunnel 访问控制，本诊断不新增未认证访问。

检查 ok、complete、truncated、timedOut、mutationMayHaveOccurred。不要把超时当作权限错误，也不要盲目重试可能已经完成的 commit。活跃 hook、不安全配置、敏感暂存路径、不支持的链接与共享 Git 元数据仍被拒绝。

不要把任意 pytest/shell runner 加入高权限 MCP 服务来规避故障；测试收集可以执行项目代码，固定 argv 不等于 OS 隔离。这类 runner 需要单独评审、明确授权的执行边界。

## Git 状态扫描与超时

`git_status` 在执行 Git 前后检查项目和 `.git` 控制面，不再递归扫描工作树。路径由 Git 原生 index 和 `.gitignore` 规则处理，没有额外排除配置。默认 `full` 包含未跟踪文件，成功时 `complete: true`；可选 `scope: "tracked"` 不包含未跟踪文件，返回 `complete: false` 和 `untrackedIncluded: false`，不能据此判断整个工作树干净。

这是范围更窄的安全检查：status 不再独立检查工作树中的忽略路径、链接和嵌套仓库。Git ignore 不是安全边界。`git_diff` 以及 `git_add`、`git_commit`、`git_push` 仍对整个工作树（包括忽略路径）做安全扫描，因此可能拒绝 status 可以读取的仓库。测试用临时仓库应放在授权项目树外。普通 Git 操作总期限为 60 秒，push 为 120 秒，包含授权、扫描及子进程。

## 离线验证

已有依赖时，从 plugins/transceiver 执行：

```powershell
node --test tests/execution-permissions.test.mjs tests/reverse-permissions.test.mjs tests/git-tools.test.mjs tests/git-write-tools.test.mjs
# 仅当操作者现有策略已允许本地脚本时，从 checkout 根目录执行：
.\scripts\diagnose-execution.Tests.ps1
```

Node 测试使用真实 disposable Git fixture 和 fake stdio App Server，不调用模型、网络、真实 Python 3.12 或生产 Git 写入。覆盖启动/续接权限映射、allowlist/撤销/cwd 隔离、ignored 目录安全及有界扫描预算。Windows AST 测试只解析诊断脚本，不执行它。PowerShell 运行测试使用无效的合成可执行文件，验证脱敏、只读行为及配置候选值，不改变执行策略；运行受阻时必须报告受阻，不能报告通过。
