// Minimal stdio fixture, no model, credentials, network or personal Codex state.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const log = (event) => appendFileSync(process.env.T35A_AUDIT_LOG, `${JSON.stringify(event)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  log({ event: "fake-rpc", method: message.method,
    // Opt-in, bounded permission audit for offline transport tests; never log input text/config.
    ...(process.env.T35A_CAPTURE_PERMISSIONS === "1" ? {
      keys: Object.keys(message.params || {}).sort(),
      ...(message.method === "thread/start" ? {
        cwd: message.params.cwd, sandbox: message.params.sandbox, approvalPolicy: message.params.approvalPolicy,
      } : {}),
    } : {}),
    ...(message.method === "turn/start" ? {
      tagged: message.params.input[0].text.startsWith("|from_chatgpt|:"),
      projectTagged: message.params.input[0].text.includes("project: sample"),
    } : {}) });
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize") result = { userAgent: "T35A_FAKE_ONLY" };
  else if (message.method === "thread/start") result = { thread: { id: `t35a-${randomUUID()}` } };
  else if (message.method === "thread/resume") result = { thread: { id: message.params.threadId } };
  else if (message.method === "turn/start") {
    const id = `t35a-turn-${randomUUID()}`;
    result = { turn: { id, status: "inProgress" } };
    send({ id: message.id, result });
    setTimeout(() => send({ method: "turn/completed", params: {
      threadId: message.params.threadId,
      turn: { id, status: "completed", items: [{ type: "agentMessage", text: "T35A_FAKE_ONLY result" }] },
    } }), 20);
    return;
  } else {
    send({ id: message.id, error: { code: -32601, message: "Unsupported fake RPC method" } });
    return;
  }
  send({ id: message.id, result });
});
input.on("close", () => { log({ event: "fake-exit", pid: process.pid }); process.exit(0); });
