# Sub-agents implementation plan

Truex already enables the Codex sub-agent engine. This plan makes spawned helper
agents visible, controllable, and correctly scoped in the Truex layers.
`vendor/codex` is not modified; everything is built around its behavior.

## Current state

- `agent-core/src/business-runtime.ts` sets `features.multi_agent: true` and the
  instructions tell the model to use helper agents. Codex can call `spawnAgent`,
  `sendInput`, `resumeAgent`, `wait`, and `closeAgent`.
- `platform/src/public.ts` reduces `collabAgentToolCall` and `subAgentActivity`
  items to generic labels ("Helper agent is working"). Agent identity, task,
  status, and result are dropped.
- `agent-core/src/manager.ts` routes each notification by `threadId`. A spawned
  child has its own thread ID, so its events likely land in an orphan thread
  record that no session or UI observes (not yet confirmed at runtime).
- Server requests from a child (for example `item/tool/requestUserInput`) are
  attributed to the child thread and would wait there until they expire.

## Open questions to confirm first

Log raw runtime notifications during one spawn and confirm:

1. Does the app server emit `thread/started` for spawned children with
   `thread.source.thread_spawn` populated (`parent_thread_id`, `depth`,
   `agent_path`, `agent_nickname`, `agent_role`)?
2. Do child threads raise their own server requests, or does Codex funnel them
   through the parent?
3. Which backend is active: V1 (`features.multi_agent`) or V2
   (`features.multi_agent_v2`, which takes precedence and ignores `max_depth`)?

## Phase 1: Link child threads to parents (agent-core)

1. On `thread/started`, read `thread.source`. For `thread_spawn`, record
   `childId -> parentId` and store the spawn metadata on the child `Thread`.
2. Also populate the mapping from `subAgentActivity.agentThreadId` and collab
   tool call receiver IDs, in case the child's `thread/started` is late or absent.
3. In `notification()`, resolve child events to the root session and emit them
   on the root stream as `subagent.event` with
   `{ agentThreadId, agentPath, nickname, role, depth }`. Do not create a
   standalone session for a child.
4. Child server requests: either forward clarification requests to the parent's
   pending queue tagged with the agent, or auto-decline with a message that the
   main agent handles clarifications (matches current instructions). Reject or
   proxy child document tool calls to the parent workspace. Pick one and test it.
5. Cascade parent interrupt, fork, resume, and delete to children. Check
   `vendor/codex/codex-rs/core/tests/suite/multi_agent_resume.rs` for resume
   semantics.

## Phase 2: Runtime configuration (`business-runtime.ts`)

Add to the enforced `config` block (keys exist in `config.schema.json`):

| Key | Purpose |
| --- | --- |
| `agents.max_concurrent_threads_per_session` | Cap open helpers, e.g. 3 |
| `agents.max_depth` | 1 or 2, prevents unbounded nesting (V1 only) |
| `agents.default_subagent_model` | Optional cheaper model for helpers |
| `agents.default_subagent_reasoning_effort` | Optional lower effort for helpers |
| `features.multi_agent_mode` | `explicitRequestOnly` or `proactive` |

Pin the backend explicitly (`multi_agent` vs `multi_agent_v2`). Children must
inherit the restricted profile: read-only sandbox, no shell, no hooks. Add a test
proving a spawned child gets no tools beyond that profile.

## Phase 3: Public contract (`shared/contracts.ts`, `platform/src/public.ts`)

1. Add a `SubAgent` type:
   `{ threadId, path, nickname, role, depth, status: CollabAgentStatus, task?, lastMessage?, startedAt, endedAt? }`.
2. Replace generic labels with structured events:
   - `subagent.spawned`, `subagent.status`, `subagent.completed`, built from
     `collabAgentToolCall` (tool, status, receiver states) and
     `subAgentActivity` (`started`, `interacted`, `interrupted`).
   - Child message and reasoning deltas, passed through the existing redactor
     and filtered like the parent. Never expose raw tool arguments.
3. Keep the existing `activity.updated` label as a fallback for older clients.
4. Add `subAgents: SubAgent[]` to the session snapshot so reconnect and
   `resync.required` rebuild state.

## Phase 4: Platform API (`platform/src/service.ts`, `platform/src/index.ts`)

- `GET /sessions/:id/agents`: list sub-agents for the session.
- `GET /sessions/:id/agents/:agentId`: read-only sub-agent transcript.
- `POST /sessions/:id/agents/:agentId/interrupt`: stop one helper
  (`turn/interrupt` on the child thread).

All routes go through the existing session owner and policy checks. There is
still no user authentication, so these stay behind the internal deployment
boundary.

## Phase 5: Frontend

- `components/session-activity.tsx`: add an "Agents" panel beside
  activity/goal/plan/timings. One card per helper with nickname or role, status
  badge, task, elapsed time, stop button, and an expandable read-only transcript.
- `components/chat-messages.tsx`: render collab tool calls inline as compact rows
  ("Spawned Researcher", "Waiting on 2 helpers").
- `lib/slash-commands.ts`: optional `/agents` command to open the panel.
- Settings: delegation mode toggle (explicit only vs proactive) and max helpers.

## Phase 6: Tests

- `agent-core/test/manager.test.ts`: parent/child mapping, child event
  forwarding to the root stream, child request routing or declining, cascading
  interrupts.
- `platform/test/public.test.ts`: collab item to `subagent.*` mapping and
  redaction.
- Pinned-runtime fixture: simulated provider response that calls
  `spawn_agent`, `wait`, then `close_agent`.
- `frontend/test`: agents panel reducer and snapshot rehydration.

## Order and risk

Phase 1 comes first. Everything depends on child events reaching the right
session, and it is where current behavior is most likely broken. Phases 2 and 3
are small. Phases 4 and 5 hold most of the UI work.
