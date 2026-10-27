# 05 — Sub-agents design: Codex multi-agent V2, surfaced by Truex

Decision (2026-10-26): Codex's native **multi_agent_v2** is the engine. Truex does not add its own
delegation tools or orchestrator. The runtime-adapter and platform-next make what Codex does
visible, bounded, billable and controllable. `vendor/codex` is not modified.

Inputs: 01-core-engine, 02-protocol, 03-tui, 04-truex.

## What Codex gives us (used as is)

- Tools for the parent model: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
  `list_agents`, `interrupt_agent`, `close_agent`. Async spawn, mailbox, wait with clamped timeout.
- Concurrency cap (`max_concurrent_threads_per_session`, root counts as 1), slot reserved before
  creation, transactional cleanup, shared rollout budget, cascade close.
- Children inherit the live turn's model, provider, sandbox, approval policy and cwd. Roles only narrow.
- Children stream on the **same app-server connection**, tagged with their own `threadId`.
  No `thread/started` is emitted for a child (observed, see below). The parent gets
  `subAgentActivity` items (started / completed) carrying `agentThreadId` and `agentPath`.
- V2 children reject direct client input (`turn/start`, `steer`, inject). `turn/interrupt` and
  `thread/archive` on a child are allowed (02 §3c).

## Observed on the pin (Phase 0, 2026-10-26)

Source: `runtime-adapter/test/codex/subagents-probe.test.ts` (7 tests, fixture model and MCP
fixture). These replace the inferred facts above wherever they differ.

| # | Fact | Consequence |
|---|---|---|
| O1 | V2 runs with our provider setup. The lead is offered `collaboration.{spawn_agent, wait_agent, send_message, followup_task, list_agents, interrupt_agent}`. No `close_agent`. | Go. |
| O2 | A depth-1 helper gets **no collaboration tools** (no nesting) and **the lead's MCP tools**. No shell, file or image tools. | Depth is safe on the fixture model; re-check on each real model. |
| O3 | Helper prompt = lead base prompt, then `subagent_developer_instructions`, then Codex's own multi-agent blocks, then the task as an `agent_message`. With `fork_turns: "none"` the member's text does not reach it. | Helper rules must override the persona and the Follow Up block. |
| O4 | The task and the answer travel as `agent_message` input items. The task payload sits in `encrypted_content`, but as plain text. | **model-gateway dropped these items in all three adapters**, so in production the helper got no task and the lead got no answer. Fixed: sent as user text (`model-gateway/src/agent-message.ts`). |
| O5 | No `thread/started` for a child. The only child→lead link is the lead's `subAgentActivity.agentThreadId`. | Registry is built from `subAgentActivity` "started". Child events that arrive first must be buffered or attributed by path. |
| O6 | Child `item/*`, `turn/*`, `thread/tokenUsage/updated` and `mcpServer/startupStatus/updated` carry the child's `threadId`/`turnId`. | Today's turn filter drops helper usage (unbilled). Child connector status is shown as the lead's. |
| O7 | Spawning past `max_concurrent_threads_per_session` returns a tool error to the model. | Cap is safe. |
| O8 | A **completed helper frees its slot**. One reply spawned 3 helpers one after another with a cap of 1. | Cap bounds concurrency only. The adapter must enforce a total per run. |
| O9 | A helper keeps running after the lead's turn completes. Its "completed" `subAgentActivity` arrives on the lead **after** `turn/completed`, tagged with the finished turn id. Its answer does **not** reach the next reply. | No leak, but the work is billed and lost. Helpers must be stopped at settle. |
| O10 | `turn/interrupt` on the lead does **not** stop helpers. `turn/interrupt` on the child does (status `interrupted`); after `thread/archive` no more child items arrive. | Stop and settle must interrupt and archive each child explicitly, using the child's turn id. |
| O11 | A helper's write tool raises `mcpServer/elicitation/request` with the **child's** `threadId`/`turnId`. Unanswered, the write never runs. | "Helpers never write" is enforceable in the adapter by thread id. |
| O12 | `fork_turns: "none"` sends prompt + rules + task only (~5 KB). `"all"` resends the whole chat (a 20 KB earlier message made it ~25 KB). | Lead hint must ask for `"none"` with a self-contained task; measure compliance on real models. |
| O13 | `features.rollout_budget {enabled, limit_tokens, reminder_at_remaining_tokens}` is shared by lead and helpers. The model sees a `<rollout_budget>` block. When spent, **every** turn in the tree fails with `codexErrorInfo: "sessionBudgetExceeded"`. Marked under development upstream. | Usable as a hard per-run token ceiling. The adapter must map the failure to a clear run error, and pin tests guard the unstable feature. |

Not yet observed: a real gateway model end to end (does it follow helper rules, drop the Follow
Up block, choose `fork_turns: "none"`), coding chats, process restart with open helpers.

## What Truex adds (adapter + platform + frontend)

| Concern | Truex responsibility |
|---|---|
| Enablement | Typed per-chat setting → adapter config. Never raw config passthrough. Off by default. |
| Routing | Recognize child threads and route their events to the parent run instead of dropping them. |
| Lifecycle | Run settles only after the parent turn ends **and** children are settled. Stop cascades. |
| Watchdog | Child activity counts as run activity; a silent child times out on its own. |
| Approvals | Child MCP approvals surface to the member, labelled with the agent. Child questions are declined. |
| Usage | Child token usage is added to the run's usage (billing and limits). |
| Contract | New `agent.*` run events, persisted as one `agent` message per child. |
| UI | Inline rows, an agents strip with status, preview and stop, plus labelled approval cards. |

## Enablement and config (adapter `codex/config.ts`)

Per-chat typed field `subAgents?: { maxConcurrent: 1..3 }` on `StartRunRequest`. When present, the
adapter adds to the session config:

```text
features.multi_agent_v2.enabled = true
features.multi_agent_v2.max_concurrent_threads_per_session = maxConcurrent + 1   # root counts
features.multi_agent_v2.hide_spawn_agent_metadata = true   # no model/role switching: one gateway provider
features.multi_agent_v2.default_wait_timeout_ms = 30000
features.multi_agent_v2.max_wait_timeout_ms = < silenceMs  # the lead is silent while it waits
features.multi_agent_v2.subagent_developer_instructions = <Truex child instructions>
features.multi_agent_v2.root_agent_usage_hint_text = <when to delegate>
```

`enabled`, `max_concurrent_threads_per_session` and `subagent_developer_instructions` are verified
on the pin. `agents.max_depth` is dropped: V2 ignores it, and O2 shows helpers get no
collaboration tools anyway. When `subAgents` is absent, `features.multi_agent` stays `false`, as
today.

Why `hide_spawn_agent_metadata`: the adapter configures exactly one gateway provider with one
token (04 §4), so any `model` override from the model would fail. Specialist roles come later.

## Lifecycle rules

```text
parent turn running ──spawn──▶ child A, child B (same process, own threadIds)
parent wait_agent ──▶ child results arrive in the parent mailbox ──▶ parent answers
parent turn/completed:
   no live children        → settle run as today
   live children remain     → interrupt + archive them (cascade), mark them "stopped", then settle
member stop                 → interrupt the parent turn and every live child; settle when all report back
                              or after a short grace period
```

Children must not outlive the run. The run is the unit of billing, idle-sweep safety
(`activeRun` gates the sweep) and audit. O9 confirms a child that finishes after the parent turn
ends never wakes the parent and its answer is lost, so stopping it is the honest outcome. O10
confirms the cascade is the adapter's job: interrupting the parent leaves children running.

## Event contract (adapter → platform → browser)

```text
agent.started   {agentId, path, nickname, role, task}            // thread/started child or subAgentActivity started
agent.activity  {agentId, preview}                               // bounded: last message/tool label, ≤240 chars
agent.completed {agentId, status: completed|failed|stopped, result?, usage?}  // result truncated (e.g. 4k chars)
approval.*      gains optional {agentId}
usage           includes children
```

The child's raw stream is never forwarded verbatim. Previews and results pass through the existing
redaction and size caps.

## Security

- The setting is typed and validated in `contract.ts`. Agent or member text cannot turn it on.
- Children inherit the TEXT_ONLY profile and the chat's connector snapshot. Phase 0 includes a test
  proving a child gets no shell/exec/file tools and no connector beyond the parent's.
- Child approvals reuse the parent's `allowed`/`critical` sets, so a child cannot widen them.
- Same gateway token for all children (04 §4). This is not a new cross-tenant surface.
- Cost: hard cap of 3 children, depth 1, and the run limits apply to the whole tree.
