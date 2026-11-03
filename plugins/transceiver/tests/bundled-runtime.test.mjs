import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GIT, ORIGINAL_TOOLS, NEW_TOOLS, fixtureGit, META_A, META_B, call, succeeded } from "./helpers/mcp-fixture.mjs";

const PLUGIN = path.resolve(import.meta.dirname, "..");
const WORKSPACE = path.resolve(PLUGIN, "../..");
const AUDIT = path.join(WORKSPACE, "codex", "T3.5-A");
const DISTRIBUTION = path.join(PLUGIN, "dist", "reverse-bridge");
const BASELINE = path.join(AUDIT, "baseline-before");
const PRELOAD = path.join(import.meta.dirname, "helpers", "bundle-preload.mjs");
const FAKE_SCRIPT = path.join(import.meta.dirname, "helpers", "fake-app-server.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Requires an explicitly prepared, private T3.5-A baseline. Ordinary CI must not
// assume that ignored local acceptance artifacts or Windows are available.
const acceptance = process.env.TRANSCEIVER_BUNDLE_ACCEPTANCE === "1" ? test : test.skip;

async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(directory, relative));
    else result.push(relative);
  }
  return result.sort();
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.notEqual(port, 8876);
  return port;
}

async function auditEvents(file) {
  try { return (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function createRun(t, source = DISTRIBUTION) {
  const directory = path.join(AUDIT, "instances", randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const distribution = path.join(directory, "standalone-bundle");
  await fs.cp(source, distribution, { recursive: true });
  assert.deepEqual(await files(distribution), await files(source));
  for (const file of await files(source)) {
    assert.equal(sha(await fs.readFile(path.join(distribution, file))), sha(await fs.readFile(path.join(source, file))));
  }
  const root = path.join(directory, "中文 sample project");
  const state = path.join(directory, "state");
  const home = path.join(directory, "synthetic-home");
  await fs.mkdir(root);
  await fs.mkdir(home);
  await fs.mkdir(path.join(state, "reverse"), { recursive: true });
  await fs.writeFile(path.join(root, "sample.txt"), "isolated sample\n中文 sample\n");
  await fixtureGit(root, ["init", "--template=", "--initial-branch=main", "."]);
  await fixtureGit(root, ["--no-optional-locks", "add", "--", "sample.txt"]);
  const configPath = path.join(directory, "projects.json");
  const config = { version: 1, projects: { [root]: { name: "sample", sync: true, allowCodexTasks: true } } };
  const save = () => fs.writeFile(configPath, JSON.stringify(config));
  await save();
  await fs.writeFile(path.join(state, "reverse", "models.json"), JSON.stringify({
    version: 1, fetchedAt: new Date().toISOString(), raw: JSON.stringify({ models: [{ slug: "T35A_FAKE_ONLY",
      visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] }] }),
  }));
  const auditLog = path.join(directory, "process-audit.jsonl");
  const processes = [];
  const run = { directory, distribution, root, state, home, configPath, config, save, auditLog, processes };
  run.stop = async (child) => {
    if (child.exitCode === null && child.signalCode === null) child.send({ type: "T35A_STOP" });
    const outcome = await Promise.race([child.finished, new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000); timer.unref();
    })]);
    if (!outcome) { child.kill("SIGKILL"); await child.finished; assert.fail("Owned test bundle required forced shutdown."); }
    await fs.writeFile(path.join(directory, `process-${child.pid}.stdout.txt`), child.stdoutText);
    await fs.writeFile(path.join(directory, `process-${child.pid}.stderr.txt`), child.stderrText);
    return outcome;
  };
  t.after(async () => {
    for (const child of processes) {
      await run.stop(child);
    }
    for (const event of await auditEvents(auditLog)) {
      if (event.event === "fake-spawn") {
        assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
      }
    }
    // Do not leave nested .git directories under the real project: the Git
    // safety scanner intentionally rejects them even when codex/ is ignored.
    const gitDirectory = path.join(root, ".git");
    const resolved = await fs.realpath(gitDirectory);
    assert.equal(path.relative(gitDirectory, resolved), "");
    const relative = path.relative(path.join(AUDIT, "instances"), resolved);
    assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  run.start = async ({ gitExecutable = GIT, ready = true } = {}) => {
    const port = await availablePort();
    const env = { HOME: home, USERPROFILE: home, TEMP: home, TMP: home,
      TRANSCEIVER_CONFIG: configPath, TRANSCEIVER_STATE_DIR: state, TRANSCEIVER_REVERSE_PORT: String(port),
      CODEX_MCP_BRIDGE_CODEX: path.join(directory, "NEVER_REAL_CODEX"),
      T35A_AUDIT_LOG: auditLog, T35A_FAKE_SCRIPT: FAKE_SCRIPT };
    for (const name of ["SystemRoot", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
    if (gitExecutable !== null) env.TRANSCEIVER_GIT_EXECUTABLE = gitExecutable;
    // Existing parent directory: no files are created outside the authorized repo.
    const cwd = path.dirname(WORKSPACE);
    assert.ok(path.relative(WORKSPACE, cwd).startsWith(".."));
    const child = spawn(process.execPath, ["--import", pathToFileURL(PRELOAD).href, path.join(distribution, "index.mjs")], {
      cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    processes.push(child);
    child.stdoutText = "";
    child.stderrText = "";
    child.stdout.on("data", (chunk) => { child.stdoutText = (child.stdoutText + chunk).slice(-64 * 1024); });
    child.stderr.on("data", (chunk) => { child.stderrText = (child.stderrText + chunk).slice(-64 * 1024); });
    child.finished = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal })); });
    child.url = `http://127.0.0.1:${port}/mcp`;
    if (ready) {
      const deadline = Date.now() + 15_000;
      let healthy = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try { healthy = (await fetch(new URL("/healthz", child.url), { signal: AbortSignal.timeout(500) })).ok; } catch {}
        if (healthy) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(healthy, true, child.stderrText.split("\n").filter((line) => line.length < 2000).slice(-14).join("\n"));
    }
    return child;
  };
  return run;
}

async function connect(child) {
  const client = new Client({ name: "T35A-isolated-client", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(child.url)));
  return client;
}

function counts(state) {
  const db = new Database(path.join(state, "reverse", "state.sqlite"), { readonly: true, fileMustExist: true });
  try { return Object.fromEntries(["jobs", "sessions", "activities"].map((table) => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count])); }
  finally { db.close(); }
}

acceptance("generated bundle is standalone, has eight prebuilds and no test/private host markers", async () => {
  const expected = ["build-info.json", "index.mjs", "licenses.txt", ...["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64",
    "linuxmusl-arm64", "linuxmusl-x64", "win32-arm64", "win32-x64"].map((name) => path.join("prebuilds", `${name}.node`))].sort();
  assert.deepEqual(await files(DISTRIBUTION), expected);
  const code = await fs.readFile(path.join(DISTRIBUTION, "index.mjs"), "utf8");
  for (const name of NEW_TOOLS) assert.ok(code.includes(name));
  assert.ok(code.includes("Unsupported Bridge internal API/build"));
  for (const marker of ["T35A_FAKE_ONLY", "fixture-token", "HOLD_FIXTURE", "C:\\Users\\chris", "C:/Users/chris",
    "D:\\MyWorks\\transceiver", "D:/MyWorks/transceiver"]) assert.equal(code.includes(marker), false, `Unexpected marker class: ${marker}`);
  assert.equal(/sk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{24,}/u.test(code), false, "Unexpected API-key-shaped value");
  const manifest = [];
  for (const file of expected) {
    const bytes = await fs.readFile(path.join(DISTRIBUTION, file));
    for (const marker of ["T35A_FAKE_ONLY", "fixture-token", "C:\\Users\\chris", "C:/Users/chris", "D:\\MyWorks\\transceiver", "D:/MyWorks/transceiver"]) {
      assert.equal(bytes.includes(Buffer.from(marker)), false, `Unexpected host/test marker in ${file}`);
      assert.equal(bytes.includes(Buffer.from(marker, "utf16le")), false, `Unexpected UTF-16 host/test marker in ${file}`);
    }
    manifest.push({ path: file, bytes: bytes.length, sha256: sha(bytes) });
  }
  await fs.writeFile(path.join(AUDIT, "built-artifacts.json"), JSON.stringify(manifest, null, 2));
});

acceptance("old baseline bundle provides the original 9-tool wire contract without real Codex", async (t) => {
  const run = await createRun(t, BASELINE);
  const child = await run.start();
  const client = await connect(child);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ORIGINAL_TOOLS);
  const resources = await client.listResources();
  const contents = [];
  for (const resource of resources.resources) contents.push(await client.readResource({ uri: resource.uri }));
  await fs.writeFile(path.join(AUDIT, "old-wire-baseline.json"), JSON.stringify({ tools, resources, contents,
    instructions: client.getInstructions(), capabilities: client.getServerCapabilities(), info: client.getServerVersion() }, null, 2));
  assert.deepEqual(counts(run.state), { jobs: 0, sessions: 0, activities: 0 });
  await client.close();
  assert.equal((await run.stop(child)).code, 0);
  assert.equal((await auditEvents(run.auditLog)).filter((event) => event.event === "fake-spawn").length, 0);
});

acceptance("new Windows bundle passes isolated HTTP, deterministic calls, Fake scope/restart and shutdown acceptance", { timeout: 60_000 }, async (t) => {
  const run = await createRun(t);
  let child = await run.start();
  let client = await connect(child);
  const summary = { directory: run.directory, outsideCwd: path.dirname(WORKSPACE), ports: [new URL(child.url).port] };
  const wire = JSON.parse(await fs.readFile(path.join(AUDIT, "old-wire-baseline.json"), "utf8"));
  await t.test("15 unique tools and original definitions/resources/instructions match old bundle", async () => {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 15);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, 15);
    assert.deepEqual(tools.filter((tool) => ORIGINAL_TOOLS.includes(tool.name)), wire.tools);
    assert.equal(client.getInstructions(), wire.instructions);
    assert.deepEqual(client.getServerCapabilities(), wire.capabilities);
    assert.deepEqual(client.getServerVersion(), wire.info);
    assert.deepEqual(await client.listResources(), wire.resources);
    for (const [i, resource] of wire.resources.resources.entries()) assert.deepEqual(await client.readResource({ uri: resource.uri }), wire.contents[i]);
  });
  await t.test("UTF-8 reading, Git staged/unstaged and no model/Job/Thread/Activity side effects", async () => {
    const file = succeeded(await call(client, "read_project_file", { project: "sample", path: "sample.txt", startLine: 2, lineCount: 1 }));
    assert.equal(file.content, "中文 sample");
    const status = succeeded(await call(client, "git_status", { project: "sample" }));
    assert.equal(status.staged[0].path, "sample.txt");
    assert.match(succeeded(await call(client, "git_diff", { project: "sample", mode: "staged" })).diff, /\+isolated sample/u);
    await fs.appendFile(path.join(run.root, "sample.txt"), "unstaged sample\n");
    assert.match(succeeded(await call(client, "git_diff", { project: "sample", mode: "unstaged" })).diff, /\+unstaged sample/u);
    summary.deterministicCounts = counts(run.state);
    assert.deepEqual(summary.deterministicCounts, { jobs: 0, sessions: 0, activities: 0 });
    assert.equal((await auditEvents(run.auditLog)).filter((event) => event.event === "fake-spawn").length, 0);
  });
  await t.test("unauthorized, traversal and live revocation fail closed", async () => {
    for (const [name, args, code] of [["read_project_file", { project: "unknown", path: "sample.txt" }, "PROJECT_NOT_AUTHORIZED"],
      ["read_project_file", { project: "sample", path: "../outside.txt" }, "INVALID_PATH"]]) {
      const result = await call(client, name, args);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, code);
    }
    run.config.projects[run.root].sync = false;
    await run.save();
    const revoked = await call(client, "git_status", { project: "sample" });
    assert.equal(revoked.isError, true);
    assert.equal(revoked.structuredContent.error.code, "PROJECT_NOT_AUTHORIZED");
    run.config.projects[run.root].sync = true;
    await run.save();
  });
  let completed;
  await t.test("Fake App Server only: request replay, scope isolation and persisted thread", async () => {
    const args = { requestId: randomUUID(), prompt: "T35A_FAKE_ONLY sample task", cwd: run.root,
      sessionMode: "new", executionMode: "foreground" };
    completed = succeeded(await call(client, "codex_task", args));
    const replay = succeeded(await call(client, "codex_task", args));
    assert.equal(replay.bridgeActivity.jobId, completed.bridgeActivity.jobId);
    const status = succeeded(await call(client, "codex_status", { jobId: completed.bridgeActivity.jobId }));
    assert.equal(status.status, "completed");
    assert.equal((await call(client, "codex_status", { jobId: completed.bridgeActivity.jobId }, META_B)).isError, true);
    assert.equal((await auditEvents(run.auditLog)).filter((event) => event.method === "turn/start").length, 1);
  });
  await t.test("actual bundled SQLite prebuild and graceful isolated process shutdown", async () => {
    await client.close();
    assert.equal((await run.stop(child)).code, 0);
    const events = await auditEvents(run.auditLog);
    const loaded = events.filter((event) => event.event === "native-load");
    assert.ok(loaded.length > 0);
    for (const event of loaded) assert.equal(path.toNamespacedPath(event.file), path.toNamespacedPath(path.join(run.distribution, "prebuilds", "win32-x64.node")));
    const db = new Database(path.join(run.state, "reverse", "state.sqlite"), { readonly: true });
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM bridge_instances WHERE stopped_at IS NULL").get().n, 0); }
    finally { db.close(); }
  });
  await t.test("fresh bundle process restores SQLite Job/Scope/Thread/Activity and provenance", async () => {
    child = await run.start();
    summary.ports.push(new URL(child.url).port);
    client = await connect(child);
    const restored = succeeded(await call(client, "codex_status", { jobId: completed.bridgeActivity.jobId }));
    assert.equal(restored.status, "completed");
    assert.equal(restored.scopeId, completed.bridgeSession.scopeId);
    const continued = succeeded(await call(client, "codex_task", { requestId: randomUUID(),
      prompt: "T35A_FAKE_ONLY continuation", cwd: run.root, sessionMode: "continue", executionMode: "foreground",
      threadId: completed.threadId, activityId: completed.bridgeActivity.activityId }));
    assert.equal(continued.threadId, completed.threadId);
    const events = await auditEvents(run.auditLog);
    assert.ok(events.some((event) => event.method === "thread/resume"));
    assert.ok(events.filter((event) => event.method === "turn/start").every((event) => event.tagged && event.projectTagged));
  });
  await t.test("stateless HTTP, 405s, final shutdown and no residual owned backend processes", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(child.url, { method });
      assert.equal(response.status, 405);
      await response.text();
    }
    const response = await fetch(child.url, { method: "POST", headers: { "Content-Type": "application/json",
      Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.match(response.headers.get("content-type"), /text\/event-stream/u);
    assert.equal(response.headers.get("mcp-session-id"), null);
    await response.text();
    await client.close();
    assert.equal((await run.stop(child)).code, 0);
    summary.finalCounts = counts(run.state);
    const db = new Database(path.join(run.state, "reverse", "state.sqlite"), { readonly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM bridge_instances WHERE stopped_at IS NULL").get().n, 0);
      summary.cleanShutdowns = db.prepare("SELECT count(*) AS n FROM bridge_instances WHERE termination_reason = 'clean-shutdown'").get().n;
      assert.equal(summary.cleanShutdowns, 2);
    } finally { db.close(); }
    assert.equal((await auditEvents(run.auditLog)).some((event) => event.event.startsWith("forbidden")), false);
    summary.events = (await auditEvents(run.auditLog)).map((event) => event.event === "native-load"
      ? { event: event.event, file: path.basename(event.file) } : event);
    await fs.writeFile(path.join(AUDIT, "isolated-summary.json"), JSON.stringify(summary, null, 2));
  });
});

acceptance("bundle startup rejects missing or invalid trusted Git configuration", async (t) => {
  const run = await createRun(t);
  for (const [label, gitExecutable, message] of [["missing", null, /Set TRANSCEIVER_GIT_EXECUTABLE/u],
    ["invalid", "git", /Cannot initialize TRANSCEIVER_GIT_EXECUTABLE/u]]) {
    await t.test(label, async () => {
      const child = await run.start({ gitExecutable, ready: false });
      const outcome = await Promise.race([child.finished, new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 10_000); timer.unref(); })]);
      assert.ok(outcome, "Bad configuration must exit promptly");
      assert.notEqual(outcome.code, 0);
      assert.match(child.stderrText, message);
      assert.equal(child.stdoutText.includes("listening"), false);
      await run.stop(child);
    });
  }
});
