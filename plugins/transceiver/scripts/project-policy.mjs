import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export class ProjectPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectPolicyError";
    this.code = code;
  }
}

export function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

// Walk from the volume root too: an authorized directory may have a linked parent.
export async function inspectProjectRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.includes(",") ||
      root.includes("\0") || root === path.parse(root).root ||
      (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(root) || root.slice(2).includes(":")))) {
    throw new ProjectPolicyError("UNSUPPORTED_ROOT", "Project root must be a local absolute directory, not a volume root or special path.");
  }
  const normalized = path.normalize(root);
  if (normalized === path.parse(normalized).root) {
    throw new ProjectPolicyError("UNSUPPORTED_ROOT", "Volume roots cannot be authorized as projects.");
  }
  let current = path.parse(normalized).root;
  for (const part of normalized.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const entry = await fs.lstat(current, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ProjectPolicyError("UNSUPPORTED_LINK", "Project root and its parents must be ordinary directories without links.");
    }
  }
  const canonical = await fs.realpath(normalized);
  const identity = await fs.lstat(canonical, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.ino === 0n) {
    throw new ProjectPolicyError("UNSUPPORTED_ROOT", "Project root identity cannot be established.");
  }
  return { root: canonical, identity };
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function gitWritePolicy(value) {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value) || Object.keys(value).some((key) => !["add", "commit", "push", "githubGcm", "pushTargets"].includes(key)) ||
      ["add", "commit", "push", "githubGcm"].some((key) => value[key] !== undefined && typeof value[key] !== "boolean") ||
      (value.pushTargets !== undefined && (!Array.isArray(value.pushTargets) || value.pushTargets.length > 50 ||
        value.pushTargets.some((target) => !isRecord(target) ||
          Object.keys(target).some((key) => !["remote", "url", "branches"].includes(key)) ||
          typeof target.remote !== "string" || !target.remote || target.remote.length > 200 ||
          typeof target.url !== "string" || !target.url || target.url.length > 2048 ||
          !Array.isArray(target.branches) || !target.branches.length || target.branches.length > 100 ||
          target.branches.some((branch) => typeof branch !== "string" || !branch || branch.length > 200))))) {
    throw new ProjectPolicyError("INVALID_CONFIG", "Invalid gitWrite policy.");
  }
  return Object.freeze({ ...value, pushTargets: Object.freeze((value.pushTargets || []).map((target) =>
    Object.freeze({ ...target, branches: Object.freeze([...target.branches]) }))) });
}

// Config is trusted server configuration, not a client-supplied tool argument.
// Bound it independently of project file limits; never create a missing config.
export async function loadAuthorizedProjects(configPath) {
  let handle;
  let config;
  try {
    handle = await fs.open(configPath, "r");
    const stat = await handle.stat();
    const maxBytes = 256 * 1024;
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Unsupported config size or type");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Config too large");
    config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } catch {
    throw new ProjectPolicyError("INVALID_CONFIG", "Project configuration is unavailable, invalid, or too large.");
  } finally {
    await handle?.close();
  }
  if (!isRecord(config) || config.version !== 1 || !isRecord(config.projects)) {
    throw new ProjectPolicyError("INVALID_CONFIG", "Expected version 1 and a projects object.");
  }
  const projects = [];
  for (const [configuredRoot, project] of Object.entries(config.projects)) {
    const gitWrite = gitWritePolicy(project?.gitWrite);
    if (!isRecord(project) || ["sync", "allowCodexTasks"].some((key) =>
      project[key] !== undefined && typeof project[key] !== "boolean") ||
      (project.name !== undefined && (typeof project.name !== "string" || !project.name.trim() || project.name.length > 200))) {
      throw new ProjectPolicyError("INVALID_CONFIG", "Invalid project entry or authorization flags.");
    }
    // Exactly the existing reverse runtime authorization predicate.
    if (project.sync !== true || project.allowCodexTasks !== true) continue;
    const { root, identity } = await inspectProjectRoot(configuredRoot);
    const name = project.name || path.basename(configuredRoot);
    if (!name || name.length > 200 || projects.some((other) =>
      other.name === name || within(root, other.root) || within(other.root, root))) {
      throw new ProjectPolicyError("INVALID_CONFIG", "Enabled project names and roots must be unique and non-overlapping.");
    }
    projects.push(Object.freeze({ name, root, identity: Object.freeze(identity), gitWrite }));
  }
  return Object.freeze(projects);
}

export async function createProjectPolicy({ configPath = process.env.TRANSCEIVER_CONFIG ||
  path.join(homedir(), ".config", "transceiver", "config.json") } = {}) {
  const initial = await loadAuthorizedProjects(configPath);
  const baseline = new Map(initial.map((project) => [project.name, project]));
  return Object.freeze({
    // Reload for every access: revocation is effective without recreating this policy.
    // Newly granted/rebound roots require explicit policy recreation by the host.
    async authorizeProject(name) {
      if (typeof name !== "string" || !name || name.length > 200) {
        throw new ProjectPolicyError("INVALID_ARGUMENT", "project must be a non-empty project name of at most 200 characters.");
      }
      const current = (await loadAuthorizedProjects(configPath)).find((project) => project.name === name);
      const original = baseline.get(name);
      if (!current || !original) {
        throw new ProjectPolicyError("PROJECT_NOT_AUTHORIZED", "Project is not authorized for deterministic access.");
      }
      if (current.root !== original.root || !sameIdentity(current.identity, original.identity)) {
        throw new ProjectPolicyError("PROJECT_CHANGED", "Project root changed; recreate the project policy before access.");
      }
      return current;
    },
  });
}
