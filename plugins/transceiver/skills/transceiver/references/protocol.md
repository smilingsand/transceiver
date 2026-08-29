# Handoff protocol

Use this reference when constructing, transporting, or recovering a Transceiver request.

## Visible message

Every Codex-authored message begins with the exact first line:

```text
|from_codex|:
project: <project-name>
source_thread: codex://threads/<thread-id>
kind: progress_update | blocker | plan_deviation | consult_request | file_offer
request_id: <uuid>

<bounded Markdown body>
```

The helper strips a duplicate leading tag before rebuilding the envelope. Transport adapters must not add their own setup text before the tag.

## Body shape

Use only sections that carry evidence for the current decision:

```markdown
目标：

已完成：

当前状态：

阻碍或偏差：

下一步：

证据：
```

For a plan deviation, identify the accepted baseline, observed state, evidence, impact, and the plan decision requested from ChatGPT.

## Local request state

The helper stores one JSON file per request under the configured state directory. The states are deliberately small:

```text
prepared -> sent -> completed
        \-> failed
sent     \-> failed
```

Repeating the current state is idempotent. A request ID identifies one immutable message; create a new request when the message changes.

The request record preserves:

- project name and canonical local root;
- source Codex thread;
- target ChatGPT conversation URL when known;
- visible message and approved attachment paths;
- timestamps, current state, and optional response artifact or error.

No hashes, embeddings, transcript index, or second event ledger are required.
