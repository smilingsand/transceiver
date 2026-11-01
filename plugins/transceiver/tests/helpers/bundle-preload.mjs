// Test-process-only instrumentation. Never imported by the production bundle.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const log = (event) => appendFileSync(process.env.T35A_AUDIT_LOG, `${JSON.stringify(event)}\n`);
log({ event: "boot", pid: process.pid, cwd: process.cwd() });
const originalSpawn = childProcess.spawn;
const normalized = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
childProcess.spawn = function (command, args, options) {
  if (command === process.env.CODEX_MCP_BRIDGE_CODEX) {
    if (JSON.stringify(args) !== JSON.stringify(["app-server", "--stdio"])) {
      log({ event: "forbidden-codex-call", args });
      throw new Error("T35A only permits the explicit Fake App Server; no real Codex command is allowed.");
    }
    // The real upstream intentionally filters its child environment. Add only
    // this fixture's audit path and Windows system directories for the fake.
    const child = originalSpawn(process.execPath, [process.env.T35A_FAKE_SCRIPT], { ...options,
      env: { ...options.env, T35A_AUDIT_LOG: process.env.T35A_AUDIT_LOG,
        SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, windowsHide: true });
    log({ event: "fake-spawn", pid: child.pid });
    return child;
  }
  if (!process.env.TRANSCEIVER_GIT_EXECUTABLE || normalized(command) !== normalized(process.env.TRANSCEIVER_GIT_EXECUTABLE)) {
    log({ event: "forbidden-process" });
    throw new Error("Unexpected subprocess in isolated bundle test.");
  }
  return originalSpawn(command, args, options);
};
childProcess.execFile = function () {
  log({ event: "forbidden-execFile" });
  throw new Error("T35A does not permit Codex catalog subprocesses.");
};
syncBuiltinESMExports();
const originalDlopen = process.dlopen;
process.dlopen = function (...args) {
  const result = Reflect.apply(originalDlopen, this, args);
  log({ event: "native-load", file: path.resolve(String(args[1])) });
  return result;
};
process.on("message", (message) => {
  if (message?.type === "T35A_STOP") {
    log({ event: "shutdown-request" });
    // Windows child.kill does not deliver Node's Unix-style SIGTERM handler.
    // IPC invokes the unchanged runtime shutdown path in THIS owned child only.
    process.emit("SIGTERM");
  }
});
