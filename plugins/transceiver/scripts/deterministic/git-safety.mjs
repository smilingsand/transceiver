import { promises as fs } from "node:fs";
import path from "node:path";
import { inspectProjectRoot, ProjectPolicyError, sameIdentity } from "../project-policy.mjs";
import { assertWithinProject, openProjectFile } from "./path-policy.mjs";

const reject = (message) => { throw new ProjectPolicyError("UNSUPPORTED_REPOSITORY", message); };
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

// Deliberately constructed from scratch, not a copy followed by a GIT_* denylist.
export function createGitEnvironment(root) {
  const env = {
    HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
    LANG: "C.UTF-8", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "", GIT_PAGER: "",
  };
  for (const key of ["SystemRoot", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function fixedGitArguments(root, { write = false } = {}) {
  return ["--no-pager", "--no-optional-locks", `--git-dir=${path.join(root, ".git")}`, `--work-tree=${root}`,
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.preloadIndex=false",
    ...(write ? [] : ["-c", `core.hooksPath=${NULL_DEVICE}`]), "-c", `core.attributesFile=${NULL_DEVICE}`,
    "-c", `core.excludesFile=${NULL_DEVICE}`, "-c", "core.quotePath=true", "-c", "core.pager=",
    "-c", "diff.external=", "-c", "diff.renames=false", "-c", "color.ui=false",
    "-c", "protocol.allow=never", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];
}

// This is a small accepted subset, not a general Git config parser. Every other
// syntax/section/key is rejected BEFORE starting Git (including includes).
export function checkLocalConfig(text, bare = false) {
  const core = {
    repositoryformatversion: /^(?:0)$/,
    bare: bare ? /^true$/i : /^false$/i,
    filemode: /^(true|false)$/i,
    logallrefupdates: /^(true|false)$/i,
    symlinks: /^(true|false)$/i,
    ignorecase: /^(true|false)$/i,
    protectntfs: /^(true|false)$/i,
    protecthfs: /^(true|false)$/i,
    autocrlf: /^(true|false|input)$/i,
    eol: /^(lf|crlf|native)$/i,
  };
  let section;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || /^[#;]/u.test(line)) continue;
    const header = /^\[(core|user|remote|branch)(?: "[^"\\\x00-\x1f]+")?\]$/iu.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      // Core/user subsections are outside the supported config subset.
      if ((section === "core" || section === "user") && line.includes('"')) reject("Unsupported local Git configuration.");
      continue;
    }
    const pair = /^([a-z][a-z0-9-]*)\s*=\s*([^"\\#;\x00-\x1f]*)$/iu.exec(line);
    if (!section || !pair) reject("Unsupported local Git configuration syntax.");
    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    const accepted = section === "core" ? Object.hasOwn(core, key) && core[key].test(value)
      : section === "user" ? ["name", "email"].includes(key)
        : section === "remote" ? ["url", "fetch"].includes(key)
          : ["remote", "merge"].includes(key);
    if (!accepted) reject("Local Git configuration contains an unsupported setting.");
  }
}

async function readMetadata(project, relative, maxBytes) {
  const opened = await openProjectFile(project, relative);
  try {
    if (opened.stat.size > BigInt(maxBytes)) reject("Git control file exceeds its size limit.");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await opened.handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await opened.handle.stat({ bigint: true });
    if (length > maxBytes || after.size !== BigInt(length) || after.mtimeNs !== opened.stat.mtimeNs ||
        after.ctimeNs !== opened.stat.ctimeNs) reject("Git control file changed or exceeded its size limit.");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { reject("Git control file must use UTF-8."); }
  } finally {
    await opened.handle.close();
  }
}

export async function inspectGitRepository(project, { checkDeadline, maxEntries }) {
  const root = await inspectProjectRoot(project.root);
  if (root.root !== project.root || !sameIdentity(root.identity, project.identity)) {
    throw new ProjectPolicyError("PROJECT_CHANGED", "Project root changed during Git access.");
  }
  let gitStat;
  try { gitStat = await fs.lstat(path.join(root.root, ".git"), { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") throw new ProjectPolicyError("NOT_GIT_REPOSITORY", "Project root is not a Git repository top-level.");
    throw error;
  }
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) reject("Only a regular in-project .git directory is supported.");

  // Inspect metadata AND worktree without following links. This also covers
  // .gitignore/.gitattributes and nested repositories before Git can read them.
  let entries = 0;
  const found = new Set();
  const pending = [""];
  while (pending.length) {
    checkDeadline();
    const relative = pending.pop();
    const absolute = path.join(root.root, relative);
    const directory = await fs.opendir(absolute);
    for await (const entry of directory) {
      checkDeadline();
      if (++entries > maxEntries) throw new ProjectPolicyError("REPOSITORY_TOO_LARGE", "Repository scan exceeds its entry limit.");
      const child = path.join(relative, entry.name);
      const portable = child.split(path.sep).join("/");
      const lower = portable.toLowerCase();
      found.add(portable);
      const full = path.join(root.root, child);
      const stat = await fs.lstat(full, { bigint: true });
      const canonical = await fs.realpath(full);
      assertWithinProject(root.root, canonical);
      if (stat.isSymbolicLink() || path.relative(full, canonical) !== "" ||
          (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) reject("Linked or special repository paths are not supported.");
      if (entry.name.toLowerCase() === ".gitmodules" ||
          (entry.name.toLowerCase() === ".git" && lower !== ".git")) reject("Submodules and nested repositories are not supported.");
      if ([".git/commondir", ".git/gitdir", ".git/config.worktree", ".git/worktrees", ".git/modules",
        ".git/shallow", ".git/info/grafts", ".git/objects/info/alternates", ".git/objects/info/http-alternates"].includes(lower) ||
          (lower.startsWith(".git/objects/") && lower.endsWith(".promisor"))) reject("External, shared, shallow or promisor Git metadata is not supported.");
      if (stat.isDirectory()) pending.push(child);
    }
  }
  const config = await readMetadata(project, ".git/config", 64 * 1024);
  checkLocalConfig(config);
  const head = await readMetadata(project, ".git/HEAD", 4096);
  let branch;
  let unborn = false;
  if (/^[a-f0-9]{40}\n?$/u.test(head)) {
    branch = { name: null, detached: true, unborn: false };
  } else {
    const match = /^ref: (refs\/heads\/[a-zA-Z0-9_\-/\.\u0080-\uffff]+)\n?$/u.exec(head);
    if (!match || match[1].includes("..") || match[1].includes("//")) reject("Unsupported or invalid HEAD reference.");
    const ref = match[1];
    // Use filesystem lookup too: Windows may resolve case variants which the
    // directory listing's spelling alone would incorrectly classify as unborn.
    try {
      await fs.lstat(path.join(root.root, ".git", ref));
      const value = await readMetadata(project, `.git/${ref}`, 4096);
      if (!/^[a-f0-9]{40}\n?$/u.test(value)) reject("Unsupported branch reference value.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      unborn = true;
    }
    if (unborn && found.has(".git/packed-refs")) {
      const packed = await readMetadata(project, ".git/packed-refs", 1024 * 1024);
      unborn = !packed.split("\n").some((line) => /^[a-f0-9]{40} /u.test(line) && line.slice(41) === ref);
    }
    branch = { name: ref.slice("refs/heads/".length), detached: false, unborn };
  }
  checkDeadline();
  return { gitIdentity: gitStat, branch, config };
}

export async function inspectGitExecutable(executable) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) ||
      path.basename(executable).toLowerCase() !== (process.platform === "win32" ? "git.exe" : "git")) {
    throw new TypeError("An absolute, host-trusted Git executable path is required.");
  }
  const canonical = await fs.realpath(executable);
  if (process.platform === "win32" &&
      (path.basename(path.dirname(canonical)).toLowerCase() !== "bin" ||
       !/^mingw(?:32|64|arm64)$/iu.test(path.basename(path.dirname(path.dirname(canonical)))))) {
    throw new TypeError("Use the native Git for Windows mingw*/bin/git.exe, not a cmd launcher or wrapper.");
  }
  const stat = await fs.lstat(canonical, { bigint: true });
  if (!stat.isFile() || stat.ino === 0n) throw new TypeError("Git executable must be a regular file with stable identity.");
  return { executable: canonical, stat };
}
