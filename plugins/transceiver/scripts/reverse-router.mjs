import path from "node:path";

import { CodexBackendRouter } from "codex-mcp-bridge-for-chatgpt/dist/upstreamRouter.js";
import { tagChatGptPrompt } from "./reverse-provenance.mjs";

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
    if ((name === "codex" || name === "codex-reply") && typeof forwarded.prompt === "string") {
      forwarded.prompt = tagChatGptPrompt(forwarded.prompt, project);
    }
    let persistence = Promise.resolve();
    const result = await super.callTool(name, forwarded, onProgress, (assignment) => {
      if (assignment.threadId && project) {
        this.threadProjects.set(assignment.threadId, project);
        persistence = this.persistThreadProjects(Object.fromEntries(this.threadProjects));
      }
      onAssigned?.(assignment);
    });
    await persistence;
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
