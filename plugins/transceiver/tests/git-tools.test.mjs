import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createProjectPolicy } from "../scripts/project-policy.mjs";
import { createGitTools } from "../scripts/deterministic/git-tools.mjs";
import { createGitEnvironment, fixedGitArguments } from "../scripts/deterministic/git-safety.mjs";

// Host-controlled executable, never a tool input or PATH lookup. Override only
// at test launch for another trusted installation/platform.
const GIT = process.env.TRANSCEIVER_TEST_GIT || (process.platform === "win32"
  ? "D:/Program Files/Git/mingw64/bin/git.exe" : "/usr/bin/git");
const TEST_DIRECTORY = import.meta.dirname;

async function setupGit(root, args, input) {
  const child = childProcess.spawn(GIT, args, { cwd: root, env: createGitEnvironment(root),
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; });
  child.stdout.resume();
  child.stdin.end(input);
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Fixture setup failed (${code}): ${error}`)));
  });
}

// Construct a deterministic baseline WITHOUT running commit/commit-tree or
// consulting personal Git identity, signing configuration, hooks or a network.
async function object(root, type, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const encoded = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  const oid = createHash("sha1").update(encoded).digest("hex");
  const directory = path.join(root, ".git", "objects", oid.slice(0, 2));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, oid.slice(2)), deflateSync(encoded));
  return oid;
}

async function fixture(t, { unborn = false, limits, empty = false } = {}) {
  const directory = await fs.mkdtemp(path.join(TEST_DIRECTORY, ".t3.3-"));
  t.after(async () => {
    const relative = path.relative(TEST_DIRECTORY, directory);
    assert.ok(relative.startsWith(".t3.3-") && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const root = path.join(directory, "project");
  const outside = path.join(directory, "other");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await setupGit(root, ["init", "--template=", "--initial-branch=main", "."]);
  if (!unborn) {
    let treeBytes = Buffer.alloc(0);
    if (!empty) {
      await fs.writeFile(path.join(root, "base.txt"), "base\n");
      const blob = await object(root, "blob", "base\n");
      treeBytes = Buffer.concat([Buffer.from("100644 base.txt\0"), Buffer.from(blob, "hex")]);
    }
    const tree = await object(root, "tree", treeBytes);
    const commit = await object(root, "commit", `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1000000000 +0000\ncommitter Fixture <fixture@example.invalid> 1000000000 +0000\n\nfixture baseline\n`);
    await fs.mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "refs", "heads", "main"), `${commit}\n`);
    await setupGit(root, [...fixedGitArguments(root), "read-tree", "HEAD"]);
  }
  const configPath = path.join(directory, "policy.json");
  const config = { version: 1, projects: {
    [root]: { name: "demo", sync: true, allowCodexTasks: true },
    [outside]: { name: "disabled", sync: true, allowCodexTasks: false },
  } };
  const save = () => fs.writeFile(configPath, JSON.stringify(config));
  await save();
  const policy = await createProjectPolicy({ configPath });
  const tools = await createGitTools({ policy, gitExecutable: GIT, limits });
  return { directory, root, outside, configPath, config, save, policy, tools,
    status: (input = {}) => tools.git_status({ project: "demo", ...input }),
    diff: (mode = "unstaged", input = {}) => tools.git_diff({ project: "demo", mode, ...input }),
    add: (...files) => setupGit(root, [...fixedGitArguments(root), "add", "--", ...files]),
  };
}

function errorCode(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.error.code, code);
  assert.equal("staged" in result, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
}

async function snapshot(root) {
  const files = {};
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else {
        const stat = await fs.stat(path.join(root, child), { bigint: true });
        files[child] = { hash: createHash("sha256").update(await fs.readFile(path.join(root, child))).digest("hex"),
          mtime: String(stat.mtimeNs), size: String(stat.size) };
      }
    }
  }
  await visit("");
  return files;
}

test("clean repository returns branch and empty staged/unstaged/untracked lists", async (t) => {
  const f = await fixture(t);
  const result = await f.status();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.branch, { name: "main", detached: false, unborn: false });
  assert.deepEqual([result.staged, result.unstaged, result.untracked], [[], [], []]);
  assert.equal(result.clean, true);
  assert.equal((await f.diff()).diff, "");
  assert.equal((await f.diff("staged")).diff, "");
});

test("tracked diagnostic omits untracked completeness and preserves the full default", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "untracked.txt"), "untracked");
  const tracked = await f.status({ scope: "tracked" });
  assert.equal(tracked.ok, true, JSON.stringify(tracked));
  assert.equal(tracked.complete, false);
  assert.equal(tracked.trackedChangesReported, false);
  assert.equal(tracked.untrackedIncluded, false);
  assert.equal(tracked.scope, "tracked");
  assert.equal("clean" in tracked, false);
  assert.equal("untracked" in tracked, false);
  const full = await f.status();
  assert.equal(full.clean, false);
  assert.deepEqual(full.untracked, ["untracked.txt"]);
  await fs.writeFile(path.join(f.root, "base.txt"), "changed");
  assert.equal((await f.status({ scope: "tracked" })).trackedChangesReported, true);
});

test("tracked status does not pre-scan worktree paths", async (t) => {
  const f = await fixture(t);
  const cache = path.join(f.root, "cache");
  await fs.mkdir(cache);
  const originalOpen = fs.opendir;
  const originalLstat = fs.lstat;
  const denied = () => Object.assign(new Error("secret absolute path"), { code: "EACCES" });
  let blocked = cache;
  const open = t.mock.method(fs, "opendir", (...args) => args[0] === blocked ? Promise.reject(denied()) : originalOpen(...args));
  const stat = t.mock.method(fs, "lstat", (...args) => args[0] === blocked ? Promise.reject(denied()) : originalLstat(...args));
  try {
    for (const target of [cache, path.join(f.root, "base.txt")]) {
      blocked = target;
      const result = await f.status({ scope: "tracked" });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(JSON.stringify(result).includes("secret absolute path"), false);
    }
  } finally { open.mock.restore(); stat.mock.restore(); }
});

test("tracked status accepts worktree links and nested repositories but rejects unsafe control configuration", async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, "escape");
  await fs.symlink(f.outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.status({ scope: "tracked" })).ok, true);
  await fs.unlink(link);
  await fs.mkdir(path.join(f.root, "nested", ".git"), { recursive: true });
  assert.equal((await f.status({ scope: "tracked" })).ok, true);
  await fs.rm(path.join(f.root, "nested"), { recursive: true });
  await fs.appendFile(path.join(f.root, ".git", "config"), "\n[include]\n path = secret\n");
  errorCode(await f.status({ scope: "tracked" }), "UNSUPPORTED_REPOSITORY");
});

test("staged, unstaged and untracked names are machine parsed, including Chinese and shell characters", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "base.txt"), "staged version\n");
  await f.add("base.txt");
  await fs.writeFile(path.join(f.root, "base.txt"), "unstaged version\n");
  const names = ["中文 space.txt", "-odd [x];$(literal).txt"];
  if (process.platform !== "win32") names.push("line\nbreak.txt");
  for (const name of names) await fs.writeFile(path.join(f.root, name), "fixture");
  const result = await f.status();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.clean, false);
  assert.deepEqual(result.staged, [{ path: "base.txt", status: "M" }]);
  assert.deepEqual(result.unstaged, [{ path: "base.txt", status: "M" }]);
  assert.deepEqual(result.untracked.sort(), names.sort());
  const staged = await f.diff("staged");
  const unstaged = await f.diff();
  assert.equal(staged.ok, true);
  assert.match(staged.diff, /-base\n\+staged version/u);
  assert.equal(unstaged.ok, true);
  assert.match(unstaged.diff, /-staged version\n\+unstaged version/u);
  assert.equal(staged.mode, "staged");
});

test("staged special filenames and deletion are represented without shell evaluation", async (t) => {
  const f = await fixture(t);
  const name = "中文 space [a];$(x).txt";
  await fs.writeFile(path.join(f.root, name), "added\n");
  await f.add(name);
  await fs.unlink(path.join(f.root, "base.txt"));
  const status = await f.status();
  assert.equal(status.ok, true);
  assert.deepEqual(status.staged, [{ path: name, status: "A" }]);
  assert.deepEqual(status.unstaged, [{ path: "base.txt", status: "D" }]);
  assert.match((await f.diff("staged")).diff, /new file mode/u);
  assert.match((await f.diff()).diff, /deleted file mode/u);
});

test("unborn repositories explicitly report state and staged additions relative to the empty tree", async (t) => {
  const f = await fixture(t, { unborn: true });
  const clean = await f.status();
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal(clean.branch.unborn, true);
  assert.equal(clean.clean, true);
  assert.deepEqual((await f.diff("staged")).diff, "");
  await fs.writeFile(path.join(f.root, "new.txt"), "new fixture\n");
  await f.add("new.txt");
  const result = await f.diff("staged");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.unborn, true);
  assert.match(result.diff, /\+new fixture/u);
});

test("corrupt or missing referenced HEAD object is an error, not an empty diff", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".git", "refs", "heads", "main"), "1".repeat(40) + "\n");
  errorCode(await f.diff("staged"), "GIT_FAILED");
});

test("detached HEAD is reported explicitly", async (t) => {
  const f = await fixture(t);
  const oid = await fs.readFile(path.join(f.root, ".git", "refs", "heads", "main"), "utf8");
  await fs.writeFile(path.join(f.root, ".git", "HEAD"), oid);
  const result = await f.status();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.branch, { name: null, detached: true, unborn: false });
});

test("packed branch references are not mistaken for an unborn HEAD", async (t) => {
  const f = await fixture(t);
  const reference = path.join(f.root, ".git", "refs", "heads", "main");
  const oid = (await fs.readFile(reference, "utf8")).trim();
  await fs.writeFile(path.join(f.root, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/heads/main\n`);
  await fs.unlink(reference);
  const result = await f.status();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.branch.unborn, false);
  assert.equal(result.clean, true);
  assert.equal((await f.diff("staged")).diff, "");
});

test("rejects unsupported inputs, arbitrary refs/options and unapproved projects", async (t) => {
  const f = await fixture(t);
  for (const input of [null, [], "x", {}, { project: "demo", command: "log" }, { project: "demo", env: {} }, { project: "demo", mode: "staged" }]) {
    errorCode(await f.tools.git_status(input), "INVALID_ARGUMENT");
  }
  for (const input of [null, {}, { project: "demo", mode: "HEAD" }, { project: "demo", mode: "--stat" },
    { project: "demo", mode: "staged", ref: "HEAD" }, { project: "demo", mode: "unstaged", shell: true }]) {
    errorCode(await f.tools.git_diff(input), "INVALID_ARGUMENT");
  }
  errorCode(await f.status({ project: "disabled" }), "PROJECT_NOT_AUTHORIZED");
  errorCode(await f.status({ project: "../project" }), "PROJECT_NOT_AUTHORIZED");
  errorCode(await f.status({ project: "unknown" }), "PROJECT_NOT_AUTHORIZED");
});

test("revocation, invalid policy and project rebinding are respected", async (t) => {
  const f = await fixture(t);
  f.config.projects[f.root].sync = false;
  await f.save();
  errorCode(await f.status(), "PROJECT_NOT_AUTHORIZED");
  await fs.writeFile(f.configPath, "{");
  errorCode(await f.diff(), "INVALID_CONFIG");
  delete f.config.projects[f.root];
  f.config.projects[f.outside] = { name: "demo", sync: true, allowCodexTasks: true };
  await f.save();
  errorCode(await f.status(), "PROJECT_CHANGED");
});

test("revocation at the final authorization check discards Git output", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const tools = await createGitTools({ gitExecutable: GIT, policy: {
    async authorizeProject(name) {
      if (++calls === 2) {
        f.config.projects[f.root].allowCodexTasks = false;
        await f.save();
      }
      return f.policy.authorizeProject(name);
    },
  } });
  errorCode(await tools.git_status({ project: "demo" }), "PROJECT_NOT_AUTHORIZED");
});

test("rejects non-repositories and project subdirectories instead of discovering the parent", async (t) => {
  const f = await fixture(t);
  f.config.projects = { [f.outside]: { name: "other", sync: true, allowCodexTasks: true } };
  await f.save();
  let tools = await createGitTools({ policy: await createProjectPolicy({ configPath: f.configPath }), gitExecutable: GIT });
  errorCode(await tools.git_status({ project: "other" }), "NOT_GIT_REPOSITORY");
  const child = path.join(f.root, "child");
  await fs.mkdir(child);
  f.config.projects = { [child]: { name: "child", sync: true, allowCodexTasks: true } };
  await f.save();
  tools = await createGitTools({ policy: await createProjectPolicy({ configPath: f.configPath }), gitExecutable: GIT });
  errorCode(await tools.git_status({ project: "child" }), "NOT_GIT_REPOSITORY");
});

test("refuses .git redirection files and linked .git directories", async (t) => {
  const f = await fixture(t);
  await fs.rename(path.join(f.root, ".git"), path.join(f.outside, "metadata"));
  await fs.writeFile(path.join(f.root, ".git"), `gitdir: ${path.join(f.outside, "metadata")}\n`);
  errorCode(await f.status(), "UNSUPPORTED_REPOSITORY");
  await fs.unlink(path.join(f.root, ".git"));
  await fs.symlink(path.join(f.outside, "metadata"), path.join(f.root, ".git"), process.platform === "win32" ? "junction" : "dir");
  errorCode(await f.diff(), "UNSUPPORTED_REPOSITORY");
});

test("rejects alternates, commondir, worktrees, worktree config and promisor metadata", async (t) => {
  const f = await fixture(t);
  for (const relative of ["objects/info/alternates", "objects/info/http-alternates", "commondir", "gitdir", "config.worktree", "objects/pack/test.promisor", "info/grafts", "shallow"]) {
    const target = path.join(f.root, ".git", relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${f.outside}\n`);
    errorCode(await f.status(), "UNSUPPORTED_REPOSITORY");
    await fs.unlink(target);
  }
  for (const name of ["worktrees", "modules"]) {
    await fs.mkdir(path.join(f.root, ".git", name));
    errorCode(await f.status(), "UNSUPPORTED_REPOSITORY");
    await fs.rmdir(path.join(f.root, ".git", name));
  }
});

test("rejects unsafe config syntax, includes, helpers and unsupported extensions before spawning Git", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, ".git", "config");
  const original = await fs.readFile(target, "utf8");
  const mock = t.mock.method(childProcess, "spawn", () => { throw new Error("Git must not run for rejected metadata"); });
  try {
    for (const extra of ['[include]\npath = outside\n', '[includeIf "gitdir:*"]\npath = outside\n',
      '[core]\nfsmonitor = evil\n', '[core]\nhooksPath = outside\n', '[core]\nworktree = outside\n',
      '[diff "evil"]\ncommand = evil\n', '[diff "evil"]\ntextconv = evil\n',
      '[filter "evil"]\nprocess = evil\n', '[credential]\nhelper = evil\n',
      '[extensions]\nworktreeConfig = true\n', '[remote "origin"]\npromisor = true\n',
      '[core]\nfilemode = false\\\n[include]\npath = outside\n']) {
      await fs.writeFile(target, original + extra);
      errorCode(await f.status(), "UNSUPPORTED_REPOSITORY");
    }
    assert.equal(mock.mock.callCount(), 0);
  } finally { mock.mock.restore(); }
});

test("ordinary remote and branch config are accepted without contacting remotes", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.root, ".git", "config"), '\n[remote "origin"]\nurl = https://example.invalid/repo.git\nfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\nremote = origin\nmerge = refs/heads/main\n');
  const result = await f.status();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.clean, true);
});

test("diff rejects worktree links, hard links, nested repos and .gitmodules", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "escape");
  await fs.symlink(f.outside, target, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.diff()).ok, false);
  await fs.unlink(target);
  await fs.writeFile(path.join(f.outside, "data"), "sample");
  await fs.link(path.join(f.outside, "data"), target);
  errorCode(await f.diff(), "UNSUPPORTED_REPOSITORY");
  await fs.unlink(target);
  await fs.mkdir(path.join(f.root, "nested", ".git"), { recursive: true });
  errorCode(await f.diff(), "UNSUPPORTED_REPOSITORY");
  await fs.rmdir(path.join(f.root, "nested", ".git"));
  await fs.writeFile(path.join(f.root, ".gitmodules"), "fixture");
  errorCode(await f.diff(), "UNSUPPORTED_REPOSITORY");
});

test("submodule index entries are rejected even without .gitmodules", async (t) => {
  const f = await fixture(t);
  const oid = (await fs.readFile(path.join(f.root, ".git", "refs", "heads", "main"), "utf8")).trim();
  await setupGit(f.root, [...fixedGitArguments(f.root), "update-index", "--add", "--cacheinfo", `160000,${oid},submodule`]);
  errorCode(await f.diff(), "UNSUPPORTED_REPOSITORY");
});

test("diff still fails closed on ignored junctions and nested metadata", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".gitignore"), "ignored/\n");
  const ignored = path.join(f.root, "ignored");
  await fs.symlink(f.outside, ignored, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.diff()).ok, false);
  await fs.unlink(ignored);
  await fs.mkdir(path.join(ignored, "nested", ".git"), { recursive: true });
  errorCode(await f.diff(), "UNSUPPORTED_REPOSITORY");
});

test("ignored-tree scan consumes its entry budget before starting Git", async (t) => {
  const f = await fixture(t, { limits: { maxEntries: 30 } });
  await fs.writeFile(path.join(f.root, ".gitignore"), "ignored/\n");
  const ignored = path.join(f.root, "ignored");
  await fs.mkdir(ignored);
  await Promise.all(Array.from({ length: 40 }, (_, i) => fs.writeFile(path.join(ignored, `${i}.txt`), "fixture")));
  const mock = t.mock.method(childProcess, "spawn", () => { throw new Error("Must reject before Git"); });
  try {
    errorCode(await f.diff(), "REPOSITORY_TOO_LARGE");
    assert.equal(mock.mock.callCount(), 0);
  } finally { mock.mock.restore(); }
});

test("caller working directory cannot rebind the authorized project or inject cwd", async (t) => {
  const f = await fixture(t);
  const previous = process.cwd();
  try {
    process.chdir(f.outside);
    assert.equal((await f.status()).ok, true);
    errorCode(await f.status({ cwd: f.outside }), "INVALID_ARGUMENT");
  } finally { process.chdir(previous); }
});

test("Git environment injection and global helper config never reach the child", async (t) => {
  const f = await fixture(t);
  const injected = {
    GIT_DIR: f.outside, GIT_WORK_TREE: f.outside, GIT_INDEX_FILE: path.join(f.outside, "index"),
    GIT_OBJECT_DIRECTORY: f.outside, GIT_ALTERNATE_OBJECT_DIRECTORIES: f.outside,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "evil",
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'", GIT_EXTERNAL_DIFF: "evil", GIT_EXEC_PATH: f.outside,
    GIT_CONFIG_GLOBAL: path.join(f.outside, "global-config"), GIT_TRACE: path.join(f.outside, "trace"),
    GIT_CONFIG_SYSTEM: path.join(f.outside, "system-config"), NODE_OPTIONS: "--not-a-real-option",
  };
  await fs.writeFile(injected.GIT_CONFIG_GLOBAL, "[core]\nfsmonitor = evil\n[include]\npath = private\n");
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, injected);
  const original = childProcess.spawn;
  const seen = [];
  const mock = t.mock.method(childProcess, "spawn", function (executable, args, options) {
    seen.push(options);
    return original.call(this, executable, args, options);
  });
  try {
    assert.equal((await f.status()).ok, true);
    assert.equal((await f.diff()).ok, true);
    for (const options of seen) {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
      assert.equal(options.env.GIT_EXTERNAL_DIFF, undefined);
      assert.equal(options.env.GIT_INDEX_FILE, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
    }
    assert.ok(seen.length >= 4);
    await assert.rejects(fs.stat(injected.GIT_INDEX_FILE), { code: "ENOENT" });
    await assert.rejects(fs.stat(injected.GIT_TRACE), { code: "ENOENT" });
  } finally {
    mock.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("attributes and hook files cannot enable an external helper", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.outside, "helper-ran");
  await fs.mkdir(path.join(f.root, ".git", "hooks"));
  const script = `#!/bin/sh\nprintf triggered > '${marker.replaceAll("\\", "/")}'\n`;
  for (const hook of ["fsmonitor-watchman", "post-index-change"]) {
    await fs.writeFile(path.join(f.root, ".git", "hooks", hook), script, { mode: 0o755 });
  }
  await fs.writeFile(path.join(f.root, ".gitattributes"), "*.txt diff=evil filter=evil\n");
  await fs.writeFile(path.join(f.root, "base.txt"), "changed\n");
  assert.equal((await f.status()).ok, true);
  assert.equal((await f.diff()).ok, true);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("operations do not change any working file, index, Git object or config", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "base.txt"), "staged\n");
  await f.add("base.txt");
  await fs.writeFile(path.join(f.root, "base.txt"), "unstaged\n");
  await fs.writeFile(path.join(f.root, "untracked.txt"), "sample\n");
  const before = await snapshot(f.root);
  for (const result of [await f.status(), await f.diff(), await f.diff("staged")]) assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await snapshot(f.root), before);
});

test("large diff returns bounded incomplete preview; raw output limits return an explicit error", async (t) => {
  const f = await fixture(t, { limits: { maxResultBytes: 1024 } });
  await fs.writeFile(path.join(f.root, "base.txt"), '😀中"\\'.repeat(2000) + "\n");
  const preview = await f.diff();
  errorCode(preview, "OUTPUT_LIMIT");
  assert.equal(preview.truncated, true);
  assert.equal(preview.mode, "unstaged");
  assert.ok(preview.diff.length > 0);
  assert.equal(preview.diff.isWellFormed(), true);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 1024);
  const limited = await createGitTools({ policy: f.policy, gitExecutable: GIT, limits: { maxOutputBytes: 1024 } });
  const result = await limited.git_diff({ project: "demo", mode: "unstaged" });
  errorCode(result, "OUTPUT_LIMIT");
  assert.equal(result.diff, undefined);
});

test("status overflow never returns a partial list or a misleading clean flag", async (t) => {
  const f = await fixture(t, { limits: { maxResultBytes: 1024 } });
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(f.root, `long-untracked-name-${i}.txt`), "sample");
  const result = await f.status();
  errorCode(result, "OUTPUT_LIMIT");
  assert.equal(result.clean, undefined);
});

test("entry scan and trusted executable/limits restrictions fail closed", async (t) => {
  const f = await fixture(t, { limits: { maxEntries: 1 } });
  errorCode(await f.status(), "REPOSITORY_TOO_LARGE");
  await assert.rejects(createGitTools({ policy: f.policy, gitExecutable: "git" }), TypeError);
  if (process.platform === "win32") {
    const launcher = path.resolve(path.dirname(GIT), "../../cmd/git.exe");
    await assert.rejects(createGitTools({ policy: f.policy, gitExecutable: launcher }), TypeError);
  }
  for (const limits of [{ maxConcurrent: 5 }, { maxOutputBytes: 0 }, { timeoutMs: 60_001 }, { pushTimeoutMs: 120_001 }, { shell: 1 }, { constructor: 1 }]) {
    await assert.rejects(createGitTools({ policy: f.policy, gitExecutable: GIT, limits }), TypeError);
  }
});

function fakeProcess(action) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
  if (action) queueMicrotask(() => action(child));
  return child;
}

test("nonzero exit, stderr overflow and malformed output are explicit errors", async (t) => {
  const f = await fixture(t, { limits: { maxOutputBytes: 1024 } });
  for (const [action, expected] of [
    [(child) => child.emit("close", 128), "GIT_FAILED"],
    [(child) => child.stderr.write(Buffer.alloc(1025)), "OUTPUT_LIMIT"],
    [(child) => { child.emit("error", new Error("sample spawn failure")); child.emit("close", -1); }, "GIT_START_FAILED"],
  ]) {
    const mock = t.mock.method(childProcess, "spawn", () => fakeProcess(action));
    try { errorCode(await f.status(), expected); } finally { mock.mock.restore(); }
  }
  let count = 0;
  const mock = t.mock.method(childProcess, "spawn", () => fakeProcess((child) => {
    child.stdout.write(++count === 1 ? "" : "## main\0 M incomplete");
    child.emit("close", 0);
  }));
  try { errorCode(await f.status(), "INVALID_GIT_OUTPUT"); } finally { mock.mock.restore(); }
});

test("raw stdout/stderr budget is shared by all subprocesses in one request", async (t) => {
  const f = await fixture(t, { limits: { maxOutputBytes: 1024 } });
  let calls = 0;
  const mock = t.mock.method(childProcess, "spawn", () => fakeProcess((child) => {
    calls++;
    child.stderr.write(Buffer.alloc(600));
    child.emit("close", 0);
  }));
  try {
    errorCode(await f.status(), "OUTPUT_LIMIT");
    assert.equal(calls, 2);
  } finally { mock.mock.restore(); }
});

test("timeout kills the owned process and releases its slot only after close", async (t) => {
  const f = await fixture(t, { limits: { timeoutMs: 300, maxConcurrent: 1 } });
  let killed = 0;
  let hang = true;
  const mock = t.mock.method(childProcess, "spawn", () => {
    const child = fakeProcess(hang ? undefined : (process) => process.emit("close", 1));
    const kill = child.kill;
    child.kill = () => { killed++; return kill(); };
    return child;
  });
  try {
    const first = f.status();
    errorCode(await f.status(), "BUSY");
    const result = await first;
    errorCode(result, "TIMEOUT");
    assert.equal(result.timedOut, true);
    assert.equal(killed, 1);
    hang = false;
    // A new process failure, rather than BUSY, proves this same executor released
    // its slot. Do not assume a real three-process operation fits in 300 ms.
    errorCode(await f.status(), "GIT_FAILED");
  } finally { mock.mock.restore(); }
});

test("global concurrency is bounded across separate tool instances", async (t) => {
  const f = await fixture(t);
  const other = await createGitTools({ policy: f.policy, gitExecutable: GIT });
  const waiting = [];
  const mock = t.mock.method(childProcess, "spawn", () => {
    const child = fakeProcess();
    waiting.push(child);
    return child;
  });
  const running = [];
  try {
    for (let i = 0; i < 4; i++) running.push((i % 2 ? other : f.tools).git_status({ project: "demo" }));
    errorCode(await f.status(), "BUSY");
    // Wait until each accepted operation reaches its first child, then fail it.
    const deadline = Date.now() + 5000;
    while (waiting.length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(waiting.length, 4);
    for (const child of waiting) child.emit("close", 1);
    for (const result of await Promise.all(running)) errorCode(result, "GIT_FAILED");
  } finally { mock.mock.restore(); }
  assert.equal((await f.status()).ok, true);
});
