import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { gitDiagnostic } from "../scripts/deterministic/git-diagnostics.mjs";
import { gitToolsFromExecutor } from "../scripts/deterministic/git-tools.mjs";
import { registerDeterministicTools } from "../scripts/deterministic/register-tools.mjs";
import { ProjectPolicyError } from "../scripts/project-policy.mjs";

test("native diagnostics classify stage and redact paths and untrusted fields", () => {
  const root = path.resolve("authorized-root");
  for (const stage of ["authorize", "pre-scan", "git", "post-authorize", "post-scan"]) {
    const error = Object.assign(new Error("secret stack and contents"), {
      code: "EPERM", syscall: "opendir", path: path.join(root, "secret-token", "private.txt"),
    });
    const diagnostic = gitDiagnostic(error, stage, root);
    assert.deepEqual(diagnostic, { stage, nativeCode: "EPERM", syscall: "opendir", pathLocation: "authorized_root" });
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private|authorized-root/);
  }
  assert.equal(gitDiagnostic({ path: path.resolve("authorized-root-sibling", "secret") }, "pre-scan", root).pathLocation, "outside_or_unknown");
  assert.deepEqual(gitDiagnostic({ code: "secret", syscall: "secret", path: "../secret" }, "git", root), { stage: "git" });
  assert.deepEqual(gitDiagnostic(new ProjectPolicyError("EPERM", "secret"), "pre-scan", root), { stage: "pre-scan" });
});

test("tracked status reports only what Git reported and validates input", async () => {
  let stdout = Buffer.from("## main\0");
  const calls = [];
  const tools = gitToolsFromExecutor({ limits: { maxResultBytes: 65536 }, execute: async (...args) => {
    calls.push(args); return { stdout, branch: { name: "main" } };
  } });
  let result = await tools.git_status({ project: "p", scope: "tracked" });
  assert.equal(calls[0][1], "tracked_status");
  assert.equal(result.complete, false);
  assert.equal(result.untrackedIncluded, false);
  assert.equal(result.trackedChangesReported, false);
  assert.equal("trackedClean" in result, false);
  assert.equal("clean" in result, false);
  assert.equal("untracked" in result, false);
  stdout = Buffer.from("## main\0 M file.txt\0");
  result = await tools.git_status({ project: "p", scope: "tracked" });
  assert.equal(result.trackedChangesReported, true);
  stdout = Buffer.from("## main\0?? file.txt\0");
  assert.equal((await tools.git_status({ project: "p", scope: "tracked" })).error.code, "INVALID_GIT_OUTPUT");
  for (const input of [{ project: "p", scope: "other" }, { project: "p", scope: null }, { project: "p", extra: true }, { project: "" }]) {
    assert.equal((await tools.git_status(input)).error.code, "INVALID_ARGUMENT");
  }
  assert.equal(calls.length, 3);
});

test("registered status schema accepts only supported scope and forwards it", async () => {
  const registered = new Map();
  const server = { registerTool: (name, config, handler) => registered.set(name, { config, handler }) };
  const gitTools = Object.fromEntries(["git_status", "git_diff", "git_add", "git_commit", "git_push"].map((name) => [name, async (args) => ({ ok: true, args })]));
  registerDeterministicTools(server, { fileTools: { read_project_file() {} }, gitTools });
  const status = registered.get("git_status");
  for (const input of [{ project: "p" }, { project: "p", scope: "full" }, { project: "p", scope: "tracked" }]) {
    assert.equal(status.config.inputSchema.safeParse(input).success, true);
  }
  for (const input of [{ project: "p", scope: "all" }, { project: "p", scope: 1 }, { project: "p", extra: true }]) {
    assert.equal(status.config.inputSchema.safeParse(input).success, false);
  }
  assert.deepEqual((await status.handler({ project: "p", scope: "tracked" })).structuredContent.args, { project: "p", scope: "tracked" });
});
