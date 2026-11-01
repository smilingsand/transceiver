import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createProjectPolicy, loadAuthorizedProjects } from "../scripts/project-policy.mjs";
import { assertWithinProject, normalizeProjectPath } from "../scripts/deterministic/path-policy.mjs";
import { createProjectTools, READ_LIMITS } from "../scripts/deterministic/project-tools.mjs";

// All fixtures, including the deliberately unauthorized sibling, stay in this repo.
const TEST_DIRECTORY = import.meta.dirname;
async function fixture(t, limits) {
  const directory = await fs.mkdtemp(path.join(TEST_DIRECTORY, ".t3.2-"));
  t.after(async () => {
    const relative = path.relative(TEST_DIRECTORY, directory);
    assert.ok(relative.startsWith(".t3.2-") && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "project");
  const outside = path.join(directory, "project-other");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const configPath = path.join(directory, "config.json");
  const config = { version: 1, unknownProject: "ask", projects: {
    [root]: { name: "demo", sync: true, allowCodexTasks: true },
    [outside]: { name: "disabled", sync: true, allowCodexTasks: false },
  } };
  const save = () => fs.writeFile(configPath, JSON.stringify(config));
  await save();
  const policy = await createProjectPolicy({ configPath });
  const tools = createProjectTools({ policy, limits });
  return { directory, root, outside, configPath, config, save, policy, tools,
    read: (args = {}) => tools.read_project_file({ project: "demo", path: "sample.txt", ...args }) };
}

function errorCode(result, expected) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, expected);
  assert.equal("content" in result, false);
}

test("reads UTF-8 BOM, Chinese/emoji paths and normalizes CRLF line ranges", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "中文 space"));
  await fs.writeFile(path.join(f.root, "中文 space", "😀.txt"), "\ufeff一\r\n二😀\r\n三\r\n");
  const result = await f.read({ path: "中文 space\\😀.txt", startLine: 2, lineCount: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.content, "二😀");
  assert.equal(result.path, "中文 space/😀.txt");
  assert.deepEqual([result.startLine, result.endLine, result.totalLines], [2, 2, 3]);
  assert.equal(result.truncated, true);
  assert.equal(result.partialLastLine, false);
  const last = await f.read({ path: result.path, startLine: 3 });
  assert.equal(last.content, "三");
  assert.equal(last.truncated, false);
});

test("empty files and trailing newline have explicit non-phantom ranges", async (t) => {
  const f = await fixture(t);
  for (const [text, total, content] of [["", 0, ""], ["\n", 1, ""], ["a\n", 1, "a"], ["a\rb", 2, "a\nb"]]) {
    await fs.writeFile(path.join(f.root, "sample.txt"), text);
    const result = await f.read();
    assert.equal(result.ok, true);
    assert.equal(result.totalLines, total);
    assert.equal(result.content, content);
    assert.equal(result.startLine, total ? 1 : null);
    assert.equal(result.endLine, total || null);
    assert.equal(result.truncated, false);
  }
  errorCode(await f.read({ startLine: 3 }), "LINE_OUT_OF_RANGE");
});

test("rejects Windows special paths and traversal on every host", async (t) => {
  const f = await fixture(t);
  const invalid = ["", "../sample.txt", "sub/../sample.txt", "sub\\..\\sample.txt", "/sample.txt",
    "C:\\sample.txt", "C:sample.txt", "\\sample.txt", "\\\\server\\share\\x", "//server/share/x",
    "\\\\?\\C:\\x", "\\\\.\\NUL", "sample.txt:secret", "a\0b", "a\nb", "a\tb",
    "a//b", "a/./b", "a/", "a\\", "file.", "file ", "folder./x", "con", "CON.txt",
    "NUL.tar.gz", "com1.log", "lpt9", "COM¹.txt", "CONIN$", "CONOUT$", "a?b", "a*b", "a|b", "a<b", "a\"b", "x".repeat(1025)];
  for (const value of invalid) errorCode(await f.read({ path: value }), "INVALID_PATH");
  assert.equal(normalizeProjectPath("console.txt"), "console.txt");
  assert.throws(() => assertWithinProject(f.root, path.join(f.outside, "sample.txt")), { code: "PATH_OUTSIDE_PROJECT" });
});

test("validates request fields and bounded integer line inputs", async (t) => {
  const f = await fixture(t);
  for (const input of [null, [], "x", { project: "demo", path: "x", command: "anything" }]) {
    errorCode(await f.tools.read_project_file(input), "INVALID_ARGUMENT");
  }
  for (const args of [{ startLine: 0 }, { startLine: -1 }, { startLine: 1.5 }, { startLine: "1" },
    { startLine: null }, { startLine: Infinity }, { startLine: Number.MAX_SAFE_INTEGER + 1 },
    { lineCount: 0 }, { lineCount: null }, { lineCount: 501 }, { lineCount: "1" }]) {
    errorCode(await f.read(args), "INVALID_ARGUMENT");
  }
  for (const project of [undefined, "", null, [], "x".repeat(201)]) {
    errorCode(await f.read({ project }), "INVALID_ARGUMENT");
  }
});

test("authorization uses both existing flags, rejects unknown projects and honors revocation", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "sample.txt"), "sample");
  await fs.writeFile(path.join(f.outside, "sample.txt"), "unauthorized fixture");
  errorCode(await f.read({ project: "disabled" }), "PROJECT_NOT_AUTHORIZED");
  errorCode(await f.read({ project: "unknown" }), "PROJECT_NOT_AUTHORIZED");
  assert.equal((await f.read()).content, "sample");
  for (const flag of ["sync", "allowCodexTasks"]) {
    f.config.projects[f.root][flag] = false;
    await f.save();
    errorCode(await f.read(), "PROJECT_NOT_AUTHORIZED");
    f.config.projects[f.root][flag] = true;
  }
  f.config.projects[f.outside].allowCodexTasks = true;
  await f.save();
  errorCode(await f.read({ project: "disabled" }), "PROJECT_NOT_AUTHORIZED");
  const renewed = createProjectTools({ policy: await createProjectPolicy({ configPath: f.configPath }) });
  assert.equal((await renewed.read_project_file({ project: "disabled", path: "sample.txt" })).content, "unauthorized fixture");
});

test("revocation before returning discards data already read", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "sample.txt"), "sample");
  let calls = 0;
  const tools = createProjectTools({ policy: {
    async authorizeProject(name) {
      if (++calls === 2) {
        f.config.projects[f.root].sync = false;
        await f.save();
      }
      return f.policy.authorizeProject(name);
    },
  } });
  errorCode(await tools.read_project_file({ project: "demo", path: "sample.txt" }), "PROJECT_NOT_AUTHORIZED");
});

test("pins root identity and rejects project root rebinding", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, "sample.txt"), "other fixture");
  delete f.config.projects[f.root];
  f.config.projects[f.outside] = { name: "demo", sync: true, allowCodexTasks: true };
  await f.save();
  errorCode(await f.read(), "PROJECT_CHANGED");
});

test("detects replacing the directory at the same configured root", async (t) => {
  const f = await fixture(t);
  await fs.rename(f.root, path.join(f.directory, "previous-project"));
  await fs.mkdir(f.root);
  await fs.writeFile(path.join(f.root, "sample.txt"), "replacement fixture");
  errorCode(await f.read(), "PROJECT_CHANGED");
});

test("missing, malformed, oversized or structurally invalid configs fail closed", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "sample.txt"), "sample");
  for (const raw of ["{", "null", "[]", JSON.stringify({ version: 2, projects: {} }),
    JSON.stringify({ version: 1, projects: [] }), " ".repeat(256 * 1024 + 1),
    JSON.stringify({ version: 1, projects: { [f.root]: null } }),
    JSON.stringify({ version: 1, projects: { [f.root]: { sync: "true" } } }),
    JSON.stringify({ version: 1, projects: { [f.root]: { name: "" } } })]) {
    await fs.writeFile(f.configPath, raw);
    errorCode(await f.read(), "INVALID_CONFIG");
  }
  await fs.unlink(f.configPath);
  errorCode(await f.read(), "INVALID_CONFIG");
  await assert.rejects(createProjectPolicy({ configPath: f.configPath }), { code: "INVALID_CONFIG" });
  await assert.rejects(fs.stat(f.configPath), { code: "ENOENT" });
});

test("rejects duplicate names, overlapping roots and unsupported root syntax", async (t) => {
  const f = await fixture(t);
  f.config.projects[f.outside] = { name: "demo", sync: true, allowCodexTasks: true };
  await f.save();
  await assert.rejects(loadAuthorizedProjects(f.configPath), { code: "INVALID_CONFIG" });
  const child = path.join(f.root, "child");
  await fs.mkdir(child);
  delete f.config.projects[f.outside];
  f.config.projects[child] = { name: "child", sync: true, allowCodexTasks: true };
  await f.save();
  await assert.rejects(loadAuthorizedProjects(f.configPath), { code: "INVALID_CONFIG" });
  for (const root of ["relative", path.parse(f.root).root, `${path.parse(f.root).root}folder${path.sep}..`, path.join(f.directory, "comma,root")]) {
    f.config.projects = { [root]: { name: "demo", sync: true, allowCodexTasks: true } };
    await f.save();
    await assert.rejects(loadAuthorizedProjects(f.configPath), { code: "UNSUPPORTED_ROOT" });
  }
});

test("missing authorization flags remain disabled; empty config grants no access", async (t) => {
  const f = await fixture(t);
  delete f.config.projects[f.root].allowCodexTasks;
  await f.save();
  assert.equal((await loadAuthorizedProjects(f.configPath)).length, 0);
  errorCode(await f.read(), "PROJECT_NOT_AUTHORIZED");
  f.config.projects = {};
  await f.save();
  assert.equal((await loadAuthorizedProjects(f.configPath)).length, 0);
});

test("file limits reject oversize and line limits report truncation", async (t) => {
  const f = await fixture(t, { maxFileBytes: 8, maxLineCount: 2 });
  await fs.writeFile(path.join(f.root, "sample.txt"), "123456789");
  errorCode(await f.read(), "FILE_TOO_LARGE");
  await fs.writeFile(path.join(f.root, "sample.txt"), "1\n2\n3\n");
  const result = await f.read();
  assert.equal(result.content, "1\n2");
  assert.deepEqual([result.startLine, result.endLine], [1, 2]);
  assert.equal(result.truncated, true);
  errorCode(await f.read({ lineCount: 3 }), "INVALID_ARGUMENT");
});

test("bounds serialized output including escaping, paths and metadata without splitting emoji", async (t) => {
  const f = await fixture(t, { maxResultBytes: 1024 });
  const text = ('😀中"\\'.repeat(500)) + "\nlast";
  await fs.writeFile(path.join(f.root, "sample.txt"), text);
  const result = await f.read();
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.partialLastLine, true);
  assert.deepEqual([result.startLine, result.endLine], [1, 1]);
  assert.ok(text.startsWith(result.content));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
  assert.equal(result.content.isWellFormed(), true);
});

test("returns a bounded error if metadata alone exceeds a tightened result limit", async (t) => {
  const f = await fixture(t);
  const name = "项".repeat(200);
  const file = `${"文".repeat(120)}.txt`;
  f.config.projects[f.root].name = name;
  await f.save();
  await fs.writeFile(path.join(f.root, file), "x");
  const tools = createProjectTools({ policy: await createProjectPolicy({ configPath: f.configPath }), limits: { maxResultBytes: 1024 } });
  const result = await tools.read_project_file({ project: name, path: file });
  errorCode(result, "RESULT_TOO_LARGE");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
});

test("default file and line caps apply without caller-supplied options", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "sample.txt"), "x".repeat(READ_LIMITS.maxFileBytes));
  const result = await f.read();
  assert.equal(result.ok, true);
  assert.equal(result.fileBytes, READ_LIMITS.maxFileBytes);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_LIMITS.maxResultBytes);
  await fs.writeFile(path.join(f.root, "sample.txt"), "x".repeat(READ_LIMITS.maxFileBytes + 1));
  errorCode(await f.read(), "FILE_TOO_LARGE");
  await fs.writeFile(path.join(f.root, "sample.txt"), "line\n".repeat(501));
  const lines = await f.read();
  assert.deepEqual([lines.startLine, lines.endLine, lines.totalLines], [1, 500, 501]);
  assert.equal(lines.truncated, true);
});

test("file reading does not call a network API or modify fixture content", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "sample.txt");
  await fs.writeFile(target, "read-only sample");
  const before = await fs.stat(target, { bigint: true });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw new Error("Unexpected network call"); };
  try {
    assert.equal((await f.read()).content, "read-only sample");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkCalls, 0);
  assert.equal(await fs.readFile(target, "utf8"), "read-only sample");
  const after = await fs.stat(target, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
});

test("rejects malformed UTF-8, UTF-16 and binary control bytes", async (t) => {
  const f = await fixture(t);
  for (const [bytes, code] of [[Buffer.from([0xc3, 0x28]), "INVALID_ENCODING"],
    [Buffer.from([0xff, 0xfe, 0x61, 0]), "INVALID_ENCODING"],
    [Buffer.from([0x61, 0, 0x62]), "BINARY_FILE"], [Buffer.from([1, 2, 3]), "BINARY_FILE"]]) {
    await fs.writeFile(path.join(f.root, "sample.txt"), bytes);
    errorCode(await f.read(), code);
  }
});

test("missing files and directories return bounded errors without absolute path disclosure", async (t) => {
  const f = await fixture(t);
  errorCode(await f.read(), "NOT_FOUND");
  await fs.mkdir(path.join(f.root, "sample.txt"));
  const result = await f.read();
  errorCode(result, "NOT_REGULAR_FILE");
  assert.equal(JSON.stringify(result).includes(f.directory), false);
});

test("filesystem permission failures produce a safe structured error", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "sample.txt");
  await fs.writeFile(target, "sample");
  const originalOpen = fs.open;
  const mock = t.mock.method(fs, "open", async function (file, ...args) {
    if (file === target) throw Object.assign(new Error(`denied: ${target}`), { code: "EACCES" });
    return originalOpen.call(this, file, ...args);
  });
  try {
    const result = await f.read();
    errorCode(result, "ACCESS_DENIED");
    assert.equal(JSON.stringify(result).includes(f.directory), false);
  } finally {
    mock.mock.restore();
  }
});

test("rejects junction/directory links into unauthorized siblings and inside the same project", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, "sample.txt"), "outside fixture");
  await fs.mkdir(path.join(f.root, "inner"));
  await fs.writeFile(path.join(f.root, "inner", "sample.txt"), "inside fixture");
  for (const [name, target] of [["escape", f.outside], ["inside", path.join(f.root, "inner")]]) {
    await fs.symlink(target, path.join(f.root, name), process.platform === "win32" ? "junction" : "dir");
    errorCode(await f.read({ path: `${name}/sample.txt` }), "UNSUPPORTED_LINK");
  }
  f.config.projects = { [path.join(f.root, "escape")]: { name: "linked-root", sync: true, allowCodexTasks: true } };
  await f.save();
  await assert.rejects(loadAuthorizedProjects(f.configPath), { code: "UNSUPPORTED_LINK" });
  await fs.mkdir(path.join(f.outside, "child"));
  f.config.projects = { [path.join(f.root, "escape", "child")]: { name: "linked-parent", sync: true, allowCodexTasks: true } };
  await f.save();
  await assert.rejects(loadAuthorizedProjects(f.configPath), { code: "UNSUPPORTED_LINK" });
});

test("rejects file symlinks when the OS permits their creation", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.outside, "target.txt");
  await fs.writeFile(target, "outside fixture");
  try {
    await fs.symlink(target, path.join(f.root, "sample.txt"), "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Windows file symlinks require Developer Mode or symlink privilege; junction coverage is separate.");
      return;
    }
    throw error;
  }
  errorCode(await f.read(), "UNSUPPORTED_LINK");
});

test("rejects hard-linked files", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.outside, "target.txt");
  await fs.writeFile(target, "outside fixture");
  await fs.link(target, path.join(f.root, "sample.txt"));
  errorCode(await f.read(), "UNSUPPORTED_LINK");
});

test("detects path replacement before returning and does not return captured data", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "sample.txt"), "original");
  let calls = 0;
  const tools = createProjectTools({ policy: {
    async authorizeProject(name) {
      if (++calls === 2) {
        await fs.rename(path.join(f.root, "sample.txt"), path.join(f.root, "old.txt"));
        await fs.writeFile(path.join(f.root, "sample.txt"), "replacement");
      }
      return f.policy.authorizeProject(name);
    },
  } });
  errorCode(await tools.read_project_file({ project: "demo", path: "sample.txt" }), "FILE_CHANGED");
});

test("cooperative deadline rejects an expired authorization operation", async (t) => {
  const f = await fixture(t);
  const tools = createProjectTools({ limits: { timeoutMs: 1 }, policy: {
    async authorizeProject(name) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return f.policy.authorizeProject(name);
    },
  } });
  errorCode(await tools.read_project_file({ project: "demo", path: "sample.txt" }), "TIMEOUT");
});

test("server overrides can only tighten hard limits", () => {
  const policy = { authorizeProject() {} };
  for (const limits of [{ maxFileBytes: READ_LIMITS.maxFileBytes + 1 }, { maxResultBytes: 1 },
    { maxLineCount: 0 }, { timeoutMs: 20_000 }, { unknown: 1 }, { maxFileBytes: NaN }]) {
    assert.throws(() => createProjectTools({ policy, limits }), TypeError);
  }
});
