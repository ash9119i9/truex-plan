# Sub-agents plan (Codex multi-agent V2)

Design: `tasks/subagents-research/05-design.md`. Research: `tasks/subagents-research/01..04`.
Engine: Codex `multi_agent_v2`, unmodified. Truex work lives in runtime-adapter, platform-next and frontend.

## Phase 0 — Pin probe (runtime-adapter tests only, no prod code)

Goal: replace every inferred fact in the design with an observed one, using the pinned binary.

- [ ] P0.1 Config: `features.multi_agent_v2 = {enabled, max_concurrent_threads_per_session, ...}` is accepted by `thread/start`; the model is offered the `collaboration` tools and nothing else new.
- [ ] P0.2 Spawn: parent `spawn_agent` call creates a child; record `thread/started` (source shape), child `turn/started`, `item/*`, `turn/completed` (with `usage`?), and parent `subAgentActivity` items.
- [ ] P0.3 Child tools: the child request offers no shell/exec/file tools, and no collab tools (depth 1).
- [ ] P0.4 Result path: parent `wait_agent` returns after child completion; the child's answer reaches the parent's next model request.
- [ ] P0.5 Parent turn ends while child runs: what happens to the child (keeps running? events keep flowing?).
- [ ] P0.6 Interrupt: `turn/interrupt` on the parent, then `turn/interrupt` + `thread/archive` on the child; child stops, no further events.
- [ ] P0.7 Child MCP approval: `mcpServer/elicitation/request` from a child carries the child `threadId`/`turnId`.
- [ ] P0.8 Cap: a 4th spawn with max 3 children fails with a model-visible error, not a crash.

Exit: update 05-design.md with observed shapes; pin assertions move into `pin-behavior`-style tests.

## Phase 1 — Adapter: enable and route (runtime-adapter)

- [ ] `contract.ts`: typed `subAgents?: { maxConcurrent: 1..3 }` on StartRunRequest; rejects anything else.
- [ ] `codex/config.ts`: V2 config block when set; unchanged params byte-for-byte when absent (existing tests guard this).
- [ ] `runtime/chat.ts`: `Active.children: Map<threadId, Child>` filled from `thread/started` (source.thread_spawn.parent_thread_id === run.threadId) and `subAgentActivity`.
- [ ] Turn filter (`chat.ts:868`): child-thread events go to `onChildNotification`; everything else unchanged.
- [ ] Emit `agent.started` / `agent.activity` (throttled, bounded) / `agent.completed`; add child usage to run usage.
- [ ] Watchdog: any child event re-arms; a running child counts as in-flight work.
- [ ] Settle: parent `turn/completed` → stop live children (interrupt + archive) → settle. Stop cascades. Grace timeout.
- [ ] Approvals: accept requests whose thread is a known child of this run; tag `agentId`. Child user-input requests are declined.
- [ ] Tests: unit (routing, settle, caps) + codex suite (end-to-end with fixture).

## Phase 2 — Platform (platform-next)

- [ ] Per-agent/tenant setting → `subAgents` in StartRunBody (off by default).
- [ ] `run-executor.ts`: map `agent.*` to LiveEvents; persist one `agent` tool message per child (task, status, result preview, usage).
- [ ] Usage/limits include children. Approval routing keeps `agentId`.
- [ ] Tests: integration (stream → persisted messages), unit (parsers).

## Phase 3 — Frontend

- [ ] `tenant-chat.ts`: parse `agent.*`, reduce into LiveReply; snapshot rehydration.
- [ ] Transcript rows: "Started helper: <task>", "Helper finished/failed/stopped"; expandable result.
- [ ] Agents strip while running: status dot, task, elapsed, preview. Stop = stop the run.
- [ ] Approval cards labelled "from helper <name>".
- [ ] Tests: reducer + rendering.

## Risks to watch
- Upstream V2 behavior drift → pin tests fail first (by design).
- Cost: N children = N concurrent model calls on one gateway profile; cap 3, depth 1.
- Children outliving the run → explicitly stopped at settle (Phase 1).
