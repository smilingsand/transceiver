import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createProjectPolicy } from "../scripts/project-policy.mjs";
import { createGitTools } from "../scripts/deterministic/git-tools.mjs";
import { createGitEnvironment } from "../scripts/deterministic/git-safety.mjs";

const GIT = process.env.TRANSCEIVER_TEST_GIT || (process.platform === "win32" ? "D:/Program Files/Git/mingw64/bin/git.exe" : "/usr/bin/git");
async function git(root, args) {
  const child = childProcess.spawn(GIT, args, { cwd: root, env: createGitEnvironment(root), shell: false, windowsHide: true });
  const out = [], err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString())));
  });
  return Buffer.concat(out).toString().trim();
}
async function fixture(t, { enabled = true, limits } = {}) {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, ".t5.7-"));
  t.after(async () => {
    assert.match(path.relative(import.meta.dirname, directory), /^\.t5\.7-[^\\/]+$/u);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const root = path.join(directory, "project"), bare = path.join(directory, "remote space [x].git");
  await fs.mkdir(root);
  await git(root, ["init", "--template=", "--initial-branch=main", "."]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(root, "base.txt"), "base\n");
  await git(root, ["add", "--", "base.txt"]);
  await git(root, ["commit", "-m", "fixture baseline"]);
  await git(directory, ["init", "--bare", "--template=", "--initial-branch=main", bare]);
  const url = bare.split(path.sep).join("/");
  await git(root, ["remote", "add", "origin", url]);
  const entry = { name: "demo", sync: true, allowCodexTasks: true, ...(enabled ? {
    gitWrite: { add: true, commit: true, push: true, pushTargets: [{ remote: "origin", url, branches: ["main"] }] },
  } : {}) };
  const configPath = path.join(directory, "policy.json");
  const save = () => fs.writeFile(configPath, JSON.stringify({ version: 1, projects: { [root]: entry } }));
  await save();
  const policy = await createProjectPolicy({ configPath });
  const tools = await createGitTools({ policy, gitExecutable: GIT, limits });
  const add = (paths) => tools.git_add({ project: "demo", paths });
  const commit = (message = "T5.7 - test: fixture change") => tools.git_commit({ project: "demo", message });
  const push = (extra = {}) => tools.git_push({ project: "demo", remote: "origin", branch: "main", ...extra });
  return { directory, root, bare, url, entry, save, policy, tools, add, commit, push };
}
const success = (value) => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const failure = (value, code) => { assert.equal(value.ok, false, JSON.stringify(value)); assert.equal(value.error.code, code); return value; };

test("each write is default denied, independently granted and immediately revocable", async (t) => {
  const f = await fixture(t, { enabled: false });
  for (const result of [await f.add(["base.txt"]), await f.commit(), await f.push()]) failure(result, "GIT_WRITE_NOT_AUTHORIZED");
  f.entry.gitWrite = { add: true }; await f.save();
  success(await f.add(["base.txt"]));
  failure(await f.commit(), "GIT_WRITE_NOT_AUTHORIZED");
  failure(await f.push(), "GIT_WRITE_NOT_AUTHORIZED");
  f.entry.gitWrite.add = false; await f.save();
  failure(await f.add(["base.txt"]), "GIT_WRITE_NOT_AUTHORIZED");
  failure(await f.tools.git_add({ project: "unknown", paths: ["base.txt"] }), "PROJECT_NOT_AUTHORIZED");
});

test("add stages multiple literal special paths, directories and deleted files", async (t) => {
  const f = await fixture(t);
  const names = ["中文 space [a];$(x).txt", "-option.txt"];
  for (const name of names) await fs.writeFile(path.join(f.root, name), "new\n");
  await fs.mkdir(path.join(f.root, "docs"));
  await fs.writeFile(path.join(f.root, "docs", "note.txt"), "note\n");
  await fs.unlink(path.join(f.root, "base.txt"));
  const result = success(await f.add([...names, "docs", "base.txt"]));
  assert.deepEqual(result.stagedPaths.sort(), [...names, "docs/note.txt", "base.txt"].sort());
  assert.ok(result.status.staged.some((item) => item.path === "base.txt" && item.status === "D"));
  assert.equal(result.status.unstaged.length, 0);
});

test("add rejects empty, traversal, absolute, metadata and pathspec inputs without staging", async (t) => {
  const f = await fixture(t);
  failure(await f.add([]), "INVALID_ARGUMENT");
  for (const file of ["../other", "a/../../other", f.root, "C:\\outside", ".", ".git/config", ":(top)*", "*.txt", "a\0b"]) {
    failure(await f.add([file]), "INVALID_PATH");
  }
  failure(await f.tools.git_add({ project: "demo", paths: ["base.txt"], all: true }), "INVALID_ARGUMENT");
  assert.deepEqual(success(await f.tools.git_status({ project: "demo" })).staged, []);
});

test("commit uses only staged content and returns verified hash, message and stats", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "base.txt"), "staged\n");
  success(await f.add(["base.txt"]));
  await fs.writeFile(path.join(f.root, "base.txt"), "unstaged\n");
  const result = success(await f.commit());
  assert.equal(result.created, true);
  assert.match(result.hash, /^[a-f0-9]{40}$/u);
  assert.equal(result.hash, await git(f.root, ["rev-parse", "HEAD"]));
  assert.equal(result.message, "T5.7 - test: fixture change");
  assert.match(result.stats, /1 file changed/u);
  assert.equal(await git(f.root, ["show", "HEAD:base.txt"]), "staged");
  assert.equal(success(await f.tools.git_status({ project: "demo" })).unstaged.length, 1);
});

test("empty staging and blank messages do not create commits; unborn commits work", async (t) => {
  const f = await fixture(t);
  const before = await git(f.root, ["rev-parse", "HEAD"]);
  assert.equal(success(await f.commit()).reason, "NO_STAGED_CHANGES");
  for (const message of ["", " \n\t", "a\0b"]) failure(await f.commit(message), "INVALID_ARGUMENT");
  assert.equal(await git(f.root, ["rev-parse", "HEAD"]), before);
  await git(f.root, ["checkout", "--orphan", "new"]);
  assert.equal(success(await f.commit("initial fixture")).created, true);
});

test("sensitive staged files and directory descendants are blocked independently of ignores", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "settings"));
  await fs.writeFile(path.join(f.root, "settings", ".env.local"), "fixture only\n");
  failure(await f.add(["settings"]), "SENSITIVE_STAGED_PATH");
  await git(f.root, ["add", "--", "settings/.env.local"]);
  failure(await f.commit(), "SENSITIVE_STAGED_PATH");
});

test("failing active hooks are rejected before execution, not bypassed or reported successful", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "base.txt"), "modified\n");
  success(await f.add(["base.txt"]));
  await fs.mkdir(path.join(f.root, ".git", "hooks"), { recursive: true });
  await fs.writeFile(path.join(f.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = await git(f.root, ["rev-parse", "HEAD"]);
  failure(await f.commit(), "HOOKS_NOT_SUPPORTED");
  assert.equal(await git(f.root, ["rev-parse", "HEAD"]), before);
});

test("ordinary push to a granted local bare repository works and reports up-to-date", async (t) => {
  const f = await fixture(t);
  assert.equal(success(await f.push()).result, "created");
  assert.equal(await git(f.directory, [`--git-dir=${f.bare}`, "rev-parse", "refs/heads/main"]), await git(f.root, ["rev-parse", "HEAD"]));
  assert.equal(success(await f.push()).result, "up-to-date");
  await fs.writeFile(path.join(f.root, "base.txt"), "next\n");
  success(await f.add(["base.txt"])); success(await f.commit());
  assert.equal(success(await f.push()).result, "updated");
});

test("push denies invalid names, force/delete/refspec fields, ungranted targets and URL changes", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ remote: "--all" }, { branch: ":main" }, { branch: "+main" }, { branch: "main:other" },
    { branch: "refs/heads/main" , force: true }, { branch: "main.lock" }, { delete: true }, { forceWithLease: true }]) {
    failure(await f.push(extra), "INVALID_ARGUMENT");
  }
  failure(await f.push({ remote: "missing" }), "PUSH_TARGET_NOT_AUTHORIZED");
  failure(await f.push({ branch: "other" }), "PUSH_TARGET_NOT_AUTHORIZED");
  f.entry.gitWrite.pushTargets[0].url = path.join(f.directory, "different"); await f.save();
  failure(await f.push(), "PUSH_TARGET_NOT_AUTHORIZED");
});

test("non-fast-forward is classified and never forced", async (t) => {
  const f = await fixture(t);
  success(await f.push());
  const baseline = await git(f.root, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(f.root, "base.txt"), "remote next\n");
  success(await f.add(["base.txt"])); const remote = success(await f.commit()); success(await f.push());
  // Fixture-only rewind then create a divergent local commit.
  await git(f.root, ["reset", "--hard", baseline]);
  await fs.writeFile(path.join(f.root, "base.txt"), "local divergent\n");
  success(await f.add(["base.txt"])); success(await f.commit());
  failure(await f.push(), "NON_FAST_FORWARD");
  assert.equal(await git(f.directory, [`--git-dir=${f.bare}`, "rev-parse", "refs/heads/main"]), remote.hash);
});

test("bare target hooks, unsafe local config and transport helpers fail closed", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.bare, "hooks"), { recursive: true });
  await fs.writeFile(path.join(f.bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
  failure(await f.push(), "HOOKS_NOT_SUPPORTED");
  await fs.unlink(path.join(f.bare, "hooks", "pre-receive"));
  await fs.appendFile(path.join(f.bare, "config"), "\n[receive]\nprocReceiveRefs = refs\n");
  failure(await f.push(), "UNSUPPORTED_REPOSITORY");
  for (const url of ["ssh://example.invalid/repo", "ext::evil", "https://token@example.invalid/repo", "https://example.invalid/repo?token=fixture"]) {
    await git(f.root, ["remote", "set-url", "origin", url]);
    f.entry.gitWrite.pushTargets[0].url = url; await f.save();
    failure(await f.push(), "UNSUPPORTED_PUSH_TRANSPORT");
  }
});

function fakeProcess(action) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
  if (action) queueMicrotask(() => action(child));
  return child;
}
test("push timeout, output overflow and sanitized failure classifications never report success", async (t) => {
  const f = await fixture(t);
  const original = childProcess.spawn;
  for (const [diagnostic, code] of [["Authentication failed secret-token", "AUTHENTICATION_FAILED"],
    ["Could not resolve host secret-token", "NETWORK_ERROR"], ["remote rejected secret-token", "REMOTE_REJECTED"],
    ["fixture secret-token", "GIT_FAILED"], ["x".repeat(2000), "OUTPUT_LIMIT"], [null, "TIMEOUT"]]) {
    const tools = await createGitTools({ policy: f.policy, gitExecutable: GIT, limits: { timeoutMs: 3000, maxOutputBytes: 1024 } });
    const mock = t.mock.method(childProcess, "spawn", function (executable, args, options) {
      if (!args.includes("push")) return original.call(this, executable, args, options);
      return fakeProcess(diagnostic === null ? undefined : (child) => { child.stderr.write(diagnostic); child.emit("close", 1); });
    });
    try {
      const result = failure(await tools.git_push({ project: "demo", remote: "origin", branch: "main" }), code);
      assert.equal(JSON.stringify(result).includes("secret-token"), false);
      assert.equal(result.mutationMayHaveOccurred, true);
    } finally { mock.mock.restore(); }
  }
});

test("commit detects missing local identity before mutation and preserves other failures", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "base.txt"), "changed\n"); success(await f.add(["base.txt"]));
  const before = await git(f.root, ["rev-parse", "HEAD"]);
  for (const [name, email] of [[false, true], [true, false], [false, false]]) {
    for (const [key, present, value] of [["user.name", name, "Fixture"], ["user.email", email, "private@example.invalid"]]) {
      if (present) await git(f.root, ["config", "--local", key, value]);
      else { try { await git(f.root, ["config", "--local", "--unset-all", key]); } catch { /* already absent */ } }
    }
    const result = failure(await f.commit(), "GIT_IDENTITY_MISSING");
    assert.match(result.error.message, /Author.*git config --local user.name.*git config --local user.email/u);
    assert.equal(JSON.stringify(result).includes("private@example.invalid"), false);
    assert.notEqual(result.mutationMayHaveOccurred, true);
    assert.equal(await git(f.root, ["rev-parse", "HEAD"]), before);
  }
  await git(f.root, ["config", "--local", "user.name", "Fixture"]);
  await git(f.root, ["config", "--local", "user.email", "private@example.invalid"]);
  const original = childProcess.spawn;
  const mock = t.mock.method(childProcess, "spawn", function (executable, args, options) {
    if (!args.includes("commit")) return original.call(this, executable, args, options);
    return fakeProcess((child) => { child.stderr.write("other failure secret-token"); child.emit("close", 1); });
  });
  try {
    const result = failure(await f.commit(), "GIT_FAILED");
    assert.equal(result.mutationMayHaveOccurred, true);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
  } finally { mock.mock.restore(); }
  assert.equal(success(await f.commit()).created, true);
});

test("malformed write policies fail closed and authorized missing branch/remote cannot push", async (t) => {
  const f = await fixture(t);
  f.entry.gitWrite.pushTargets[0].branches.push("missing");
  f.entry.gitWrite.pushTargets.push({ remote: "absent", url: f.url, branches: ["main"] }); await f.save();
  failure(await f.push({ branch: "missing" }), "LOCAL_BRANCH_NOT_FOUND");
  failure(await f.push({ remote: "absent" }), "REMOTE_NOT_FOUND");
  for (const policy of [{ add: "true" }, { shell: true }, { push: true, pushTargets: [{}] }]) {
    f.entry.gitWrite = policy; await f.save();
    failure(await f.add(["base.txt"]), "INVALID_CONFIG");
  }
});

test("an oversized result after successful commit reports uncertain mutation, not false success", async (t) => {
  const f = await fixture(t, { limits: { maxResultBytes: 1024 } });
  await fs.writeFile(path.join(f.root, "base.txt"), "modified\n"); success(await f.add(["base.txt"]));
  const before = await git(f.root, ["rev-parse", "HEAD"]);
  const result = failure(await f.commit("message ".repeat(300)), "OUTPUT_LIMIT");
  assert.equal(result.mutationMayHaveOccurred, true);
  assert.notEqual(await git(f.root, ["rev-parse", "HEAD"]), before);
});

test("push timeout terminates only the owned transport process tree", async (t) => {
  const f = await fixture(t);
  const tools = await createGitTools({ policy: f.policy, gitExecutable: GIT, limits: { timeoutMs: 3000 } });
  const spawn = childProcess.spawn;
  let hanging;
  const kills = [];
  const spawnMock = t.mock.method(childProcess, "spawn", function (executable, args, options) {
    if (!args.includes("push")) return spawn.call(this, executable, args, options);
    if (process.platform !== "win32") assert.equal(options.detached, true);
    hanging = fakeProcess(); hanging.pid = 424242;
    return hanging;
  });
  const killMock = process.platform === "win32" ? t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    assert.equal(path.basename(file).toLowerCase(), "taskkill.exe");
    assert.deepEqual(args, ["/PID", "424242", "/T", "/F"]);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    kills.push(args); callback(null);
  }) : t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -424242); assert.equal(signal, "SIGKILL"); kills.push(pid); hanging.kill();
  });
  try {
    failure(await tools.git_push({ project: "demo", remote: "origin", branch: "main" }), "TIMEOUT");
    assert.equal(kills.length, 1);
  } finally { spawnMock.mock.restore(); killMock.mock.restore(); }
});

test("project locks exclude read/write overlap across tool instances and release on failure", async (t) => {
  const f = await fixture(t);
  const other = await createGitTools({ policy: f.policy, gitExecutable: GIT });
  const spawn = childProcess.spawn;
  let release;
  let started = new Promise((resolve) => { release = resolve; });
  let hanging;
  const mock = t.mock.method(childProcess, "spawn", function (executable, args, options) {
    if (!args.includes("cat-file")) return spawn.call(this, executable, args, options);
    hanging = fakeProcess(); release(); return hanging;
  });
  try {
    const reading = other.git_status({ project: "demo" });
    await Promise.race([started, reading.then((result) => assert.fail(`Read did not reach fixture subprocess: ${JSON.stringify(result)}`))]);
    failure(await f.add(["base.txt"]), "BUSY"); hanging.emit("close", 1); failure(await reading, "GIT_FAILED");
    started = new Promise((resolve) => { release = resolve; });
    const writing = f.add(["base.txt"]);
    await Promise.race([started, writing.then((result) => assert.fail(`Write did not reach fixture subprocess: ${JSON.stringify(result)}`))]);
    failure(await other.git_status({ project: "demo" }), "BUSY"); hanging.emit("close", 1); failure(await writing, "GIT_FAILED");
  } finally { mock.mock.restore(); }
  success(await f.add(["base.txt"]));
});
