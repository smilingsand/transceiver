# Bridge Lab 维护者架构与验证指南

本文供维护者理解当前源码的装配方式、限制和验证路径。下述实现判断依据仓库当前脚本与测试定义；历史运行结果单独标明，不能代替当前环境的实测。使用和配置步骤见 [Bridge Lab 手册](../README-BRIDGE-LAB-CN.md)与 [Windows 配置指南](Windows-Setup-BRIDGE-LAB-CN.md)。

## 进程内组合与状态

Windows 控制器启动 [reverse-runtime.mjs](../plugins/transceiver/scripts/reverse-runtime.mjs)。它从项目配置选取同时启用 `sync` 和 `allowCodexTasks` 的项目，建立上游 Codex 后端池和路由，再交给 [reverse-http.mjs](../plugins/transceiver/scripts/reverse-http.mjs) 装配 HTTP 服务。Tunnel 是外部客户端，转发到本地 `/mcp`；`/healthz` 只检查本地服务。

HTTP 层对每个 POST 创建 MCP Server 和无状态 transport，先调用上游工厂，再注册 `read_project_file`、`git_status`、`git_diff`。这样原有工具与新增工具由同一个端点提供，无须维护另一套 MCP 代理的初始化、资源、通知和错误转发语义。确定性工具直接调用本地服务，不需要创建 Codex 任务。

每个 HTTP 服务只创建一组 state store、session、job、model catalog、settings 和 scope resolver，并显式传给每次创建的 MCP Server。请求结束关闭该请求的 server 和 transport，HTTP 服务关闭时才关闭共享 state store。若依赖工厂默认值而逐请求重建注册表或 scope 状态，跨请求的会话连续性可能受损。线程到项目的映射另由 runtime 写入状态目录；持久状态与 ChatGPT 对话历史、Desktop 显示不是同一份数据。

项目配置有两种不同的生效方式：任务路由和允许根目录在启动时建立，新增或重新绑定项目需要重启；确定性文件与 Git 服务每次访问会重新读取策略，因此撤销授权可以阻止后续确定性访问。不能据此假定已启动的任务已取消或任务路由已实时重载。

## 确定性工具的边界

- 项目策略使用服务端配置而非客户端传入的根路径；读取和 Git 操作重新检查授权。文件工具只接受项目内相对路径、普通 UTF-8 文本，拒绝遍历、链接和不受支持的路径；默认文件上限 1 MiB、返回上限 64 KiB、每次最多 500 行。应检查 `ok`、`truncated` 和行范围。
- 路径组件和文件身份检查降低链接逃逸及替换风险，但源码明确指出这不是针对恶意本地写入者的原子遍历，尤其在 Windows 上。授权根目录也不是 Codex 进程的操作系统级隔离；实际权限仍受 sandbox 和宿主环境约束。
- Git 工具仅提供固定的 status 与 staged/unstaged diff，不接受任意命令或 ref；使用可信的绝对 Git 路径、无 shell 子进程、最小环境和固定参数，并禁用外部 diff、textconv、hooks 等入口。Windows 要求原生 Git for Windows 的 `mingw*/bin/git.exe`，且 Git 版本至少 2.45。
- 为限制 Git 读取范围，当前实现只接受项目顶层内的普通 `.git` 目录和受限配置，拒绝链接、嵌套仓库、子模块、linked worktree、alternates、浅克隆及 promisor 等不支持的结构。这些拒绝可能影响正常仓库，不能简单关闭检查以获得结果。Git 操作有时间、输出、扫描数量和并发上限；status 超限不返回部分状态，diff 截断时明确标记不完整。未跟踪文件内容不包含在普通 diff 中。

源码入口绑定 loopback 并关闭本地 HTTP 认证，依赖本机与 Tunnel 的访问边界；它还关闭上游按文件名的秘密扫描。凭据和敏感状态应放在受保护的仓库外位置，不应把这些限制误认为通用秘密检测或完整安全沙箱。修改网络暴露、凭据处理或权限边界前须先取得授权。

## 依赖与构建

[package.json](../plugins/transceiver/package.json) 固定上游 Bridge 发布包及 MCP SDK 版本，锁文件记录依赖树。HTTP 装配直接导入上游 `dist/` 内部模块，并检查上游版本与构建哈希；即使包可以安装，也不代表内部工厂参数、状态对象和协议行为仍兼容。升级时应审阅这些导入及兼容性检查，并验证工具 schema、资源、跨请求状态和重启恢复；不要只修改版本检查来绕过失败。

控制器运行源码入口，而 `npm run reverse:start` 运行受版本控制的 `dist/reverse-bridge/index.mjs`。源码变更不会自动更新 bundle，现有 bundle 可运行也不能证明与当前源码一致。不要手工修补压缩 bundle 或依赖目录；需要发布构建时，使用锁定依赖和受控环境重新生成并审阅完整产物。

[build-reverse.mjs](../plugins/transceiver/scripts/build-reverse.mjs) 使用当前 Node 直接运行 ncc JS CLI，生成 bundle、source map、许可信息和原生预构建文件；后处理校验预期匹配数量、规范化本机相关 fallback，并要求八个预构建文件。这些措施支持可复现构建，但不能单独证明任意平台或依赖版本的输出字节相同。记录 Node、依赖和平台版本，在相同条件下比较产物哈希或 Git 差异，异常时调查而非直接覆盖基线。

**构建有写入副作用：**脚本先删除整个 `dist/reverse-bridge/` 再生成；失败可能留下不完整产物。`npm test` 也先执行该构建。执行前检查工作区和输出目录，保留可恢复的完整基线及校验值，确认写入范围和授权；不要依赖构建失败后自动回滚。

## 分层验证与维护

选择与改动相称的验证，并记录环境、结果和跳过项：

1. 静态审查配置、源码入口、锁文件与变更，特别是授权、状态所有权和上游内部 API。检查受跟踪和未跟踪变更。
2. 使用 [tests](../plugins/transceiver/tests/) 中的单元与集成测试验证文件路径、授权撤销、Git 安全限制、HTTP 组合、权限和 bundle 行为。测试定义或通过结果不等于所有平台与真实服务均已验证；运行 `npm test` 前注意上述构建副作用。
3. 在明确授权的隔离项目及独立状态目录中验证平台相关行为、构建产物、跨请求和重启恢复。需要真实 Codex、Tunnel 或 ChatGPT 时，再做有界的只读链路验证；本地 health、进程存活或 doctor 输出不能证明端到端连接。`--doctor` 也会创建状态目录、调用本地帮助命令并请求 health，并非纯静态检查。
4. 升级或切换前记录正在运行的入口和版本，确认兼容性、维护窗口及恢复方法。保护并备份配置、状态及必要的受跟踪产物；一致性备份应在安全停止写入或使用相应存储机制后进行。日志和备份可能包含敏感信息，应限制访问并在分享前脱敏。不要随意删除状态库、覆盖原配置或停止未知进程。

历史隔离验证曾在 Windows 环境构建并运行 bundle，检查工具装配、状态恢复及与旧工具定义的兼容；该记录使用隔离状态和假后端，并非真实 ChatGPT、Tunnel 和模型的端到端验收。它只说明当时环境的结果，不保证当前代码、依赖或其他机器通过。本次文档整理依据当前代码静态核对，未重新运行服务或端到端测试。
