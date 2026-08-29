# Bundled ChatGPT-to-Codex bridge

Read this only when configuring or using the reverse direction.

## Runtime

Transceiver embeds the fixed `menaje/codex-mcp-bridge-for-chatgpt` v0.3.0 release and adds project-policy derivation plus enforced `|from_chatgpt|:` provenance. The runtime binds only to `127.0.0.1`, uses Codex App Server, and stores its private SQLite state under the Transceiver state directory.

The reverse bridge is exposed to ChatGPT with OpenAI Secure MCP Tunnel. It is not registered as a Codex MCP dependency because that would create a recursive Codex-to-Codex tool surface.

## Project policy

Enable reverse tasks explicitly:

```bash
node "<plugin-root>/scripts/transceiver.mjs" project-set \
  --root /absolute/project/root \
  --sync true \
  --allow-codex-tasks true
```

Only roots with both properties enabled enter `CODEX_MCP_BRIDGE_ROOTS`. Names must be unique. The bundled runtime fixes the access strategy and sandbox to read-only and disables network and mutation capabilities. `CODEX_MCP_BRIDGE_ROOTS` constrains the task cwd; it is not an OS-level read allowlist. The upstream filename-based secret scan is disabled because it blocks ordinary virtual-environment CA bundles; keep credentials outside delegated project context.

## Required proof before claiming availability

1. `--doctor` confirms Codex App Server and the expected allowed projects.
2. MCP Inspector initializes and lists the bridge tools without schema errors.
3. One `codex_task` starts in an explicitly allowed project root and reaches a terminal result.
4. `codex_status` returns the terminal result for that exact job.
5. A second request resumes the returned exact thread id.
6. The Codex thread's incoming message starts with `|from_chatgpt|:`.
7. ChatGPT Developer Mode sees the tunnel connection and performs one live tool call.

Local proofs do not substitute for item 7. Account-side live testing requires `tunnel-client`, a `tunnel_id`, a runtime API key, Tunnels Read + Use, target-workspace association, and ChatGPT Developer Mode.

## Shared project status

Basic Memory can serve as an optional explicit Markdown checkpoint shared by ChatGPT and Codex. It is not a queue and does not synchronize either product's native memory. Transceiver's forward request record and reverse bridge state remain distinct delivery traces.
