export const CHATGPT_TAG = "|from_chatgpt|:";

export function tagChatGptPrompt(prompt, project = "continued-codex-thread") {
  const trimmed = prompt.trim();
  const body = trimmed.startsWith(CHATGPT_TAG)
    ? trimmed.slice(CHATGPT_TAG.length).replace(/^\s*/, "")
    : trimmed;
  return `${CHATGPT_TAG}\nproject: ${project}\ntransport: transceiver-mcp\n\n${body}`;
}
