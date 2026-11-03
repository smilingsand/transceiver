import childProcess from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { ProjectPolicyError, sameIdentity } from "../project-policy.mjs";
import { createGitEnvironment, fixedGitArguments, inspectGitCredentialManager, inspectGitExecutable, inspectGitRepository } from "./git-safety.mjs";
import { authorizeWrite, validateWriteInput, WRITE_OPERATIONS } from "./git-write-policy.mjs";
import { executeGitWrite } from "./git-write-operations.mjs";

export const GIT_LIMITS = Object.freeze({ timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
  maxResultBytes: 64 * 1024, maxEntries: 20_000, maxConcurrent: 4 });
let activeOperations = 0;
const writingProjects = new Set();
const accessingProjects = new Map();

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
    const stderr = [];
    const fail = (code, message) => {
      if (error) return;
      error = new ProjectPolicyError(code, message);
      // Push may create trusted transport/receive-pack children. Terminate only
      // this owned process tree, never an existing Bridge or Tunnel process.
      try {
        if (budget.processTree && Number.isSafeInteger(child?.pid) && child.pid > 0) {
          if (process.platform === "win32") {
            childProcess.execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
              ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true, shell: false, timeout: 1000, maxBuffer: 4096,
                env: createGitEnvironment(path.dirname(executable)) }, (terminationError) => {
                if (terminationError && child.exitCode === null) {
                  error = new ProjectPolicyError("GIT_TERMINATION_FAILED", "Transport tree termination failed; inspect owned processes and Git state before retrying.");
                }
                try { child.kill("SIGKILL"); } catch { /* close determines slot release */ }
              });
          } else process.kill(-child.pid, "SIGKILL");
        } else child?.kill("SIGKILL");
        // Descendants cannot hold our response open through inherited pipes.
        child?.stdout.destroy();
        child?.stderr.destroy();
      }
      catch { error = new ProjectPolicyError("GIT_TERMINATION_FAILED", "Git process termination failed; its slot remains held until close."); }
    };
    try { child = childProcess.spawn(executable, args, { ...options,
      ...(budget.processTree && process.platform !== "win32" ? { detached: true } : {}),
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(new ProjectPolicyError("GIT_START_FAILED", "Git process could not start.")); return; }
    const timer = setTimeout(() => fail("TIMEOUT", "Git operation exceeded its time budget."), budget.timeoutMs);
    const collect = (chunk, output) => {
      length += chunk.length;
      if (length > budget.maxOutputBytes) fail("OUTPUT_LIMIT", "Git stdout/stderr exceeded its byte limit.");
      if (!error && output) stdout.push(chunk);
      if (!error && !output) stderr.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.on("error", () => { error ||= new ProjectPolicyError("GIT_START_FAILED", "Git process failed."); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0 && budget.identityRole && /fatal: no (?:name|email) was given and auto-detection is disabled/iu.test(Buffer.concat(stderr).toString("utf8"))) {
        reject(new ProjectPolicyError("GIT_IDENTITY_MISSING", `${budget.identityRole} identity is missing. In the authorized project repository, run git config --local user.name "Your Name" and git config --local user.email "you@example.com".`));
      }
      else if (code !== 0 && !budget.classifyFailures) reject(new ProjectPolicyError("GIT_FAILED", "Git returned a non-zero exit status."));
      else if (code !== 0) {
        // Classify bounded diagnostics, but never return raw subprocess text:
        // transport/helper messages may contain URLs or credentials.
        const diagnostic = Buffer.concat([...stderr, ...stdout]).toString("utf8");
        const category = /non-fast-forward|fetch first|stale info/iu.test(diagnostic) ? "NON_FAST_FORWARD"
          : /could not read (?:username|password)|terminal prompts disabled|(?:cannot|can't|unable to) prompt|interactivity (?:is |has been )?disabled/iu.test(diagnostic) ? "AUTHENTICATION_REQUIRED"
          : /authentication failed|\b(?:401|403)\b/iu.test(diagnostic) ? "AUTHENTICATION_FAILED"
          : /could not resolve|unable to access|failed to connect|connection.*(?:closed|refused|timed out)|network is unreachable/iu.test(diagnostic) ? "NETWORK_ERROR"
          : /remote rejected|pre-receive hook declined|permission denied/iu.test(diagnostic) ? "REMOTE_REJECTED" : "GIT_FAILED";
        const advice = category === "AUTHENTICATION_REQUIRED"
          ? "The remote requested credentials; check the project's GCM opt-in and existing local authentication. Interactive sign-in is disabled."
          : category === "AUTHENTICATION_FAILED"
            ? "The remote rejected authentication or access; check repository access using an authorized local Git workflow."
            : `Git failed (${category}, exit ${code}); inspect local state before retrying.`;
        reject(new ProjectPolicyError(category, advice));
      }
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
    async execute(projectName, operation, input) {
      const write = WRITE_OPERATIONS.includes(operation);
      if (!write && !Object.hasOwn(COMMANDS, operation)) throw new ProjectPolicyError("INVALID_ARGUMENT", "Unsupported Git operation.");
      if (write) input = validateWriteInput(input, operation);
      if (activeOperations >= GIT_LIMITS.maxConcurrent || active >= limits.maxConcurrent) {
        throw new ProjectPolicyError("BUSY", "Git concurrency limit reached; retry later.");
      }
      activeOperations++;
      active++;
      const deadline = performance.now() + limits.timeoutMs;
      let writingRoot;
      let accessRoot;
      let mutationAttempted = false;
      const checkDeadline = () => {
        if (performance.now() >= deadline) throw new ProjectPolicyError("TIMEOUT", "Git operation exceeded its time budget.");
      };
      try {
        const project = await policy.authorizeProject(projectName);
        const target = write ? authorizeWrite(project, operation, input) : undefined;
        if (writingProjects.has(project.root) || (write && accessingProjects.has(project.root))) {
          throw new ProjectPolicyError("BUSY", "Another Git operation is in progress for this project.");
        }
        accessRoot = project.root;
        accessingProjects.set(accessRoot, (accessingProjects.get(accessRoot) || 0) + 1);
        if (write) { writingRoot = project.root; writingProjects.add(writingRoot); }
        checkDeadline();
        const before = await inspectGitRepository(project, { checkDeadline, maxEntries: limits.maxEntries });
        const currentExecutable = await inspectGitExecutable(trusted.executable);
        if (!sameIdentity(trusted.stat, currentExecutable.stat) || trusted.stat.size !== currentExecutable.stat.size ||
            trusted.stat.mtimeNs !== currentExecutable.stat.mtimeNs) throw new ProjectPolicyError("GIT_CHANGED", "Trusted Git executable changed.");
        let outputBytes = 0;
        const invoke = async (command, transport, identityRole) => {
          checkDeadline();
          let auth = false;
          if (write) {
            const current = await policy.authorizeProject(projectName);
            const currentTarget = authorizeWrite(current, operation, input);
            if (JSON.stringify(currentTarget) !== JSON.stringify(target)) throw new ProjectPolicyError("PUSH_TARGET_NOT_AUTHORIZED", "Push grant changed during execution.");
            if ((current.gitWrite.githubGcm === true) !== (project.gitWrite.githubGcm === true)) throw new ProjectPolicyError("GIT_WRITE_NOT_AUTHORIZED", "GitHub authentication policy changed during execution.");
            auth = Boolean(transport === "https" && current.gitWrite.githubGcm === true &&
              new URL(target.url).host === "github.com");
          }
          let helperArgs = [];
          let authEnv = {};
          if (auth) {
            const helper = await inspectGitCredentialManager(trusted.executable);
            const checked = await inspectGitCredentialManager(trusted.executable);
            if (!sameIdentity(helper.stat, checked.stat) || helper.stat.size !== checked.stat.size || helper.stat.mtimeNs !== checked.stat.mtimeNs) {
              throw new ProjectPolicyError("CREDENTIAL_UNAVAILABLE", "Trusted Credential Manager changed; retry after reviewing the Git installation.");
            }
            // Git runs credential helpers via its shell. The canonical path is
            // restricted to safe characters above; single quotes are forbidden.
            helperArgs = ["-c", "credential.helper=", "-c", `credential.helper=!'${helper.executable.replaceAll("\\", "/")}' --no-ui`];
            authEnv = { PATH: path.dirname(trusted.executable), GCM_INTERACTIVE: "0", GCM_PROVIDER: "github", GCM_CREDENTIAL_STORE: "wincredman" };
            for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
              if (process.env[key] && path.isAbsolute(process.env[key])) authEnv[key] = process.env[key];
            }
          }
          checkDeadline();
          const result = await runChild(trusted.executable, [...fixedGitArguments(project.root, { write }), ...helperArgs, ...command],
            { cwd: project.root, env: { ...createGitEnvironment(project.root),
              ...(transport ? { GIT_ALLOW_PROTOCOL: transport } : {}), ...authEnv } },
            { timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxOutputBytes: limits.maxOutputBytes - outputBytes,
              classifyFailures: operation === "push", processTree: Boolean(transport), identityRole });
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
        const result = write ? await executeGitWrite({ operation, input, project, target, invoke,
          inspection: { checkDeadline, maxEntries: limits.maxEntries },
          markMutation: () => { mutationAttempted = true; } }) : undefined;
        const stdout = write ? undefined : await invoke(COMMANDS[operation]);
        const current = await policy.authorizeProject(projectName);
        const after = await inspectGitRepository(current, { checkDeadline, maxEntries: limits.maxEntries });
        if (!sameIdentity(before.gitIdentity, after.gitIdentity) || before.config !== after.config ||
            (operation === "commit" ? before.branch.name !== after.branch.name || before.branch.detached !== after.branch.detached
              : JSON.stringify(before.branch) !== JSON.stringify(after.branch))) {
          throw new ProjectPolicyError("REPOSITORY_CHANGED", "Git metadata changed during access.");
        }
        checkDeadline();
        return { stdout, branch: after.branch, result };
      } catch (error) {
        if (write && mutationAttempted) error.mutationMayHaveOccurred = true;
        throw error;
      } finally {
        if (writingRoot) writingProjects.delete(writingRoot);
        if (accessRoot) {
          const remaining = accessingProjects.get(accessRoot) - 1;
          if (remaining) accessingProjects.set(accessRoot, remaining); else accessingProjects.delete(accessRoot);
        }
        activeOperations--;
        active--;
      }
    },
  });
}
