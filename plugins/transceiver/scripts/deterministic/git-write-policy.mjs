import { promises as fs } from "node:fs";
import path from "node:path";
import { inspectProjectRoot, ProjectPolicyError } from "../project-policy.mjs";
import { normalizeProjectPath } from "./path-policy.mjs";
import { checkLocalConfig } from "./git-safety.mjs";

const deny = (code, message) => { throw new ProjectPolicyError(code, message); };
export const WRITE_OPERATIONS = ["add", "commit", "push"];

export function validateWriteInput(input, operation) {
  const fields = { add: ["project", "paths"], commit: ["project", "message"], push: ["project", "remote", "branch"] }[operation];
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !fields.includes(key)) ||
      typeof input.project !== "string" || !input.project || input.project.length > 200) {
    deny("INVALID_ARGUMENT", "Expected only the documented Git write arguments.");
  }
  if (operation === "add") {
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 100) {
      deny("INVALID_ARGUMENT", "paths must contain between 1 and 100 explicit relative paths.");
    }
    return { ...input, paths: input.paths.map((item) => {
      const normalized = normalizeProjectPath(item).split(path.sep).join("/");
      if (normalized.split("/").some((part) => part.toLowerCase() === ".git")) {
        deny("INVALID_PATH", "Git metadata cannot be staged.");
      }
      return normalized;
    }) };
  }
  if (operation === "commit" && (typeof input.message !== "string" || !input.message.trim() ||
      input.message.length > 8192 || /[\x00\r]/u.test(input.message))) {
    deny("INVALID_ARGUMENT", "message must be explicit, non-blank and at most 8192 characters (no NUL or CR).");
  }
  if (operation === "push" && (!validRemote(input.remote) || !validBranch(input.branch))) {
    deny("INVALID_ARGUMENT", "Expected an explicit remote name and a plain local branch name, without options or refspecs.");
  }
  return input;
}

export function validRemote(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value) &&
    !value.includes("..") && !value.endsWith(".") && !value.endsWith(".lock");
}
export function validBranch(value) {
  return typeof value === "string" && value.length <= 200 &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/u.test(value) &&
    !value.includes("..") && !value.includes("//") && !value.includes("@{") &&
    value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

export function authorizeWrite(project, operation, input) {
  if (project.gitWrite?.[operation] !== true) deny("GIT_WRITE_NOT_AUTHORIZED", `git_${operation} is disabled for this project.`);
  if (operation !== "push") return;
  const targets = (project.gitWrite.pushTargets || []).filter((item) =>
    item.remote === input.remote && item.branches.includes(input.branch));
  if (targets.length !== 1) deny("PUSH_TARGET_NOT_AUTHORIZED", "Exactly one remote URL and branch grant is required.");
  return targets[0];
}

// Filename protection is independent of ignore rules and applies to the entire
// staged set. This deliberately errs on the side of blocking local config.
export function assertSafeStagedPaths(paths) {
  if (paths.some((name) => name.split(/[\\/]/u).some((part) =>
    /^(?:\.git|\.env(?:\..*)?|bridge\.env|config\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.pypirc|proj-info|codex|\.aws|\.ssh)$/iu.test(part) ||
    /\.(?:pem|key|p12|pfx)$/iu.test(part)))) {
    deny("SENSITIVE_STAGED_PATH", "Staging contains a potentially sensitive configuration, credential or private development path; review locally.");
  }
}

export async function assertNoActiveHooks(gitDirectory) {
  let entries;
  try { entries = await fs.readdir(path.join(gitDirectory, "hooks")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (entries.some((name) => !name.endsWith(".sample"))) {
    deny("HOOKS_NOT_SUPPORTED", "Active Git hooks require local review/execution; this tool neither runs nor bypasses them.");
  }
}

export function pushTransport(url) {
  if (typeof url !== "string" || /[\x00-\x1f\x7f]/u.test(url)) deny("UNSUPPORTED_PUSH_TRANSPORT", "Unsupported push URL.");
  if (url.startsWith("https://")) {
    let parsed;
    try { parsed = new URL(url); } catch { deny("UNSUPPORTED_PUSH_TRANSPORT", "Invalid HTTPS push URL."); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname || !parsed.pathname ||
        /%/u.test(parsed.host) || parsed.href !== url) {
      deny("UNSUPPORTED_PUSH_TRANSPORT", "HTTPS push URL must be canonical and contain no credentials, query or fragment.");
    }
    return "https";
  }
  if (path.isAbsolute(url) && !url.startsWith("\\\\") && !url.startsWith("//")) return "file";
  deny("UNSUPPORTED_PUSH_TRANSPORT", "Only credential-free HTTPS or an explicitly granted local bare directory is supported; no SSH or helpers.");
}

// A local receive-pack reads the destination's config and hooks too. Validate
// that repository before allowing file transport, never just trust the URL.
export async function inspectBareTarget(root, { checkDeadline, maxEntries }) {
  const checked = await inspectProjectRoot(root);
  let count = 0;
  const pending = [checked.root];
  while (pending.length) {
    checkDeadline();
    const dir = pending.pop();
    for await (const entry of await fs.opendir(dir)) {
      checkDeadline();
      if (++count > maxEntries) deny("REPOSITORY_TOO_LARGE", "Bare target exceeds scan limit.");
      const file = path.join(dir, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || path.relative(file, await fs.realpath(file)) !== "" ||
          (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) {
        deny("UNSUPPORTED_REPOSITORY", "Bare target contains linked or special paths.");
      }
      if (stat.isDirectory()) pending.push(file);
    }
  }
  for (const relative of ["commondir", "gitdir", "config.worktree", "worktrees", "modules", "shallow",
    "objects/info/alternates", "objects/info/http-alternates", "info/grafts"]) {
    try { await fs.lstat(path.join(root, relative)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    deny("UNSUPPORTED_REPOSITORY", "Shared/external bare metadata is unsupported.");
  }
  const stat = await fs.stat(path.join(root, "config"));
  if (stat.size > 64 * 1024) deny("UNSUPPORTED_REPOSITORY", "Bare config exceeds size limit.");
  const config = await fs.readFile(path.join(root, "config"), "utf8");
  checkLocalConfig(config, true);
  if (!/^\s*bare\s*=\s*true\s*$/imu.test(config)) deny("UNSUPPORTED_REPOSITORY", "Push target must be a bare repository.");
  await assertNoActiveHooks(root);
  return checked;
}
