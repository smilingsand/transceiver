import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, "../scripts/transceiver.mjs");

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transceiver-test-"));
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  return {
    directory,
    project,
    env: {
      ...process.env,
      TRANSCEIVER_CONFIG: path.join(directory, "config.json"),
      TRANSCEIVER_STATE_DIR: path.join(directory, "state"),
    },
  };
}

function invoke(args, { env, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, json: JSON.parse(stdout) }));
    child.stdin.end(input);
  });
}

test("excluded projects stop before body data is read", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await invoke(["project-set", "--root", f.project, "--sync", "false", "--name", "excluded"], f);

  const result = await invoke([
    "prepare", "--root", f.project, "--kind", "progress_update", "--body-file", path.join(f.directory, "missing.md"),
  ], f);

  assert.equal(result.code, 4);
  assert.equal(result.json.code, "project_excluded");
});

test("unknown projects do not sync implicitly", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const result = await invoke(["project-get", "--root", f.project], f);
  assert.equal(result.code, 3);
  assert.equal(result.json.code, "project_not_configured");
});

test("reverse Codex tasks require an explicit project policy", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const enabled = await invoke([
    "project-set", "--root", f.project, "--sync", "true", "--allow-codex-tasks", "true",
  ], f);
  assert.equal(enabled.code, 0);
  assert.equal(enabled.json.project.allowCodexTasks, true);

  const disabled = await invoke([
    "project-set", "--root", f.project, "--sync", "false",
  ], f);
  assert.equal(disabled.json.project.allowCodexTasks, false);
});

test("a configured project applies from its subdirectories", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const nested = path.join(f.project, "writings", "tables");
  await fs.mkdir(nested, { recursive: true });
  await invoke(["project-set", "--root", f.project, "--sync", "true", "--name", "demo"], f);

  const project = await invoke(["project-get", "--root", nested], f);
  assert.equal(project.code, 0);
  assert.equal(project.json.root, await fs.realpath(f.project));

  const prepared = await invoke([
    "prepare", "--root", nested, "--kind", "progress_update", "--request-id", "request-nested1",
    "--body-file", "-",
  ], { ...f, input: "nested progress" });
  assert.equal(prepared.code, 0);
  assert.equal(prepared.json.request.project.root, await fs.realpath(f.project));
});

test("prepare creates one tagged, traceable request", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await invoke(["project-set", "--root", f.project, "--sync", "true", "--name", "demo"], f);
  const requestId = "request-12345678";
  const result = await invoke([
    "prepare", "--root", f.project, "--kind", "progress_update", "--request-id", requestId,
    "--source-thread", "codex://threads/example", "--body-file", "-",
  ], { ...f, input: "|from_codex|:\n已完成：测试。\n" });

  assert.equal(result.code, 0);
  assert.equal(result.json.request.status, "prepared");
  assert.equal(result.json.request.message.split("\n")[0], "|from_codex|:");
  assert.equal(result.json.request.message.match(/\|from_codex\|:/g).length, 1);
  assert.match(result.json.request.message, /request_id: request-12345678/);
  assert.match(result.json.request.message, /source_thread: codex:\/\/threads\/example/);
  assert.equal(JSON.parse(await fs.readFile(result.json.requestPath, "utf8")).id, requestId);

  const listed = await invoke([
    "request-list", "--root", f.project, "--source-thread", "codex://threads/example", "--status", "prepared",
  ], f);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.json.requests.map((request) => request.id), [requestId]);
  assert.equal(Object.hasOwn(listed.json.requests[0], "message"), false);
});

test("sent and completed transitions are persistent and idempotent", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await invoke(["project-set", "--root", f.project, "--sync", "true", "--name", "demo"], f);
  const prepared = await invoke([
    "prepare", "--root", f.project, "--kind", "consult_request", "--request-id", "request-abcdefgh",
    "--body-file", "-",
  ], { ...f, input: "请分析。" });
  assert.equal(prepared.code, 0);

  const sent = await invoke([
    "mark", "--request-id", "request-abcdefgh", "--status", "sent",
    "--conversation-url", "https://chatgpt.com/c/example-conversation",
  ], f);
  assert.equal(sent.json.request.status, "sent");

  const sentAgain = await invoke([
    "mark", "--request-id", "request-abcdefgh", "--status", "sent",
  ], f);
  assert.equal(sentAgain.code, 0);

  const completed = await invoke([
    "mark", "--request-id", "request-abcdefgh", "--status", "completed", "--response-file", "-",
  ], { ...f, input: "ChatGPT response\n" });
  assert.equal(completed.json.request.status, "completed");
  assert.equal(await fs.readFile(completed.json.request.responseFile, "utf8"), "ChatGPT response\n");

  const project = await invoke(["project-get", "--root", f.project], f);
  assert.equal(project.json.project.chatgptUrl, "https://chatgpt.com/c/example-conversation");
});

test("invalid request transitions fail closed", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await invoke(["project-set", "--root", f.project, "--sync", "true"], f);
  await invoke([
    "prepare", "--root", f.project, "--kind", "progress_update", "--request-id", "request-invalid1",
    "--body-file", "-",
  ], { ...f, input: "progress" });
  const result = await invoke([
    "mark", "--request-id", "request-invalid1", "--status", "completed",
  ], f);
  assert.equal(result.code, 1);
  assert.equal(result.json.code, "invalid_transition");
});

test("sent requests require a mapped conversation", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await invoke(["project-set", "--root", f.project, "--sync", "true"], f);
  await invoke([
    "prepare", "--root", f.project, "--kind", "progress_update", "--request-id", "request-no-url1",
    "--body-file", "-",
  ], { ...f, input: "progress" });

  const result = await invoke([
    "mark", "--request-id", "request-no-url1", "--status", "sent",
  ], f);
  assert.equal(result.code, 1);
  assert.equal(result.json.code, "missing_conversation_url");
});

test("revoking project sync blocks stored request output and send state", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await invoke([
    "project-set", "--root", f.project, "--sync", "true", "--chatgpt-url", "https://chatgpt.com/c/example",
  ], f);
  await invoke([
    "prepare", "--root", f.project, "--kind", "progress_update", "--request-id", "request-revoked1",
    "--body-file", "-",
  ], { ...f, input: "progress" });
  await invoke(["project-set", "--root", f.project, "--sync", "false"], f);

  const shown = await invoke(["show", "--request-id", "request-revoked1"], f);
  assert.equal(shown.code, 4);
  assert.equal(shown.json.code, "project_excluded");

  const marked = await invoke([
    "mark", "--request-id", "request-revoked1", "--status", "sent",
  ], f);
  assert.equal(marked.code, 4);
  assert.equal(marked.json.code, "project_excluded");

  const repeated = await invoke([
    "mark", "--request-id", "request-revoked1", "--status", "prepared",
  ], f);
  assert.equal(repeated.code, 4);
  assert.equal(repeated.json.code, "project_excluded");
});

test("session context distinguishes included and excluded projects", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await invoke(["project-set", "--root", f.project, "--sync", "true", "--name", "demo"], f);
  const included = await invoke(["context", "--root", f.project], f);
  assert.match(included.json.hookSpecificOutput.additionalContext, /Transceiver is enabled for demo/);

  await invoke(["project-set", "--root", f.project, "--sync", "false", "--name", "demo"], f);
  const excluded = await invoke(["context", "--root", f.project], f);
  assert.match(excluded.json.hookSpecificOutput.additionalContext, /sync is disabled/);
});
