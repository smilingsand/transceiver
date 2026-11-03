import path from "node:path";
import { ProjectPolicyError } from "../project-policy.mjs";
import { assertNoActiveHooks, assertSafeStagedPaths, inspectBareTarget, pushTransport } from "./git-write-policy.mjs";

const fail = (code, message) => { throw new ProjectPolicyError(code, message); };
export function nulPaths(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("INVALID_GIT_OUTPUT", "Staged paths are not UTF-8."); }
  if (!text) return [];
  if (!text.endsWith("\0")) fail("INVALID_GIT_OUTPUT", "Staged path output is incomplete.");
  return text.slice(0, -1).split("\0");
}

export async function executeGitWrite({ operation, input, project, target, invoke, inspection, markMutation }) {
  // Never silently disable hooks for writes. Even a failing hook is rejected
  // before mutation because executing repository scripts is outside this grant.
  await assertNoActiveHooks(path.join(project.root, ".git"));
  const stagedPaths = async () => nulPaths(await invoke(["diff", "--cached", "--name-only", "--no-renames", "-z", "--"]));
  if (operation === "add") {
    assertSafeStagedPaths(input.paths);
    // Expand directory arguments before mutation to enforce the same sensitive
    // path check on ignored/tracked files and descendants. No pathspec magic.
    const candidates = nulPaths(await invoke(["--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...input.paths]));
    assertSafeStagedPaths(candidates);
    markMutation();
    await invoke(["--literal-pathspecs", "add", "--all", "--", ...input.paths]);
    return { paths: input.paths, stagedPaths: await stagedPaths(),
      statusBytes: await invoke(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=all", "--no-renames"]) };
  }
  if (operation === "commit") {
    const staged = await stagedPaths();
    assertSafeStagedPaths(staged);
    if (!staged.length) return { created: false, reason: "NO_STAGED_CHANGES" };
    // Require an explicit repository identity, without exposing Git's output or
    // allowing its automatic system identity to fill in missing settings.
    for (const role of ["Author", "Committer"]) {
      await invoke(["-c", "user.useConfigOnly=true", "var", `GIT_${role.toUpperCase()}_IDENT`], undefined, role);
    }
    markMutation();
    await invoke(["commit", "--cleanup=verbatim", "-m", input.message]);
    const hash = (await invoke(["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
    if (!/^[a-f0-9]{40}$/u.test(hash)) fail("INVALID_GIT_OUTPUT", "Commit hash output is invalid; inspect local HEAD.");
    const message = (await invoke(["log", "-1", "--format=%B", "HEAD", "--"])).toString("utf8").trimEnd();
    const stats = (await invoke(["show", "--format=", "--shortstat", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"])).toString("utf8").trim();
    return { created: true, hash, message, stats };
  }
  const preflight = async (command, code, message) => {
    try { return await invoke(command); }
    catch (error) { if (error.code === "GIT_FAILED") fail(code, message); throw error; }
  };
  await preflight(["check-ref-format", "--branch", input.branch], "INVALID_ARGUMENT", "Invalid local branch name.");
  await preflight(["show-ref", "--verify", `refs/heads/${input.branch}`], "LOCAL_BRANCH_NOT_FOUND", "The explicitly requested local branch does not exist.");
  const urls = (await preflight(["remote", "get-url", "--push", "--all", input.remote],
    "REMOTE_NOT_FOUND", "The explicitly requested remote does not exist.")).toString("utf8").trim().split(/\r?\n/u);
  if (urls.length !== 1 || urls[0] !== target.url) fail("PUSH_TARGET_NOT_AUTHORIZED", "Configured remote URL differs from the server grant.");
  const transport = pushTransport(target.url);
  if (transport === "file") await inspectBareTarget(target.url, inspection);
  markMutation();
  // The refspec is constructed here, never accepted as input. Use the pinned URL
  // directly so no remote mapping or default refspec can broaden the push.
  const output = await invoke(["-c", `protocol.${transport}.allow=always`, "-c", "http.followRedirects=false",
    "push", "--porcelain", "--", target.url, `refs/heads/${input.branch}:refs/heads/${input.branch}`], transport);
  const lines = output.toString("utf8").split(/\r?\n/u);
  const record = lines.find((line) => /^[ =*+!\-]\t/u.test(line));
  if (!record || !/^[ =*]\t/u.test(record)) fail("INVALID_GIT_OUTPUT", "Push result could not be confirmed; inspect the remote before retrying.");
  return { remote: input.remote, branch: input.branch,
    result: record[0] === "=" ? "up-to-date" : record[0] === "*" ? "created" : "updated" };
}
