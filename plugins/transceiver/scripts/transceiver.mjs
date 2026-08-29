#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT_TAG = "|from_codex|:";
export const REQUEST_KINDS = new Set([
  "progress_update",
  "blocker",
  "plan_deviation",
  "consult_request",
  "file_offer",
]);

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "transceiver", "config.json");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "state", "transceiver");
const ALLOWED_TRANSITIONS = {
  prepared: new Set(["prepared", "sent", "failed"]),
  sent: new Set(["sent", "completed", "failed"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
};

class CliError extends Error {
  constructor(code, message, exitCode = 1, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function configPath() {
  return process.env.TRANSCEIVER_CONFIG || DEFAULT_CONFIG_PATH;
}

function stateDir() {
  return process.env.TRANSCEIVER_STATE_DIR || DEFAULT_STATE_DIR;
}

async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error instanceof SyntaxError) {
      throw new CliError("invalid_json", `Invalid JSON in ${file}`);
    }
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, value, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function emptyConfig() {
  return { version: 1, unknownProject: "ask", projects: {} };
}

async function loadConfig() {
  const config = await readJson(configPath(), emptyConfig());
  if (config.version !== 1 || typeof config.projects !== "object" || config.projects === null) {
    throw new CliError("invalid_config", "Transceiver config must use version 1 and contain a projects object.");
  }
  return config;
}

async function canonicalRoot(value) {
  if (!value) throw new CliError("missing_root", "--root is required.");
  try {
    return await fs.realpath(path.resolve(value));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CliError("project_root_missing", `Project root does not exist: ${value}`);
    }
    throw error;
  }
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new CliError("invalid_argument", `Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = args[index + 1];
    const value = next && !next.startsWith("--") ? args[++index] : true;
    if (key === "attachment") {
      options.attachment = [...(options.attachment || []), value];
    } else {
      options[key] = value;
    }
  }
  return options;
}

function validateChatGptUrl(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError("invalid_chatgpt_url", `Invalid ChatGPT URL: ${value}`);
  }
  if (parsed.protocol !== "https:" || !(parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com"))) {
    throw new CliError("invalid_chatgpt_url", `Expected an HTTPS chatgpt.com URL: ${value}`);
  }
  return parsed.toString();
}

async function projectEntry(root) {
  const canonical = await canonicalRoot(root);
  const config = await loadConfig();
  const projectRoot = Object.keys(config.projects)
    .filter((candidate) => canonical === candidate || canonical.startsWith(`${candidate}${path.sep}`))
    .sort((left, right) => right.length - left.length)[0] || null;
  return {
    canonical,
    config,
    projectRoot,
    project: projectRoot ? config.projects[projectRoot] : null,
  };
}

function requireIncludedProject(project, canonical) {
  if (!project) {
    throw new CliError("project_not_configured", "Project is not configured for Transceiver.", 3, { root: canonical });
  }
  if (project.sync !== true) {
    throw new CliError("project_excluded", "Project is excluded from Transceiver sync.", 4, {
      root: canonical,
      project: project.name,
    });
  }
}

async function readBody(bodyFile) {
  if (!bodyFile) throw new CliError("missing_body", "--body-file is required.");
  const body = bodyFile === "-" ? await readStdin() : await fs.readFile(path.resolve(bodyFile), "utf8");
  if (!body.trim()) throw new CliError("empty_body", "Message body must not be empty.");
  return body.trim();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8");
}

function stripLeadingTag(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith(AGENT_TAG)) return trimmed;
  return trimmed.slice(AGENT_TAG.length).replace(/^\s*/, "");
}

export function buildMessage({ project, sourceThread, kind, requestId, body }) {
  const metadata = [
    AGENT_TAG,
    `project: ${project}`,
    ...(sourceThread ? [`source_thread: ${sourceThread}`] : []),
    `kind: ${kind}`,
    `request_id: ${requestId}`,
  ];
  return `${metadata.join("\n")}\n\n${stripLeadingTag(body)}\n`;
}

function validateRequestId(value) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new CliError("invalid_request_id", "Request IDs must contain 8-128 letters, digits, underscores, or hyphens.");
  }
  return value;
}

async function approvedAttachments(values = []) {
  const result = [];
  for (const value of values) {
    if (value === true) throw new CliError("invalid_attachment", "--attachment requires an absolute path.");
    const absolute = path.resolve(value);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) throw new CliError("invalid_attachment", `Attachment is not a file: ${value}`);
    result.push(await fs.realpath(absolute));
  }
  return result;
}

function requestPath(requestId) {
  return path.join(stateDir(), "requests", `${validateRequestId(requestId)}.json`);
}

async function commandProjectSet(options) {
  const canonical = await canonicalRoot(options.root);
  if (options.sync !== "true" && options.sync !== "false") {
    throw new CliError("invalid_sync_policy", "--sync must be true or false.");
  }
  if (options["allow-codex-tasks"] !== undefined && !["true", "false"].includes(options["allow-codex-tasks"])) {
    throw new CliError("invalid_codex_task_policy", "--allow-codex-tasks must be true or false.");
  }
  const config = await loadConfig();
  const existing = config.projects[canonical] || {};
  const sync = options.sync === "true";
  const allowCodexTasks = sync && (options["allow-codex-tasks"] === undefined
    ? existing.allowCodexTasks === true
    : options["allow-codex-tasks"] === "true");
  const chatgptUrl = sync
    ? validateChatGptUrl(options["chatgpt-url"] || existing.chatgptUrl || null)
    : null;
  config.projects[canonical] = {
    name: options.name || existing.name || path.basename(canonical),
    sync,
    allowCodexTasks,
    chatgptUrl,
    updatedAt: now(),
  };
  await writeJsonAtomic(configPath(), config);
  return { ok: true, root: canonical, project: config.projects[canonical] };
}

async function commandProjectGet(options) {
  const { canonical, projectRoot, project } = await projectEntry(options.root);
  if (!project) throw new CliError("project_not_configured", "Project is not configured for Transceiver.", 3, { root: canonical });
  return { ok: true, root: projectRoot, project };
}

async function commandProjectList() {
  const config = await loadConfig();
  const projects = Object.entries(config.projects).map(([root, project]) => ({ root, ...project }));
  return { ok: true, unknownProject: config.unknownProject, projects };
}

async function commandPrepare(options) {
  const { canonical, projectRoot, project } = await projectEntry(options.root);
  requireIncludedProject(project, projectRoot || canonical);
  const kind = String(options.kind || "");
  if (!REQUEST_KINDS.has(kind)) throw new CliError("invalid_kind", `Unsupported request kind: ${kind}`);

  // Policy is resolved before body or attachment data is read.
  const body = await readBody(options["body-file"]);
  const attachments = await approvedAttachments(options.attachment);
  const requestId = validateRequestId(String(options["request-id"] || randomUUID()));
  const createdAt = now();
  const request = {
    version: 1,
    id: requestId,
    status: "prepared",
    createdAt,
    updatedAt: createdAt,
    project: { name: project.name, root: projectRoot },
    kind,
    sourceThread: options["source-thread"] || null,
    target: { chatgptUrl: project.chatgptUrl || null },
    message: buildMessage({
      project: project.name,
      sourceThread: options["source-thread"] || null,
      kind,
      requestId,
      body,
    }),
    attachments,
  };
  const file = requestPath(requestId);
  try {
    await fs.access(file);
    throw new CliError("request_exists", `Request already exists: ${requestId}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(file, request);
  return { ok: true, requestPath: file, request };
}

async function commandShow(options) {
  const file = requestPath(String(options["request-id"] || ""));
  const request = await readJson(file);
  const config = await loadConfig();
  requireIncludedProject(config.projects[request.project.root], request.project.root);
  return { ok: true, requestPath: file, request };
}

async function commandRequestList(options) {
  const { canonical, projectRoot, project } = await projectEntry(options.root);
  requireIncludedProject(project, projectRoot || canonical);
  const requestedStatus = options.status ? String(options.status) : null;
  if (requestedStatus && !Object.hasOwn(ALLOWED_TRANSITIONS, requestedStatus)) {
    throw new CliError("invalid_status", `Unsupported request status: ${requestedStatus}`);
  }
  const directory = path.join(stateDir(), "requests");
  const names = await fs.readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const requests = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const request = await readJson(path.join(directory, name));
    if (request.project?.root !== projectRoot) continue;
    if (requestedStatus && request.status !== requestedStatus) continue;
    if (options["source-thread"] && request.sourceThread !== options["source-thread"]) continue;
    requests.push({
      id: request.id,
      status: request.status,
      kind: request.kind,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      sourceThread: request.sourceThread,
      chatgptUrl: request.target?.chatgptUrl || null,
    });
  }
  return { ok: true, root: projectRoot, requests };
}

async function updateMappedConversation(request, conversationUrl) {
  if (!conversationUrl) return;
  const config = await loadConfig();
  const project = config.projects[request.project.root];
  if (!project || project.sync !== true) return;
  project.chatgptUrl = conversationUrl;
  project.updatedAt = now();
  await writeJsonAtomic(configPath(), config);
}

async function commandMark(options) {
  const requestId = validateRequestId(String(options["request-id"] || ""));
  const file = requestPath(requestId);
  const request = await readJson(file);
  const config = await loadConfig();
  requireIncludedProject(config.projects[request.project.root], request.project.root);
  const next = String(options.status || "");
  if (!ALLOWED_TRANSITIONS[request.status]?.has(next)) {
    throw new CliError("invalid_transition", `Cannot move request from ${request.status} to ${next}.`);
  }
  const conversationUrl = validateChatGptUrl(options["conversation-url"] || request.target?.chatgptUrl || null);
  if (next === "sent" || next === "completed") {
    if (!conversationUrl) {
      throw new CliError("missing_conversation_url", "A ChatGPT conversation URL is required before marking a request sent.");
    }
  }
  let responseFile = null;
  if (options["response-file"] === "-") {
    const response = (await readStdin()).trim();
    if (!response) throw new CliError("empty_response", "ChatGPT response must not be empty.");
    responseFile = path.join(stateDir(), "responses", `${requestId}.md`);
    await writeTextAtomic(responseFile, `${response}\n`);
  } else if (options["response-file"]) {
    responseFile = await fs.realpath(path.resolve(options["response-file"]));
  }
  request.status = next;
  request.updatedAt = now();
  request.target = { chatgptUrl: conversationUrl };
  if (responseFile) request.responseFile = responseFile;
  if (options.error) request.error = String(options.error);
  await writeJsonAtomic(file, request);
  if (next === "sent" || next === "completed") await updateMappedConversation(request, conversationUrl);
  return { ok: true, requestPath: file, request };
}

async function commandContext(options) {
  const { canonical, projectRoot, project } = await projectEntry(options.root);
  if (!project) return null;
  const additionalContext = project.sync === true
    ? `Transceiver is enabled for ${project.name}. Use $transceiver for material milestones, blockers, plan deviations, explicit checkpoints, or task wrap-up. The mapped ChatGPT conversation is ${project.chatgptUrl || "not set"}. Reverse ChatGPT-to-Codex tasks are ${project.allowCodexTasks === true ? "enabled" : "disabled"} for this project. Every outbound message must be prepared by the Transceiver helper so it begins with ${AGENT_TAG}`
    : `Transceiver sync is disabled for ${project.name} (${projectRoot || canonical}). Do not collect or send this project's files, Git state, transcripts, or progress through Transceiver.`;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

async function commandDoctor() {
  const config = await loadConfig();
  const projects = Object.values(config.projects);
  return {
    ok: true,
    node: process.version,
    configPath: configPath(),
    stateDir: stateDir(),
    includedProjects: projects.filter((project) => project.sync === true).length,
    excludedProjects: projects.filter((project) => project.sync !== true).length,
    mappedConversations: projects.filter((project) => project.sync === true && project.chatgptUrl).length,
    codexTaskProjects: projects.filter((project) => project.sync === true && project.allowCodexTasks === true).length,
  };
}

function help() {
  return {
    ok: true,
    commands: {
      "project-set": "--root PATH --sync true|false [--allow-codex-tasks true|false] [--name NAME] [--chatgpt-url URL]",
      "project-get": "--root PATH",
      "project-list": "",
      prepare: "--root PATH --kind KIND --body-file PATH|- [--source-thread URI] [--attachment PATH]",
      show: "--request-id ID",
      "request-list": "--root PATH [--source-thread URI] [--status prepared|sent|completed|failed]",
      mark: "--request-id ID --status sent|completed|failed [--conversation-url URL] [--response-file PATH|-]",
      context: "--root PATH",
      doctor: "",
    },
  };
}

export async function run(argv) {
  const [command = "help", ...rest] = argv;
  const options = parseOptions(rest);
  if (command === "project-set") return commandProjectSet(options);
  if (command === "project-get") return commandProjectGet(options);
  if (command === "project-list") return commandProjectList();
  if (command === "prepare") return commandPrepare(options);
  if (command === "show") return commandShow(options);
  if (command === "request-list") return commandRequestList(options);
  if (command === "mark") return commandMark(options);
  if (command === "context") return commandContext(options);
  if (command === "doctor") return commandDoctor();
  if (command === "help" || command === "--help" || command === "-h") return help();
  throw new CliError("unknown_command", `Unknown command: ${command}`);
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    if (result !== null) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const payload = error instanceof CliError
      ? { ok: false, code: error.code, message: error.message, ...error.details }
      : { ok: false, code: "unexpected_error", message: error instanceof Error ? error.message : String(error) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

const invokedAs = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedAs === import.meta.url) await main();
