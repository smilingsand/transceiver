// HTTP/state assembly adapted from codex-mcp-bridge-for-chatgpt v0.3.0
// dist/server.js (MIT; see THIRD_PARTY_NOTICES.md). Tool logic stays upstream.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createBridgeMcpServer } from "codex-mcp-bridge-for-chatgpt/dist/server.js";
import { BRIDGE_BUILD_INFO } from "codex-mcp-bridge-for-chatgpt/dist/buildInfo.js";
import { PRODUCT_INFO } from "codex-mcp-bridge-for-chatgpt/dist/productInfo.js";
import { CodexCliModelCatalog } from "codex-mcp-bridge-for-chatgpt/dist/modelCatalog.js";
import { CodexJobRegistry } from "codex-mcp-bridge-for-chatgpt/dist/tools.js";
import { SessionRegistry } from "codex-mcp-bridge-for-chatgpt/dist/sessionRegistry.js";
import { ScopeResolver } from "codex-mcp-bridge-for-chatgpt/dist/scopeResolver.js";
import { BridgeStateStore } from "codex-mcp-bridge-for-chatgpt/dist/stateStore.js";
import { UserSettingsStore } from "codex-mcp-bridge-for-chatgpt/dist/userSettings.js";
import { CodexBackendRouter } from "codex-mcp-bridge-for-chatgpt/dist/upstreamRouter.js";
import { assertDeterministicServices, registerDeterministicTools } from "./deterministic/register-tools.mjs";
import { titleContext } from "./reverse-title.mjs";

export function assertBridgeCompatibility(build = BRIDGE_BUILD_INFO, factory = createBridgeMcpServer) {
  if (build?.version !== "0.3.0" ||
      build?.sourceHash !== "df6753352723a93cb5b78082213f9be64a1203ec4dad904594872f3b7733e2ea" ||
      typeof factory !== "function") {
    throw new Error("Unsupported Bridge internal API/build; review reverse-http.mjs and run compatibility tests before upgrading.");
  }
}

// Exactly one owner for these persistent objects per HTTP server. modelCatalog
// is a trusted host seam so tests can use a pure fake without any Codex process.
export function createSharedBridgeState(config, upstream, { modelCatalog } = {}) {
  assertBridgeCompatibility();
  const stateStore = new BridgeStateStore({ file: config.stateDatabaseFile });
  try {
    const sessions = new SessionRegistry({ stateFile: config.sessionStateFile, stateStore,
      allowedRoots: config.allowedRoots, autoResumeTtlMs: config.autoResumeTtlMs });
    const jobs = new CodexJobRegistry({ maxConcurrentJobs: config.maxConcurrentJobs,
      ttlMs: config.jobTtlMs, maxJobs: config.maxRetainedJobs, maxResultBytes: config.maxJobResultBytes,
      staleAfterMs: config.jobStaleAfterMs, stateFile: config.jobStateFile, stateStore,
      allowedRoots: config.allowedRoots });
    // The pinned upstream strips activityTitle from the backend payload. Bind it
    // to the job's callback so concurrent and deferred jobs keep their own title.
    const startJob = jobs.start.bind(jobs);
    jobs.start = (input, run, ...rest) => {
      const title = jobs.getActivity(input.activityId)?.title;
      return startJob(input, (...args) => titleContext.run(title, () => run(...args)), ...rest);
    };
    const catalog = modelCatalog || new CodexCliModelCatalog(config.codexCommand, config.modelCatalogCacheTtlMs,
      config.modelCatalogTimeoutMs, undefined, undefined, config.modelCatalogStateFile);
    const userSettings = new UserSettingsStore(config, { stateFile: config.settingsStateFile, stateStore });
    const scopeResolver = new ScopeResolver({ stateStore });
    if (upstream instanceof CodexBackendRouter) {
      for (const session of sessions.list()) upstream.bindThread(session.threadId, session.backendKind);
    }
    return Object.freeze({ stateStore, sessions, jobs, modelCatalog: catalog, userSettings, scopeResolver });
  } catch (error) {
    stateStore.close();
    throw error;
  }
}

export function createUnifiedMcpServer(config, upstream, state, services) {
  assertBridgeCompatibility();
  assertDeterministicServices(services);
  for (const name of ["sessions", "jobs", "modelCatalog", "userSettings", "scopeResolver", "stateStore"]) {
    if (!state?.[name]) throw new TypeError(`Missing shared Bridge state: ${name}`);
  }
  // Do not omit any argument: factory defaults would create per-POST registries
  // and an ephemeral ScopeResolver secret, breaking conversation continuity.
  const server = createBridgeMcpServer(config, upstream, state.sessions, state.jobs,
    state.modelCatalog, state.userSettings, state.scopeResolver);
  if (typeof server?.registerTool !== "function" || typeof server?.connect !== "function" || typeof server?.close !== "function") {
    throw new Error("Unsupported Bridge MCP factory result.");
  }
  registerDeterministicTools(server, services);
  return server;
}

export function createHttpServer(config, upstream, { fileTools, gitTools, modelCatalog } = {}) {
  assertBridgeCompatibility();
  const services = { fileTools, gitTools };
  assertDeterministicServices(services);
  const app = createMcpExpressApp({ allowedHosts: config.allowedHosts, host: config.host });
  const state = createSharedBridgeState(config, upstream, { modelCatalog });
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.status(404).end();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: PRODUCT_INFO.runtimeName, title: PRODUCT_INFO.displayName, build: BRIDGE_BUILD_INFO });
  });
  app.use("/mcp", (req, res, next) => {
    if (isAuthorized(req.headers.authorization, config)) return next();
    res.status(401).json({ error: "unauthorized" });
  });
  app.post("/mcp", async (req, res) => {
    let server;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      server = createUnifiedMcpServer(config, upstream, state, services);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") console.error("MCP request failed:", error);
      else console.error("MCP request failed. Set CODEX_MCP_BRIDGE_DEBUG=1 for local diagnostics.");
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    } finally {
      try { await transport.close(); }
      finally { await server?.close(); }
    }
  });
  for (const method of ["get", "delete"]) {
    app[method]("/mcp", (_req, res) => {
      res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    });
  }
  const httpServer = createServer(app);
  httpServer.once("close", () => state.stateStore.close());
  return httpServer;
}

function isAuthorized(header, config) {
  if (config.noAuth) return true;
  if (!header || !config.token) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${config.token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
