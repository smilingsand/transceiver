import * as z from "zod/v4";
import { READ_LIMITS } from "./project-tools.mjs";

const annotations = Object.freeze({ readOnlyHint: true, destructiveHint: false,
  idempotentHint: true, openWorldHint: false });

export function assertDeterministicServices({ fileTools, gitTools } = {}) {
  if (typeof fileTools?.read_project_file !== "function" ||
      ["git_status", "git_diff", "git_add", "git_commit", "git_push"].some((name) => typeof gitTools?.[name] !== "function")) {
    throw new TypeError("Unified MCP requires initialized FileTools and GitTools services.");
  }
}

function handler(service, name) {
  return async (args) => {
    let result;
    try {
      result = await service[name](args);
      if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw new Error("Invalid service result");
    } catch {
      result = { ok: false, error: { code: "DETERMINISTIC_SERVICE_FAILED", message: "Deterministic service failed." } };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result, isError: !result.ok };
  };
}

export function registerDeterministicTools(server, services) {
  assertDeterministicServices(services);
  const project = z.string().min(1).max(200).describe("Exact authorized Transceiver project name.");
  server.registerTool("read_project_file", {
    title: "Read Project File",
    description: "Read a bounded UTF-8 text file from an explicitly authorized project. Paths must be relative; links and traversal are rejected. No Codex task is created.",
    inputSchema: z.strictObject({ project, path: z.string().min(1).max(1024),
      startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
      lineCount: z.number().int().min(1).max(READ_LIMITS.maxLineCount).optional() }),
    annotations,
  }, handler(services.fileTools, "read_project_file"));
  server.registerTool("git_status", {
    title: "Read Project Git Status",
    description: "Read bounded branch, staged, unstaged and untracked status for an authorized project repository. No Codex task is created.",
    inputSchema: z.strictObject({ project }), annotations,
  }, handler(services.gitTools, "git_status"));
  server.registerTool("git_diff", {
    title: "Read Project Git Diff",
    description: "Read a bounded unstaged or staged diff from an authorized project repository. Check ok, complete, truncated and timedOut before using the result. No Codex task is created.",
    inputSchema: z.strictObject({ project, mode: z.enum(["unstaged", "staged"]) }), annotations,
  }, handler(services.gitTools, "git_diff"));
  const writes = [
    ["git_add", "Stage Project Files", "Stage explicit relative files/directories, including deletions. Requires server gitWrite.add permission. No shell or Codex task.",
      { project, paths: z.array(z.string().min(1).max(1024)).min(1).max(100) }],
    ["git_commit", "Commit Staged Project Files", "Commit only staged changes with an explicit message. Requires server gitWrite.commit permission; sensitive paths and active hooks are rejected. Inspect state after incomplete results.",
      { project, message: z.string().min(1).max(8192) }],
    ["git_push", "Push Project Branch", "Ordinary non-force push to an explicit authorized remote and branch, pinned to the server URL grant. Requires server gitWrite.push permission. No arbitrary refspecs or credential helpers.",
      { project, remote: z.string().min(1).max(200), branch: z.string().min(1).max(200) }],
  ];
  for (const [name, title, description, schema] of writes) {
    server.registerTool(name, { title, description, inputSchema: z.strictObject(schema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: name !== "git_commit", openWorldHint: name === "git_push" } },
    handler(services.gitTools, name));
  }
}
