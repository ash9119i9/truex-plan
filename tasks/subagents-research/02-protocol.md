# Sub-agents — App-Server Protocol Surface (Track 02)

Scope: what an external JSON-RPC-over-stdio client (Truex's runtime-adapter)
sees from `codex app-server` when sub-agents / multi-agent collaboration run.
Pinned source: `/Users/ashok/truex-plan/vendor/codex/codex-rs` (rev
`1ef30bcbe784f1006548adc1542985be32b05109`). Generated TS mirror:
`/Users/ashok/truex-plan/shared/protocol`.

Legend: **[V]** = verified in code/tests; **[I]** = inferred.

---

## 0. Two multi-agent generations exist — this is the single most important fact [V]

The protocol surfaces **two different mechanisms** gated by different feature
flags, and they emit **different ThreadItems**:

- **Collab (multi-agent v1)** — `Feature::Collab`. Emits
  `collabAgentToolCall` items. Spawned children **can accept direct client
  input** (`sendInput`, `resumeAgent`, direct `turn/start`).
- **Multi-Agent v2** — `Feature::MultiAgentV2`. Emits `subAgentActivity`
  items **instead of** `collabAgentToolCall`. Spawned children **reject all
  direct client input** (owner-mediated only).

Evidence they are mutually exclusive in a turn:
- v1 path asserts `CollabAgentToolCall` items:
  `vendor/codex/codex-rs/app-server/tests/suite/v2/turn_start.rs:4346-4357`
  (test `turn_start_emits_spawn_agent_item_with_model_metadata_v2`, enabled with
  `Feature::Collab` at `turn_start.rs:4302`).
- v2 path asserts the opposite — **no** `CollabAgentToolCall`, only
  `SubAgentActivity`:
  `vendor/codex/codex-rs/app-server/tests/suite/v2/turn_start.rs:4582-4601`
  (test `direct_input_to_multi_agent_v2_subagent_is_rejected`, enabled with
  `Feature::MultiAgentV2` at `turn_start.rs:4538`); the loop explicitly asserts
  `!matches!(&completed.item, ThreadItem::CollabAgentToolCall { .. })` at lines
  4582-4585.

Truex's own `agent-core` handles **both** (it reads `collabAgentToolCall` for
the "fallback activity label" and `subAgentActivity` for lifecycle):
`/Users/ashok/truex-plan/agent-core/test/threads/manager.test.ts:628,520`.

---

## 1. Exact ThreadItem shapes & when each is emitted

Both variants are members of the **stable** `ThreadItem` enum (no
`#[experimental]` attr on either variant — see §7). Rust def:
`vendor/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:373-405`.
Generated TS: `shared/protocol/v2/ThreadItem.ts` (single file, union type).

### 1a. `collabAgentToolCall` (v1 / Collab) [V]
Rust `item.rs:373-393`; TS in `ThreadItem.ts`; schema
`shared/schema/ServerNotification.json:5240`.

Fields (camelCase on the wire):
- `type: "collabAgentToolCall"`
- `id: string` — unique id of the collab tool call (equals the model's
  `function_call` call_id, e.g. `"spawn-call-1"`; `turn_start.rs:4347`).
- `tool: CollabAgentTool` — enum `"spawnAgent" | "sendInput" | "resumeAgent" |
  "wait" | "closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" |
  "listAgents"` (`shared/protocol/v2/CollabAgentTool.ts`).
- `status: CollabAgentToolCallStatus` — `"inProgress" | "completed" | "failed"
  | "interrupted"` (`CollabAgentToolCallStatus.ts`).
- `senderThreadId: string` — thread issuing the collab request (the parent).
- `receiverThreadIds: string[]` — target agents; **for spawn this is the newly
  spawned child thread id** (`item.rs:384-385`; empty on the `inProgress`
  start, populated on `completed` — `turn_start.rs:4351` vs `4376,4388`).
- `prompt: string | null` — prompt/message text sent to the child.
- `model: string | null` — model requested for the spawned child.
- `reasoningEffort: ReasoningEffort | null` — effort requested for the child.
- `agentsStates: { [threadId]: CollabAgentState }` — `CollabAgentState = {
  status: CollabAgentStatus, message: string | null }`; `CollabAgentStatus =
  "pendingInit" | "running" | "interrupted" | "completed" | "errored" |
  "shutdown" | "notFound"` (`CollabAgentState.ts`, `CollabAgentStatus.ts`).

**When emitted:** as a normal turn item on the **parent** thread, via
`item/started` (status `inProgress`) then `item/completed` (terminal status).
Emission path: core `TurnItem::CollabAgentToolCall` → `item.rs:965-983`
(`From` conversion) → `ItemStarted`/`ItemCompleted` server notifications in
`bespoke_event_handling.rs:1083-1120` (ItemStarted) and `1127+`
(ItemCompleted). The deprecated raw `CollabAgent*Begin/End` events are **not**
surfaced to v2 clients (`bespoke_event_handling.rs:979-994`). No per-call delta
stream for the collab item itself.

### 1b. `subAgentActivity` (v2) [V]
Rust `item.rs:397-405`; TS in `ThreadItem.ts`.

Fields:
- `type: "subAgentActivity"`
- `model: string | null` — resolved model at sub-agent **creation** (absent on
  other kinds / older records).
- `reasoningEffort: ReasoningEffort | null` — resolved effort at creation.
- `id: string` — equals the spawning call id (`turn_start.rs:4588` matches
  `id == SPAWN_CALL_ID`).
- `kind: SubAgentActivityKind` — `"started" | "interacted" | "interrupted" |
  "completed"` (`SubAgentActivityKind.ts`).
- `agentThreadId: string` — the child thread id.
- `agentPath: string` — the child's agent path (e.g. `/root/researcher`).

**When emitted:** `item/started`/`item/completed` on the **parent** thread. The
`started` kind carries the child thread id (test reads it from
`item/completed` with `kind: Started`: `turn_start.rs:4582-4601`). Interrupted
activity triggers a side-effect that drops the watch on a now-missing child:
`bespoke_event_handling.rs:1370-1378`.

---

## 2. Child-thread notifications on the SAME connection, source, and routing

### 2a. Children DO stream their own notifications on the same connection [V]
This is the key integration fact and is **verified by Truex's own adapter
tests**, which feed the exact app-server notification shapes:
`agent-core/test/threads/manager.test.ts:516-560`. On the single connection,
after a spawn the client receives, all tagged with the **child** `threadId`:
- `turn/started` `{ threadId: "child_1", turn: { id } }` (`:532`)
- `item/agentMessage/delta` `{ threadId: "child_1", itemId, delta }` (`:537`)
- `item/started` / `item/completed` with child items (e.g. `mcpToolCall`,
  `agentMessage`) `{ threadId: "child_1", item }` (`:541,547`)
- `turn/completed` `{ threadId: "child_1", turn: { status } }` (`:553`)
- `thread/started` for grandchildren (`:734`, see §2c).

So children are **auto-subscribed to the spawning connection** — the client
does not call `thread/subscribe` for them. (Confirmed behaviorally; the Codex
Rust spawn tests observe child progress via the mock model server +
analytics, not via item notifications — `turn_start.rs:4420-4470` — but
Truex's adapter tests assert the notifications arrive, and
`thread/started` fan-out to the parent's connection is the mechanism.)

### 2b. Token usage [V]
Children emit their own `thread/tokenUsage/updated` /
`TurnCompleted.turn.usage` on the child `threadId` via the same event pipeline
(`bespoke_event_handling.rs:1027` `handle_token_count_event`;
`TurnCompleted` at `:1340-1351`). Per-connection delivery is by thread
subscription (§2d).

### 2c. `Thread.source` for a child (`thread_spawn`) [V]
`SessionSource = ... | { subAgent: SubAgentSource } | ...`
(`shared/protocol/v2/SessionSource.ts`). `SubAgentSource` (top-level
`shared/protocol/SubAgentSource.ts`):
```
"review" | "compact"
| { thread_spawn: { parent_thread_id: ThreadId, depth: number,
                    agent_path: AgentPath | null, agent_nickname: string | null,
                    agent_role: string | null } }
| "memory_consolidation" | { other: string }
```
Note the **snake_case** inner object (`thread_spawn`, `parent_thread_id`,
`agent_path`, …) — it is a `codex_protocol` core type, not re-cased to
camelCase. Confirmed by Truex's adapter test consuming exactly that shape:
`manager.test.ts:734-752` (`source: { subagent: { thread_spawn: {
parent_thread_id, depth, agent_path, agent_nickname, agent_role } } }`), which
yields `depth`, `nickname`, `role`, `path` on the nested agent (`:757-761`).

The `Thread` object also exposes top-level mirrors (`shared/protocol/v2/Thread.ts`):
`parentThreadId: string | null`, `sessionId` (shared across the session tree),
`agentNickname: string | null`, `agentRole: string | null`,
`canAcceptDirectInput: boolean | null`, `source: SessionSource`.

`ThreadSourceKind` (filter enum, `shared/protocol/v2/ThreadSourceKind.ts`):
`"cli" | "vscode" | "exec" | "appServer" | "subAgent" | "subAgentReview" |
"subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "unknown"`.

### 2d. Code that decides which connections receive a child's events [V]
Per-thread fan-out, not global broadcast. A thread's outgoing sender is built
from the set of connections subscribed to **that** thread id:
- `ThreadScopedOutgoingMessageSender { connection_ids: Vec<ConnectionId> }` and
  `send_server_notification` → `send_server_notification_to_connections(
  self.connection_ids, …)`:
  `vendor/codex/codex-rs/app-server/src/outgoing_message.rs:143-213`.
- The connection list comes from
  `ThreadStateManager::subscribed_connection_ids(thread_id)`:
  `thread_state.rs:436-441`; subscriptions are a
  `HashSet<ConnectionId>` per thread (`thread_state.rs:322`,
  subscribe at `:601-646`, unsubscribe `:557-583`).
- The sender is constructed per thread at
  `request_processors/thread_lifecycle.rs:358-365,669-672` and
  `extensions.rs:140-189`.
- Source-kind filtering for `thread/list` lives in `app-server/src/filters.rs`
  (`compute_source_filters`, `source_kind_matches`) — note default `thread/list`
  returns only `INTERACTIVE_SESSION_SOURCES`, so sub-agents are hidden unless
  explicitly requested (`filters.rs:6-83`).

**[I]** Spawn auto-subscribes the parent's connection(s) to the child thread
(so §2a holds). The exact subscribe-on-spawn call site was not pinned in this
track, but the behavior is confirmed by Truex's adapter tests and the
per-thread fan-out model above. Treat "auto-subscribed on spawn, same
connection" as the contract to design against.

---

## 3. Client-callable methods relevant to sub-agents

### 3a. Discover children — `thread/list` [V]
`ThreadListParams` (`shared/protocol/v2/ThreadListParams.ts`) has:
- `sourceKinds?: ThreadSourceKind[]` — filter to `["subAgentThreadSpawn"]`,
  etc.
- `parentThreadId?: string` — direct children only.
- `ancestorThreadId?: string` — descendants at any depth (mutually exclusive
  with `parentThreadId`).
Verified usage: `turn_start.rs:4610-4620` lists the spawned child with
`sourceKinds: [SubAgentThreadSpawn]` + `parentThreadId: <parent>` and checks
`source` is `SubAgent(ThreadSpawn { agent_path: Some(_), .. })`,
`can_accept_direct_input == Some(false)` (`:4625-4636`).

### 3b. Inspect a child — `thread/read` [V]
Always allowed (read-only). Error text explicitly recommends it for v2
children: "cannot resume an unloaded multi-agent v2 sub-agent through its
parent; resume the parent first, or **use thread/read to inspect it**"
(`request_processors/thread_processor.rs:4011-4013`).

### 3c. Interrupt a child — `turn/interrupt` [V]
A client can interrupt a child by its own thread id. Truex calls
`turn/interrupt { threadId: "child_1", turnId: "child_turn" }` and then
`thread/archive { threadId: "child_1" }` so the parent's `wait` ends
(`manager.test.ts:691-703`). Interrupting the root also interrupts running
helpers (`manager.test.ts:708-712`: interrupts observed order
`["child_1","thread_1","child_1"]`).

### 3d. Resume a child — `thread/resume` [V, with a v2 caveat]
- **v1 / collab children:** resumable with caller config (`can_accept_direct_input`
  true).
- **v2 ThreadSpawn children:** resuming through the parent is redirected —
  the server `ensure_multi_agent_v2_child_loaded` and attaches with only the
  caller's history-paging prefs, ignoring caller config; if the child is
  unloaded and the parent isn't resumed first it returns `invalid_request`
  ("...resume the parent first, or use thread/read to inspect it"):
  `thread_processor.rs:3989-4020`.

### 3e. Can a client send input to a child directly? [V]
- **v1 / collab:** YES — children accept `turn/start`, `turn/steer`,
  `thread/inject_items` (`can_accept_direct_input` returns true for non-v2).
- **v2 ThreadSpawn:** NO. `can_accept_direct_input` returns false
  (`request_processors/thread_input.rs:12-21`) and every direct mutation is
  rejected with `INVALID_REQUEST_ERROR_CODE` + message
  `"direct app-server input is not allowed for multi-agent v2 sub-agents"`.
  Verified rejections for: `thread/inject_items`
  (`turn_start.rs:4655-4657`), `turn/start` (`:4675-4677`), `turn/steer`
  (`:4696-4699`), `thread/approveGuardianDeniedAction` (`:4720-4722`),
  `thread/settings/update` (`:4735+`). Enforcement also in
  `thread_queue_processor.rs:301` and `thread_goal_processor.rs:373`.
- There is **no dedicated `agent/*` RPC**. All sub-agent control is driven by
  the model's own collab/multi-agent tools inside the parent turn; the client
  only observes items + child notifications and can interrupt/archive/read/list.

---

## 4. Server requests originating from a child

Server→client requests (approvals, input) from a child carry the **child's**
`threadId` in their params. Observed by Truex adapter tests
(`manager.test.ts:650-688`):
- `item/tool/requestUserInput` `{ threadId: "child_1", turnId, itemId,
  questions, autoResolutionMs }`
- `item/commandExecution/requestApproval` `{ threadId: "child_1", turnId,
  itemId }`
Each is a JSON-RPC **request** (has an `id`) the client must answer.

How a client should answer (Truex's chosen policy, verified):
- Truex **declines** child-originated requests so they never reach the human
  user queue: for `requestUserInput` it auto-answers with text mentioning the
  "main agent" (`manager.test.ts:682`; validated against the response schema at
  `:683`); for approvals it replies `{ decision: "decline" }` (`:684`); an
  unidentified helper gets `{ answers: {} }` (`:685`). Root (`thread_1`)
  requests still queue for the user (`:686-688`). This is a Truex design
  choice, not a protocol requirement — the protocol only requires a
  schema-valid response on the same `id`. (Response types: see
  `ToolRequestUserInputResponse.ts`, `CommandExecutionRequestApprovalResponse.ts`.)

For Truex specifically (no shell/file tools for the model, HTTP-MCP only), the
child-originated requests you must be able to answer are primarily
`item/tool/requestUserInput` and MCP elicitation
(`mcp/server/elicitationRequest`); shell/file approval requests should not
arise but must still be declined defensively.

Dynamic tool calls: `item/started` with a `DynamicToolCall` item triggers a
server `DynamicToolCall` request (`bespoke_event_handling.rs:1096-1118`); it
carries `threadId` of the issuing (possibly child) thread.

---

## 5. Codex TUI pointers (covered by another stage) [I, pointers only]
Not analyzed in depth here. The TUI's rendering of surfaced tool activity and
reasoning is downstream of these same `item/started|completed` notifications;
`SubAgentActivityKind`/`CollabAgentState` enums are the display vocabulary.
Hand to the TUI track: start from `bespoke_event_handling.rs` item mapping and
the `ThreadItem` union in `item.rs`.

---

## 6. Concrete JSON notification sequence (client's view)

Based directly on Truex's adapter test fixtures
(`manager.test.ts:860-911`, the `collab`/`child` helpers) — this is the
**collab/v1** shape (parent `collabAgentToolCall` + child notifications on the
same connection). Marked [V] where lifted from tests, [I] where field values
are illustrative.

```jsonc
// parent turn already running on thread_1 (turn_1)

// 1. parent model calls spawn_agent -> item/started (inProgress) [V shape]
{ "method": "item/started", "params": { "threadId": "thread_1", "turnId": "turn_1",
  "item": { "type": "collabAgentToolCall", "id": "call_spawnAgent",
    "tool": "spawnAgent", "status": "inProgress",
    "senderThreadId": "thread_1", "receiverThreadIds": [],
    "prompt": "Summarise the pricing page", "model": null,
    "reasoningEffort": null, "agentsStates": {} } } }

// 2. spawn completes -> child id now known [V]
{ "method": "item/completed", "params": { "threadId": "thread_1", "turnId": "turn_1",
  "item": { "type": "collabAgentToolCall", "id": "call_spawnAgent",
    "tool": "spawnAgent", "status": "completed",
    "senderThreadId": "thread_1", "receiverThreadIds": ["child_1"],
    "prompt": "Summarise the pricing page", "model": null, "reasoningEffort": null,
    "agentsStates": { "child_1": { "status": "pendingInit", "message": null } } } } }

// 2b. (v2 variant instead of 1-2) subAgentActivity started [V shape, §1b]
// { "method": "item/completed", "params": { "threadId": "thread_1",
//   "item": { "type": "subAgentActivity", "id": "call_spawnAgent",
//     "kind": "started", "agentThreadId": "child_1",
//     "agentPath": "/root/researcher", "model": "gpt-5.5",
//     "reasoningEffort": "low" } } }

// 2c. grandchildren announce via thread/started with a spawn source [V, §2c]
// { "method": "thread/started", "params": { "thread": { "id": "grandchild",
//   "source": { "subAgent": { "thread_spawn": { "parent_thread_id": "child_1",
//     "depth": 2, "agent_path": "/root/researcher/checker",
//     "agent_nickname": "Checker", "agent_role": "reviewer" } } } } } }

// 3. CHILD runs on the SAME connection, tagged threadId=child_1 [V]
{ "method": "turn/started", "params": { "threadId": "child_1", "turn": { "id": "ct1" } } }
{ "method": "item/agentMessage/delta",
  "params": { "threadId": "child_1", "itemId": "cm1", "delta": "Plans start" } }

// 4. parent model calls wait -> item (inProgress) [V]
{ "method": "item/started", "params": { "threadId": "thread_1", "turnId": "turn_1",
  "item": { "type": "collabAgentToolCall", "id": "call_wait", "tool": "wait",
    "status": "inProgress", "senderThreadId": "thread_1",
    "receiverThreadIds": ["child_1"], "prompt": null, "model": null,
    "reasoningEffort": null,
    "agentsStates": { "child_1": { "status": "running", "message": null } } } } }

// 5. child finishes [V]
{ "method": "item/completed", "params": { "threadId": "child_1",
  "item": { "type": "agentMessage", "id": "cm1", "text": "Plans start at $10" } } }
{ "method": "turn/completed",
  "params": { "threadId": "child_1", "turn": { "id": "ct1", "status": "completed" } } }

// 6. wait completes with the child's final message [V]
{ "method": "item/completed", "params": { "threadId": "thread_1", "turnId": "turn_1",
  "item": { "type": "collabAgentToolCall", "id": "call_wait", "tool": "wait",
    "status": "completed", "senderThreadId": "thread_1",
    "receiverThreadIds": ["child_1"], "prompt": null, "model": null,
    "reasoningEffort": null,
    "agentsStates": { "child_1": { "status": "completed",
      "message": "Plans start at $10" } } } } }

// 7. parent closes the agent [V]
{ "method": "item/completed", "params": { "threadId": "thread_1", "turnId": "turn_1",
  "item": { "type": "collabAgentToolCall", "id": "call_closeAgent",
    "tool": "closeAgent", "status": "completed", "senderThreadId": "thread_1",
    "receiverThreadIds": ["child_1"], "prompt": null, "model": null,
    "reasoningEffort": null,
    "agentsStates": { "child_1": { "status": "shutdown", "message": null } } } } }

// 8. parent turn completes as normal [V]
{ "method": "turn/completed",
  "params": { "threadId": "thread_1", "turn": { "id": "turn_1", "status": "completed" } } }
```
Ordering caveat [V]: child output can arrive **before** its spawn
`item/completed` (Truex buffers/replays until the child is identified —
`manager.test.ts:800-857`). Design the adapter to tolerate out-of-order child
events keyed by `agentThreadId`.

---

## 7. Experimental-API gating [V]

Mechanism: `InitializeCapabilities.experimentalApi: boolean`
(`shared/protocol/InitializeCapabilities.ts`). Fields/methods marked
`#[experimental("reason")]` via `codex_experimental_api_macros::ExperimentalApi`
(`app-server-protocol/src/experimental_api.rs`). Using a gated field/method
without the capability returns an error whose message is
`"<reason> requires experimentalApi capability"`
(`experimental_api.rs:30-32`; test
`tests/suite/v2/experimental_api.rs:30-67`).

For sub-agents specifically: **neither** `ThreadItem::CollabAgentToolCall`
**nor** `ThreadItem::SubAgentActivity` carries an `#[experimental]` attribute
(`item.rs:373-405`) — they are **stable** and delivered without the
`experimentalApi` flag. The `#[experimental]`-gated surfaces are elsewhere
(e.g. `thread/items/read`, `mock/experimentalMethod`,
`plan` item content noted "EXPERIMENTAL" at `item.rs:274`). So Truex does
**not** need `experimentalApi: true` to receive collab/subagent items, but
confirm against your live Codex build and set it if you adopt any gated field
(e.g. `thread/items/read`).

Separate from capabilities: the sub-agent machinery itself is **feature-gated
server-side** (`Feature::Collab` / `Feature::MultiAgentV2`,
`Feature::Goals`) in config, and the model only emits collab/multi-agent tool
calls when those features + the corresponding tool namespaces
(`collaboration`, `multi_agent_v1`, `multi_agent_v2`) are enabled
(`turn_start.rs:4247-4253,4302,4538`). These are config/model concerns, not
client init capabilities.

---

## 8. Implications for Truex (runtime-adapter → platform-next → frontend)

1. Truex already has a working model in `agent-core` — mine it heavily; it is
   the reference for the exact wire shapes and the decline-child-requests
   policy.
2. Prefer **MultiAgent v2** semantics for a business assistant: children can't
   be driven directly by the client, so there is no risk of the tenant UI
   accidentally injecting into a helper. `subAgentActivity` + child
   `item/*` on the same connection is enough to render a "helper working"
   panel.
3. Children stream on the **same stdio connection**, keyed by child `threadId`;
   route by `parentThreadId`/`ancestorThreadId` (from `thread/started`'s
   `SubAgentSource.thread_spawn` or `thread/list`) to attribute helper events
   to the root tenant chat.
4. Child-originated server requests must be answered on their `id`; Truex's
   "decline / main-agent" policy keeps the human out of helper approvals — keep
   that. For HTTP-MCP-only Truex, expect `item/tool/requestUserInput` and MCP
   elicitation from children; decline/auto-answer defensively.
5. Lifecycle control the client can exert: `turn/interrupt` + `thread/archive`
   on a child; `thread/read` to inspect; `thread/list` (with `sourceKinds` /
   `parentThreadId` / `ancestorThreadId`) to enumerate. No `agent/*` RPCs.
6. Do not create first-class MongoDB session docs for helper threads — Truex's
   adapter deliberately keeps them out of its thread registry
   (`manager.test.ts:559 manager.threads.has("child_1") === false`); model them
   as sub-objects of the root conversation.
```
