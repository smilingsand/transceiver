import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import childProcess from "node:child_process";
import { request } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createBridgeMcpServer, createHttpServer as upstreamHttp } from "codex-mcp-bridge-for-chatgpt/dist/server.js";
import { BRIDGE_BUILD_INFO } from "codex-mcp-bridge-for-chatgpt/dist/buildInfo.js";
import { BridgeStateStore } from "codex-mcp-bridge-for-chatgpt/dist/stateStore.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHttpServer, createSharedBridgeState, createUnifiedMcpServer, assertBridgeCompatibility } from "../scripts/reverse-http.mjs";
import { createProjectPolicy } from "../scripts/project-policy.mjs";
import { createProjectTools } from "../scripts/deterministic/project-tools.mjs";
import { createGitTools } from "../scripts/deterministic/git-tools.mjs";
import { createDeterministicServices } from "../scripts/deterministic/create-services.mjs";
import { GIT, ORIGINAL_TOOLS, NEW_TOOLS, META_A, META_B, createFixture, memoryClient,
  call, succeeded, taskArgs } from "./helpers/mcp-fixture.mjs";

test("12 unique tools preserve all original schemas/annotations/metadata and both card resources", async (t) => {
  const f = await createFixture(t);
  const state = createSharedBridgeState({ ...f.config, stateDatabaseFile: path.join(f.directory, "baseline.sqlite") },
    f.upstream, { modelCatalog: f.catalog });
  f.setExtraCleanup(() => state.stateStore.close());
  const baseline = await memoryClient(t, createBridgeMcpServer(f.config, f.upstream,
    state.sessions, state.jobs, state.modelCatalog, state.userSettings, state.scopeResolver));
  const actual = (await f.client.listTools()).tools;
  const expected = (await baseline.listTools()).tools;
  assert.equal(actual.length, 12);
  assert.equal(new Set(actual.map((tool) => tool.name)).size, 12);
  assert.deepEqual(expected.map((tool) => tool.name), ORIGINAL_TOOLS);
  assert.deepEqual(actual.filter((tool) => ORIGINAL_TOOLS.includes(tool.name)), JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(actual.filter((tool) => NEW_TOOLS.includes(tool.name)).map((tool) => tool.name), NEW_TOOLS);
  assert.equal(f.client.getInstructions(), baseline.getInstructions());
  assert.deepEqual(f.client.getServerVersion(), baseline.getServerVersion());
  assert.deepEqual(f.client.getServerCapabilities(), baseline.getServerCapabilities());
  const resources = await f.client.listResources();
  assert.deepEqual(resources, JSON.parse(JSON.stringify(await baseline.listResources())));
  assert.equal(resources.resources.length, 2);
  for (const resource of resources.resources) {
    const actualResource = await f.client.readResource({ uri: resource.uri });
    assert.deepEqual(actualResource, JSON.parse(JSON.stringify(await baseline.readResource({ uri: resource.uri }))));
    assert.match(actualResource.contents[0].text, /<html|<!doctype/iu);
  }
  for (const name of ["codex_models", "codex_settings"]) {
    const actualOutput = await call(f.client, name);
    const baselineOutput = await call(baseline, name);
    assert.deepEqual(actualOutput, JSON.parse(JSON.stringify(baselineOutput)));
  }
  assert.equal(f.backend.calls.length, 0);
});

test("three real deterministic services work through one HTTP MCP client without upstream/model calls", async (t) => {
  const f = await createFixture(t);
  const file = await call(f.client, "read_project_file", { project: "demo", path: "sample.txt", startLine: 2, lineCount: 1 });
  assert.equal(succeeded(file).content, "fixture line two");
  assert.deepEqual(JSON.parse(file.content[0].text), file.structuredContent);
  const status = succeeded(await call(f.client, "git_status", { project: "demo" }));
  assert.equal(status.branch.unborn, true);
  assert.equal(status.staged[0].path, "sample.txt");
  const diff = succeeded(await call(f.client, "git_diff", { project: "demo", mode: "staged" }));
  assert.match(diff.diff, /\+fixture line one/u);
  assert.equal(diff.unborn, true);
  assert.equal(succeeded(await call(f.client, "git_diff", { project: "demo", mode: "unstaged" })).diff, "");
  assert.equal(f.backend.calls.length, 0);
  assert.equal(f.catalog.calls, 0);
});

test("HTTP maps authorization, traversal, Git failures and strict schemas to explicit errors", async (t) => {
  const f = await createFixture(t);
  for (const [name, args, code] of [
    ["read_project_file", { project: "unknown", path: "sample.txt" }, "PROJECT_NOT_AUTHORIZED"],
    ["read_project_file", { project: "demo", path: "../outside" }, "INVALID_PATH"],
    ["git_status", { project: "plain" }, "NOT_GIT_REPOSITORY"],
    ["git_diff", { project: "unknown", mode: "staged" }, "PROJECT_NOT_AUTHORIZED"],
  ]) {
    const result = await call(f.client, name, args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, code);
  }
  const invalid = await call(f.client, "git_diff", { project: "demo", mode: "staged", ref: "HEAD" });
  assert.equal(invalid.isError, true);
  f.projects.projects[f.root].sync = false;
  await f.save();
  const revoked = await call(f.client, "git_status", { project: "demo" });
  assert.equal(revoked.structuredContent.error.code, "PROJECT_NOT_AUTHORIZED");
  assert.equal(f.backend.calls.length, 0);
  assert.equal(f.catalog.calls, 0);
});

test("real HTTP diff preview preserves failure/complete/truncated/timedOut and file truncation", async (t) => {
  const f = await createFixture(t);
  await fs.writeFile(path.join(f.root, "sample.txt"), "😀中 fixture ".repeat(12_000) + "\n");
  const diff = await call(f.client, "git_diff", { project: "demo", mode: "unstaged" });
  assert.equal(diff.isError, true);
  assert.equal(diff.structuredContent.ok, false);
  assert.equal(diff.structuredContent.complete, false);
  assert.equal(diff.structuredContent.truncated, true);
  assert.equal(diff.structuredContent.timedOut, false);
  assert.equal(diff.structuredContent.error.code, "OUTPUT_LIMIT");
  assert.ok(diff.structuredContent.diff.length > 0);
  assert.deepEqual(JSON.parse(diff.content[0].text), diff.structuredContent);
  const file = await call(f.client, "read_project_file", { project: "demo", path: "sample.txt" });
  assert.equal(succeeded(file).truncated, true);
  assert.equal(file.structuredContent.partialLastLine, true);
  assert.equal(f.backend.calls.length, 0);
});

test("HTTP maps real tightened Git timeout without applying it to other tools", async (t) => {
  const f = await createFixture(t);
  const policy = await createProjectPolicy({ configPath: f.configPath });
  const gitTools = await createGitTools({ policy, gitExecutable: GIT, limits: { timeoutMs: 1 } });
  const server = createHttpServer({ ...f.config, stateDatabaseFile: path.join(f.directory, "timeout.sqlite") },
    f.upstream, { fileTools: createProjectTools({ policy }), gitTools, modelCatalog: f.catalog });
  f.servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({ name: "timeout-fixture", version: "1" });
  f.clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await call(client, "git_status", { project: "demo" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "TIMEOUT");
  assert.equal(result.structuredContent.timedOut, true);
  assert.equal(succeeded(await call(client, "read_project_file", { project: "demo", path: "sample.txt" })).ok, true);
  assert.equal(f.backend.calls.length, 0);
});

test("shared state preserves request replay, thread continuation, scope isolation and Activity lifecycle across POSTs", async (t) => {
  const f = await createFixture(t);
  const args = taskArgs(f.root);
  const firstResult = await call(f.client, "codex_task", args);
  const first = succeeded(firstResult);
  // Upstream deliberately strips backend _meta from retained job results.
  assert.equal(firstResult._meta, undefined);
  assert.equal(first.result, "fixture result");
  assert.equal(f.backend.calls.length, 1);
  assert.match(f.backend.calls[0].args.prompt, /^\|from_chatgpt\|:\nproject: demo/u);
  const replay = succeeded(await call(f.client, "codex_task", args));
  assert.equal(replay.bridgeActivity.jobId, first.bridgeActivity.jobId);
  assert.equal(f.backend.calls.length, 1);
  const wrongReplay = await call(f.client, "codex_task", { ...args, prompt: "different fixture" });
  assert.equal(wrongReplay.isError, true);
  const continued = succeeded(await call(f.client, "codex_task", taskArgs(f.root, {
    sessionMode: "continue", threadId: first.threadId, activityId: first.bridgeActivity.activityId,
  })));
  assert.equal(continued.threadId, first.threadId);
  assert.equal(f.backend.calls.at(-1).name, "codex-reply");
  assert.match(f.backend.calls.at(-1).args.prompt, /^\|from_chatgpt\|:\nproject: demo/u);
  const auto = succeeded(await call(f.client, "codex_task", taskArgs(f.root, {
    sessionMode: "auto", activityId: first.bridgeActivity.activityId,
  })));
  assert.equal(auto.threadId, first.threadId);
  assert.equal(f.backend.calls.at(-1).name, "codex-reply");
  const job = succeeded(await call(f.client, "codex_status", { jobId: continued.bridgeActivity.jobId }));
  assert.equal(job.status, "completed");
  assert.equal(job.scopeId, first.bridgeSession.scopeId);
  const thread = succeeded(await call(f.client, "codex_status", { threadId: first.threadId }));
  assert.equal(thread.session.threadId, first.threadId);
  assert.equal((await call(f.client, "codex_status", { jobId: job.jobId }, META_B)).isError, true);
  assert.equal((await call(f.client, "codex_status", { threadId: first.threadId }, META_B)).isError, true);
  const hidden = succeeded(await call(f.client, "codex_activity", {}, META_B));
  assert.equal(hidden.activities.length, 0);
  const activityId = first.bridgeActivity.activityId;
  const card = await call(f.client, "codex_activity", { activityId });
  assert.equal(succeeded(card).activities[0].activityId, activityId);
  const detail = succeeded(await call(f.client, "codex_status", { activityId }));
  assert.equal(detail.jobs.length, 3);
  assert.equal(detail.activity.lifecycle, "open");
  const seal = succeeded(await call(f.client, "codex_activity_update", { activityId, action: "seal" }));
  assert.equal(seal.activity.lifecycle, "sealed");
  const complete = succeeded(await call(f.client, "codex_activity_update", { activityId, action: "complete", reason: "fixture verified" }));
  assert.equal(complete.activity.lifecycle, "completed");
  assert.equal((await call(f.client, "codex_activity_update", { activityId, action: "abandon", reason: "cross-scope" }, META_B)).isError, true);
  assert.equal(f.backend.closed, 0);
  assert.equal((await f.client.listTools()).tools.length, 12);
});

test("HTTP activity title reaches the new thread naming request", async (t) => {
  const f = await createFixture(t);
  const names = [];
  f.backend.workers = [{ index: 0, generation: 1, connection: { rpc: { request: async (method, params) => { names.push({ method, params }); } } } }];
  const original = f.backend.callTool.bind(f.backend);
  f.backend.callTool = (name, args, progress, assigned) => original(name, args, progress,
    (assignment) => assigned({ ...assignment, workerId: "app-0" }));
  const first = succeeded(await call(f.client, "codex_task", taskArgs(f.root, { activityTitle: "Documentation QA" })));
  assert.deepEqual(names, [{ method: "thread/name/set", params: { threadId: first.threadId, name: "[ChatGPT] demo — Documentation QA" } }]);
  succeeded(await call(f.client, "codex_task", taskArgs(f.root, { sessionMode: "continue", threadId: first.threadId })));
  assert.equal(names.length, 1);
});

test("settings, model catalog and optimistic revisions remain shared and preserve locale metadata", async (t) => {
  const f = await createFixture(t);
  const models = succeeded(await call(f.client, "codex_models"));
  assert.equal(models.models[0].id, "fixture-model");
  const settings = await call(f.client, "codex_settings");
  assert.equal(settings._meta["openai/locale"], "zh-CN");
  const initial = succeeded(settings).settings;
  const update = await call(f.client, "codex_update_settings", { expectedRevision: initial.revision, defaultSessionMode: "new" });
  assert.equal(succeeded(update).settings.defaultSessionMode, "new");
  assert.equal(succeeded(await call(f.client, "codex_settings", {}, META_B)).settings.revision, initial.revision + 1);
  assert.equal((await call(f.client, "codex_update_settings", { expectedRevision: initial.revision, defaultSessionMode: "auto" })).isError, true);
  assert.equal((await call(f.client, "codex_update_settings", { accessStrategy: "always-full" })).isError, true);
  assert.equal(f.backend.calls.length, 0);
});

test("background task, Activity watch, steering and supervised cancellation route to fake backend", async (t) => {
  const f = await createFixture(t);
  const started = succeeded(await call(f.client, "codex_task", taskArgs(f.root, {
    prompt: "HOLD_FIXTURE", executionMode: "background",
  })));
  assert.equal(started.status, "running");
  const current = succeeded(await call(f.client, "codex_status", { jobId: started.jobId }));
  assert.ok(current.threadId);
  const busy = await call(f.client, "codex_task", taskArgs(f.root, { sessionMode: "continue",
    threadId: current.threadId, activityId: started.activityId }));
  assert.equal(busy.isError, true);
  assert.equal(f.backend.calls.length, 1);
  const view = succeeded(await call(f.client, "codex_activity", { activityId: started.activityId }));
  const watched = call(f.client, "codex_activity", { sinceVersion: view.scopeVersion, waitMs: 1000 });
  const steered = await call(f.client, "codex_activity_update", { activityId: started.activityId,
    action: "steer", jobId: started.jobId, steeringPrompt: "fixture steering" });
  assert.notEqual(steered.isError, true, JSON.stringify(steered));
  assert.equal(f.backend.controls[0].action, "steer");
  assert.match(f.backend.controls[0].prompt, /^\|from_chatgpt\|:/u);
  const cancelled = succeeded(await call(f.client, "codex_cancel", { jobId: started.jobId }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(f.backend.controls.at(-1).action, "cancel");
  assert.notEqual((await watched).isError, true);
  const status = succeeded(await call(f.client, "codex_status", { jobId: started.jobId }));
  assert.equal(status.terminal, true);
  assert.equal(f.backend.closed, 0);
});

test("completion outbox handoff leases remain transactional and isolated to the conversation/widget", async (t) => {
  const f = await createFixture(t);
  const completed = succeeded(await call(f.client, "codex_task", taskArgs(f.root, { handoffPolicy: "notify" })));
  const activityId = completed.bridgeActivity.activityId;
  succeeded(await call(f.client, "codex_activity_update", { activityId, action: "seal" }));
  succeeded(await call(f.client, "codex_activity_update", { activityId, action: "complete", reason: "fixture completion" }));
  const view = succeeded(await call(f.client, "codex_activity", {}));
  const event = view.pendingHandoffs.find((entry) => entry.activityId === activityId);
  assert.ok(event);
  const args = { action: "claim", outboxId: event.outboxId };
  const wrongScope = succeeded(await call(f.client, "codex_activity_handoff", args, META_B));
  assert.equal(wrongScope.claimed, false);
  const claimed = succeeded(await call(f.client, "codex_activity_handoff", args));
  assert.equal(claimed.claimed, true);
  const otherWidget = { ...META_A, "openai/widgetSessionId": "another-fixture-widget" };
  const denied = await call(f.client, "codex_activity_handoff", { ...args, action: "delivered" }, otherWidget);
  assert.equal(denied.isError, true);
  assert.equal(succeeded(await call(f.client, "codex_activity_handoff", { ...args, action: "release" })).released, true);
  assert.equal(succeeded(await call(f.client, "codex_activity_handoff", args)).claimed, true);
  assert.equal(succeeded(await call(f.client, "codex_activity_handoff", { ...args, action: "delivered" })).delivered, true);
  const after = succeeded(await call(f.client, "codex_activity", {}));
  assert.equal(after.pendingHandoffs.some((entry) => entry.outboxId === event.outboxId), false);
});

test("HTTP close owns the SQLite lifecycle and reopening restores jobs/threads/Activities/scope", async (t) => {
  const f = await createFixture(t);
  const first = succeeded(await call(f.client, "codex_task", taskArgs(f.root)));
  const originalClose = BridgeStateStore.prototype.close;
  const closes = [];
  const mock = t.mock.method(BridgeStateStore.prototype, "close", function () {
    closes.push(this.persistencePath);
    return originalClose.call(this);
  });
  try {
    await f.client.listTools();
    await call(f.client, "codex_status", { threadId: first.threadId });
    assert.equal(closes.length, 0);
    await f.client.close();
    await new Promise((resolve) => f.server.close(resolve));
    assert.deepEqual(closes, [f.config.stateDatabaseFile]);
    assert.equal(f.backend.closed, 0);
    const server = createHttpServer(f.config, f.upstream, { ...f.services, modelCatalog: f.catalog });
    f.servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = new Client({ name: "reopen-fixture", version: "1" });
    f.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    const restored = succeeded(await call(client, "codex_status", { jobId: first.bridgeActivity.jobId }));
    assert.equal(restored.status, "completed");
    assert.equal(restored.scopeId, first.bridgeSession.scopeId);
    const activity = succeeded(await call(client, "codex_status", { activityId: first.bridgeActivity.activityId }));
    assert.equal(activity.jobs[0].jobId, restored.jobId);
    const continued = succeeded(await call(client, "codex_task", taskArgs(f.root, {
      sessionMode: "continue", threadId: first.threadId, activityId: first.bridgeActivity.activityId,
    })));
    assert.equal(continued.threadId, first.threadId);
  } finally { mock.mock.restore(); }
});

test("original foreground task and status long poll can both exceed the deterministic 10-second cap", { timeout: 30_000 }, async (t) => {
  const f = await createFixture(t);
  const foreground = call(f.client, "codex_task", taskArgs(f.root, { prompt: "HOLD_FIXTURE" }));
  const deadline = Date.now() + 5000;
  while (!f.backend.pending.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.backend.pending.size, 1);
  const overview = succeeded(await call(f.client, "codex_status"));
  const jobId = overview.jobs[0].jobId;
  const begin = Date.now();
  const watch = call(f.client, "codex_status", { jobId, waitFor: "terminal", waitMs: 15_000 });
  const timer = setTimeout(() => { for (const resolve of f.backend.pending.values()) resolve(); }, 10_150);
  try {
    const [result, terminal] = await Promise.all([foreground, watch]);
    succeeded(result);
    assert.equal(succeeded(terminal).status, "completed");
    assert.ok(Date.now() - begin >= 10_000);
  } finally { clearTimeout(timer); }
});

test("compatibility guards reject drift/missing shared objects and constructors share a persistent scope secret", async (t) => {
  assert.throws(() => assertBridgeCompatibility({ ...BRIDGE_BUILD_INFO, version: "next" }), /Unsupported Bridge/);
  assert.throws(() => assertBridgeCompatibility({ ...BRIDGE_BUILD_INFO, sourceHash: "different" }), /Unsupported Bridge/);
  assert.throws(() => assertBridgeCompatibility(BRIDGE_BUILD_INFO, null), /Unsupported Bridge/);
  const f = await createFixture(t);
  assert.throws(() => createUnifiedMcpServer(f.config, f.upstream, {}, f.services), /Missing shared Bridge state/);
  assert.throws(() => createHttpServer(f.config, f.upstream, {}), /initialized FileTools/);
  const config = { ...f.config, stateDatabaseFile: path.join(f.directory, "scope-persistence.sqlite") };
  const first = createSharedBridgeState(config, f.upstream, { modelCatalog: f.catalog });
  const scope = first.scopeResolver.require(META_A, undefined, "fixture").scopeId;
  first.stateStore.close();
  const second = createSharedBridgeState(config, f.upstream, { modelCatalog: f.catalog });
  try { assert.equal(second.scopeResolver.require(META_A, undefined, "fixture").scopeId, scope); }
  finally { second.stateStore.close(); }
});

test("Git version detection happens only at trusted host initialization, not per POST", async (t) => {
  const f = await createFixture(t);
  await assert.rejects(createDeterministicServices({ configPath: f.configPath, gitExecutable: "git" }),
    /Cannot initialize TRANSCEIVER_GIT_EXECUTABLE/u);
  const original = childProcess.spawn;
  let versions = 0;
  const mock = t.mock.method(childProcess, "spawn", function (executable, args, options) {
    if (args.includes("--version")) versions++;
    return original.call(this, executable, args, options);
  });
  let server;
  try {
    const services = await createDeterministicServices({ configPath: f.configPath, gitExecutable: GIT });
    server = createHttpServer({ ...f.config, stateDatabaseFile: path.join(f.directory, "version.sqlite") },
      f.upstream, { ...services, modelCatalog: f.catalog });
    f.servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = new Client({ name: "version-fixture", version: "1" });
    f.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    await client.listTools();
    succeeded(await call(client, "git_status", { project: "demo" }));
    succeeded(await call(client, "git_diff", { project: "demo", mode: "staged" }));
    succeeded(await call(client, "read_project_file", { project: "demo", path: "sample.txt" }));
    assert.equal(versions, 1);
    assert.equal(f.backend.calls.length, 0);
  } finally { mock.mock.restore(); }
});

let rpcId = 1;
async function rawPost(url, body, headers = {}) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json",
    Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
}

// fetch/undici may normalize Host; native HTTP sends the exact test header.
function exactHostRequest(url, { method, headers }) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("HTTP protocol matches upstream: health/discovery/Host/auth/405/Accept/JSON/version and POST SSE", async (t) => {
  const f = await createFixture(t, { noAuth: false });
  const baseline = upstreamHttp({ ...f.config, stateDatabaseFile: path.join(f.directory, "protocol-baseline.sqlite"),
    sessionStateFile: path.join(f.directory, "protocol-sessions.json"), jobStateFile: path.join(f.directory, "protocol-jobs.json"),
    settingsStateFile: path.join(f.directory, "protocol-settings.json") }, f.upstream);
  f.servers.push(baseline);
  baseline.listen(0, "127.0.0.1");
  await once(baseline, "listening");
  const oldUrl = `http://127.0.0.1:${baseline.address().port}/mcp`;
  const auth = { Authorization: "Bearer fixture-token" };
  for (const [method, route, headers, status] of [
    ["GET", "/healthz", {}, 200], ["GET", "/.well-known/oauth-protected-resource", {}, 404],
    ["GET", "/.well-known/oauth-protected-resource/mcp", {}, 404],
    ["GET", "/mcp", auth, 405], ["DELETE", "/mcp", auth, 405],
    ["GET", "/mcp", {}, 401], ["GET", "/mcp", { Authorization: "Bearer wrong" }, 401],
    ["GET", "/healthz", { Host: "untrusted.example" }, 403],
  ]) {
    const [actual, expected] = await Promise.all([f.url, oldUrl].map((url) =>
      headers.Host ? exactHostRequest(new URL(route, url), { method, headers }) : fetch(new URL(route, url), { method, headers })));
    assert.equal(actual.status, status);
    assert.equal(expected.status, status);
    assert.equal(await actual.text(), await expected.text());
  }
  const rpc = { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} };
  const response = await rawPost(f.url, rpc, auth);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const text = await response.text();
  const messages = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(messages.find((message) => message.id === rpc.id).result.tools.length, 12);
  for (const headers of [{ ...auth, Accept: "application/json" }, { ...auth, "mcp-protocol-version": "invalid" }]) {
    const [actual, expected] = await Promise.all([f.url, oldUrl].map((url) => rawPost(url, rpc, headers)));
    assert.equal(actual.status, expected.status);
    assert.ok(actual.status >= 400);
    assert.deepEqual(await actual.json(), await expected.json());
  }
  for (const url of [f.url, oldUrl]) {
    const bad = await fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{" });
    assert.equal(bad.status, 400);
    await bad.text();
    const notification = await rawPost(url, { jsonrpc: "2.0", method: "notifications/initialized" }, auth);
    assert.equal(notification.status, 202);
    await notification.text();
  }
  const unknown = await rawPost(f.url, { ...rpc, method: "unknown/fixture" }, auth);
  const payload = await unknown.text();
  assert.match(payload, /-32601/u);
  assert.equal(f.backend.calls.length, 0);
});

test("HTTP internal failures are sanitized and do not close shared state or the backend", async (t) => {
  const f = await createFixture(t);
  const mock = t.mock.method(McpServer.prototype, "connect", async () => { throw new Error("private fixture failure"); });
  const logs = t.mock.method(console, "error", () => {});
  try {
    const response = await rawPost(f.url, { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  } finally { mock.mock.restore(); logs.mock.restore(); }
  assert.equal((await f.client.listTools()).tools.length, 12);
  assert.equal(f.backend.closed, 0);
});
