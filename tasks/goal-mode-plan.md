# Implementation Plan: Goal mode

Idea: [docs/ideas/goal-mode.md](../docs/ideas/goal-mode.md). Tasks: [goal-mode-todo.md](goal-mode-todo.md).

## Overview

Turn on Codex goals and copy Codex's behaviour exactly. Codex (pinned `1ef30bc`) runs the
loop, enforces the budget and owns the goal status. Truex adds only the tenant layer:
budget presets, active-goal limits, the owner's review, and pausing goals the model creates
on its own. Each turn Codex starts for a goal is saved as a normal run, also while no
browser is open.

```text
frontend ──/chats/:id/events──► platform-next ──/v1/chats/:id/events──► runtime-adapter ──► codex app-server
   ▲  goal card, review          GoalWatcher saves goal runs              goal turns become runs
   └──/runs/:runId/stream (unchanged) ◄── RunExecutor (unchanged reader) ◄── /v1/runs/:runId/events
```

## Architecture Decisions

**Codex owns the goal.** `thread/goal/set|get|clear`, `thread/goal/updated|cleared`, the
model's `get_goal`/`create_goal`/`update_goal`, continuation, the hidden continuation
prompt and SQL budget accounting are used unchanged. Truex never computes `tokensUsed` or
decides a goal's Codex status. `vendor/codex` is not modified.

**Goals are on per chat, decided at creation.** A tenant with goal settings gets
`goals: { maxTokenBudget }` snapshotted on each new `ChatDoc`. The platform sends it on
every run and goal request; the adapter then sets `features.goals` and
`max_goal_token_budget` for that chat. Chats without it are exactly as today. Changing a
tenant's settings affects new chats only (as agreed in the one-pager).

**A Codex-started turn is an adapter run.** Codex starts continuation turns itself
(`continue_if_idle` → `turn/started` with no client request). The adapter turns each one
into a `Run`, so events, reconnect, stop, steer, approvals and the watchdog work unchanged.
Its run ID is the first 24 hex characters of `sha256(threadId + ":" + turnId)`. That fits
the adapter's ID rule and is ObjectId-shaped, so platform-next uses it as the `RunDoc._id`
and two readers inserting the same turn collide on `_id` instead of saving it twice. The
run reuses the context (MCP specs, approvals, limits, skills) the thread was last loaded
with; the adapter keeps it in memory for the chat.

**One event stream per chat, as in the Codex TUI.** The TUI holds one stream per thread
and learns about goal turns from `turn/started` and `thread/goal/updated`
(`tui/src/app/app_server_event_targets.rs`). The adapter adds
`GET /v1/chats/:chatId/events` with `goal.updated`, `goal.cleared` and `run.started`
(cursor, bounded buffer, snapshot on overflow, like run streams). `goal.updated` is also
sent on the active run's stream so a goal created during a member's run is seen by the
reader already attached. platform-next relays the same three events to the browser on
`GET /chats/:id/events`. No polling.

**Goal changes go through one adapter endpoint.** `PUT /v1/chats/:chatId/goal` sends
`thread/goal/set` with `origin: "user"`; `DELETE` sends `thread/goal/clear`; `GET` reads.
A set whose resulting status is `active` carries the run context, because the adapter may
first have to start or resume the thread (Codex only continues a loaded thread).

**Stop pauses the goal, in the adapter.** Stopping a run while the chat's goal is active
sends `thread/goal/set {status: paused}` and then `turn/interrupt`, the order the TUI uses
on exit (`tui/src/app/event_dispatch.rs:1029`). Pausing first means Codex's idle hook finds
no active goal and starts nothing. The adapter's watchdog and helper-limit stops pause the
same way; a shutdown does not, so the goal continues after the restart.

**Model-created goals are paused in the adapter.** The adapter is next to Codex, so it can
pause within the same turn and no continuation slips through. A `thread/goal/updated` for
a goal the adapter did not set is paused at once and reported with `origin: "model"`.
The adapter records the goal it set (`createdAt` and objective; Codex goals have no ID, Task 1
finding 10) in the chat's existing `chat.json`, so this survives a process restart. Once
the platform has ended goal mode in a chat (cleared), it clears any later model goal
instead of showing it.

**platform-next owns the Truex state.**
- `TenantDoc.goals` (catalog): three presets, a maximum above them, and an active-goal cap.
  Absent means goals are off for the tenant.
- `goals` collection (tenant database), one document per chat: Codex mirror (`createdAt`,
  `objective`, `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`), `origin`,
  `review` (`none | pending | approved | accepted_as_is`), `slotHeld`, `ended`, a bounded
  history, and stale-update protection so a stale or replayed update never overwrites a
  newer one (ported from legacy `platform/src/conversations/goal-state.ts`). Codex
  `updatedAt` is in whole seconds, so updates are ordered by the adapter chat stream as well
  (Task 1 finding 10). Task 7: a later `createdAt` is a new goal, then a later `updatedAt`
  wins; within one second a later `seq` on the same stream wins, and a replay is refused.
- `ChatDoc.goal`: a small summary (status, review) for chat-list badges.
- Slots: one `goal_slots` document per tenant `{total, users: {<userId>: n}}`. A claim is a
  single `findOneAndUpdate` filtered on `total < cap` and `users.<id> < 3` that increments
  both, so two tabs can never take the last slot and no transaction is needed. Releases
  decrement once per `slotHeld: true → false` transition. A sweep recomputes the document
  from `goals` to repair drift; while unsure, a goal counts as active.

**The GoalWatcher reads goal chats with no browser attached.** For every chat whose goal
is `active` it holds the adapter chat stream under a lease (same pattern as run leases and
`RecoverySweep`). On `run.started` it claims `ChatDoc.activeRun` and hands the run to the
existing `RunExecutor` in a new `attach` mode (reconnect from seq 0). On `goal.updated` it
updates the goal document and slots (`complete` → `review: pending`, slot released). After
a platform restart, the sweep restarts watchers whose lease lapsed and reconciles each with
`GET /v1/chats/:chatId/goal`. The chat stream's cursor names its stream (`streamId`), so a
reconnect after an adapter restart gets a snapshot instead of silently skipping events.

**Goal runs have no user message.** `RunDoc.trigger: "user" | "goal"`; `userMessageId`
and `clientMessageId` are optional when `trigger` is `goal`. Missing `trigger` reads as
`user`, so no migration (expand only). The reply is saved as assistant messages with no
user bubble, as Codex shows it.

**Review is Truex-only.** Codex stops at `complete`. Approve records `approved`; request
changes merges feedback into the objective (≤ 4000 characters, refused rather than cut) and
sends `set {objective, status: active, tokenBudget?}`, which keeps the goal's `createdAt`
and `tokensUsed` (`ext/goal/src/api.rs`). Accept as is is offered only when the goal is
`budgetLimited` at the tenant maximum. Only the chat owner can act; chats are private.

**Local and AgentCore are the same.** Goals are adapter routes and stream events; the
transport carries them unchanged. The AgentCore bridge (`tasks/agentcore-runtime-todo.md`)
must add the goal routes to its allowlist and report `HealthyBusy` while the chat's goal is
active. That is listed there, not built here.

## Task List

This change covers runtime-adapter and platform-next only. The frontend is being
redesigned, so Phase 3 and Checkpoint C wait for that work; Task 18 follows Checkpoint B.

### Phase 1: runtime-adapter
- [x] Task 1: Goal behaviour on the pin (probe)
- [x] Task 2: Goal contract on both sides
- [x] Task 3: Per-chat goal config and the goal endpoint
- [x] Task 4: Codex-started goal turns become runs; chat event stream
- [x] Task 5: Stop pauses the goal; model-created goals are paused

### Checkpoint A: adapter

### Phase 2: platform-next
- [x] Task 6: Tenant goal settings and the chat snapshot
- [x] Task 7: Goal document and atomic slots
- [x] Task 8: Goal runs without a user message
- [x] Task 9: GoalWatcher and recovery
- [x] Task 10: Goal lifecycle API (new-chat start dropped)
- [x] Task 11: Review and budget API
- [x] Task 12: Browser chat stream, badges and archive

### Checkpoint B: platform

### Phase 3: frontend (deferred until the frontend redesign)
- [ ] Task 13: Goal client and chat stream
- [ ] Task 14: Goal button and start dialog
- [ ] Task 15: Goal card, resume prompt and proposed goals
- [ ] Task 16: Review panel and raise budget
- [ ] Task 17: Chat-list badge

### Checkpoint C: feature complete (deferred with Phase 3)

### Phase 4: validation
- [ ] Task 18: Stack test with the fixture model
- [ ] Task 19: Real-model checks (opt-in, costs money)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A member's `turn/start` lands in the moment Codex starts a goal turn; Codex steers it into the goal turn (`start_or_steer_turn`) | High: one turn, two runs | Task 1 measured it (probe findings 4, 8): Codex handles a thread's requests in write order and never runs two turns, but the `turn/start` answer always comes before `turn/started`, and `turn/started` does not mark goal turns, so a steer cannot be detected afterwards. Task 4: whatever turn Codex answers `turn/start` with is that run's, and a lead turn no run owns becomes a goal run (also one that started while a member's run was starting, or before the previous run finished), so every turn has exactly one run. A member's input steered into a goal turn makes that turn the member's run |
| `features.goals` is read from the process config, not only the thread config (`thread_goal_processor.rs:138`) | Med | Task 1 (finding 1): the goal requests check only the process config, which is on by default; the thread config decides tools and goal turns. A chat without `goals` accepts a set and never runs it, so Task 3 refuses goal requests for such chats in the adapter |
| The budget maximum in the thread config is ignored for a set on an unloaded thread | Med: budget above the tenant maximum | Task 1 (finding 2): pass `-c goals.max_goal_token_budget=N` to the chat's Codex process as well (Task 3), and validate in the adapter before calling Codex |
| A goal without a budget loops as fast as the model answers | High: unbounded spend | Task 1 (finding 3): every goal gets a budget; with the maximum set, Codex gives a model-created goal the maximum |
| Resuming a thread with an active goal may not continue by itself (`restore_after_resume` only marks it) | Med: goal shows active, nothing runs | Task 1 (finding 9): resume DOES continue by itself (resume emits the idle hook). Task 9's reconcile resumes the thread with context instead of re-sending `set {status: active}`; a set on an unloaded thread starts nothing |
| Interrupt without pausing leaves the goal active; the member's next message restarts it | High: Stop does not stop | Task 1 (finding 6) confirmed; Task 5 pauses before interrupting |
| The protocol goal has no goal ID, and `updatedAt` is in whole seconds | Med: Task 5's "goal ID the adapter set" and Task 7's stale-update check need another key | Task 1 (finding 10): identify a goal by `createdAt` plus objective, and order updates by stream sequence rather than `updatedAt` alone. Task 5 keeps that identity in `chat.json`; Task 7 orders by createdAt, then updatedAt, then the stream position within one stream |
| Lost releases or updates leave a slot held | Med: member blocked from goals | Release on every transition, sweep recomputes slots from `goals` |
| Long goals keep the MCP headers from the run that loaded the thread; OAuth tokens may expire | Med: tool errors, goal stalls | Accepted for MVP; stalled goals resume through a member run, which reloads fresh headers |
| Budgets drain faster than presets suggest (non-cached input + output + helpers) | Med | Task 19 measures before operators pick presets |
| Coding-worded continuation prompt for business agents | Med | Task 19 checks `@generalagent` on a report goal |
| Browser stream reaches only the process reading the chat | Low today (single process) | Same limit as run streams (`backlog/performance/06-multi-instance-streams.md`) |

## Open Questions

- Starting a goal in a brand-new chat (no first message) is Task 10's last criterion. Drop
  it to ship sooner, and the Goal button appears only after the first message.
- `tasks/agentcore-runtime-todo.md` Task 1 fixes "exactly the adapter's 10 routes", and
  Task 3 bases `/ping` on active runs. Add the goal routes and "active goal = busy" there
  when that work resumes.
