# 01 — Codex core sub-agent engine

Source: `vendor/codex/codex-rs/core/src` (agent/, tools/handlers/multi_agents*, thread_spawn.rs, session_prefix.rs), `protocol/src/protocol.rs`.

## Mental model

A sub-agent in Codex is **just another thread** (same `Session` machinery as the root), started by a tool call from a parent turn. Nothing is special about the child's loop; everything special lives in a per-session controller (`LocalAgentControl`) shared by the whole agent tree.

```text
parent turn ──spawn_agent(tool)──▶ thread_spawn::spawn
                                     ├─ validate message non-empty
                                     ├─ prepare_agent_spawn_config (inherit + role + model override)
                                     ├─ agent path = parent_path / task_name
                                     └─ agent_control.spawn(SpawnRequest)
                                          ├─ registry.reserve_spawn_slot(max_threads)  → AgentLimitReached
                                          ├─ PendingSpawn guard (RAII: drop ⇒ shutdown + discard + close edge)
                                          ├─ create thread, persist spawn edge (agent-graph-store)
                                          └─ deliver initial message (TriggerTurn) → child runs async
child finishes turn ──▶ notify_parent_of_terminal_turn
                          └─ InterAgentCommunication(kind=Result, trigger_turn=false) → parent mailbox
parent ──wait_agent──▶ blocks on mailbox activity | steered user input | timeout
```

Spawn returns immediately (`{task_name, nickname}`). "Accepted" does not mean "completed".

## Two protocol generations

| | V1 (legacy, namespace tool) | V2 (current) |
|---|---|---|
| Addressing | `agent_id` (thread id) | `task_name` → hierarchical `AgentPath` (`root/research/api`) |
| Tools | spawn_agent, send_input, resume_agent, wait_agent, close_agent | spawn_agent, send_message, followup_task, wait_agent, list_agents, interrupt_agent (+ close) |
| Context | `fork_context: bool` | `fork_turns: "all" \| "none"` (default **all**) |
| wait result | final statuses keyed by id (+content) | summary only ("Wait completed."); content arrives as mailbox messages |
| Concurrency | `agent_max_threads` default **6** | `max_concurrent_threads_per_session` default **4** (incl. root ⇒ 3 children) |

V2 is the design to copy. V1 shows why: returning content from `wait` and id-based addressing did not scale to trees.

## Tools (V2) and semantics

- `spawn_agent(task_name, message, agent_type?, fork_turns?, model?, reasoning_effort?)` — required: task_name, message. Unknown fields rejected (`deny_unknown_fields`). Empty message rejected.
- `send_message(target, message)` — deliver into mailbox, **does not** trigger a turn.
- `followup_task(target, message)` — deliver and trigger a turn if idle; if running, delivered at the next message boundary / after the pending tool call. Non-root targets only.
- `wait_agent(timeout_ms?)` — waits for **any** mailbox update. Ends early on steered user input. Timeout clamped: min 10s, default 30s, max 1h (> max is an error, < min is clamped and the clamp is reported to the model).
- `list_agents(path_prefix?)` — live agents in the root tree with last known status.
- `interrupt_agent(target)` — stop current turn, agent stays alive for more messages.
- `close_agent(target)` — shut down agent **and open descendants**; returns previous status. Completed agents keep counting against the concurrency limit until closed.

Status enum (protocol): `PendingInit | Running | Interrupted | Completed(Option<String>) | Errored(String) | Shutdown | NotFound`. Only Completed/Errored/Shutdown/NotFound produce a parent notification.

## Limits and safety rails

- **Depth**: `agent_max_depth` default **1** (children cannot spawn grandchildren). `depth > max_depth` ⇒ refuse. Depth carried in `SessionSource::SubAgent(ThreadSpawn{depth,..})`.
- **Concurrency**: atomic counter in `AgentRegistry`, reserved *before* creating the thread, released on close/shutdown. Root is not counted.
- **Model overrides**: at most 5 distinct models (`MAX_SPAWN_AGENT_MODEL_OVERRIDES`); validated against catalog.
- **Rollout budget**: token usage shared across the tree; exceeding ⇒ `SessionBudgetExceeded`; budget reminders injected and acked only after they land in history.
- **Spawn is transactional**: `PendingSpawn` Drop guard tears down a half-created child (shutdown, discard persistence, mark edge Closed) if the spawn future is cancelled or fails. Edge Open write must finish before Closed write.
- **Prompt-level gate**: the spawn tool description tells the model *not* to spawn unless the user/AGENTS.md explicitly asks; "be thorough" is not permission. Plus critical-path guidance (do the blocking step locally, delegate sidecars).
- **Errors to the child's parent** are truncated by tokens and carry a "next action" hint; a Guardian "too many denials" gets its own message.

## Child config inheritance (child_config.rs)

Start from parent's effective config, then force from the **live turn**: model + provider, reasoning effort/summary, developer instructions (or `subagent_developer_instructions`), approval policy, approvals reviewer, sandbox, cwd. Then layer role overrides, then explicit model/effort override. Rationale in code: cloning stale config sends the child out with the wrong provider or sandbox.

Rules:
- Roles may **reduce** capability, never exceed the parent's authority.
- Full-history fork + `agent_type` override is rejected (fork inherits parent role).
- Context window / auto-compact limits reset for children.

## Roles

Built-ins: `default`, `explorer` (read-oriented, "fast and authoritative", spawn many in parallel, reuse), `worker` (execution; parent must assign file ownership and tell workers they are not alone in the codebase). `awaiter` exists but is commented out. Users can add roles via config (TOML layer, optional locked model/effort shown in the tool description). Nicknames come from candidate lists with "X the 2nd" suffix on reuse.

## Messaging / mailbox

- Per-thread mailbox: `Vec<StoredMail>` + `watch::Sender<bool>` "has mail" flag. `take()` drains atomically. Closed on runtime shutdown (enqueue then errors).
- Mail survives session eviction (residency): mail is transferred before the residency guard is released.
- Parent learns results by **mail**, not by return value. Completion message = rendered `InterAgentCompletionMessage{task_name, sender, payload}`; delivery is best-effort with a `result_delivery{queued|failed}` metric.

## Observability

Every collab tool emits `TurnItem::CollabAgentToolCall` start/complete items (sender, receivers, status, model, effort) — this is what the UI renders. Plus `SubAgentActivity{Started|Completed}`, counters `codex.multi_agent.spawn{role,version}`, `wait.duration_ms{mailbox|steered|timed_out}`, `result_delivery`, rollout-trace reducers per agent.

## Lessons for Truex

1. Child = ordinary run with a parent pointer; do not build a second agent loop.
2. Async spawn + mailbox + wait, not a blocking "call subagent and return its answer". (Blocking is a degenerate case: spawn + wait.)
3. Reserve concurrency slot before creating anything; RAII/transactional cleanup on failure or cancel.
4. Hard defaults: depth 1, small concurrency (3–6), wait timeout clamps, shared token budget.
5. Inherit permissions from the live turn; roles can only narrow.
6. Hierarchical paths for addressing; close cascades to descendants.
7. Emit structured start/complete events for every orchestration action; UI is a projection of those events.
