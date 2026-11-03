# 受控 Git 写入工具 — T5.7

[English](Git-Write-Tools-BRIDGE-LAB.md)

保留 `git_status`、`git_diff` 原有只读接口，新增三个独立 MCP 工具，使用共享确定性 Git 执行与策略层。不启动 Codex、不创建 Activity/Thread、不消耗模型推理额度。**所有写入权限默认关闭**，读取授权不等于写入授权。

## 参数与结果

所有参数对象均严格限制（`additionalProperties: false`），示例字段全部必填。`project` 为已授权项目的精确名称（1–200 字符），不是路径。不接受 command、root、env、force、amend、delete 或任意 RefSpec。

从 MCP 工具发现直接导出的精确 Schema 见 [Git-Write-Tools-Schema.json](Git-Write-Tools-Schema.json)。

| 工具 | 参数示例 | 返回结果 |
| --- | --- | --- |
| `git_add` | `{"project":"transceiver","paths":["README.md","scripts/bridge-lab.ps1"]}` | 请求的 `paths`、整个索引的实际 `stagedPaths`、解析后的 `status` |
| `git_commit` | `{"project":"transceiver","message":"T5.7 - feat: add controlled Git write operations"}` | `created`、核实后的 40 位 `hash`、实际 `message`、简要 `stats` |
| `git_push` | `{"project":"transceiver","remote":"origin","branch":"dev/bridge-lab"}` | `remote`、`branch`、`result`：`created`、`updated` 或 `up-to-date` |

- Add 接受 1–100 个明确的相对文件/目录路径，每项 1–1024 字符，支持新增、修改、删除暂存。中文、空格、方括号和前导连字符按字面处理；拒绝绝对路径、遍历、`.`、`.git`、通配/Pathspec 及有歧义的 Windows/设备路径。没有默认全项目模式。暂存目录前检查后代路径；结果也包含原先暂存的内容。
- Commit 接受 1–8192 字符明确消息，执行层拒绝纯空白、NUL 和 CR。只提交现有索引，不自动 Add、Amend、空提交、修改配置或绕过 Hooks。空暂存区返回 `ok: true`、`created: false`、`reason: "NO_STAGED_CHANGES"`。阶段编号是本项目约定，不是通用工具限制。执行器不读取全局/系统配置，因此需要已有的**仓库本地** `user.name` 和 `user.email`；工具不会写入身份设置。
- Push 的 Remote/Branch 均为 1–200 字符，必须明确指定。Remote 使用以 ASCII 字母/数字开头的字母、数字、点、下划线和连字符；Branch 使用保守 ASCII 子集及 Git Ref 校验。本地分支必须存在。拒绝选项、通配符、删除语法和客户端 RefSpec；只允许普通的同名分支推送。不创建 Tag、Release、PR，不修改上游跟踪或凭据配置。


缺少身份时，`git_commit` 会在尝试提交前返回 `GIT_IDENTITY_MISSING`。请在已授权仓库中设置 `git config --local user.name "Your Name"` 和 `git config --local user.email "you@example.com"`。身份属于仓库本地 Git 配置，不属于 Transceiver 配置或启动流程；不会注入全局 Git 身份。

## 服务端授权

检查当前统一 MCP 路径后，确认它有端点认证，但没有可验证的逐次用户写操作审批通道。连接器确认及 MCP annotations 只是客户端提示，不能作为服务端授权边界，也不能由 Prompt 中承诺询问代替。操作者须在现有服务端项目配置（`TRANSCEIVER_CONFIG` / 控制器 `-ConfigPath`）明确启用：

```json
{
  "version": 1,
  "projects": {
    "D:/MyWorks/transceiver": {
      "name": "transceiver",
      "sync": true,
      "allowCodexTasks": true,
      "gitWrite": {
        "add": true,
        "commit": true,
        "push": true,
        "githubGcm": true,
        "pushTargets": [
          {
            "remote": "origin",
            "url": "https://github.com/OWNER/REPO.git",
            "branches": ["dev/bridge-lab"]
          }
        ]
      }
    }
  }
}
```

这只是启用示例，不会自动应用。缺省权限关闭，非法策略拒绝执行，每个操作分别要求布尔值 `true`。仅填写 `pushTargets` 不授予 Push。Remote/Branch 必须恰好匹配一条授权，仓库的唯一 Push URL 必须与授权完全一致，无通配授权。实际推送使用固定 URL 及内部构造的同名分支 RefSpec，修改本地默认配置不能重定向或扩大操作；这种 URL 推送不更新本地 Remote Tracking Refs。

每次子进程启动前重载策略；撤销阻止后续步骤，不能撤回已启动命令。已有根目录的权限变更可重载；新增或重新绑定根目录需要重建宿主策略。授权对该 Bridge 所有调用者生效，不按 ChatGPT 用户隔离，应保护配置和端点。写工具 annotations 与只读工具区分；上游 Codex sandbox 设置不会授予或阻止这些确定性操作。

## 安全范围及限制

- 复用可信 Git 绝对路径、根目录身份检查、项目顶层普通 `.git`、严格配置子集和最小环境。Git 由进程接口直接启动；启用的助手由 Git 的助手 Shell 按下述限制调用。不继承全局/系统配置、`GIT_*`、PATH 或凭据环境。拒绝 Includes、Aliases、Filters、外部 Diff/Textconv、签名程序和本地凭据管理器配置，不自动改写。
- 写操作发现 `.git/hooks` 活动文件就返回 `HOOKS_NOT_SUPPORTED`，`*.sample` 惰性文件除外。失败的 pre-commit Hook 同样在执行 Hook 或创建 Commit **之前拒绝**，不会运行或静默跳过。需要 Hooks 的流程请本地完成。Linked Worktree、嵌套仓库、Submodule、浅克隆、Promisor、共享元数据和链接仍不支持。
- Commit 检查**整个暂存区**，不依赖 `.gitignore`；Add 同时检查选中目录的后代。`.env*`、`bridge.env`、`config.json`、Credentials/Secrets、私钥、`.npmrc`、`.pypirc`、`.aws`、`.ssh`、`proj-info` 和 `codex` 等会被阻止（`SENSITIVE_STAGED_PATH`）。这是保守文件名规则，可能阻止无害示例，不是秘密内容扫描；提交/推送前仍需审查完整暂存 Diff 和新增文件。
- Push 支持不含用户凭据、Query、Fragment 的规范 HTTPS URL，禁用重定向，不支持 SSH 和自定义传输。`githubGcm` 默认关闭；启用后仅精确授权的 `https://github.com/...` 推送可使用可信 Git for Windows 原生 Git 同目录的 GCM，其他 HTTPS 主机不会使用该助手。Git 安装及其依赖须可信且受本机权限保护。Git 会通过助手 Shell 调用固定且校验过的路径，不接受配置传入的任意助手。GCM 使用 `GCM_INTERACTIVE=0`、`GIT_TERMINAL_PROMPT=0`、GitHub provider 和 Windows Credential Manager；它可能读取、保存或删除凭据条目。不要把 Token 放入 URL 或参数。
- 仅对启用认证的推送，`PATH` 指向可信 Git 的 bin 目录；`USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 为绝对路径时按需传入。`HOME` 仍隔离，系统/全局 Git 配置及继承的 Git/GCM 环境变量仍被禁用。认证依赖 Bridge 的 Windows 账户、凭据、权限、网络和 GCM 安装。`CREDENTIAL_UNAVAILABLE` 表示固定助手不可用或路径不支持；`AUTHENTICATION_REQUIRED` 表示需要凭据或交互；`AUTHENTICATION_FAILED` 表示认证/访问被拒（包括 HTTP 401/403）。这些分类不能证明凭据存储状态。
- 支持明确授权的本地绝对 Bare 目录，用于离线流程。Receive-Pack 前检查目标配置、元数据、链接和活动 Hooks；拒绝 UNC 及普通非 Bare 目标。URL 授权意味着允许写入该目标。HTTPS 远端仍可按自身策略拒绝推送。
- 每个请求的全部子进程共享 10 秒期限、1 MiB stdout/stderr 预算；响应上限 64 KiB，扫描上限 20,000 条目，全局并发最多 4。进程内项目写锁阻止工具重叠访问。不返回原始 Git stderr/传输文本。错误区分授权、参数/路径、仓库不支持、认证、网络、Non-fast-forward、远程拒绝、超时和输出超限。
- 这不是进程树沙箱，也不对恶意本地并发写入提供原子防护；应使用可信、空闲的仓库，OS 权限仍是外层边界。HTTPS 远端 Hooks 按远端自身策略执行。
- 检查 `ok`、`complete`、`truncated`、`timedOut`。尝试写入后的错误带有 `mutationMayHaveOccurred: true`；超时、输出超限、后验失败或断线不代表回滚。重试前检查 Status、暂存 Diff、本地 HEAD 及远端状态。

## 典型流程、测试与上线

安排仅重启 Bridge 后，刷新 MCP 工具发现，再对明确授权的分支调用 `git_push`，检查 `ok` 和 `result`；失败时重试前检查本地和远程状态。Bridge 账户须已有可非交互使用的 GitHub 凭据；必要时先通过普通本地流程单独登录。离线测试使用假助手，不能证明真实 GitHub 认证成功。

本次上线中，用户报告启用 `githubGcm` 并重启 Bridge 后，`git_push` 返回 `up-to-date`。这次调用没有创建或更新远程提交，不能单独证明 GCM 已完成认证写入；仍需推送用户授权的新提交并检查结果，才能验证认证写入。

1. `git_status` 检查现有修改，记录原先暂存的内容。
2. `git_diff` 使用 `mode: "unstaged"`；新增文件需另行读取。
3. `git_add` 指定预期路径，检查 `stagedPaths` 和 `status`。
4. `git_diff` 使用 `mode: "staged"`，审阅**整个索引**后用明确消息调用 `git_commit`；核对 Hash/统计，必要时本地执行 `git log -1 --stat`。
5. 授权和传输方式满足限制时，以明确 Remote/Branch 调用 `git_push`，检查目标和结果；有疑问时独立核对远端分支。

离线检查：在 `plugins/transceiver` 执行 `npm test`（先重建分发包，再运行全部 Node 测试）；在根目录执行 `pwsh -NoProfile -File ./scripts/bridge-lab.Tests.ps1` 和 `git diff --check`。临时夹具和 Bare Remote 均在仓库内，不向 GitHub 推送。真实 HTTP MCP 写入测试验证模型调用数为零。不操作真实服务、配置或私有 Runtime。

源码/控制器入口需要**仅重启 Bridge**才能加载新代码；分发包入口（`npm run reverse:start`）还需先执行 `npm run build:reverse`。不要重启 Tunnel。由操作者安排重启后刷新连接器工具发现，核对三个严格 Schema，先验证默认拒绝，再启用所需的精确授权。

控制器 `stop` 会停止**两个**组件，本次上线不要使用。先以现有实例相同的配置/Runtime 参数运行 `./scripts/bridge-lab.ps1 -Action status`，核实受管 Bridge PID、可执行文件、命令行及创建时间；再由操作者执行 `Stop-Process -Id <已核实的Bridge-PID>`，随后以相同参数执行 `./scripts/bridge-lab.ps1 -Action start`。控制器会保留身份匹配且仍运行的 Tunnel，仅启动缺失的 Bridge。这些命令只是后续操作说明，本次开发及离线测试不会对真实实例执行。
