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
  `thread/started` carries `source.subAgent.thread_spawn {parent_thread_id, depth, agent_path,
  agent_nickname, agent_role}`. The parent gets `subAgentActivity` items (started / interacted /
  interrupted / completed).
- V2 children reject direct client input (`turn/start`, `steer`, inject). `turn/interrupt` and
  `thread/archive` on a child are allowed (02 §3c).

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
features.multi_agent_v2.max_wait_timeout_ms = 300000      # bounded below run limits
features.multi_agent_v2.subagent_developer_instructions = <Truex child instructions>
features.multi_agent_v2.root_agent_usage_hint_text = <when to delegate>
agents.max_depth = 1                                       # defensive; V2 gates child tools by model
```

Exact key spelling and override shape are verified in Phase 0. When `subAgents` is absent,
`features.multi_agent` stays `false`, as today.

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
(`activeRun` gates the sweep) and audit. Codex delivers a child's completion with
`trigger_turn=false`, so a child that finishes after the parent turn ends would never wake the
parent. Stopping it is the honest outcome.

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
