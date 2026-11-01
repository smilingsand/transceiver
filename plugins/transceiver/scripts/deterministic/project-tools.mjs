import { performance } from "node:perf_hooks";
import { ProjectPolicyError, sameIdentity } from "../project-policy.mjs";
import { normalizeProjectPath, openProjectFile, resolveProjectFile } from "./path-policy.mjs";

export const READ_LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxResultBytes: 64 * 1024,
  maxLineCount: 500,
  timeoutMs: 10_000,
});

function validateLimits(overrides) {
  const limits = { ...READ_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in READ_LIMITS) || !Number.isSafeInteger(value) || value < (key === "maxResultBytes" ? 1024 : 1) || value > READ_LIMITS[key]) {
      throw new TypeError("Read limits must be positive integers no larger than the hard limits (result limit >= 1024).");
    }
  }
  return Object.freeze(limits);
}

function failure(error) {
  if (error instanceof ProjectPolicyError) return { ok: false, error: { code: error.code, message: error.message } };
  const errors = {
    ENOENT: ["NOT_FOUND", "Requested project directory or file does not exist."],
    EACCES: ["ACCESS_DENIED", "Filesystem access was denied."],
    EPERM: ["ACCESS_DENIED", "Filesystem access was denied."],
    ELOOP: ["UNSUPPORTED_LINK", "A linked path could not be safely opened."],
    ENOTDIR: ["NOT_REGULAR_FILE", "A path component is not a directory."],
  };
  const [code, message] = errors[error?.code] || ["READ_FAILED", "File access failed."];
  return { ok: false, error: { code, message } };
}

export function createProjectTools({ policy, limits: overrides = {} }) {
  if (typeof policy?.authorizeProject !== "function") throw new TypeError("A project policy is required.");
  const limits = validateLimits(overrides);
  return Object.freeze({
    async read_project_file(input) {
      let handle;
      const deadline = performance.now() + limits.timeoutMs;
      const checkDeadline = () => {
        if (performance.now() >= deadline) throw new ProjectPolicyError("TIMEOUT", "File operation exceeded its time budget.");
      };
      try {
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            Object.keys(input).some((key) => !["project", "path", "startLine", "lineCount"].includes(key))) {
          throw new ProjectPolicyError("INVALID_ARGUMENT", "Expected project, path, and optional startLine/lineCount only.");
        }
        const projectName = input.project;
        const requestedPath = input.path;
        const startLine = input.startLine === undefined ? 1 : input.startLine;
        const lineCount = input.lineCount === undefined ? limits.maxLineCount : input.lineCount;
        if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > limits.maxLineCount) {
          throw new ProjectPolicyError("INVALID_ARGUMENT", "Line numbers must be positive integers and lineCount must respect the service limit.");
        }
        normalizeProjectPath(requestedPath);
        const project = await policy.authorizeProject(projectName);
        checkDeadline();
        const opened = await openProjectFile(project, requestedPath);
        handle = opened.handle;
        checkDeadline();
        if (opened.stat.size > BigInt(limits.maxFileBytes)) {
          throw new ProjectPolicyError("FILE_TOO_LARGE", "File exceeds the service byte limit.");
        }
        const buffer = Buffer.alloc(limits.maxFileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          checkDeadline();
          const { bytesRead } = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), length);
          checkDeadline();
          if (!bytesRead) break;
          length += bytesRead;
          if (length > limits.maxFileBytes) throw new ProjectPolicyError("FILE_TOO_LARGE", "File grew beyond the service byte limit.");
        }
        const after = await handle.stat({ bigint: true });
        if (!sameIdentity(opened.stat, after) || after.nlink !== 1n || after.size !== BigInt(length) ||
            after.size !== opened.stat.size || after.mtimeNs !== opened.stat.mtimeNs || after.ctimeNs !== opened.stat.ctimeNs) {
          throw new ProjectPolicyError("FILE_CHANGED", "File changed while being read.");
        }
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        } catch {
          throw new ProjectPolicyError("INVALID_ENCODING", "Only valid UTF-8 text files are supported.");
        }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) {
          throw new ProjectPolicyError("BINARY_FILE", "Binary or unsupported control characters were found.");
        }
        const lines = text === "" ? [] : text.split(/\r\n|\n|\r/u);
        if (lines.length && /[\r\n]$/u.test(text)) lines.pop();
        if (startLine > Math.max(1, lines.length)) throw new ProjectPolicyError("LINE_OUT_OF_RANGE", "startLine is beyond the end of the file.");
        const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
        const result = {
          ok: true, project: project.name, path: requestedPath.replaceAll("\\", "/"),
          fileBytes: length, totalLines: lines.length,
          startLine: selected.length ? startLine : null,
          endLine: selected.length ? startLine + selected.length - 1 : null,
          content: selected.join("\n"),
          truncated: startLine - 1 + selected.length < lines.length,
          partialLastLine: false,
        };
        if (Buffer.byteLength(JSON.stringify(result)) > limits.maxResultBytes) {
          // Search code points rather than UTF-16 offsets; never split a surrogate pair.
          const points = Array.from(result.content);
          let low = 0;
          let high = points.length;
          result.truncated = true;
          result.partialLastLine = true;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            result.content = points.slice(0, mid).join("");
            if (Buffer.byteLength(JSON.stringify(result)) <= limits.maxResultBytes) low = mid;
            else high = mid - 1;
          }
          result.content = points.slice(0, low).join("");
          result.partialLastLine = low > 0 && points[low - 1] !== "\n" && points[low] !== "\n";
          const represented = result.content ? result.content.split("\n").length - Number(result.content.endsWith("\n")) : 0;
          result.startLine = represented ? startLine : null;
          result.endLine = represented ? startLine + represented - 1 : null;
        }
        if (Buffer.byteLength(JSON.stringify(result)) > limits.maxResultBytes) {
          throw new ProjectPolicyError("RESULT_TOO_LARGE", "Result metadata alone exceeds the service byte limit.");
        }
        // Re-check both live authorization and the path before releasing data.
        const authorized = await policy.authorizeProject(projectName);
        const finalPath = await resolveProjectFile(authorized, requestedPath);
        if (!sameIdentity(opened.stat, finalPath.stat) || finalPath.stat.size !== after.size ||
            finalPath.stat.mtimeNs !== after.mtimeNs || finalPath.stat.ctimeNs !== after.ctimeNs) {
          throw new ProjectPolicyError("FILE_CHANGED", "File path changed before returning its contents.");
        }
        checkDeadline();
        return result;
      } catch (error) {
        return failure(error);
      } finally {
        await handle?.close();
      }
    },
  });
}
