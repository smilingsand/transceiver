import childProcess from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { ProjectPolicyError, sameIdentity } from "../project-policy.mjs";
import { createGitEnvironment, fixedGitArguments, inspectGitExecutable, inspectGitRepository } from "./git-safety.mjs";

export const GIT_LIMITS = Object.freeze({ timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
  maxResultBytes: 64 * 1024, maxEntries: 20_000, maxConcurrent: 4 });
let activeOperations = 0;

const COMMANDS = Object.freeze({
  status: ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=all", "--no-renames"],
  unstaged: ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", "--no-renames", "--unified=3", "--"],
  staged: ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", "--no-renames", "--unified=3", "--"],
});

function runChild(executable, args, options, budget) {
  return new Promise((resolve, reject) => {
    let child;
    let error;
    let length = 0;
    const stdout = [];
    const fail = (code, message) => {
      error ||= new ProjectPolicyError(code, message);
      // No shell/helpers are permitted. kill() targets only this owned process;
      // wait for close before releasing its concurrency slot.
      try { child?.kill("SIGKILL"); }
      catch { error = new ProjectPolicyError("GIT_TERMINATION_FAILED", "Git process termination failed; its slot remains held until close."); }
    };
    try { child = childProcess.spawn(executable, args, { ...options, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(new ProjectPolicyError("GIT_START_FAILED", "Git process could not start.")); return; }
    const timer = setTimeout(() => fail("TIMEOUT", "Git operation exceeded its time budget."), budget.timeoutMs);
    const collect = (chunk, output) => {
      length += chunk.length;
      if (length > budget.maxOutputBytes) fail("OUTPUT_LIMIT", "Git stdout/stderr exceeded its byte limit.");
      if (!error && output) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.on("error", () => { error ||= new ProjectPolicyError("GIT_START_FAILED", "Git process failed."); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0) reject(new ProjectPolicyError("GIT_FAILED", "Git returned a non-zero exit status."));
      else resolve({ stdout: Buffer.concat(stdout), outputBytes: length });
    });
  });
}

export async function createGitExecutor({ policy, gitExecutable, limits: overrides = {} }) {
  if (typeof policy?.authorizeProject !== "function") throw new TypeError("A project policy is required.");
  const limits = Object.freeze({ ...GIT_LIMITS, ...overrides });
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(GIT_LIMITS, key) || !Number.isSafeInteger(value) ||
        value < (["maxOutputBytes", "maxResultBytes"].includes(key) ? 1024 : 1) || value > GIT_LIMITS[key]) {
      throw new TypeError("Git limits must be positive integers within the hard limits (byte limits >= 1024).");
    }
  }
  const trusted = await inspectGitExecutable(gitExecutable);
  const version = (await runChild(trusted.executable, ["--version"], {
    cwd: path.dirname(trusted.executable), env: createGitEnvironment(path.dirname(trusted.executable)),
  }, { timeoutMs: 5000, maxOutputBytes: 4096 })).stdout.toString("utf8");
  const match = /^git version (\d+)\.(\d+)\./u.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 45)) {
    throw new TypeError("Git 2.45 or newer is required for the supported safety baseline.");
  }
  let active = 0;
  return Object.freeze({
    limits,
    async execute(projectName, operation) {
      if (!Object.hasOwn(COMMANDS, operation)) throw new ProjectPolicyError("INVALID_ARGUMENT", "Unsupported Git operation.");
      if (activeOperations >= GIT_LIMITS.maxConcurrent || active >= limits.maxConcurrent) {
        throw new ProjectPolicyError("BUSY", "Git concurrency limit reached; retry later.");
      }
      activeOperations++;
      active++;
      const deadline = performance.now() + limits.timeoutMs;
      const checkDeadline = () => {
        if (performance.now() >= deadline) throw new ProjectPolicyError("TIMEOUT", "Git operation exceeded its time budget.");
      };
      try {
        const project = await policy.authorizeProject(projectName);
        checkDeadline();
        const before = await inspectGitRepository(project, { checkDeadline, maxEntries: limits.maxEntries });
        const currentExecutable = await inspectGitExecutable(trusted.executable);
        if (!sameIdentity(trusted.stat, currentExecutable.stat) || trusted.stat.size !== currentExecutable.stat.size ||
            trusted.stat.mtimeNs !== currentExecutable.stat.mtimeNs) throw new ProjectPolicyError("GIT_CHANGED", "Trusted Git executable changed.");
        let outputBytes = 0;
        const invoke = async (command) => {
          checkDeadline();
          const result = await runChild(trusted.executable, [...fixedGitArguments(project.root), ...command],
            { cwd: project.root, env: createGitEnvironment(project.root) },
            { timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxOutputBytes: limits.maxOutputBytes - outputBytes });
          outputBytes += result.outputBytes;
          return result.stdout;
        };
        // An invalid existing HEAD must not be treated as an unborn branch by
        // `diff --cached` (Git can otherwise fall back to the empty tree).
        if (!before.branch.unborn) await invoke(["cat-file", "-e", "HEAD^{commit}"]);
        // Gitlinks can exist without .gitmodules or a populated submodule folder.
        const index = await invoke(["ls-files", "--stage", "-z"]);
        if (index.subarray(0, 7).toString() === "160000 " || index.includes(Buffer.from("\0" + "160000 "))) {
          throw new ProjectPolicyError("UNSUPPORTED_REPOSITORY", "Submodule index entries are not supported.");
        }
        const stdout = await invoke(COMMANDS[operation]);
        const current = await policy.authorizeProject(projectName);
        const after = await inspectGitRepository(current, { checkDeadline, maxEntries: limits.maxEntries });
        if (!sameIdentity(before.gitIdentity, after.gitIdentity) || before.config !== after.config ||
            JSON.stringify(before.branch) !== JSON.stringify(after.branch)) {
          throw new ProjectPolicyError("REPOSITORY_CHANGED", "Git metadata changed during access.");
        }
        checkDeadline();
        return { stdout, branch: before.branch };
      } finally {
        activeOperations--;
        active--;
      }
    },
  });
}
