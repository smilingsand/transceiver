---
name: transceiver
description: Synchronize selected Codex projects with mapped ChatGPT Web conversations in both directions while preserving agent provenance and explicit project authorization. Use for progress handoffs, blockers, plan revision, ChatGPT consultation, reverse Codex delegation, or Transceiver bridge setup and diagnosis.
---

# Transceiver

Transceiver is the policy and handoff layer. Reuse an installed transport; do not implement browser automation, a memory database, or a second Codex runtime inside this skill.

## Before collecting context

Resolve `<plugin-root>` from this skill's absolute path: this file is at `<plugin-root>/skills/transceiver/SKILL.md`. Put that literal absolute path in the commands below. Do not rely on `CLAUDE_PLUGIN_ROOT`; Codex provides it to plugin hooks, not ordinary shell commands.

Run the bundled helper against the current repository root:

```bash
node "<plugin-root>/scripts/transceiver.mjs" project-get --root "$PWD"
```

- `sync: false`: stop before reading project files, Git state, transcripts, or attachments. Do not send anything.
- `project_not_configured`: ask whether this project should be included. Unknown projects never sync implicitly.
- `sync: true`: use the configured project name and exact ChatGPT conversation URL when present.

Do not infer inclusion from a similarly named directory.

## Configure a project

When the user explicitly enables the current project, configure it through the bundled helper. Do not ask the user to locate the installed plugin directory.

For forward sync only:

```bash
node "<plugin-root>/scripts/transceiver.mjs" project-set \
  --root "$PWD" \
  --sync true \
  --allow-codex-tasks false \
  --name "<project-name>" \
  --chatgpt-url "https://chatgpt.com/c/<conversation-id>"
```

Add reverse delegation only after the user authorizes ChatGPT to start read-only Codex tasks in this project. Run the same command with `--allow-codex-tasks true`. The ChatGPT URL is optional when the user has not chosen a forward conversation yet.

## When to sync

Sync only when at least one of these is true:

- a meaningful milestone or experiment completed;
- a blocker changes the next decision;
- execution materially diverges from an accepted PRD, proposal, or plan;
- the user explicitly requests a checkpoint;
- a task is wrapping up and the next step should remain visible in ChatGPT.

Ordinary tool calls and minor intermediate progress do not justify a handoff.

## Prepare the message

Summarize only the evidence needed for the target decision. For research work, preserve claim boundaries and distinguish completed evidence, current interpretation, blockers, and proposed next steps.

Pipe the body to the helper so policy is checked before the body is consumed:

```bash
node "<plugin-root>/scripts/transceiver.mjs" prepare \
  --root "$PWD" \
  --kind progress_update \
  --source-thread "codex://threads/<thread-id>" \
  --body-file -
```

Allowed kinds are `progress_update`, `blocker`, `plan_deviation`, `consult_request`, and `file_offer`. Add each user-approved attachment with a repeated `--attachment <absolute-path>` argument.

The helper is the only message constructor. It makes the first line exactly `|from_codex|:` and records a request ID. Read [references/protocol.md](references/protocol.md) when implementing or debugging the envelope or request state.

## Send through an existing transport

Use the first available transport that satisfies the request:

1. `codex-chatgpt-control` for an exact ChatGPT conversation, Work lifecycle, or transactional retry.
2. Oracle for a saved browser conversation or Deep Research.
3. The installed Chrome/Browser control plugin for a visible ChatGPT Web interaction.

Never retry an uncertain send as a new request. Reuse the request ID and inspect the existing browser conversation or transport operation first.

If the request ID was lost after a restart or compaction, recover it without reading message bodies:

```bash
node "<plugin-root>/scripts/transceiver.mjs" request-list \
  --root "$PWD" \
  --status prepared
```

For visible browser sends:

- follow the selected Browser/Chrome skill, including its action-time confirmation requirements;
- navigate to the exact configured URL, or create one new conversation when no URL is mapped;
- submit the prepared message without rewriting it;
- verify the visible user turn contains `|from_codex|:` and the request ID;
- record the resulting conversation URL:

```bash
node "<plugin-root>/scripts/transceiver.mjs" mark \
  --request-id <request-id> \
  --status sent \
  --conversation-url "https://chatgpt.com/c/<conversation-id>"
```

When the handoff asks ChatGPT for analysis or plan revision, pipe the completed answer into `mark --status completed --response-file -`. This stores the returned result under the Transceiver state directory before completing the request. A pure progress record can remain `sent`.

## Reverse direction

The plugin bundles a loopback Streamable HTTP MCP bridge backed by Codex App Server. A project must have both `sync: true` and `allowCodexTasks: true`; forward authorization alone is insufficient. Run the bundled doctor and server with literal paths derived from `<plugin-root>`:

```bash
node "<plugin-root>/dist/reverse-bridge/index.mjs" --doctor
node "<plugin-root>/dist/reverse-bridge/index.mjs"
```

Connect `http://127.0.0.1:8876/mcp` to ChatGPT through OpenAI Secure MCP Tunnel. The MCP surface provides `codex_task`, `codex_status`, Activity lifecycle, model/settings discovery, steering, and force-stop. It uses App Server and requires a task working directory under a configured project root. This fork defaults to read-only access; explicit configuration can allow workspace writes, and network restrictions depend on the effective sandbox and environment. This cwd check is a project-selection policy, not an OS-level read sandbox. Every task, continuation, and steering prompt reaching Codex is rebuilt with `|from_chatgpt|:` as its exact first line.

Use `codex_task` to start or continue an exact Codex thread. If it returns a running job, use the Activity card or a bounded `codex_status` wait until terminal, then inspect the returned result before claiming completion.

Read [references/reverse-bridge.md](references/reverse-bridge.md) only when configuring or using ChatGPT-to-Codex delegation.

If Basic Memory or another shared explicit memory MCP is installed, update the accepted current checkpoint after a successful handoff. Keep ChatGPT Saved Memory, Codex local memory, shared notes, and conversation history as separate provenance sources.

## Stop conditions

Stop and report the exact blocker on missing project authorization, login, CAPTCHA, selector drift, unavailable transport, tunnel credentials, developer-mode access, or ambiguous target conversation. Do not silently choose a different project or conversation.
