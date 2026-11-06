import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CodexAppServerUpstreamPool } from "codex-mcp-bridge-for-chatgpt/dist/appServerUpstream.js";
import { enforceSandbox } from "codex-mcp-bridge-for-chatgpt/dist/config.js";
import { UserSettingsStore } from "codex-mcp-bridge-for-chatgpt/dist/userSettings.js";
import { resolveReversePermissions } from "../scripts/reverse-permissions.mjs";

test("workspace permission remains independent of approval=never and full access stays opt-in", async () => {
  const defaults = resolveReversePermissions({});
  assert.equal(defaults.CODEX_MCP_BRIDGE_DEFAULT_SANDBOX, "read-only");
  assert.equal(defaults.CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS, "0");
  const config = { defaultSandbox: "read-only", allowWorkspaceWrite: true, allowDangerFullAccess: false };
  assert.equal(enforceSandbox(config, "workspace-write"), "workspace-write");
  assert.throws(() => enforceSandbox(config, "danger-full-access"), /disabled/);
  // Guard the source reported by the offline diagnostic; no runtime import (it starts a server).
  const runtime = await fs.readFile(new URL("../scripts/reverse-runtime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /CODEX_MCP_BRIDGE_APPROVAL_POLICY:\s*"never"/);
  assert.doesNotMatch(runtime, /CODEX_MCP_BRIDGE_APPROVAL_POLICY:\s*process\.env/);
});

test("saved access strategy mapping distinguishes adaptive requests from forced strategies", () => {
  const config = { defaultSandbox: "read-only", allowWorkspaceWrite: true, allowDangerFullAccess: false };
  const resolve = (strategy, requested) => UserSettingsStore.prototype.resolveSandbox.call({
    config, settings: { accessStrategy: strategy },
  }, requested);
  assert.equal(resolve("adaptive"), "read-only");
  assert.equal(resolve("adaptive", "workspace-write"), "workspace-write");
  assert.throws(() => resolve("adaptive", "danger-full-access"), /disabled/);
  assert.equal(resolve("read-only", "workspace-write"), "read-only");
  assert.throws(() => resolve("always-full"), /disabled/);
});

test("fake App Server receives start permissions; resume and turns inherit without overrides", { timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, ".execution-permissions-"));
  const audit = path.join(directory, "audit.jsonl");
  const fake = path.join(import.meta.dirname, "helpers", "fake-app-server.mjs");
  const spawn = childProcess.spawn;
  const pools = [];
  t.after(async () => {
    await Promise.all(pools.map((pool) => pool.close()));
    mock.mock.restore();
    syncBuiltinESMExports();
    assert.equal(path.dirname(directory), import.meta.dirname);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const mock = t.mock.method(childProcess, "spawn", (command, args, options) => {
    assert.equal(command, "OFFLINE_FAKE_CODEX_ONLY");
    assert.deepEqual(args, ["app-server", "--stdio"]);
    const env = { T35A_AUDIT_LOG: audit, T35A_CAPTURE_PERMISSIONS: "1", TEMP: directory, TMP: directory };
    for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    return spawn(process.execPath, [fake], { ...options, env, cwd: directory, windowsHide: true });
  });
  syncBuiltinESMExports();
  const first = new CodexAppServerUpstreamPool("OFFLINE_FAKE_CODEX_ONLY", 1);
  pools.push(first);
  let threadId;
  await first.callTool("codex", { cwd: directory, sandbox: "workspace-write", "approval-policy": "never", prompt: "offline" },
    undefined, (assignment) => { threadId = assignment.threadId; });
  assert.ok(threadId);
  await first.close();
  const restarted = new CodexAppServerUpstreamPool("OFFLINE_FAKE_CODEX_ONLY", 1);
  pools.push(restarted);
  await restarted.callTool("codex-reply", { threadId, prompt: "offline continuation" });
  await restarted.close();
  const events = (await fs.readFile(audit, "utf8")).trim().split("\n").map(JSON.parse);
  const starts = events.filter((e) => e.method === "thread/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].cwd, directory);
  assert.equal(starts[0].sandbox, "workspace-write");
  assert.equal(starts[0].approvalPolicy, "never");
  assert.deepEqual(events.find((e) => e.method === "thread/resume").keys, ["threadId"]);
  const turns = events.filter((e) => e.method === "turn/start");
  assert.equal(turns.length, 2);
  for (const turn of turns) assert.deepEqual(turn.keys, ["input", "threadId"]);
});

test("Windows diagnostic parses and contains only read-only commands (does not execute ps1)",
  { skip: process.platform !== "win32" }, () => {
    const script = path.resolve(import.meta.dirname, "../../../scripts/diagnose-execution.ps1");
    // Fixed parser command, path supplied through a dedicated environment variable, never interpolated.
    const command = "$t=$null; $e=$null; $a=[Management.Automation.Language.Parser]::ParseFile($env:TRANSCEIVER_AST_FILE,[ref]$t,[ref]$e); " +
      "if($e.Count){throw 'PowerShell parse failed'}; " +
      "$null=[Management.Automation.Language.Parser]::ParseFile($env:TRANSCEIVER_AST_TEST_FILE,[ref]$t,[ref]$e); if($e.Count){throw 'PowerShell test parse failed'}; " +
      "@($a.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true) | ForEach-Object {$_.GetCommandName()} | Sort-Object -Unique) | ConvertTo-Json";
    const executable = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", timeout: 10000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, TRANSCEIVER_AST_FILE: script,
        TRANSCEIVER_AST_TEST_FILE: path.join(path.dirname(script), "diagnose-execution.Tests.ps1") },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout);
    const allowed = new Set(["Set-StrictMode", "Join-Path", "Get-Item", "New-Object", "Get-Acl", "Get-Command",
      "Select-Object", "Where-Object", "Split-Path", "ConvertFrom-Json", "ConvertTo-Json", "Get-LocalPath",
      "Test-PlainPath", "Read-BoundedText", "Get-Field", "Get-PathObservation", "Find-Application", "Get-Setting"]);
    for (const name of commands) assert.ok(allowed.has(name), `Unexpected diagnostic command: ${name}`);
  });
