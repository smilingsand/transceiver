import test from "node:test";
import assert from "node:assert/strict";
import { createScanCounters, scanCountersSnapshot } from "../scripts/deterministic/git-diagnostics.mjs";

test("scan snapshot contains only bounded aggregate counters and phase", () => {
  const counters = createScanCounters("post-scan");
  Object.assign(counters, { entriesVisited: 4, directoriesVisited: 2, opendir: 3, lstat: 4, realpath: 3, path: "secret" });
  const snapshot = scanCountersSnapshot(counters, 12.9);
  assert.deepEqual(snapshot, { phase: "post-scan", entriesVisited: 4, directoriesVisited: 2,
    opendir: 3, lstat: 4, realpath: 3, elapsedMs: 12 });
  counters.entriesVisited = 9;
  assert.equal(snapshot.entriesVisited, 4);
});

test("scan snapshot bounds invalid or oversized values", () => {
  const counters = createScanCounters("pre-scan");
  Object.assign(counters, { entriesVisited: Number.MAX_VALUE, directoriesVisited: -1, opendir: NaN });
  const snapshot = scanCountersSnapshot(counters, Infinity);
  assert.equal(snapshot.entriesVisited, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.directoriesVisited, 0);
  assert.equal(snapshot.opendir, 0);
  assert.equal(snapshot.elapsedMs, 0);
  assert.equal(snapshot.phase, "pre-scan");
});
