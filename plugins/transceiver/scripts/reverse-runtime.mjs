#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadConfig as loadBridgeConfig } from "codex-mcp-bridge-for-chatgpt/dist/config.js";
import { createHttpServer } from "codex-mcp-bridge-for-chatgpt/dist/server.js";
import { CodexUpstreamPool } from "codex-mcp-bridge-for-chatgpt/dist/upstream.js";
import { CodexAppServerUpstreamPool } from "codex-mcp-bridge-for-chatgpt/dist/appServerUpstream.js";
import { TransceiverRouter } from "./reverse-router.mjs";

const TRANSCEIVER_CONFIG = process.env.TRANSCEIVER_CONFIG || path.join(homedir(), ".config", "transceiver", "config.json");
const TRANSCEIVER_STATE_DIR = process.env.TRANSCEIVER_STATE_DIR || path.join(homedir(), ".local", "state", "transceiver");

const transceiver = JSON.parse(await fs.readFile(TRANSCEIVER_CONFIG, "utf8"));
if (transceiver.version !== 1 || typeof transceiver.projects !== "object" || transceiver.projects === null) {
  throw new Error("Transceiver config must use version 1 and contain a projects object.");
}

const allowedProjects = Object.entries(transceiver.projects)
  .filter(([, project]) => project.sync === true && project.allowCodexTasks === true)
  .map(([root, project]) => ({ root, name: project.name || path.basename(root) }));
if (allowedProjects.length === 0) {
  throw new Error("No project has both sync=true and allowCodexTasks=true.");
}
if (new Set(allowedProjects.map((project) => project.name)).size !== allowedProjects.length) {
  throw new Error("Projects with allowCodexTasks=true must have unique names.");
}

const reverseStateDir = path.join(TRANSCEIVER_STATE_DIR, "reverse");
await fs.mkdir(reverseStateDir, { recursive: true, mode: 0o700 });

Object.assign(process.env, {
  CODEX_MCP_BRIDGE_NO_AUTH: "1",
  CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
  CODEX_MCP_BRIDGE_PORT: process.env.TRANSCEIVER_REVERSE_PORT || process.env.CODEX_MCP_BRIDGE_PORT || "8876",
  CODEX_MCP_BRIDGE_ALLOWED_HOSTS: "127.0.0.1,localhost",
  CODEX_MCP_BRIDGE_ROOTS: allowedProjects.map((project) => project.root).join(","),
  CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server",
  CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: "read-only",
  CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: "read-only",
  CODEX_MCP_BRIDGE_ALLOW_WRITE: "0",
  CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "0",
  CODEX_MCP_BRIDGE_APPROVAL_POLICY: "never",
  CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN: "1",
  CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: process.env.CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS || "4",
  CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: process.env.CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE || "2",
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(reverseStateDir, "state.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(reverseStateDir, "models.json"),
  CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(reverseStateDir, "settings.json"),
  CODEX_MCP_BRIDGE_SESSION_STATE_FILE: path.join(reverseStateDir, "sessions.json"),
  CODEX_MCP_BRIDGE_JOB_STATE_FILE: path.join(reverseStateDir, "jobs.json"),
});

const config = loadBridgeConfig();

if (process.argv.includes("--doctor")) {
  const codex = spawnSync(config.codexCommand, ["app-server", "--help"], { stdio: "ignore" });
  const tunnelCommand = process.env.TRANSCEIVER_TUNNEL_CLIENT || "tunnel-client";
  const tunnel = spawnSync(tunnelCommand, ["help"], { stdio: "ignore" });
  let bridgeReachable = false;
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(1000) });
    bridgeReachable = response.ok;
  } catch {}
  process.stdout.write(`${JSON.stringify({
    ok: codex.status === 0,
    codexAppServer: codex.status === 0,
    allowedProjects: allowedProjects.map((project) => project.name),
    endpoint: `http://${config.host}:${config.port}/mcp`,
    bridgeReachable,
    tunnelClient: tunnel.status === 0,
  }, null, 2)}\n`);
  process.exit(codex.status === 0 ? 0 : 1);
}

const threadProjectsFile = path.join(reverseStateDir, "thread-projects.json");
let storedThreadProjects = {};
try {
  storedThreadProjects = JSON.parse(await fs.readFile(threadProjectsFile, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const allowedProjectNames = new Set(allowedProjects.map(({ name }) => name));
storedThreadProjects = Object.fromEntries(
  Object.entries(storedThreadProjects).filter(([, name]) => allowedProjectNames.has(name)),
);
let threadProjectWrite = Promise.resolve();
function persistThreadProjects(value) {
  threadProjectWrite = threadProjectWrite.catch(() => {}).then(async () => {
    const temporary = `${threadProjectsFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, threadProjectsFile);
  });
  return threadProjectWrite;
}

const upstream = new TransceiverRouter(
  config.defaultBackend,
  new CodexUpstreamPool(config.codexCommand, config.upstreamPoolSize),
  new CodexAppServerUpstreamPool(config.codexCommand, config.upstreamPoolSize),
  { allowedProjects, threadProjects: storedThreadProjects, persistThreadProjects },
);
const server = createHttpServer(config, upstream);
let shuttingDown = false;

server.listen(config.port, config.host, () => {
  console.log(`Transceiver reverse MCP listening on http://${config.host}:${config.port}/mcp`);
  console.log(`allowed projects: ${allowedProjects.map((project) => project.name).join(", ")}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  await new Promise((resolve) => server.close(resolve));
  await upstream.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
