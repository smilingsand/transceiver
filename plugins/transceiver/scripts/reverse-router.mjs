import path from "node:path";

import { CodexBackendRouter } from "codex-mcp-bridge-for-chatgpt/dist/upstreamRouter.js";
import { tagChatGptPrompt } from "./reverse-provenance.mjs";
import { makeThreadTitle, titleContext } from "./reverse-title.mjs";

export async function setNewThreadTitle(rpc, threadId, name) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rpc.request("thread/name/set", { threadId, name }, { timeoutMs: 5000 });
      return;
    } catch (error) {
      const emptyRollout = error?.code === -32603 && /rollout at .+ is empty/i.test(String(error?.message));
      if (emptyRollout && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const category = emptyRollout ? "empty_rollout" : error?.code === -32001 ? "timeout" : "rpc_error";
      console.warn(`Unable to set new Codex thread title: threadId=${/^[a-f0-9-]+$/i.test(threadId) ? threadId : "[redacted]"} category=${category} message=[redacted]`);
      return;
    }
  }
}

export class TransceiverRouter extends CodexBackendRouter {
  constructor(defaultBackend, mcpBackend, appBackend, options) {
    super(defaultBackend, mcpBackend, appBackend);
    this.allowedProjects = options.allowedProjects;
    this.threadProjects = new Map(Object.entries(options.threadProjects || {}));
    this.persistThreadProjects = options.persistThreadProjects || (() => Promise.resolve());
  }

  async callTool(name, args, onProgress, onAssigned) {
    const forwarded = { ...args };
    const project = this.projectFor(name, forwarded);
    const title = name === "codex" ? makeThreadTitle(project, titleContext.getStore(), forwarded.prompt) : undefined;
    if ((name === "codex" || name === "codex-reply") && typeof forwarded.prompt === "string") {
      forwarded.prompt = tagChatGptPrompt(forwarded.prompt, project);
    }
    let persistence = Promise.resolve();
    let naming = Promise.resolve();
    let namingStarted = false;
    const result = await super.callTool(name, forwarded, onProgress, (assignment) => {
      if (assignment.threadId && project) {
        this.threadProjects.set(assignment.threadId, project);
        persistence = this.persistThreadProjects(Object.fromEntries(this.threadProjects));
      }
      if (title && !namingStarted && assignment.threadId && assignment.backendKind === "app-server") {
        namingStarted = true;
        const worker = this.appBackend.workers?.find((item) => `app-${item.index}` === assignment.workerId && item.generation === assignment.workerGeneration);
        if (worker?.connection?.rpc) {
          naming = setNewThreadTitle(worker.connection.rpc, assignment.threadId, title);
        }
      }
      onAssigned?.(assignment);
    });
    await Promise.all([persistence, naming]);
    return result;
  }

  steerThread(threadId, prompt) {
    return super.steerThread(threadId, tagChatGptPrompt(prompt, this.threadProjects.get(threadId)));
  }

  projectFor(name, args) {
    if (name === "codex-reply" && typeof args.threadId === "string") {
      return this.threadProjects.get(args.threadId);
    }
    if (typeof args.cwd !== "string") return undefined;
    return this.allowedProjects.find(
      ({ root }) => args.cwd === root || args.cwd.startsWith(`${root}${path.sep}`),
    )?.name;
  }
}
