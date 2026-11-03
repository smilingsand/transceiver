import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "codex-mcp-bridge-for-chatgpt/dist/config.js";
import { TransceiverRouter } from "../../scripts/reverse-router.mjs";
import { createHttpServer } from "../../scripts/reverse-http.mjs";
import { createDeterministicServices } from "../../scripts/deterministic/create-services.mjs";
import { createGitEnvironment } from "../../scripts/deterministic/git-safety.mjs";

export const GIT = process.env.TRANSCEIVER_TEST_GIT || (process.platform === "win32"
  ? "D:/Program Files/Git/mingw64/bin/git.exe" : "/usr/bin/git");
export const ORIGINAL_TOOLS = ["codex_status", "codex_activity", "codex_activity_handoff", "codex_cancel",
  "codex_activity_update", "codex_models", "codex_settings", "codex_update_settings", "codex_task"];
export const NEW_TOOLS = ["read_project_file", "git_status", "git_diff", "git_add", "git_commit", "git_push"];
export const META_A = { "openai/organization": "fixture-org", "openai/subject": "fixture-user",
  "openai/session": "fixture-chat-a", "openai/locale": "zh-CN", "openai/widgetSessionId": "fixture-widget" };
export const META_B = { ...META_A, "openai/session": "fixture-chat-b" };

export async function fixtureGit(root, args) {
  const child = childProcess.spawn(GIT, args, { cwd: root, env: createGitEnvironment(root),
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
}

export function fakeBackend() {
  const backend = {
    calls: [], controls: [], pending: new Map(), closed: 0,
    async listTools() { return { tools: [] }; },
    canResumeThread() { return true; },
    async callTool(name, args, onProgress, onAssigned) {
      const number = backend.calls.length + 1;
      const threadId = args.threadId || `fixture-thread-${number}`;
      const turnId = `fixture-turn-${number}`;
      backend.calls.push({ name, args });
      onAssigned?.({ backendKind: "app-server", threadId, workerId: `fixture-worker-${number}`,
        workerGeneration: 1, workerPid: 9000 + number, upstreamRequestId: turnId });
      if (args.prompt.includes("HOLD_FIXTURE")) {
        await new Promise((resolve) => backend.pending.set(turnId, resolve));
        backend.pending.delete(turnId);
      }
      return { content: [{ type: "text", text: "fixture result" }],
        structuredContent: { threadId, turnId, turnStatus: "completed", result: "fixture result" },
        _meta: { fixture: "preserved" } };
    },
    async steerThread(threadId, prompt) { backend.controls.push({ action: "steer", threadId, prompt }); },
    async forceTerminateWorker(assignment) {
      backend.controls.push({ action: "cancel", assignment });
      backend.pending.get(assignment.upstreamRequestId)?.();
      return { exited: true, workerExited: false, mode: "turn-interrupt", escalated: false };
    },
    async close() { backend.closed++; for (const resolve of backend.pending.values()) resolve(); },
  };
  return backend;
}

export function fakeCatalog() {
  return { calls: 0, async getCatalog() {
    this.calls++;
    return { source: "fixture", fetchedAt: "2026-11-01T00:00:00.000Z", cached: true, stale: false,
      models: [{ id: "fixture-model", displayName: "Fixture", defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ effort: "low", description: "fixture" }] }] };
  } };
}

export async function createFixture(t, { services: overrideServices, noAuth = true } = {}) {
  const parent = path.resolve(import.meta.dirname, "..");
  const directory = await fs.mkdtemp(path.join(parent, ".t3.4-"));
  const servers = [];
  const clients = [];
  const backend = fakeBackend();
  let cleanupExtra = () => {};
  t.after(async () => {
    // Finish pending fake calls before closing only our own listeners/state.
    for (const resolve of backend.pending.values()) resolve();
    for (const client of clients) await client.close();
    for (const server of servers) {
      if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
    }
    await cleanupExtra();
    await backend.close();
    const relative = path.relative(parent, directory);
    assert.ok(relative.startsWith(".t3.4-") && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const root = path.join(directory, "project");
  const plain = path.join(directory, "plain");
  await fs.mkdir(root);
  await fs.mkdir(plain);
  await fs.writeFile(path.join(root, "sample.txt"), "fixture line one\nfixture line two\n");
  await fs.writeFile(path.join(plain, "sample.txt"), "plain fixture\n");
  await fixtureGit(root, ["init", "--template=", "--initial-branch=main", "."]);
  await fixtureGit(root, ["--no-optional-locks", "add", "--", "sample.txt"]);
  const configPath = path.join(directory, "projects.json");
  const projects = { version: 1, projects: {
    [root]: { name: "demo", sync: true, allowCodexTasks: true },
    [plain]: { name: "plain", sync: true, allowCodexTasks: true },
  } };
  const save = () => fs.writeFile(configPath, JSON.stringify(projects));
  await save();
  const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: noAuth ? "1" : "0",
    CODEX_MCP_BRIDGE_TOKEN: "fixture-token", CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_ALLOWED_HOSTS: "127.0.0.1,localhost", CODEX_MCP_BRIDGE_ROOTS: `${root},${plain}`,
    CODEX_MCP_BRIDGE_CODEX: path.join(directory, "codex-must-never-run"),
    CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server", CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: "read-only",
    CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: "read-only", CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN: "1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(directory, "bridge.sqlite"),
    CODEX_MCP_BRIDGE_SESSION_STATE_FILE: path.join(directory, "sessions.json"),
    CODEX_MCP_BRIDGE_JOB_STATE_FILE: path.join(directory, "jobs.json"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(directory, "models.json"),
    CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(directory, "settings.json") });
  const catalog = fakeCatalog();
  const upstream = new TransceiverRouter("app-server", backend, backend, {
    allowedProjects: [{ root, name: "demo" }, { root: plain, name: "plain" }],
  });
  const services = overrideServices || await createDeterministicServices({ configPath, gitExecutable: GIT });
  const server = createHttpServer(config, upstream, { ...services, modelCatalog: catalog });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = new Client({ name: "transceiver-fixture", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: noAuth ? {} : { Authorization: "Bearer fixture-token" } },
  }));
  return { directory, root, plain, projects, configPath, save, config, services, backend, upstream, catalog,
    server, url, client, servers, clients, setExtraCleanup(callback) { cleanupExtra = callback; } };
}

export async function memoryClient(t, server) {
  const client = new Client({ name: "memory-fixture", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(right);
  await client.connect(left);
  return client;
}

export const call = (client, name, args = {}, meta = META_A) => client.callTool({ name, arguments: args, _meta: meta });
export function succeeded(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}
export function taskArgs(root, overrides = {}) {
  return { requestId: randomUUID(), prompt: "fixture task", cwd: root, sessionMode: "new",
    executionMode: "foreground", ...overrides };
}
