import { ProjectPolicyError } from "../project-policy.mjs";
import { createGitExecutor } from "./git-executor.mjs";
import { validateWriteInput } from "./git-write-policy.mjs";

function failure(error) {
  const code = error instanceof ProjectPolicyError ? error.code : "GIT_ACCESS_FAILED";
  return { ok: false, complete: false, truncated: code === "OUTPUT_LIMIT", timedOut: code === "TIMEOUT",
    ...(error.mutationMayHaveOccurred ? { mutationMayHaveOccurred: true } : {}),
    error: { code, message: error instanceof ProjectPolicyError ? error.message : "Git repository access failed." } };
}

function checkInput(input, diff) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !(diff ? ["project", "mode"] : ["project"]).includes(key)) ||
      typeof input.project !== "string" || !input.project || input.project.length > 200 ||
      (diff && !["staged", "unstaged"].includes(input.mode))) {
    throw new ProjectPolicyError("INVALID_ARGUMENT", "Expected project only, or project and mode (staged/unstaged) for diff.");
  }
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
function parseStatus(bytes, branch) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ProjectPolicyError("INVALID_GIT_OUTPUT", "Git output is not valid UTF-8."); }
  if (!text.endsWith("\0")) throw new ProjectPolicyError("INVALID_GIT_OUTPUT", "Git status output is incomplete.");
  const records = text.slice(0, -1).split("\0");
  if (!records.shift()?.startsWith("## ")) throw new ProjectPolicyError("INVALID_GIT_OUTPUT", "Git branch status header is missing.");
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const record of records) {
    if (record.length < 4 || record[2] !== " " || !/^[ MADRCUT?!]{2}$/u.test(record.slice(0, 2))) {
      throw new ProjectPolicyError("INVALID_GIT_OUTPUT", "Git status record is invalid.");
    }
    const file = record.slice(3);
    if (record.startsWith("?? ")) untracked.push(file);
    else {
      if (record[0] !== " ") staged.push({ path: file, status: record[0] });
      if (record[1] !== " ") unstaged.push({ path: file, status: record[1] });
    }
  }
  return { ok: true, complete: true, truncated: false, timedOut: false, branch,
    staged, unstaged, untracked, clean: records.length === 0 };
}

export async function createGitTools(options) {
  const executor = await createGitExecutor(options);
  const write = (operation) => async (input) => {
    let completed = false;
    try {
      input = validateWriteInput(input, operation);
      const { result, branch } = await executor.execute(input.project, operation, input);
      completed = true;
      const { statusBytes, ...details } = result;
      const output = { ok: true, complete: true, truncated: false, timedOut: false, project: input.project,
        ...details, ...(statusBytes ? { status: parseStatus(statusBytes, branch) } : {}) };
      if (jsonBytes(output) > executor.limits.maxResultBytes) {
        throw new ProjectPolicyError("OUTPUT_LIMIT", "Write completed but its result exceeds the limit; inspect Git state before retrying.");
      }
      return output;
    } catch (error) {
      if (completed) error.mutationMayHaveOccurred = true;
      return failure(error);
    }
  };
  return Object.freeze({
    git_add: write("add"),
    git_commit: write("commit"),
    git_push: write("push"),
    async git_status(input) {
      try {
        checkInput(input, false);
        const { project } = input;
        const { stdout, branch } = await executor.execute(project, "status");
        const result = { ...parseStatus(stdout, branch), project };
        if (jsonBytes(result) > executor.limits.maxResultBytes) {
          throw new ProjectPolicyError("OUTPUT_LIMIT", "Git status result exceeds its byte limit; no partial status is returned.");
        }
        return result;
      } catch (error) { return failure(error); }
    },
    async git_diff(input) {
      try {
        checkInput(input, true);
        const { project, mode } = input;
        const { stdout, branch } = await executor.execute(project, mode);
        // Diff may include arbitrary tracked bytes. Replacement decoding produces
        // display text only; binary patches are not requested and not applicable.
        const result = { ok: true, complete: true, truncated: false, timedOut: false,
          project, mode, unborn: branch.unborn, diff: stdout.toString("utf8") };
        if (jsonBytes(result) > executor.limits.maxResultBytes) {
          const points = Array.from(result.diff);
          let low = 0;
          let high = points.length;
          result.ok = false;
          result.complete = false;
          result.truncated = true;
          result.error = { code: "OUTPUT_LIMIT", message: "Diff result was truncated and is not a complete patch." };
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            result.diff = points.slice(0, mid).join("");
            if (jsonBytes(result) <= executor.limits.maxResultBytes) low = mid;
            else high = mid - 1;
          }
          result.diff = points.slice(0, low).join("");
          if (jsonBytes(result) > executor.limits.maxResultBytes) {
            throw new ProjectPolicyError("OUTPUT_LIMIT", "Diff metadata exceeds its byte limit.");
          }
        }
        return result;
      } catch (error) { return failure(error); }
    },
  });
}
