#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(pluginRoot, "dist", "reverse-bridge");
const bundlePath = path.join(outputDir, "index.mjs");
const ncc = path.join(pluginRoot, "node_modules", ".bin", process.platform === "win32" ? "ncc.cmd" : "ncc");

await fs.rm(outputDir, { recursive: true, force: true });

const build = spawnSync(ncc, [
  "build",
  "scripts/reverse-runtime.mjs",
  "-o",
  "dist/reverse-bridge",
  "-m",
  "--license",
  "licenses.txt",
], { cwd: pluginRoot, stdio: "inherit" });

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

let bundle = await fs.readFile(bundlePath, "utf8");

function replaceOnce(pattern, replacement, label) {
  const matches = bundle.match(new RegExp(pattern.source, "g")) || [];
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label} in the ncc bundle, found ${matches.length}.`);
  }
  bundle = bundle.replace(pattern, replacement);
}

// ncc turns the URL into a plain asset path before fileURLToPath sees it.
replaceOnce(
  /\(0,[A-Za-z_$][\w$]*\.fileURLToPath\)\(([A-Za-z_$][\w$]*\.ab\+"build-info\.json")\)/,
  "$1",
  "build-info path",
);

// Supported platforms use the emitted prebuilds. Remove ncc's machine-local fallback
// and normalize its host-dependent module ID so macOS and Linux builds are identical.
const fallbackModuleKey = JSON.stringify("transceiver-better-sqlite3-fallback");
let fallbackModuleId;
replaceOnce(
  /(\d+):module=>\{module\.exports=eval\("require"\)\("[^"]*better_sqlite3\.node"\)\}/,
  (_, moduleId) => {
    fallbackModuleId = moduleId;
    return `${fallbackModuleKey}:()=>{throw new Error("No bundled better-sqlite3 prebuild for "+process.platform+"-"+process.arch+".")}`;
  },
  "better-sqlite3 fallback",
);
replaceOnce(
  new RegExp(`__nccwpck_require__\\(${fallbackModuleId}\\)`),
  `__nccwpck_require__(${fallbackModuleKey})`,
  "better-sqlite3 fallback reference",
);

await fs.writeFile(bundlePath, bundle);

const prebuilds = (await fs.readdir(path.join(outputDir, "prebuilds"))).filter((name) => name.endsWith(".node"));
if (prebuilds.length !== 8) {
  throw new Error(`Expected 8 better-sqlite3 prebuilds, found ${prebuilds.length}.`);
}
