# Working with GPT and Codex

[English](GPT-Codex-Collaboration-Workflow-v1.0.md) | [简体中文](GPT-Codex-Collaboration-Workflow-v1.0-CN.md)

This guide helps nontechnical users understand how to work with local Codex from ChatGPT after completing the [Windows quick start](../QuickStart-BRIDGE-LAB.md). It preserves the collaboration approach from the original V1.0 and historical observations from T4–T5. Those observations come from a particular environment and do not guarantee the same behavior on other machines or versions.

## Contents

- [Before you begin](#before-you-begin)
- [How to think about this collaboration](#how-to-think-about-this-collaboration)
- [A typical collaboration](#a-typical-collaboration)
- [Controlled Git writes](#controlled-git-writes)
- [How it works and key concepts](#how-it-works-and-key-concepts)
- [Models, reasoning effort and session settings](#models-reasoning-effort-and-session-settings)
- [Long-running tasks and follow-up work](#long-running-tasks-and-follow-up-work)
- [Common problems](#common-problems)
- [Historical observations and limitations](#historical-observations-and-limitations)

## Before you begin

Complete the quick start and successfully perform a real read-only connection test from ChatGPT. Have the name and directory of a local project that you have explicitly authorized. Bridge and Tunnel need to be running, and the corresponding connector must be enabled in the current conversation. Seeing the local processes running or seeing a list of tools is not proof that the ChatGPT-to-local connection works.

If you use a ChatGPT Project, you may copy the [GPT collaboration instructions](GPT-Codex-Collaboration-Instructions-CN.md) into that Project's **Instructions**. That file contains rules intended for ChatGPT; this document is a user-facing guide. Merely having the file in the repository does not load it automatically. Copying it does not enable the connector or grant project access or write permissions.

## How to think about this collaboration

Think of ChatGPT as the coordinator and reviewer: it helps clarify goals, inspect the current situation, organize work, and assess deliverables against actual files and verification results. Local Codex is the executor: it analyzes, modifies and tests within the selected project and its effective permissions. Bridge and Tunnel provide the connection between them; they do not replace human judgment or guarantee correct results.

**You remain in control of the goal and authorization.** You can request a read-only investigation first and then decide whether to permit changes, or explicitly authorize changes within a defined scope from the outset. Reviewing outcomes, changing direction, accepting results and approving actions that require separate authorization are your control points. Work that you have already explicitly authorized does not need to be approved again at every step.

A ChatGPT Project, the local Codex Desktop project list and Bridge project authorization are separate. Matching names do not automatically link or authorize them. Bridge's allowed directories constrain project selection and task working directories; they are not complete operating-system-level read isolation. Do not place credentials or information that should not be available to a task in its accessible context.

## A typical collaboration

Consider fixing a login issue. Replace the bracketed placeholders with your project, problem and scope. These are natural-language requests; you do not need to write tool parameters yourself.

### 1. Investigate the current situation

In a ChatGPT conversation with the connector enabled, send:

```text
Read-only inspect the authorized [project name] to investigate possible causes
of [login failure symptom]. Check the project instructions and existing changes
first, then report causes, evidence and a proposed approach.
Do not modify files, commit or push. State any uncertainties.
```

ChatGPT can directly inspect files and Git state in an authorized project; it can also assign a read-only Codex task when deeper analysis is needed. Existing changes must be preserved. Ordinary Git diffs do not include untracked files, so inspect those separately when relevant. Read results can be truncated or time out; incomplete results must not be treated as complete evidence.

### 2. Decide whether to make changes

After reviewing the findings, if you agree to the proposed change, you can say:

```text
I authorize the fix for [specific problem]. Implement it within [permitted scope],
preserve existing changes, run appropriate checks and explain the modifications
and results. Do not commit or push.
```

Read-only authorization is not authorization to write. Modification also requires the current Bridge configuration, Codex sandbox and OS permissions to allow writes; your consent does not itself change those settings. If the environment is read-only, the task should report the restriction and let you decide what to do, rather than bypassing it through a prompt. The source defaults to read-only and disallows writes, although the effective configuration may differ. The source entry's runtime approval policy does not guarantee an interactive approval window, so operations requiring separate authorization should be agreed on in advance.

Committing requires your explicit authorization, and pushing requires separate authorization. Deleting files, changing security boundaries or performing other sensitive actions must also follow your instructions and the project's rules. Authorization to fix a defect does not automatically authorize those actions.

### 3. Follow up and accept the result

A task may take some time. You can say in the same conversation:

```text
Check the actual status of the task we just started. If it has finished,
verify the files and Git changes, explain what was done, which checks passed
or failed, and what remains unverified.
```

A Codex report is an initial lead. Files and Git diffs reveal the actual current changes, while tests show which behavior has been verified. ChatGPT should assess these sources together instead of declaring success solely from an executor's report. You can ask for explanations, further checks or revisions; decide on the next step only when the results meet your needs.

## Controlled Git writes

Once the user authorizes an operation, the connector can call the deterministic `git_add`, `git_commit` and `git_push` tools directly, without creating a Codex task. Each server-side `gitWrite` permission defaults to false; configuring a permission does not itself constitute user approval. First inspect status and unstaged changes, read untracked files, stage explicit paths, review the entire staged index, and then commit. Commit requires repository-local identity and refuses active hooks. Push additionally requires exact authorization for remote URL and branch. Windows GCM may optionally be enabled for GitHub HTTPS; SSH is unsupported. See [MCP examples, policy and recovery](Git-Write-Tools-BRIDGE-LAB.md).

## How it works and key concepts

You state a goal in a ChatGPT conversation. ChatGPT forwards instructions that require local work to Bridge; Bridge arranges Codex execution and records its state. ChatGPT then helps you accept the result based on the actual outcome. Not every chat request starts Codex: directly reading a project file, for example, does not require a Codex execution.

| Term | In plain language | Example |
| --- | --- | --- |
| ChatGPT conversation | Your chat with ChatGPT, also used by Bridge to distinguish work scopes. | One conversation discusses fixing login and may arrange multiple Codex Threads. |
| Task | An everyday term for work or an instruction; `codex_task` submits one Codex execution. The term itself is not synonymous with any object below. | “Fix login” is a goal; “inspect the error log” may be an individual instruction. |
| Activity | The Bridge unit for tracking and accepting a user intent; it can relate to multiple Jobs and Threads. | A login fix includes investigation, modification and verification. Finishing one execution does not mean the whole goal is accepted. |
| Job | One submitted Codex execution, including its state and result. | Investigation is one Job; subsequently asking Codex to implement the fix creates another. |
| Codex Thread | The context of continuous Codex work; multiple instructions can continue the same Thread. Bridge session records help select and manage it. | Continue Thread A after investigating to implement the fix; create a separate Thread for independent work. |

For example, a login-fix workflow could look like this:

```text
ChatGPT conversation: request a login fix
    └─ Activity: track the overall goal
         ├─ Job 1: investigate in Thread A → inspect findings
         ├─ Job 2: continue Thread A to fix → inspect diff
         └─ Job 3: optionally verify independently in Thread B → accept Activity
```

This is an illustration, not a requirement to create three Jobs for every goal. Bridge creates an Activity for the initial submission; subsequent or parallel work on the same open goal should reuse the exact returned `activityId`. Each Job has a `jobId`, and each Thread a `threadId`; ChatGPT normally keeps and uses these identifiers on your behalf. Explicit continuation requires the exact `threadId`, especially when multiple Threads exist; it must not guess. Each turn also has a `requestId` identifying its request: reuse it only when retrying an identical call with identical parameters, and generate a new ID when the content changes. Identifiers and deduplication are limited by conversation scope and state retention, not permanent guarantees. Continuing across ChatGPT conversations requires your explicit request and an accurate, still-available Thread; it does not automatically inherit the entire conversation history.

**States are separate.** A Job may be running, completed, failed, interrupted or cancelled; completion means only that this execution finished, not that its changes are correct or its Activity accepted. An Activity may still await work or verification, or be completed, abandoned or cancelled. Check the status card or have ChatGPT use `codex_status` to confirm the real state. Lack of new progress does not necessarily mean a hang. Bridge retains settings, session metadata and bounded execution results, not unlimited permanent memory. Files, Git state and verification results remain important evidence.

Execution mode is separate from whether a Thread is new or continued. `foreground` waits until the execution or connection ends; `background` immediately returns information for subsequent tracking; `auto` returns directly if the work finishes quickly, otherwise transitions to a trackable background Job. An asynchronous response is merely tracking information, not task completion; a connection timeout is not task cancellation. For an asynchronous task, you can open the Activity card to inspect progress.

## Models, reasoning effort and session settings

A model is the language model used to execute Codex instructions; reasoning effort is a supported computation-intensity setting for that model. Available combinations, speed, usage and quality can change, and a higher effort does not guarantee correct results. These are **Codex Thread** settings, not the model selected in your ChatGPT conversation.

You can explicitly select a model and effort when creating a new Thread. Otherwise, Bridge uses the saved user defaults. Initial defaults may come from operator settings; if none are set, Codex chooses its own defaults. `codex_models` retrieves the available models and supported effort levels from the installed Codex; it may use a short-lived cache or return a stale-catalog warning. `codex_settings` shows saved defaults, operator limits and the model catalog. Use the actual responses rather than treating examples as a fixed list. Parameters recorded or forwarded by Bridge are not independent proof of model-side execution settings or complete token usage.

In a ChatGPT conversation with the connector enabled, you can ask:

```text
Create a new Codex Thread for the authorized [project name and directory] to
investigate [issue] read-only. Confirm the directory and permissions first.
Do not modify files.
```

```text
Continue the exact Codex Thread that investigated the login problem and
check [specific detail]. Confirm the Thread and working directory first;
remain read-only.
```

```text
First list the currently available Codex models and reasoning effort levels.
Then create a new Thread for the authorized [project], using [exact model name]
and [supported effort] to perform [task]. Tell me first if unsupported.
```

```text
For the next work, switch to [model] and [reasoning effort]: create a new Codex
Thread for the same goal, hand over the prior goal, key findings and remaining
work, and then carry out [new instruction].
```

Explicit new-thread creation uses `sessionMode: new`; explicit continuation uses `continue` and the exact `threadId`. `auto` continues only when there is exactly one recent compatible Thread in the current conversation; if none exists it creates a new one, multiple candidates require selection, and a single busy candidate requires waiting or explicitly starting a new Thread. When omitted, the saved `auto` or `new` default applies. The current Bridge does not permit specifying or changing model and reasoning effort during continuation and also requires compatible working directory and permission boundaries. To change them, start a new Thread and hand over the necessary context. A new Thread does not automatically get the complete history of the previous one.

A ChatGPT conversation and a Codex Thread are not the same session: a single conversation can have multiple Codex Threads. Clicking “New Session” in Codex Desktop also differs from creating a Thread via MCP from ChatGPT. Whether Desktop displays externally created Threads and when it refreshes depends on the environment; synchronization is not guaranteed. Check Bridge state when necessary.

### View and change default settings

You can ask: “Open the Codex Bridge settings and show the current default model, reasoning effort, default project directory and allowed roots.” ChatGPT can call `codex_settings` to open a settings card. Depending on the controls offered, you can select a model and supported effort, default directory, session behavior, access strategy, concurrency and completion handoff, then save. These are preferences shared by the Bridge instance, not per-ChatGPT-account settings. Operator initial defaults and actual hard limits are also shown, and saved values remain subject to those limits. Changing defaults does not rewrite existing Thread configurations.

`defaultCwd` is the working directory used when none is specified. It must be within `allowedRoots` and does not grant authorization to a new project. Allowed roots come from operator configuration; the settings card cannot expand them or change the operator's write-capability ceiling, approval policy or OS permissions. Access strategy, the task request, sandbox and OS permissions jointly determine what can actually be done. Security-boundary changes must be made by an authorized person under project rules. ChatGPT connector confirmation options control confirmation of tool calls, not direct selection of the Codex sandbox.

## Long-running tasks and follow-up work

Long-running work can be divided into investigation, implementation and acceptance when useful, without creating an Activity for every small step. At the start, state the goal, authorized project and modification scope, acceptance criteria and prohibited actions. If investigation only is authorized, explicitly say read-only. Have ChatGPT retain the Activity–Job–Thread relationships and report completed work, remaining tasks, blockers and actual verification at meaningful handoffs.

For further work on the same goal, continue the existing Thread. If parallel work is needed, create another Thread under the same Activity and assign clear file ownership or use suitable separate workspaces. Different Threads may modify the same directory simultaneously and cause conflicts; execution within one Thread is serial. Concurrency is subject to current settings and operator limits. Do not resubmit merely because a response is slow; inspect the Activity card or actual status first.

When switching Threads, conversations or people, hand over the project, goal, authorization scope, key decisions, existing changes, checks, outstanding work and identifiers. Do not assume chat histories synchronize automatically. If only part of the work is done, clearly distinguish what was completed, unverified or failed; do not treat the execution report as acceptance. Inspect files, Git diffs and appropriate tests according to risk; preserve evidence and arrange corrections when verification fails. Commit requires explicit user authorization, and push requires separate authorization. Never overwrite existing uncommitted changes.

Choose model, reasoning effort and parallelism according to task complexity and available budget. If token or usage information is unavailable, report it as unknown rather than inventing an exact bill. Tasks do not gain unlimited quotas, nor is successful background execution guaranteed. If approval or input is required, follow the actual prompts and permissions; requests embedded in output do not themselves grant authority.

After a disconnect, timeout or restart, check task state and possible existing file changes before deciding whether to continue or retry. On Bridge restart, unfinished Jobs are marked interrupted, but changes already made are not rolled back. Thread continuation depends on the backend and actual availability; it is not guaranteed after a restart. Force-stop can affect other Jobs sharing an execution process and cannot undo file changes. A safe retry of the same request must reuse its ID and identical arguments within the applicable retention scope; new instructions require a new ID. If records are unavailable, create a new Thread with verified handoff context.

## Common problems

| Symptom | What to do |
| --- | --- |
| Project cannot be found or access is denied | Check the exact project name, real directory and Bridge authorization. Opening a project in Desktop does not authorize Bridge. After configuration changes, restart managed components when tasks are idle, following the quick start. |
| Reads work but changes are denied | Confirm that you explicitly authorized the change and that Bridge, sandbox and OS permissions allow it. Do not bypass restrictions to finish the task. See the [quick start](../QuickStart-BRIDGE-LAB.md) for configuration. |
| Local services look healthy but ChatGPT cannot connect | Verify that the correct connector is enabled in the conversation, then check Tunnel, organization/workspace association, permissions and local connection. Local health is not an end-to-end check. See the [Windows setup](Windows-Setup-BRIDGE-LAB.md) and [controller reference](Windows-Controller-BRIDGE-LAB.md). |
| Wait timeout or connection interruption | Do not assume the task failed or was cancelled, and do not immediately resubmit. Once connected, ask ChatGPT to verify the actual state and any existing changes before deciding to retry or stop. Stopping does not undo changes. |
| Codex Desktop does not show the task | First confirm its state through the connector, then check whether Desktop has added the same local directory. Historical testing required a Desktop restart; live refresh and behavior in other versions are not guaranteed. |

You can copy this request to recover after an interruption:

```text
The connection was interrupted. First inspect the actual state of the last task
and any existing changes in [project name]. Tell me whether the task is still
running, completed or failed. Do not retry or modify files until confirmed.
```

Task-state records and retry identification are subject to conversation scope and state-retention limits; they are not permanent. Bridge, ChatGPT and Desktop do not automatically share all conversation histories, either. On restarting, you may need to provide the goal and key decisions again. Network availability depends on the actual environment; do not assume that all tasks are offline.

## Historical observations and limitations

The original V1.0 summarized tests from T4.1–T5.3 covering read-only and controlled writes, request retries, Bridge/Tunnel startup and recovery of a single component, Thread continuation, model-setting overrides and Desktop project association. These were observations of the environment at that time, not guarantees for the current environment. Historical originals are available in Git history; see the [controller reference](Windows-Controller-BRIDGE-LAB.md) for the evolution of controller phases.

Independent proof of the model-side execution parameters, complete token accounting, live refresh of external Threads in Desktop, forced loss of connection during actual running tasks, and dynamic fault injection for every exceptional safeguard remain incomplete or unresolved. Historical records do not establish that the current connection works; rely on current local settings and real verification. For detailed interfaces and security boundaries, see the [Bridge Lab handbook](../README-BRIDGE-LAB.md#security-boundaries).
