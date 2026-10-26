# Truex current state — sub-agents readiness (both stacks)

Scope: Truex's own code. Codex-internal sub-agent mechanics are covered by the
other tracks. "Verified" = read in code at the cited file:line. "Infer" =
reasoned from the code, not asserted by a comment/test.

Headline: **The NEW stack (runtime-adapter + platform-next + frontend tenant)
has zero sub-agent code.** Sub-agents are explicitly disabled
(`"features.multi_agent": false`, `runtime-adapter/src/codex/config.ts:20`) and
the whole event/run/persistence pipeline is built on the assumption of **one
Codex thread per chat and one turn per run**. The OLD stack (agent-core +
platform/src + frontend/lib/subagents.ts) *did* build a full helper-agent
feature on the Codex V1 multi-agent engine; it is reference only (`tasks/chat-v1-plan.md`
excludes helpers from v1).

---

## 0. Old stack (reference only — what was built & learned)

- **Engine on:** `agent-core/src/runtime/policy.ts:runtimeConfiguration` set
  `"features.multi_agent": true`, `"features.multi_agent_v2": false`,
  `"agents.max_depth": 1`,
  `"agents.max_concurrent_threads_per_session": helpers.maxConcurrent`
  (`policy.ts` ~ the `Object.assign(config,…)` block). Helpers inherited the
  same restricted profile (read-only sandbox, no shell/hooks) — comment at
  `policy.ts` "Helpers inherit this profile".
- **Delegation options:** `SubAgentOptions {mode: "explicitRequestOnly"|"proactive",
  maxConcurrent 1..5 (default 3)}`, `policy.ts:82-95` (`subAgentOptions`). The
  system prompt text swapped `proactiveHelpers`/`explicitHelpers`
  (`policy.ts:77-81`). Prompt tells the model to "delegate independent steps"
  and that "Only you, not helper agents, ask for plan approval"
  (`policy.ts:10`, `:14`).
- **Helper thread handling:** `BusinessRuntime` kept a `helpers: Set<string>`
  of child thread IDs (`agent-core/src/runtime/business-runtime.ts:60`). Helper
  threads had **no workspace**; only `turn/interrupt`, `thread/archive`,
  `thread/read(includeTurns:false)` were allowed through for them
  (`business-runtime.ts:218-235`). `turn/completed` for a non-helper thread
  cleared temp (`business-runtime.ts:68-76`). Helper settings persisted in the
  thread record (`helperSettings`, `:208`).
- **Public redaction:** `platform/src/runtime/subagents.ts` validated
  `subAgents` options; `platform/src/public.ts` (per the plan) reduced
  `collabAgentToolCall`/`subAgentActivity` to generic labels.
- **Frontend reducer:** `frontend/lib/subagents.ts` is a complete helper-agent
  UI model — `SubAgentState {agents, previews, skewMs}`, `upsertAgent` (finished
  never reverts to running), `applySubAgentEvent` handling
  `subagent.spawned|status|completed|event` (with `message.delta/final`,
  `turn.started`), `helperName`, `taskTitle`, `previewTail`, per-helper timers,
  and `DelegationPrefs` in localStorage.
- **Plan & lessons:** `docs/SUBAGENTS_PLAN.md` is the blueprint. Key learned
  risks it flags (all directly relevant to the new design):
  1. child threads have **their own thread IDs**, so a `threadId`-keyed router
     orphans them ("Current state" bullet 3);
  2. child **server requests** (e.g. request_user_input) are attributed to the
     child thread and hang there (bullet 4);
  3. must confirm V1 vs V2 backend (`multi_agent_v2` ignores `max_depth`);
  4. cascade interrupt/fork/resume/delete to children;
  5. children must inherit the restricted profile and be proven to get no extra
     tools.
  The old router keyed by `threadId` (SUBAGENTS_PLAN "routes each notification
  by threadId") — the new adapter keys by **turnId** instead (see §2), a
  different but analogous hazard.

---

## 1. End-to-end flow of one chat turn (NEW stack) — verified

Request → platform-next → runtime-adapter → codex app-server → back.

1. **Browser → platform-next.** `frontend/lib/tenant-chat.ts` `startChat` /
   `sendMessage` POST `/api/v1/chats[/:id/messages]`. A POST to a busy chat is
   a **steer** or a new run (`messageReceiptOf`, `tenant-chat.ts`).
2. **platform-next build.** `chats.service.ts` resolves agent+model, builds the
   `StartRunBody`: `agentPrompt` from `chat-prompt.ts chatPrompt(...)`
   (`chats.service.ts:1610`), `model` incl. a **gateway token**
   `signGatewayToken(modelId, secret, tenantId)` (`gateway-token.ts`,
   `chats.service.ts:103`), and `mcp` specs resolved from connectors
   (`chats.service.ts:306/398/630`, `resolveConnectors` ~`:1247-1296`). Persists
   user message + `RunDoc(status:"accepted")`, reserves `chat.activeRun`
   (lease), then hands to `RunExecutor.begin(dispatch)`.
3. **RunExecutor reader.** `run-executor.ts` `execute`→`read`→`startRun`
   streams the adapter's SSE; one reader per run regardless of browser
   subscribers. `handle()` maps adapter events to `LiveEvent`s and fans out to
   browser subscribers; `finish()` persists the settled run/messages.
4. **runtime-adapter admission.** `server.ts` POST `/v1/runs` → `parseStartRun`
   (`contract.ts`) → `manager.startRun`. **One active run per chat**
   (`manager.ts:` `CHAT_BUSY` if `chat.activeRun`), idempotent on `runId`
   (`RUN_CONFLICT`), bounded Codex processes (§2).
5. **ChatRuntime executes the turn.** `chat.ts execute()`: `prepareThread`
   (thread/start or thread/resume, recorded once in `chat.json`), then
   `turn/start` → `{turn:{id}}` → `run.turnId = turnId`
   (`chat.ts:416-417`), emits `run.accepted`.
6. **Codex notifications → dict events.** `onNotification` (`chat.ts:849`)
   translates `session/update`-style notifications into the Run's event
   contract: `text.delta`, `item.completed`, `tool.started/completed`,
   `command.*`, `file_change.*`, `approval.*`, `connector.status`,
   `skill.used`, `network.blocked`, `usage`, `run.completed`. Stored in a
   bounded numbered buffer (`run.ts emit`, `bufferEvents` default 500).
7. **Stream contract → platform.** `server.ts stream()` writes SSE
   `id/event/data`. Reconnect via `?after=<seq>` with a `run.snapshot` fallback
   (`run.ts subscribe`).
8. **Persistence (Mongo).** `chat.ts` collections (`chat.ts CHAT_INDEXES` etc.):
   `chats` (`ChatDoc`: `runtime.threadId`, `activeRun`, `connectors`, snapshots),
   `messages` (`MessageDoc`: role user/assistant/tool; tool messages carry
   `tool`/`activity`/`skill`/`network`; unique `(runId, runtimeItemId)`),
   `runs` (`RunDoc`: status, `threadId`, `turnId`, `usage`, `steers`),
   `tool_approvals`, `chat_files`, `chat_uploads`. `RunExecutor.finish`
   → `store.settleWithRetry`.
9. **SSE → frontend rendering.** `tenant-chat.ts applyStreamEvent` reduces the
   `LiveReply { items: LiveReplyItem[] … }`; a `snapshot` replaces everything
   (reconnect-safe). Rendering is `frontend/components/tenant/*`
   (chat-transcript.tsx, tenant-chat.tsx).

### Which items are kept/dropped; the thread-id filter (critical)

- **Event turn filter is keyed by `run.turnId`, NOT threadId.**
  `chat.ts:856-868`: `eventTurn = n.params.turnId ?? n.params.turn?.id`; before
  acceptance such events are buffered in `active.early`
  (`chat.ts:859-866`); after acceptance **`if (eventTurn && eventTurn !== run.turnId) return;`**
  (`chat.ts:868`). **Verified.** A Codex sub-agent runs on a *child thread* with
  its own *child turn id*; its `item/*`, `turn/completed`, etc. would carry
  `turnId !== run.turnId` and be **silently dropped** here. (Infer: depends on
  Codex V2 emitting child events with a distinct turnId — the other tracks must
  confirm the exact child-event shape; but the filter as written drops anything
  whose turn id is not the parent's.)
- **Notifications with no turn id are special-cased:**
  `mcpServer/startupStatus/updated` is surfaced regardless
  (`chat.ts:852-855`). (Infer: a child-thread `thread/started`-style
  notification likely carries no `turnId` and would be ignored by the `switch`
  default.)
- **Codex's own MCP-resource helper tools are dropped** by name
  (`CODEX_RESOURCE_TOOLS`, `chat.ts` + `onToolItem`), counted as activity only.

---

## 2. Everything that must change to support sub-agents (NEW stack), file:line

**Config flag (adapter).**
- `runtime-adapter/src/codex/config.ts:20` `"features.multi_agent": false` in
  the frozen `TEXT_ONLY` block — must become `true` (and pin the backend; the
  old stack pinned V1 with `multi_agent_v2:false` + `max_depth:1`,
  `agent-core/.../policy.ts`). Nothing platform-sent is merged into config
  (`config.ts:3-6` comment), so this is the *only* place it can turn on.
- There is **no** adapter config for agent spawn caps
  (`agents.max_concurrent_threads_per_session`, `agents.max_depth`,
  `agents.default_subagent_model`); all would be new keys in `sessionSettings`
  (`config.ts:` `sessionSettings`). `contract.ts parseStartRun` rejects unknown
  body fields (`contract.ts object()`), so a per-chat delegation option needs a
  new validated field there and a new `StartRunRequest` member
  (`contract.ts:StartRunRequest`).

**Event filtering keyed by turnId.**
- `chat.ts:868` `if (eventTurn && eventTurn !== run.turnId) return;` — the
  single biggest change. Child-thread/turn events are dropped. Needs a
  parent↔child turn/thread map on `Active` and a rule that routes child events
  onto the parent run as a distinct event type (the old plan's
  `subagent.event`, `docs/SUBAGENTS_PLAN.md` Phase 1).
- `chat.ts:856-866` early-buffering also assumes one turn.

**Run/turn completion detection (child vs parent).**
- `chat.ts:962-972` `turn/completed` → `onTurnCompleted` → `finish(...)`.
  Verified: it does **not** check the thread/turn id against the parent before
  finishing. If a **child** `turn/completed` were (incorrectly) let past the
  §2 filter, it could settle the parent run early. Current filter (`:868`)
  would drop a child `turn/completed` whose turnId differs — so today a child
  completing is invisible, and a parent whose children are still running could
  `finish` as soon as *its own* turn reports completed. Both are wrong for
  sub-agents; completion must become "parent turn completed AND no child turns
  in flight". (Infer on child turnId shape; the gating logic is verified.)

**Interrupt/stop.**
- `chat.ts interrupt()` (`:453`) + `sendInterrupt` (`:1005`) call
  `turn/interrupt {threadId: run.threadId, turnId: run.turnId}` — **parent
  thread only**. Must cascade to child threads (old stack special-cased
  `turn/interrupt`/`thread/archive` for helpers,
  `business-runtime.ts:218-235`).

**Steer.**
- `chat.ts sendSteer` (`:519-547`) steers `run.turnId` on `run.threadId`. A
  steer while children run has undefined semantics (does it reach children? do
  their turns continue?). Needs a decision + likely child cancellation.

**Idle-stop while children run (`RUNTIME_IDLE_MS`).**
- `config.ts:94` `idleMs` default 600_000; `manager.ts:166-171` sweep closes a
  chat's process when `activeRun` is falsy and idle. Verified: idle is gated on
  `chat.activeRun`, so while the **parent run** is active the process is never
  idle-swept — children are safe *as long as they live inside the parent run's
  lifetime*. Risk (infer): if children outlive the parent `turn/completed`
  (because completion is mis-detected, §2) the run finishes, `activeRun`
  clears, and the sweep could kill the process with children still running.

**`RUNTIME_MAX_PROCESSES`.**
- `config.ts:93` default 20; `manager.ts:194-205 reserveSlot` caps **processes
  per chat** (one process per chat). Sub-agents run as **threads inside one
  Codex process** (old stack: `max_concurrent_threads_per_session`), so
  max-processes is unaffected, BUT the real resource cap (concurrent child
  model calls → gateway load, memory) is unbounded by the adapter today. Needs
  a per-session child cap (new config, see above). `RUNTIME_BUSY`
  (`manager.ts:201`) victimises idle processes — unchanged.

**Timeouts / watchdog.**
- `chat.ts rearmWatchdog` (`:1290-1309`) picks the silence interval from
  in-flight **MCP tool** and **command** counts
  (`run.inFlightToolCount`, `inFlightCommandCount`, `run.ts`). A child agent
  "thinking" emits **no** parent-visible events once child events are filtered
  (`:868`), so the parent run would hit `silenceMs` (120s, `config.ts
  DEFAULT_LIMITS`) and fail with `MODEL_TIMEOUT` while children work. Watchdog
  must treat in-flight children like in-flight tools.

**Persistence schema.**
- No child-agent concept anywhere in `chat.ts` (`MessageDoc`, `RunDoc`,
  `MessageTool`/`MessageActivity`/`MessageSkill`/`MessageNetwork`). A saved
  sub-agent would need a new tool-message variant (old stack dropped them to
  labels, `docs/SUBAGENTS_PLAN.md` Phase 3) or a new collection. `RunItem`
  union in `runtime-adapter/src/runtime/run.ts` (`:36-54`) and the platform
  `SettleItem`/`LiveEvent` unions (`run-executor.ts:` `LiveEvent`,
  `chat-store.ts SettleItem`) would all gain a `subagent` member.

**Public event contract.**
- `run.ts emit` event types (text.delta/item.completed/tool.*/…); `run-executor.ts`
  `LiveEvent` union; `tenant-chat.ts StreamEvent`/`LiveReplyItem`/`applyStreamEvent`
  — all closed unions with validated parsers (`tenant-chat.ts parseItems`,
  `approvalOf`, `activityOf` in `run-executor.ts`). Each needs a new
  `subagent.*` event + parser (old stack had `SubAgentSource.ts`,
  `shared/protocol/`).

**Frontend reducer & transcript.**
- New stack: `tenant-chat.ts` `LiveReply.items: LiveReplyItem[]` and
  `applyStreamEvent` must gain subagent items (the old `frontend/lib/subagents.ts`
  reducer is the proven template but targets the old `DomainEvent` shape).
- `frontend/components/tenant/chat-transcript.tsx` / `tenant-chat.tsx` render
  the `LiveReplyItem` list — would need helper cards (old stack:
  `components/session-activity.tsx`, `helper-chip.tsx`, `helper-group.tsx`).

---

## 3. Agent catalog — how agents are modeled (verified)

- **Stores (per tenant DB):** `agents` (`AgentDoc`,
  `platform-next/src/modules/agents/agent.ts:AGENTS_COLLECTION`). Built-ins in
  the **shared catalog DB** `builtin_agents` (`builtin-agent.ts:BUILTIN_AGENTS_COLLECTION`).
- **Scoping:** `AgentScope = "personal" | "tenant"` (`agent.ts:AGENT_SCOPES`);
  `AgentSource = "builtin" | "personal" | "tenant"` (`agents.service.ts:43`).
  Visibility: `visibleTo(userId)` = `{scope:"tenant"} OR {scope:"personal",
  ownerId:userId}` (`agents.service.ts:123-130`). Every read/write is bound to
  the caller's tenant DB and `ownerId` (`agents.service.ts:132-133`). Chats stay
  owner-only even for a shared agent (`tasks/chat-v1-plan.md` "Confirmed product
  decisions").
- **Fields (`AgentDoc`, `agent.ts`):** `scope, ownerId, name, description,
  modelId (ObjectId), look, tint, connectors?: AgentConnector[]
  (connectorId+slug+access, max 3 = MAX_AGENT_CONNECTORS,
  `agent.ts:MAX_AGENT_CONNECTORS`), skillIds?, status, revision,
  clientRequestId`. Built-ins add product-written `instructions`
  (`builtin-agent.ts:BuiltinAgentSpec`). Model is named by slug there, resolved
  to `modelId`.
- **Is there any agent-team / @handle / agent-calling-agent?**
  **No, verified.** `grep` across `platform-next/src` for
  sub-agent/multi-agent/helper/@handle/mention/collab returns **nothing**
  except the `chat-prompt.ts` "Don't mention Kiro…" lines (false positives).
  An `AgentDoc` cannot reference other agents as helpers — no field for it. The
  prompt actively tells the model it has no other agents: v1 "You have no
  tools… you cannot…" (`chat-prompt.ts BASE_INSTRUCTIONS.v1`).
- **README '@generalagent' / 'helper-agent collaboration' claim:** **Not found
  in `platform-next/README.md`.** The only new-stack reference is
  `runtime-adapter/README.md:133` stating sub-agents are **disabled**. The
  "@generalagent handles / helper-agent collaboration" language belongs to the
  OLD product (old `README.md` / `agent-team-list-v2-spec.md` /
  `development-spec.md`), not the new tenant stack. (So the brief's premise that
  the README "mentions" these is true only of legacy docs.)

---

## 4. Model-gateway constraints (verified)

- **Token scope:** `signGatewayToken(modelId/profileId, secret, tenantId)`
  produces `{p: profileId, t: tenantId}` HMAC
  (`platform-next/src/modules/chats/gateway-token.ts`; shared impl
  `shared/gateway-token.ts`). The gateway verifies `p` matches the request path
  profile and `t` is **usage-log only, grants nothing — "models are shared
  across tenants"** (`shared/gateway-token.ts` comment,
  `verifyGatewayToken`). **The token is NOT scoped per-chat or per-thread** —
  it is per model profile. Tokens **don't expire** (comment: "Codex keeps a
  thread's provider config for the thread's life").
- **Would concurrent child threads each get a valid token?** Yes (infer): all
  children in one chat run under the one `model.gatewayToken` the adapter put in
  `model_providers.truex_gateway.experimental_bearer_token`
  (`runtime-adapter/src/codex/config.ts sessionSettings`), held in memory only.
  If children use the **same model** as the parent, the existing single token
  works for all of them — **no per-chat token issue**. If a design wants
  children on a **cheaper model** (`agents.default_subagent_model`,
  SUBAGENTS_PLAN Phase 2), that is a *different* profile and would need a
  **second** gateway token minted for that profile and passed in config — the
  adapter currently builds exactly one provider entry
  (`config.ts sessionSettings` — single `model_providers.${PROVIDER}`), so
  multi-model helpers are not expressible today.
- **Providers:** gateway translates to chat/anthropic/gemini
  (`model-gateway/src/adapters/{chat,anthropic,gemini}.ts`); profiles resolved
  from `truex_models` with Secrets-Manager keys and SWR caching
  (`model-gateway/src/profiles.ts`). Nothing here is per-request-count limited,
  so N concurrent children = N concurrent provider calls on one tenant's shared
  model — a cost/throughput concern, not a token-identity one.

---

## 5. Security / tenant-isolation considerations specific to sub-agents

- **No raw config passthrough (good):** `config.ts:3-6` — "nothing [the
  platform] sends is merged in as raw configuration, so agent text can never
  turn a capability back on." Enabling multi-agent must stay a *typed* flag,
  not a passthrough, or agent/member text could spawn agents.
- **Workspace isolation:** one chat = one home/workspace keyed by
  `t/<tenant>/c/<chat>` (`chat.ts ChatRuntime` ctor). Old stack gave helpers
  **no workspace** (`business-runtime.ts:60`) — the new design should do the
  same so a child can't read/write the chat workspace unexpectedly. Business
  posture is **no shell/file tools for the model** (`config.ts TEXT_ONLY`:
  shell_tool/unified_exec/view_image/goals all false) — children must inherit
  this restricted profile (old plan Phase 2; SUBAGENTS_PLAN "children must
  inherit the restricted profile", and it recommends a test proving a spawned
  child gets no extra tools).
- **Child server requests / approvals:** `chat.ts onApprovalRequest`
  (`:1250-1300`) declines anything whose `params.threadId !== run.threadId ||
  params.turnId !== run.turnId` ("other_turn", `:1270` equivalent) — so a
  **child MCP approval would be auto-declined** today (child never runs write
  tools). For sub-agents to use MCP connectors, approval matching must accept
  child thread/turn ids and attribute the card to the child. This is exactly the
  old plan's unresolved "child server requests hang / are mis-attributed"
  hazard (SUBAGENTS_PLAN bullet 4).
- **MCP credentials per child:** MCP specs (incl. header token values) are
  per-chat (`contract.ts McpServerSpec`, fingerprinted in
  `chat.ts threadFingerprint`). A child inheriting the session gets the same
  connector credentials — acceptable within one chat (same owner), but a child
  must not be able to widen `enabledTools`/`approvedTools` beyond the chat's
  snapshot (`chat.ts` builds `allowed`/`critical` from the parent request).
- **Gateway token reuse (see §4):** same token for all children is fine for
  tenant isolation (token already carries `t` for logs and grants nothing
  cross-tenant). No new cross-tenant surface is introduced by reuse.
- **Prompt provenance:** agent name/description are member-written and quoted as
  data (`chat-prompt.ts` "quoted as data … can never reach runtime
  configuration"). A helper's role/task, if surfaced, must be treated the same
  (old `frontend/lib/subagents.ts` renders previews as markdown through the
  redactor).

---

## Bottom line for the design

The new stack is a clean, single-turn pipeline whose **turnId event filter
(`chat.ts:868`), turn-completion gating (`onTurnCompleted`), parent-only
interrupt/steer, watchdog, and closed event/persistence unions** all assume no
child threads. Turning on `features.multi_agent` alone would make every child
event invisible (dropped at `:868`), likely strand the parent on the silence
watchdog, and give the member no UI. The OLD stack
(`agent-core/.../business-runtime.ts`, `policy.ts`, `platform/src/runtime/subagents.ts`,
`frontend/lib/subagents.ts`, `docs/SUBAGENTS_PLAN.md`) is a working reference
for the required pieces (child→parent event routing, delegation options, helper
UI, restricted child profile), and its documented open hazards
(child thread IDs, child server-request mis-attribution, V1-vs-V2 backend,
cascade control) map almost one-to-one onto the new stack's gaps.
