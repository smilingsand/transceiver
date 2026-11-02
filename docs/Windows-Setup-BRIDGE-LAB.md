# Bridge Lab: Windows Setup

[English](Windows-Setup-BRIDGE-LAB.md) | [简体中文](Windows-Setup-BRIDGE-LAB-CN.md)

Use the [six-step quick start](../QuickStart-BRIDGE-LAB.md) to connect an explicitly authorized local project. This reference explains the prerequisites; the repository does not create accounts, Tunnels, project authorization or credentials for you. See the [handbook](../README-BRIDGE-LAB.md) for architecture and security.

## Prepare the environment

You need Windows PowerShell 5.1+, Node.js 22+, Git for Windows, a signed-in Codex CLI with App Server, `tunnel-client`, and a stable checkout of this fork. Select the intended Platform organization and ChatGPT workspace and ensure Developer Mode is available. Creating or editing a Tunnel requires Tunnels Read + Manage; running the client and selecting it in ChatGPT requires Tunnels Read + Use.

Choose the checkout and an explicitly authorized local project. Non-secret `bridge.env` and `config.json` live at the checkout root; state and profiles default to `runtime/`. Git ignore rules do not isolate the checkout: if it is an allowed workspace, `runtime/` is inside that workspace. Keep credentials in protected Windows environment variables, outside the repository and authorized projects. Restrict profile access and never publish profiles.

The controller uses `plugins/transceiver/scripts/reverse-runtime.mjs`, not the upstream bundled entry point. If source dependencies are absent, review the source, network permissions and lockfile, then install them; this accesses the package registry and writes `node_modules` and may require local build tools:

```powershell
Set-Location 'C:\Path\To\transceiver\plugins\transceiver'
npm ci
Set-Location 'C:\Path\To\transceiver'
node --version
& 'C:\Path\To\Git\mingw64\bin\git.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' --version
& 'C:\Path\To\Tested\Codex\codex.exe' app-server --help
& 'C:\Path\To\tunnel-client.exe' help quickstart
```

Replace every placeholder. The deterministic Git service requires a trusted absolute path to native Git, typically `mingw64\bin\git.exe`, and does not fall back to PATH. The controller's fallback Codex directory is tied to an older machine and its expected version defaults to empty: provide a directory and exact version verified for compatibility. Desktop updates can replace that executable. The upstream packaged installation does not require this source dependency step, but it is a different entry point.

For example, if the verified CLI reports `codex-cli 0.123.0`, set `CODEX_VERSION=0.123.0` without the `codex-cli ` prefix. The controller adds the prefix when comparing the complete output.

## Continue setup

Follow the quick start in order: [get the fork](../QuickStart-BRIDGE-LAB.md#1-get-the-fork-and-select-the-branch), [prepare dependencies and Tunnel](../QuickStart-BRIDGE-LAB.md#2-install-prerequisites-and-create-a-tunnel), [credentials and profile](../QuickStart-BRIDGE-LAB.md#3-secure-credentials-and-create-a-profile), [configuration and authorization](../QuickStart-BRIDGE-LAB.md#4-configure-the-controller-and-authorize-a-project), [controller operation](../QuickStart-BRIDGE-LAB.md#5-start-inspect-stop-and-maintain-logs), and [live verification](../QuickStart-BRIDGE-LAB.md#6-connect-chatgpt-and-verify-a-real-mcp-call). If the port changes, the controller and profile MCP URL must match. Desktop project membership, ChatGPT Project membership and Bridge authorization are independent. See the [controller reference](Windows-Controller-BRIDGE-LAB.md) for operational details.

This guide describes the source and existing records. Documentation preparation did not install dependencies, start services or perform an end-to-end test.
