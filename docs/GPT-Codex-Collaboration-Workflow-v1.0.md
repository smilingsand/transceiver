# Working with GPT and Codex

[English](GPT-Codex-Collaboration-Workflow-v1.0.md) | [简体中文](GPT-Codex-Collaboration-Workflow-v1.0-CN.md)

Complete the [Windows quick start](../QuickStart-BRIDGE-LAB.md) and a real read-only call first. Know your authorized project name and directory; Bridge and Tunnel must run and the connector must be enabled in the conversation. Process liveness or a tool list alone does not prove connectivity. Optionally copy the [Chinese GPT instructions](GPT-Codex-Collaboration-Instructions-CN.md) into your ChatGPT Project Instructions. They do not load themselves, enable a connector or grant access.

## Roles and a typical task

ChatGPT helps clarify goals, coordinate work and review evidence; local Codex analyzes, modifies and tests within actual permissions. You control the goal, authorization and acceptance. Already authorized work does not need approval at every step. ChatGPT Projects, Codex Desktop projects and Bridge authorization are independent. Allowed roots constrain project selection and cwd, not all OS reads.

Start with a request such as:

```text
Inspect [authorized project] read-only for possible causes of [login problem].
Review project instructions and existing changes first; explain evidence,
uncertainties and a recommended approach. Do not modify, commit or push.
```

ChatGPT can read files and Git directly or ask Codex for deeper analysis. Preserve existing changes. Ordinary Git diffs omit untracked files; truncated or timed-out results are incomplete evidence. After reviewing the findings, you might say:

```text
Please fix [specific problem] within [allowed scope], preserve existing changes,
run appropriate checks and explain the results. Do not commit or push.
```

Read-only consent is not write consent. Your consent does not itself change Bridge configuration, sandbox or OS permissions. Source defaults are read-only, but actual configuration can differ. The source entry does not guarantee interactive approval; agree on sensitive actions beforehand. Commit requires explicit user authorization, push separate authorization; deletion and security-boundary changes follow user and project rules.

Ask for actual status, files and Git differences, passed and failed checks, and unresolved uncertainty. A Codex report is a lead; independently inspect evidence before acceptance.

## Controlled Git writes

When the user authorizes the operation, the connector can call deterministic `git_add`, `git_commit` and `git_push` directly without a Codex task. Each server `gitWrite` grant defaults to false and does not imply user approval. Inspect status and unstaged changes, read untracked files, add explicit paths, review the whole staged diff, then commit. Commit needs repository-local identity and refuses active hooks. Push needs an exact remote URL/branch grant; GitHub HTTPS may additionally opt into Windows GCM, while SSH is unsupported. See [MCP examples, policy and recovery](Git-Write-Tools-BRIDGE-LAB.md).

## Activity, Job and Thread

| Term | Meaning |
| --- | --- |
| Conversation | Your ChatGPT conversation and a Bridge work scope; it may contain multiple Codex Threads. |
| Task | An everyday word for work; `codex_task` submits one execution. It is not synonymous with the objects below. |
| Activity | Tracks a user goal through work and verification; it can contain multiple Jobs and Threads. |
| Job | One submitted Codex execution, its state and result. Its completion does not establish acceptance. |
| Thread | Continuous Codex working context, which can be continued across Jobs. |

A login-fix Activity might contain an investigation Job in Thread A, a fix Job continuing A and an independent verification Job in Thread B. Not every goal needs three Jobs. Reuse the returned `activityId` for further or parallel work on the same open goal. Save exact `jobId` and `threadId`; do not guess which Thread to continue. A `requestId` identifies one logical request: reuse it only for an identical retry with identical parameters; changed content needs a new ID. Deduplication and records are bounded by conversation scope and retention, not permanent. Cross-conversation continuation must be explicitly requested with an accurate, still available Thread; full chat history is not inherited.

Job and Activity states are separate. A Job can run, finish, fail, be interrupted or cancelled; an Activity may still need work or validation, or be completed, abandoned or cancelled. Use the Activity card or `codex_status`; lack of new progress does not prove a hang. Bridge stores settings, session metadata and bounded results, not unlimited memory. Files, Git and verification remain important evidence.

Execution mode is independent of Thread selection: `foreground` waits for execution or connection to end, `background` returns tracking information immediately, and `auto` returns a quick result or transitions to a trackable background Job. Async return is not completion; connection timeout does not stop a Job.

## Models, effort and session settings

A model executes Codex instructions; reasoning effort selects a supported computation level. Availability, speed, usage and quality can change, and higher effort does not guarantee correctness. These are Codex Thread settings, distinct from the ChatGPT model. `codex_models` lists available models and supported efforts from installed Codex, possibly using a short cache or warning about stale data. `codex_settings` shows saved defaults and operator limits. Use actual returned values. Recorded parameters do not independently prove model-side execution or complete token usage.

New Threads use the saved defaults when no model or effort is specified. Initial defaults can come from the operator configuration; if still unset, Codex chooses its defaults. You can ask naturally:

```text
Create a new Codex Thread for [authorized project and directory] and investigate
[issue] read-only. Confirm the directory and permissions; do not change files.
```

```text
Continue the exact Thread that investigated the login issue and check [detail].
Confirm its Thread and cwd first; remain read-only.
```

```text
List available Codex models and reasoning efforts, then start a new Thread for
[project] with [exact model] and [supported effort] for [task]. Tell me if unavailable.
```

To change model or effort for the same goal, create a new Thread and hand over the goal, findings and outstanding work. Explicit new uses `sessionMode: new`; continuation uses `continue` and the exact `threadId`. `auto` continues only when exactly one recent compatible Thread exists in the current conversation; none creates a new one, multiple require selection, and a busy sole candidate requires waiting or explicitly creating a new Thread. Omission uses the saved `auto` or `new` default. Continuation cannot specify or change model or effort and requires compatible cwd and permission boundaries. A new Thread does not automatically receive the old one's complete history. Desktop's New Session is separate from creating an MCP Thread; external Thread display and refresh are environment-dependent.

Ask ChatGPT to open the `codex_settings` card to inspect or change supported defaults for model, effort, cwd, session behavior, access strategy, concurrency and completion handoff. Settings are shared by the Bridge instance, not isolated per ChatGPT account; operator limits still apply. Changed defaults do not rewrite existing Threads. `defaultCwd` must be within `allowedRoots`; it does not authorize a project. The card cannot expand roots, write limits, approval policy or OS permissions. Connector confirmations govern tool calls, not Codex sandbox selection.

## Long tasks and follow-up

State the goal, authorized project and change scope, acceptance criteria and prohibitions. Break substantial work into investigation, implementation and acceptance when useful, without creating an Activity for every small step. Track IDs and report completed and remaining work, blockers and real verification at meaningful handoffs.

Continue the same Thread for related work, or use separate Threads under the same Activity for parallel work with clear file ownership or suitable separate workspaces. Concurrent Threads can conflict in the same directory; one Thread executes serially. Concurrency is subject to settings and operator limits. Do not resubmit merely because a response is slow; check status first.

When changing Thread, conversation or person, hand over project, goal, authorization, decisions, existing changes, checks, outstanding work and IDs. Do not assume automatic history synchronization. Report partial work and failed or missing verification honestly; preserve uncommitted changes. Choose model, effort and parallelism for the task and budget; unknown token usage is not a precise bill. Background operation does not guarantee success or unlimited quota.

After disconnect, timeout or restart, check state and possible file changes before continuing or retrying. On Bridge restart unfinished Jobs are marked interrupted, but changes are not rolled back; Thread continuation depends on backend availability. Forced stop can affect other Jobs sharing an execution process and cannot undo changes. Identical safe retries use the same ID and arguments within their applicable retention scope; new instructions use a new ID. If records are unavailable, start a new Thread with verified context.

## Common problems and limitations

If a project is unavailable, check the exact name, real path and Bridge authorization; Desktop membership is separate. Restart managed components when idle after configuration changes. If only reading works, verify user consent and effective Bridge, sandbox and OS permissions; do not bypass restrictions. If ChatGPT cannot connect, check the enabled connector, Tunnel, organization, workspace, permissions and local connectivity. Local health is not end-to-end proof. After timeout, inspect state and changes before retrying; stop cannot undo changes. If Desktop does not show a task, check Bridge status and whether Desktop has the same directory; a historical test needed a Desktop restart, and live refresh is not guaranteed. Network availability depends on the actual environment.

For recovery, ask: “The connection was interrupted. Check the last task's actual state and existing changes in [project]. Tell me whether it is running, completed or failed; do not retry or modify files before confirming.”

Original V1.0 records described T4.1–T5.3 tests of read-only and controlled writes, retries, startup and single-component recovery, Thread continuation, model overrides and Desktop association. These were observations in a particular environment, not proof of current operation. Independent proof of model-side parameters and complete token counts, live Desktop refresh, forced connection loss during real work and dynamic testing of all failure protections remain incomplete. Historical originals are in Git history. See the [controller reference](Windows-Controller-BRIDGE-LAB.md) and [security boundaries](../README-BRIDGE-LAB.md#security-boundaries).
