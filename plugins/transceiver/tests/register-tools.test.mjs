import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDeterministicTools } from "../scripts/deterministic/register-tools.mjs";
import { createDeterministicServices } from "../scripts/deterministic/create-services.mjs";
import { memoryClient, NEW_TOOLS } from "./helpers/mcp-fixture.mjs";

async function registered(t, result = { ok: true, content: "fixture data" }) {
  const calls = [];
  const service = Object.fromEntries(NEW_TOOLS.map((name) => [name, async (args) => { calls.push({ name, args }); return result; }]));
  const server = new McpServer({ name: "registration-test", version: "1.0.0" });
  registerDeterministicTools(server, { fileTools: service, gitTools: service });
  return { client: await memoryClient(t, server), calls };
}

test("registerTool publishes three strict bounded schemas and read-only annotations", async (t) => {
  const { client } = await registered(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), NEW_TOOLS);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const forbidden of ["root", "cwd", "gitExecutable", "command", "env", "ref", "limits"]) {
      assert.equal(tool.inputSchema.properties[forbidden], undefined);
    }
  }
});

test("unknown fields, modes and out-of-range lines are rejected before service invocation", async (t) => {
  const { client, calls } = await registered(t);
  for (const [name, args] of [["read_project_file", { project: "demo", path: "x", lineCount: 501 }],
    ["read_project_file", { project: "demo", path: "x", startLine: 0 }],
    ["git_diff", { project: "demo", mode: "HEAD" }], ["git_status", { project: "demo", root: "/" }],
    ["git_diff", { project: "demo", mode: "staged", env: {} }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test("successful data and failure preview survive MCP content and structuredContent mapping", async (t) => {
  for (const data of [{ ok: true, content: "fixture", startLine: 1, endLine: 1, truncated: false },
    { ok: false, complete: false, truncated: true, timedOut: false, mode: "staged", diff: "partial fixture",
      error: { code: "OUTPUT_LIMIT", message: "fixture error" } }]) {
    const { client, calls } = await registered(t, data);
    for (const name of NEW_TOOLS) {
      const args = name === "read_project_file" ? { project: "demo", path: "x" }
        : name === "git_diff" ? { project: "demo", mode: "staged" } : { project: "demo" };
      const result = await client.callTool({ name, arguments: args });
      assert.deepEqual(result.structuredContent, data);
      assert.deepEqual(JSON.parse(result.content[0].text), data);
      assert.equal(result.isError, !data.ok);
      assert.deepEqual(calls.at(-1), { name, args });
    }
  }
});

test("service exceptions are sanitized and missing services fail initialization", async (t) => {
  assert.throws(() => registerDeterministicTools({}, {}), /initialized FileTools and GitTools/);
  const server = new McpServer({ name: "exception-test", version: "1.0.0" });
  const fail = async () => { throw new Error("private fixture path"); };
  registerDeterministicTools(server, { fileTools: { read_project_file: fail }, gitTools: { git_status: fail, git_diff: fail } });
  const client = await memoryClient(t, server);
  const result = await client.callTool({ name: "git_status", arguments: { project: "demo" } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "DETERMINISTIC_SERVICE_FAILED");
  assert.equal(JSON.stringify(result).includes("private fixture"), false);
});

test("host initialization requires explicit trusted Git and never falls back to PATH", async () => {
  await assert.rejects(createDeterministicServices({ gitExecutable: "" }), /TRANSCEIVER_GIT_EXECUTABLE.*PATH fallback/);
});

test("direct SDK/Zod pins match the lockfile and installed versions without dependency installation", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
    const installed = JSON.parse(await fs.readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    assert.equal(pkg.dependencies[name], installed.version);
    assert.equal(lock.packages[""].dependencies[name], installed.version);
    assert.equal(lock.packages[`node_modules/${name}`].version, installed.version);
  }
});
