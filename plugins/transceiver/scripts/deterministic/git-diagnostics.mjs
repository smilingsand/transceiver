import path from "node:path";
import { ProjectPolicyError } from "../project-policy.mjs";

export function createScanCounters(phase) {
  return { phase, entriesVisited: 0, directoriesVisited: 0, opendir: 0, lstat: 0, realpath: 0 };
}

export function scanCountersSnapshot(counters, elapsedMs) {
  const bounded = (value) => Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
  return { phase: counters.phase === "post-scan" ? "post-scan" : "pre-scan",
    entriesVisited: bounded(counters.entriesVisited), directoriesVisited: bounded(counters.directoriesVisited),
    opendir: bounded(counters.opendir), lstat: bounded(counters.lstat), realpath: bounded(counters.realpath),
    elapsedMs: bounded(elapsedMs) };
}

// Do not expose names: even a relative component can itself contain a secret.
export function gitDiagnostic(error, stage, root) {
  const diagnostic = { stage };
  if (!(error instanceof ProjectPolicyError) && error && typeof error === "object") {
    if (["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EIO", "EBUSY", "EMFILE", "ENFILE"].includes(error.code)) diagnostic.nativeCode = error.code;
    if (["open", "opendir", "scandir", "lstat", "stat", "realpath", "read", "spawn"].includes(error.syscall)) diagnostic.syscall = error.syscall;
    if (typeof root === "string" && path.isAbsolute(root) && typeof error.path === "string" && path.isAbsolute(error.path)) {
      const relative = path.relative(root, error.path);
      diagnostic.pathLocation = relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        ? "authorized_root" : "outside_or_unknown";
    }
  }
  return diagnostic;
}
