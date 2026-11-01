import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { inspectProjectRoot, ProjectPolicyError, sameIdentity } from "../project-policy.mjs";

export function normalizeProjectPath(input) {
  if (typeof input !== "string" || !input || input.length > 1024 ||
      /[\x00-\x1f\x7f:<>"|?*]/u.test(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new ProjectPolicyError("INVALID_PATH", "Expected a bounded project-relative file path without special Windows syntax.");
  }
  const parts = input.split(/[\\/]/u);
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part) ||
      /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw new ProjectPolicyError("INVALID_PATH", "Path contains traversal, an ambiguous component, or a reserved device name.");
  }
  return parts.join(path.sep);
}

export function assertWithinProject(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectPolicyError("PATH_OUTSIDE_PROJECT", "Path is outside the authorized project.");
  }
}

export async function resolveProjectFile(project, input) {
  const relativePath = normalizeProjectPath(input);
  const checkedRoot = await inspectProjectRoot(project.root);
  if (checkedRoot.root !== project.root || !sameIdentity(checkedRoot.identity, project.identity)) {
    throw new ProjectPolicyError("PROJECT_CHANGED", "Project root changed during access.");
  }
  let current = project.root;
  const parts = relativePath.split(path.sep);
  let stat;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    assertWithinProject(project.root, current);
    stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new ProjectPolicyError("UNSUPPORTED_LINK", "Symbolic links and junctions are not supported.");
    }
    const canonical = await fs.realpath(current);
    assertWithinProject(project.root, canonical);
    // Fail closed on canonical aliases the component walk cannot explain.
    if (path.relative(current, canonical) !== "") {
      throw new ProjectPolicyError("UNSUPPORTED_LINK", "Canonical path differs from the inspected path.");
    }
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new ProjectPolicyError("NOT_REGULAR_FILE", "Path must resolve through ordinary directories to a regular file.");
    }
  }
  if (stat.nlink !== 1n || stat.ino === 0n) {
    throw new ProjectPolicyError("UNSUPPORTED_LINK", "Hard-linked files or files without stable identity are not supported.");
  }
  return { absolutePath: current, relativePath, stat };
}

// Caller owns the returned read-only handle. No writes or shell commands occur.
// Component checks and identity comparisons reduce common link escapes; they do
// not provide atomic traversal against a hostile local writer, especially on Windows.
export async function openProjectFile(project, input) {
  const resolved = await resolveProjectFile(project, input);
  let handle;
  try {
    handle = await fs.open(resolved.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !sameIdentity(stat, resolved.stat)) {
      throw new ProjectPolicyError("FILE_CHANGED", "File identity changed during access.");
    }
    return { ...resolved, stat, handle };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}
