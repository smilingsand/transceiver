import { AsyncLocalStorage } from "node:async_hooks";

export const titleContext = new AsyncLocalStorage();

// Titles are visible outside the conversation. Reject suspicious candidates rather
// than trying to redact arbitrary credentials or private data reliably.
function candidate(value) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\r\n\t\x00-\x1f\x7f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text || /(?:\b(?:password|secret|token|api[ _-]?key|authorization|bearer|credential)\b|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[A-Za-z0-9_\-]{32,}\b)/iu.test(text)) return "";
  if (/^(?:codex activity|task|new task|work|continue|help|please|hi)[.!]?$/iu.test(text)) return "";
  return text;
}

export function makeThreadTitle(project, activityTitle, prompt) {
  const safeProject = candidate(project) || "project";
  const firstLine = typeof prompt === "string" ? prompt.split(/\r?\n/u).find((line) => {
    const trimmed = line.trim();
    return trimmed && !/^(?:\|from_chatgpt\|:|project:|transport:)/iu.test(trimmed);
  }) || "" : "";
  const sentence = firstLine.split(/(?<=[.!?。！？])\s+/u)[0].replace(/^\s*(?:#{1,6}|[-*])\s*/u, "");
  const task = candidate(activityTitle) || candidate(sentence) || "Task";
  const chars = Array.from(`[ChatGPT] ${safeProject} — ${task}`);
  return chars.length > 85 ? `${chars.slice(0, 84).join("").trimEnd()}…` : chars.join("");
}
