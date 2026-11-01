import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { tagChatGptPrompt } from "../scripts/reverse-provenance.mjs";
import { TransceiverRouter } from "../scripts/reverse-router.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(PLUGIN_ROOT, "dist", "reverse-bridge", "index.mjs");
const TEST_GIT = process.env.TRANSCEIVER_TEST_GIT || (process.platform === "win32"
  ? "D:/Program Files/Git/mingw64/bin/git.exe" : "/usr/bin/git");

function invoke(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test("ChatGPT provenance is rebuilt exactly once", () => {
  const tagged = tagChatGptPrompt("|from_chatgpt|:\nold metadata\n\ninspect this", "demo");
  assert.equal(tagged.split("\n")[0], "|from_chatgpt|:");
  assert.equal(tagged.match(/\|from_chatgpt\|:/g).length, 1);
  assert.match(tagged, /project: demo/);
  assert.match(tagged, /inspect this/);
});

test("reverse router tags starts, continuations after restart, and steering", async () => {
  const calls = [];
  const appBackend = {
    async callTool(name, args, onProgress, onAssigned) {
      calls.push({ name, args });
      onAssigned({ threadId: "thread-1", backendKind: "app-server" });
      return { structuredContent: { threadId: "thread-1" } };
    },
    async steerThread(threadId, prompt) {
      calls.push({ name: "steer", args: { threadId, prompt } });
      return { turnId: "turn-1" };
    },
    close: async () => {},
  };
  const mcpBackend = { close: async () => {} };
  let persisted = {};
  const options = {
    allowedProjects: [{ root: "/work/demo", name: "demo" }],
    persistThreadProjects: async (value) => { persisted = value; },
  };
  const router = new TransceiverRouter("app-server", mcpBackend, appBackend, options);
  await router.callTool("codex", { cwd: "/work/demo", prompt: "start" });
  assert.match(calls.at(-1).args.prompt, /^\|from_chatgpt\|:\nproject: demo/);
  assert.deepEqual(persisted, { "thread-1": "demo" });
  await router.steerThread("thread-1", "steer");
  assert.match(calls.at(-1).args.prompt, /^\|from_chatgpt\|:\nproject: demo/);

  const restarted = new TransceiverRouter("app-server", mcpBackend, appBackend, {
    ...options,
    threadProjects: persisted,
  });
  await restarted.callTool("codex-reply", { threadId: "thread-1", prompt: "continue" });
  assert.match(calls.at(-1).args.prompt, /^\|from_chatgpt\|:\nproject: demo/);
});

test("bundled reverse doctor lists only explicitly enabled projects", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transceiver-reverse-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const enabled = path.join(directory, "enabled");
  const disabled = path.join(directory, "disabled");
  await fs.mkdir(enabled);
  await fs.mkdir(disabled);
  const configPath = path.join(directory, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    version: 1,
    projects: {
      [enabled]: { name: "enabled", sync: true, allowCodexTasks: true },
      [disabled]: { name: "disabled", sync: true, allowCodexTasks: false },
    },
  }));

  const result = await invoke(process.execPath, [BUNDLE, "--doctor"], {
    ...process.env,
    TRANSCEIVER_CONFIG: configPath,
    TRANSCEIVER_STATE_DIR: path.join(directory, "state"),
    TRANSCEIVER_REVERSE_PORT: "18877",
  });
  assert.equal(result.code, 0, result.stderr);
  const doctor = JSON.parse(result.stdout);
  assert.deepEqual(doctor.allowedProjects, ["enabled"]);
  assert.equal(doctor.codexAppServer, true);
});

test("bundled reverse server starts outside the repository", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transceiver-bundle-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, "project");
  const bridge = path.join(directory, "reverse-bridge");
  await fs.mkdir(project);
  await fs.cp(path.dirname(BUNDLE), bridge, { recursive: true });
  const configPath = path.join(directory, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    version: 1,
    projects: {
      [project]: { name: "isolated", sync: true, allowCodexTasks: true },
    },
  }));

  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(bridge, "index.mjs")], {
    env: {
      ...process.env,
      TRANSCEIVER_CONFIG: configPath,
      TRANSCEIVER_STATE_DIR: path.join(directory, "state"),
      TRANSCEIVER_REVERSE_PORT: String(port),
      TRANSCEIVER_GIT_EXECUTABLE: TEST_GIT,
    },
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  let health = null;
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await delay(50);
  }

  assert.ok(health, stderr || "reverse bridge did not become healthy");
  const expectedBuild = JSON.parse(await fs.readFile(path.join(bridge, "build-info.json"), "utf8"));
  assert.deepEqual(health.build, expectedBuild);
  child.kill("SIGTERM");
  await once(child, "close");
});
