# Goal mode tasks

Plan: [goal-mode-plan.md](goal-mode-plan.md). Idea: [docs/ideas/goal-mode.md](../docs/ideas/goal-mode.md).
Tasks are sequential unless noted. Only Task 19 calls a paid provider.

**Scope of this change: runtime-adapter and platform-next only.** The frontend is being
redesigned, so Phase 3 (Tasks 13–17) and Checkpoint C are deferred until that is done.
Task 12 still builds the browser-facing API in platform-next; Task 18 depends on
Checkpoint B instead of Checkpoint C.

Commands run inside each package: `npm test`, `npm run typecheck`, `npm run format:check`
(frontend: `npm test`, `npm run typecheck`, `npm run build`). Root `npm test` is not
evidence for this work.

## Phase 1: runtime-adapter

## Task 1: Goal behaviour on the pin (probe)

**Description:** A pin test, like `subagents-probe.test.ts`, that turns goals on for a test
thread with the fixture model and records what the pinned Codex actually does. Every later
adapter task builds on its answers, so it goes first. No product code.

**Acceptance criteria:**
- [x] Records where `features.goals` and `max_goal_token_budget` must be set (process
      `-c` arguments, thread config, or both) for `thread/goal/set` to succeed and the
      model to be offered the goal tools.
- [x] Records the event sequence for: `set {status: active}` on an idle thread (does a
      `turn/started` follow with no client request), a model `update_goal complete`, a
      budget running out, `set {paused}` then `turn/interrupt` during a goal turn, and a
      model `create_goal` during a member's turn.
- [x] Records what `turn/start` returns when sent just as Codex starts a goal turn (its
      own turn, or the goal turn's ID as a steer) and whether `turn/started` arrives
      before that answer.
- [x] Records whether `thread/resume` of a thread whose goal is `active` continues by
      itself, and whether `set` on an unloaded thread works for `paused` and `active`.

**Verification:**
- [x] `runtime-adapter`: `npm test`, `npm run typecheck`, `npm run format:check`
- [x] Findings summarised in the test file's header comment and copied to the plan's
      Risks table

**Dependencies:** None

**Files likely touched:**
- `runtime-adapter/test/codex/goals-probe.test.ts` (new)
- `runtime-adapter/test/support/model-fixture.ts` (goal tool calls, if needed)

**Estimated scope:** Medium

## Task 2: Goal contract on both sides

**Description:** Define the platform ↔ adapter seam: `goals?: {maxTokenBudget}` on the
run request; `PUT|GET|DELETE /v1/chats/:chatId/goal`; `GET /v1/chats/:chatId/events`
(`goal.updated`, `goal.cleared`, `run.started {runId, turnId, trigger: "goal"}`, snapshot
on overflow); `goal.updated` on run streams; the deterministic goal run ID. Adapter
validation and README, platform `RuntimeClient` methods and parsers. Handlers may return
`501` until Task 3.

**Acceptance criteria:**
- [x] The adapter rejects unknown fields, an objective over 4000 characters, a budget
      that is not a positive integer or exceeds `maxTokenBudget`, and an `active` set
      without run context.
- [x] `RuntimeClient` sends each request and parses each event against a fake adapter;
      malformed events are dropped, not thrown.
- [x] `goalRunId(threadId, turnId)` has a fixed test vector and matches
      `^[0-9a-f]{24}$`.

**Verification:**
- [x] `runtime-adapter`: `npm test`, `npm run typecheck`, `npm run format:check`
- [x] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 1

**Files likely touched:**
- `runtime-adapter/src/contract.ts`
- `runtime-adapter/README.md`
- `runtime-adapter/test/unit/unit.test.ts`
- `platform-next/src/modules/chats/runtime-client.ts`
- `platform-next/test/unit/goal-client.test.ts` (new)

**Estimated scope:** Medium

## Task 3: Per-chat goal config and the goal endpoint

**Description:** When a request carries `goals`, build the Codex config with goals on and
`max_goal_token_budget` set (where Task 1 says). Implement the goal endpoint: load the
thread with the given context when the result is `active` (start it when `threadId` is
null), send `thread/goal/set` with `origin: "user"`, `clear` and `get`. Record the goal ID
the adapter set in `chat.json`.

**Acceptance criteria:**
- [x] A chat without `goals` offers exactly the same tools as today (existing tool-list
      pin tests unchanged); a chat with it is also offered `get_goal`, `create_goal`,
      `update_goal`.
- [x] `PUT` with an objective and budget on an idle chat returns the goal and Codex starts
      a turn; `PUT {status: paused}`, `GET` and `DELETE` work on an unloaded thread.
- [x] A budget above the chat's maximum is refused by the adapter before Codex is called.

**Verification:**
- [x] `runtime-adapter`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 2

**Files likely touched:**
- `runtime-adapter/src/codex/config.ts`
- `runtime-adapter/src/runtime/chat.ts`
- `runtime-adapter/src/runtime/manager.ts`
- `runtime-adapter/src/server.ts`
- `runtime-adapter/test/codex/goals.test.ts` (new)

**Estimated scope:** Medium

## Task 4: Codex-started goal turns become runs; chat event stream

**Description:** A chat-level listener in `ChatRuntime`: a `turn/started` for the lead
thread with no active run creates a `Run` with the goal run ID and the chat's last
context, publishes `run.started` on the chat stream, and runs it through the existing
handlers. `thread/goal/updated|cleared` go to the chat stream and to the active run's
stream. Admission treats a goal run as the chat's active run.

**Acceptance criteria:**
- [x] A goal of three continuation turns yields three runs, each with its own `run.accepted`
      … `run.completed`, reconnectable by `GET /v1/runs/:runId/events`, and three
      `run.started` on the chat stream.
- [x] `POST /v1/runs` during a goal turn is `CHAT_BUSY`; steer, stop and approvals work
      on the goal run. A `turn/start` answered with a goal turn's ID is reported as a steer
      into that run, never a second run (the race from Task 1). *Built as: that turn is
      the member's run and gets no `run.started`; Task 1 showed a steer cannot be told
      apart, and either way the turn has exactly one run.*
- [x] The chat stream replays after a cursor, sends one snapshot when the cursor is older
      than the buffer, and never carries another chat's events.

**Verification:**
- [x] `runtime-adapter`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 3

**Files likely touched:**
- `runtime-adapter/src/runtime/chat.ts`
- `runtime-adapter/src/runtime/run.ts`
- `runtime-adapter/src/runtime/manager.ts`
- `runtime-adapter/src/server.ts`
- `runtime-adapter/test/codex/goals.test.ts`

**Estimated scope:** Large (the riskiest task; split the chat stream out if it grows)

## Task 5: Stop pauses the goal; model-created goals are paused

**Description:** Stopping any run while the chat's goal is active sends
`set {status: paused}` and then the interrupt. A `thread/goal/updated` for a goal ID the
adapter did not set is paused at once and reported with `origin: "model"`.

**Acceptance criteria:**
- [x] After Stop during a goal turn, the goal is `paused` and no further `turn/started`
      arrives within 5 s; a repeated Stop sends nothing more.
- [x] A model `create_goal` during a member's run is paused before that run completes,
      and no continuation turn starts (measured, not assumed). *Measured with the
      fixture model, which answers in milliseconds: 12 of 12 repeated runs.*
- [x] After a restart of the chat's Codex process, a goal set through the endpoint is
      still recognised as the adapter's own. *Built as: Codex goals have no ID, so
      `chat.json` keeps the goal's `createdAt` and objective; tested across an adapter
      restart. An active set through the endpoint also makes a goal the adapter's, so
      a proposed goal the member starts (Task 10) is not paused again.*

**Verification:**
- [x] `runtime-adapter`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 4

**Files likely touched:**
- `runtime-adapter/src/runtime/chat.ts`
- `runtime-adapter/src/runtime/manager.ts`
- `runtime-adapter/test/codex/goals.test.ts`

**Estimated scope:** Small

## Checkpoint A: adapter
- [x] `runtime-adapter`: test, typecheck, build, format pass
- [x] Existing pin tests (lifecycle, steer, plan, subagents, failures) pass unchanged
- [x] Review the adapter contract and Task 1 findings with the human before Phase 2

## Phase 2: platform-next

## Task 6: Tenant goal settings and the chat snapshot

**Description:** Add `TenantDoc.goals {presets: [n, n, n], maxTokenBudget, maxActive}`, an
operator command to set or remove it, and its validation (three ascending presets, each
below the maximum). New chats snapshot `goals: {maxTokenBudget}` and every run sends it.
The current-tenant API exposes the presets, the maximum and whether goals are on.

**Acceptance criteria:**
- [x] The operator command refuses unordered, duplicate, non-integer or out-of-range
      values and writes an audit event.
- [x] A chat created after settings exist sends `goals` on its runs; an older chat, or a
      tenant without settings, sends nothing and behaves as today.
- [x] Changing settings does not change existing chats' snapshot.

**Verification:**
- [x] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Checkpoint A

**Files likely touched:**
- `platform-next/src/modules/tenants/tenant.ts`
- `platform-next/src/modules/operator/operator.service.ts`
- `platform-next/src/cli/operator.ts`
- `platform-next/src/modules/chats/chat.ts`
- `platform-next/src/modules/chats/chats.service.ts`

**Estimated scope:** Medium

## Task 7: Goal document and atomic slots

**Description:** A `goals` collection (one per chat, unique on `chatId`) with the Codex
mirror, origin, review, `slotHeld`, `ended` and history; stale-update protection that does
not rely on Codex `updatedAt` alone (whole seconds, and goals have no ID; Task 1 finding 10):
order by the adapter chat stream. A `goal_slots` document per tenant with claim, release
and recompute. Indexes through `ensure-tenant-indexes`.

**Acceptance criteria:**
- [x] 20 concurrent claims for one user with a cap of 3 grant exactly 3; for a tenant cap
      of 10 across users, exactly 10.
- [x] Releasing twice for one transition decrements once; recompute repairs a document
      that was edited by hand.
- [x] An older or replayed Codex update never overwrites a newer one.

**Verification:**
- [x] `platform-next`: `npm test` (integration against the test MongoDB),
      `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 6

**Files likely touched:**
- `platform-next/src/modules/goals/goal.ts` (new)
- `platform-next/src/modules/goals/goal-store.ts` (new)
- `platform-next/src/modules/tenants/tenant-indexes.ts`
- `platform-next/test/integration/goal-slots.test.ts` (new)

**Estimated scope:** Medium

## Task 8: Goal runs without a user message

**Description:** Add `RunDoc.trigger` and make `userMessageId`/`clientMessageId` optional
for `goal`. Add an `attach` mode to `RunExecutor`: no post, reconnect from seq 0, save the
outcome as assistant messages after the chat's last message. Recovery handles attached
runs.

**Acceptance criteria:**
- [x] An attached run is saved with `trigger: "goal"`, its replies in order, and no user
      message; inserting the same run ID twice saves it once.
- [x] Existing runs without `trigger` read and recover exactly as before.
- [x] A lapsed attached run is recovered by `RecoverySweep` like a started one.

**Verification:**
- [x] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 7

**Files likely touched:**
- `platform-next/src/modules/chats/chat.ts`
- `platform-next/src/modules/chats/run-executor.ts`
- `platform-next/src/modules/chats/chat-store.ts`
- `platform-next/src/modules/chats/chats.service.ts`
- `platform-next/test/unit/run-executor.test.ts`

**Estimated scope:** Medium

## Task 9: GoalWatcher and recovery

**Description:** A service that, under a lease, reads the adapter chat stream for every
chat whose goal is active. `run.started` claims `ChatDoc.activeRun` and begins an attached
run. `goal.updated` updates the goal document, `ChatDoc.goal` and slots (`complete` →
review pending). A `goal.updated` seen on a member's run stream starts the watcher. A sweep
restarts lapsed watchers and reconciles with `GET /v1/chats/:chatId/goal`; when Codex reports
active, it resumes the thread with the chat's run context (`PUT … {status: active, run}`),
since a resume continues the goal by itself (Task 1 finding 9). The watcher reconnects with
its last `ChatCursor`; a `chat.snapshot` means events were missed, so it reconciles.

**Acceptance criteria:**
- [x] With no browser connected, a three-turn goal is saved as three runs and the goal
      document ends `complete`, review pending, slot released.
- [x] Killing the platform mid-goal and starting it again: the sweep resumes reading and
      no turn is lost or saved twice.
- [x] Two platform processes never both read one chat (lease takeover test).

**Verification:**
- [x] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 8

**Files likely touched:**
- `platform-next/src/modules/goals/goal-watcher.ts` (new)
- `platform-next/src/modules/goals/goals.module.ts` (new)
- `platform-next/src/modules/chats/run-executor.ts`
- `platform-next/test/integration/goal-watcher.test.ts` (new)

**Estimated scope:** Large (split the sweep into its own task if it grows)

## Task 10: Goal lifecycle API

**Description:** Owner-only routes under `/chats/:id/goal`: start (objective + preset),
edit objective, pause, resume, clear. Start and resume claim a slot first and release it
if the adapter refuses. One goal per chat; after clear, goal mode in that chat is over. A
proposed (model) goal is started by choosing a preset. Starting a goal from a new chat
creates the chat with the goal instead of a first message.

**Acceptance criteria:**
- [x] Start at the limit is refused with `GOAL_LIMIT` ("3 goals running. Pause or finish
      one."); a second goal on a chat, or any goal after clear, is refused.
- [x] Another member, another tenant or an archived chat gets the same not-found as an
      unknown chat.
- [x] A retried start with the same client ID returns the same goal; an adapter failure
      leaves no slot held.
- [ ] (Droppable) A goal started from a new chat creates exactly one chat on retry.
      Not built: a goal starts on a chat that already has a thread. Starting from a new
      chat belongs with the new-chat screen, which waits for the frontend redesign.

**Verification:**
- [x] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 9

**Files likely touched:**
- `platform-next/src/modules/goals/goals.controller.ts` (new)
- `platform-next/src/modules/goals/goals.service.ts` (new)
- `platform-next/src/modules/chats/chats.service.ts`
- `platform-next/test/http/goals.test.ts` (new)

**Estimated scope:** Medium

## Task 11: Review and budget API

**Description:** Approve, request changes (feedback merged into the objective, optional
higher budget), raise budget, accept as is. Port the review rules from legacy
`platform/src/conversations/goals.ts`.

**Acceptance criteria:**
- [x] Request changes on a complete goal sends one `set` with the merged objective and
      `active`, keeps the goal's `createdAt` and `tokensUsed`, and claims a slot; a merge
      over 4000 characters is refused with `OBJECTIVE_TOO_LONG`.
- [x] Raise budget accepts only values above `tokensUsed` and at most the chat maximum.
- [x] Accept as is works only for `budgetLimited` at the maximum; approve only for
      review pending; every decision is audited and appears in the goal history.

**Verification:**
- [x] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 10

**Files likely touched:**
- `platform-next/src/modules/goals/goals.controller.ts`
- `platform-next/src/modules/goals/goals.service.ts`
- `platform-next/test/http/goals.test.ts`

**Estimated scope:** Medium

## Task 12: Browser chat stream, badges and archive

**Description:** `GET /chats/:id/events` (owner only) relays `goal.updated`,
`goal.cleared` and `run.started` from the GoalWatcher, with a snapshot first. Chat views
and the chat list include the goal summary. Archiving a chat with a goal clears it and
releases its slot.

**Acceptance criteria:**
- [x] A subscriber sees `run.started` for a goal turn and can attach to that run's
      existing stream; a reconnect starts with a snapshot.
- [x] The chat list returns each chat's goal status and review state without an extra
      query per chat.
- [x] Archive pauses or clears the goal before the chat is hidden, and frees its slot.

**Verification:**
- [x] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 11

**Files likely touched:**
- `platform-next/src/modules/chats/chats.controller.ts`
- `platform-next/src/modules/chats/chats.service.ts`
- `platform-next/src/modules/goals/goal-watcher.ts`
- `platform-next/test/http/goals.test.ts`

**Estimated scope:** Medium

## Checkpoint B: platform
- [x] `platform-next`: test, typecheck, build, format pass
- [x] With the fixture model: start a goal by API, disconnect, and find every turn saved
- [ ] Review with the human before Phase 4

## Phase 3: frontend (deferred until the frontend redesign)

## Task 13: Goal client and chat stream

**Description:** API client and types for the goal routes, a subscription to
`/chats/:id/events` that attaches to Codex-started runs through the existing run stream,
and a goal reducer. Status text copies Codex's footer wording.

**Acceptance criteria:**
- [ ] A `run.started` while the chat is open attaches to the run without a reload.
- [ ] Out-of-order or repeated goal events never move the goal backwards.
- [ ] Status text for every Codex status plus review pending matches the one-pager.

**Verification:**
- [ ] `frontend`: `npm test`, `npm run typecheck`, `npm run build`

**Dependencies:** Task 12

**Files likely touched:**
- `frontend/lib/tenant-goal.ts` (new)
- `frontend/lib/tenant-chat.ts`
- `frontend/lib/tenant-chat-stream.ts`
- `frontend/test/tenant-goal.test.ts` (new)

**Estimated scope:** Medium

## Task 14: Goal button and start dialog

**Description:** A Goal button in the composer opens a dialog with the objective (4000
character counter) and the tenant's three presets. Hidden when goals are off; disabled
with the limit message at the limit; absent once the chat has had a goal.

**Acceptance criteria:**
- [ ] Starting shows the goal card at once and the first goal turn streams in.
- [ ] `GOAL_LIMIT` and objective-length errors are shown in the dialog, not as a toast
      that loses the text.
- [ ] Keyboard only: open, fill, choose a preset, submit and cancel.

**Verification:**
- [ ] `frontend`: `npm test`, `npm run typecheck`, `npm run build`

**Dependencies:** Task 13

**Files likely touched:**
- `frontend/components/tenant/chat-composer.tsx`
- `frontend/components/tenant/goal-dialog.tsx` (new)
- `frontend/test/goal-dialog.test.ts` (new)

**Estimated scope:** Small

## Task 15: Goal card, resume prompt and proposed goals

**Description:** A card pinned above the composer: objective, status, token meter, time
used, and edit, pause, resume and clear (clear asks for confirmation). Reopening a chat
whose goal is paused, stalled or usage-limited shows "Resume paused goal?". A model goal
shows "The agent proposed a goal. Choose a budget to start." Goal turns render as
assistant replies with no user bubble.

**Acceptance criteria:**
- [ ] Stop during a goal turn leaves the card on "Goal paused" and Resume continues it.
- [ ] The meter and time update from `goal.updated` while turns run.
- [ ] The resume prompt appears only for the three Codex statuses, once per opening.

**Verification:**
- [ ] `frontend`: `npm test`, `npm run typecheck`, `npm run build`

**Dependencies:** Task 14

**Files likely touched:**
- `frontend/components/tenant/goal-card.tsx` (new)
- `frontend/components/tenant/tenant-chat.tsx`
- `frontend/components/tenant/chat-transcript.tsx`

**Estimated scope:** Medium

## Task 16: Review panel and raise budget

**Description:** On review pending: Approve, or Request changes with feedback and an
optional higher preset. On budget-limited: Raise budget (only presets above `tokensUsed`,
up to the maximum) or, at the maximum, Accept as is and Clear.

**Acceptance criteria:**
- [ ] Request changes shows the merged-objective length before sending and refuses over
      4000 characters.
- [ ] Raise offers no preset at or below `tokensUsed`.
- [ ] Approve shows "Goal achieved"; Accept as is shows "Goal achieved (stopped at
      budget)".

**Verification:**
- [ ] `frontend`: `npm test`, `npm run typecheck`, `npm run build`

**Dependencies:** Task 15

**Files likely touched:**
- `frontend/components/tenant/goal-review.tsx` (new)
- `frontend/components/tenant/goal-card.tsx`
- `frontend/test/tenant-goal.test.ts`

**Estimated scope:** Small

## Task 17: Chat-list badge

**Description:** Each chat with a goal shows its status badge in the list, kept fresh
from the chat list response and the open chat's stream.

**Acceptance criteria:**
- [ ] Badges for pursuing, paused, stalled, usage-limited, budget-limited, waiting for
      review and achieved, with text not only colour.
- [ ] A goal finishing in the open chat updates its badge without a reload.

**Verification:**
- [ ] `frontend`: `npm test`, `npm run typecheck`, `npm run build`

**Dependencies:** Task 13 (can run in parallel with Tasks 14–16)

**Files likely touched:**
- `frontend/components/tenant/chat-list.tsx`
- `frontend/lib/tenant-chat.ts`

**Estimated scope:** Small

## Checkpoint C: feature complete (deferred with Phase 3)
- [ ] All three packages: test, typecheck, build, format pass
- [ ] Manual run with the fixture model: start, close the tab, reopen, review, request
      changes, approve
- [ ] Review with the human

## Phase 4: validation

## Task 18: Stack test with the fixture model

**Description:** One test that runs frontend-facing APIs, platform-next, the adapter and
the pinned Codex with the fixture model through the whole flow, including a platform
restart mid-goal and two tabs racing for the last slot.

**Acceptance criteria:**
- [ ] Start → three turns with no browser → complete → request changes → complete →
      approve, every turn saved once.
- [ ] A restart mid-goal loses and duplicates nothing.
- [ ] Two simultaneous starts for the last slot: one succeeds, one gets `GOAL_LIMIT`.

**Verification:**
- [ ] `platform-next`: `npm test` (integration)

**Dependencies:** Checkpoint B (Checkpoint C is deferred with Phase 3)

**Files likely touched:**
- `platform-next/test/integration/goals-stack.test.ts` (new)
- `platform-next/test/support/chat-stack.ts`

**Estimated scope:** Medium

## Task 19: Real-model checks (opt-in, costs money)

**Description:** `*-real.test.ts` checks for the one-pager's assumptions on the nvidia
profile: tokens per turn on three document goals, `@generalagent` on a report goal with
Codex's coding-worded continuation prompt, and feedback merged into the objective changing
what the completion check accepts. Ask the human before running; report numbers.

**Acceptance criteria:**
- [ ] A table of tokens per turn and turns per preset for three goals.
- [ ] A verdict on the continuation prompt for business agents, with transcripts.
- [ ] A requested fix shows up in the next completion.

**Verification:**
- [ ] Run only with explicit approval; results added to the idea doc

**Dependencies:** Task 18

**Files likely touched:**
- `runtime-adapter/test/codex/goals-real.test.ts` (new)
- `docs/ideas/goal-mode.md`

**Estimated scope:** Small
