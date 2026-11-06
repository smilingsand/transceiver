# Bridge Lab：Windows 首次配置

[English](Windows-Setup-BRIDGE-LAB.md) | [简体中文](Windows-Setup-BRIDGE-LAB-CN.md)

本参考帮助你准备 Windows 环境并理解配置条件。要连接一个**明确授权的本地项目**，请按 [快速开始](../QuickStart-BRIDGE-LAB-CN.md) 操作；仓库不会自动创建云端账号、Tunnel、项目授权或凭据。架构、安全边界与工具细节见 [Bridge Lab 手册](../README-BRIDGE-LAB-CN.md)。

沙盒/Python 访问失败或 Git 超时时，参见[离线执行权限诊断与最小权限流程](Execution-Permissions-BRIDGE-LAB-CN.md)。

## 1. 准备环境

准备 Windows PowerShell 5.1+、Node.js 22+、Git for Windows、可用的 Codex CLI/App Server、`tunnel-client` 和本 fork 的稳定 checkout。Codex 需要完成自身登录；Tunnel 需要可用的 Platform organization、正确的 ChatGPT 工作区关联，以及具有 Developer Mode 的 ChatGPT 账号。创建或编辑 Tunnel 需要 Tunnels Read + Manage；运行客户端和在 ChatGPT 选择 Tunnel 需要 Tunnels Read + Use。

确定 checkout 和用户明确授权的目标项目。本机 `bridge.env`、`config.json` 位于 checkout 根目录，状态和 profile 等位于 `runtime/`。Git 忽略不是访问边界：仓库作为允许的工作区时包含 `runtime/`。根目录配置不得存放秘密；凭据仅存于受保护的 Windows 环境变量。Tunnel profile 可能含敏感信息，须限制访问且绝不发布。以下路径都是占位符；不要复制为实际授权路径。

控制器执行源码入口 `plugins/transceiver/scripts/reverse-runtime.mjs`，不使用上游打包入口。源码运行需要 `plugins/transceiver/package.json` 中的依赖；如果尚未准备，在确认来源、网络权限及锁文件后，由用户在该目录按锁文件安装：

```powershell
Set-Location 'C:\Path\To\transceiver\plugins\transceiver'
npm ci
```

安装访问软件源、写入 `node_modules`，可能需要本机编译环境；这里没有声称本次已安装或验证。上游打包安装不需要此步骤，但它不是此控制器使用的源码运行方式。回到 checkout 根目录：

```powershell
Set-Location 'C:\Path\To\transceiver'
node --version
& 'C:\Path\To\Git\mingw64\bin\git.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' app-server --help
& 'C:\Path\To\tunnel-client.exe' help quickstart
```

确定性 Git 服务要求可信的**绝对路径原生 Git 可执行文件**，Windows 源码提示使用 `mingw*/bin/git.exe`，不回退到 PATH。控制器默认固定旧机器的 Codex Desktop CLI 目录，预期版本默认为空；须提供经过兼容验证的 `CodexBin` 目录与匹配的 `ExpectedCodexVersion`。不要依赖固定路径在 Desktop 更新后继续存在。

## 后续配置和连接

首次配置按 [六步快速开始](../QuickStart-BRIDGE-LAB-CN.md) 顺序执行：[获取 fork](../QuickStart-BRIDGE-LAB-CN.md#1-获取本-fork-并选择分支)、[准备 Tunnel](../QuickStart-BRIDGE-LAB-CN.md#2-准备依赖并创建-tunnel)、[凭据与 profile](../QuickStart-BRIDGE-LAB-CN.md#3-安全设置凭据及-profile)、[项目授权](../QuickStart-BRIDGE-LAB-CN.md#4-配置控制器并授权项目)、[控制器操作](../QuickStart-BRIDGE-LAB-CN.md#5-启动检查停止和日志维护) 和 [ChatGPT 验证](../QuickStart-BRIDGE-LAB-CN.md#6-连接-chatgpt-并验证真实-mcp)。

Desktop 中打开项目、ChatGPT Project 和 Bridge 授权相互独立。端口变更时，控制器端口与 profile MCP URL 必须一致。配置和运行细节见 [控制器参考](Windows-Controller-BRIDGE-LAB-CN.md)。

本参考基于源码和已有说明；未在本次文档整理中安装依赖、启动服务或执行端到端测试。
