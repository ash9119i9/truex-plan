# Goal mode — Codex goals for Truex

## Problem Statement
How might we let a tenant member give an agent one objective and a token budget, and have
it keep working (even with the tab closed) until the member approves the result, using
Codex's own goal engine unchanged?

## Recommended Direction
Turn on Codex goals (`features.goals`, today `false` in
`runtime-adapter/src/codex/config.ts:32`) and copy Codex's behaviour exactly. Codex runs the
loop and enforces the budget; Truex builds no loop, prompt or goal state machine of its own.
Truex adds only the tenant layer: budget presets, active-goal limits, the review step, and
pausing goals the model creates on its own.

Each goal turn is a normal run. platform-next reads the chat's event stream the way the
Codex terminal app does, so turns are saved while the tab is closed. Goals are new
runtime-adapter endpoints plus goal events on the existing chat stream, so they are
transport-agnostic: as in legacy `platform/src/runtime/transport.ts`, the same request is a
plain `fetch` locally and an `InvokeAgentRuntime` call (one AgentCore session per chat) in
production. Local is for development only and gets no extra goal handling.

### Copied from Codex (pinned `1ef30bc`)

| Mechanic | Codex | Truex |
|---|---|---|
| Protocol | `thread/goal/set\|get\|clear`, events `thread/goal/updated\|cleared` | Same, via adapter endpoints |
| Model tools | `get_goal`, `create_goal`, `update_goal`; `complete` only after a completion audit, `blocked` after the same blocker on 3 turns | Same |
| Loop | Idle thread with an `active` goal starts the next turn (`continue_if_idle`) with a hidden continuation prompt | Same; platform saves each turn as a run |
| Live updates | One event stream per thread (`turn/started`, `thread/goal/updated`) | One event stream per chat; no polling |
| Tab closed | "Run in background" keeps the app-server working | platform-next is the background reader |
| Turn display | No user bubble, no label for goal turns | Same |
| Status text | `footer.rs`: "Pursuing goal (40k / 200k)", "Goal paused", "Goal stalled", "Goal hit usage limits", budget-limited, "Goal achieved" | Same wording on the goal card and chat-list badge |
| Stop | Interrupt during a goal turn pauses the goal | Same |
| Typing during a turn | Steers the running turn | Same (existing steer receipt) |
| Actions | Edit, pause, resume, clear | Same, from the Goal menu |
| Reopen | "Resume paused goal?" for paused / stalled / usage-limited | Same prompt |
| Objective edit | `set` on an existing goal updates it in place; tokens kept | Used for review feedback |

## Truex rules

**Starting**
- Goal button in the composer. The member writes an objective (Codex limit: 4000
  characters) and picks one of three operator-set budget presets for the tenant.
- One goal per chat, for the life of the chat. No replace. Clear ends goal mode in that
  chat and frees the slot; past turns stay.
- Model-created goals (`create_goal` without the button) are paused by platform-next and
  shown as "The agent proposed a goal. Choose a budget to start." (Deliberate departure
  from Codex.)

**Budgets**
- Each tenant has three presets and a separate maximum above them (for example 100k / 300k
  / 1M presets, 3M maximum). The maximum is passed as `goals.max_goal_token_budget` in the
  thread config.
- Raise budget: when budget-limited or during "request changes". Any goal can be raised in
  steps up to the tenant maximum. The dialog offers only values above `tokensUsed` (Codex
  stays budget-limited otherwise).
- Operators changing presets or the maximum affects new chats only; existing chats keep the
  cap from their thread config.

**Limits**
- At most 3 active goals per user, plus an operator-set cap per tenant. Only `active` goals
  hold a slot.
- Slot claims are an atomic MongoDB write. When unsure, count a goal as active until
  `thread/goal/get` confirms otherwise.
- Resume, request changes and raise budget each need a free slot. At the limit the Goal
  button is disabled with "3 goals running. Pause or finish one." No queue.

**Review (only the member who started the goal)**
- Model sets `complete` → card and badge show "Waiting for your review". Codex has already
  stopped the loop, so nothing is spent while waiting.
- Approve → recorded in platform-next → "Goal achieved".
- Request changes → `set {objective: original + feedback, status: active}`, optionally with
  a raised budget. Same goal, tokens kept. If the feedback won't fit in 4000 characters,
  the user edits the objective down first; no silent truncation.
- At the tenant maximum the goal stays budget-limited with the model's summary of what's
  left. The user can keep chatting manually, then **Accept as is** (recorded as approved,
  "Goal achieved (stopped at budget)") or **Clear**.

**Recovering a stopped goal**

| Stopped because | Shown | Finish by |
|---|---|---|
| User pressed Stop | Goal paused | Resume |
| Same blocker 3 turns, or provider error after retries | Goal stalled | Reply or edit the objective, then Resume |
| Provider quota | Goal hit usage limits | Resume later |
| Budget used up | Budget-limited | Raise budget, or Accept as is / Clear at the maximum |
| Model says done | Waiting for your review | Approve or Request changes |

## Layers
- **runtime-adapter:** enable `features.goals`; add goal endpoints (set/get/clear); pass
  `goals.max_goal_token_budget` in the thread config (and on resume); forward goal events
  and Codex-started goal turns on the chat stream.
- **platform-next:**
  - Tenant goal settings: three presets, maximum, active-goal cap.
  - Goal record with review state (port legacy `platform/src/conversations/goals.ts` and
    `goal-state.ts`: accept/reopen, history, stale-replay protection).
  - Atomic per-user and per-tenant slot accounting.
  - Server-side stream reader that saves goal turns with no browser attached.
  - `RunDoc.trigger: "user" | "goal"`; `userMessageId` / `clientMessageId`
    (`chat.ts:389-390`) optional when the trigger is `goal`. Existing runs read as `user`;
    no migration.
  - Pause model-created goals; Stop pauses the goal.
  - Deleting or archiving a chat clears its goal and frees the slot.
- **frontend:** Goal button and preset picker, pinned goal card (objective, status, token
  meter, time, actions), "Resume paused goal?" prompt, review panel, raise-budget dialog,
  chat-list badge. `frontend/legacy/goal-*` is reference only.

## Key Assumptions to Validate
- [ ] Presets are realistic for business work. Codex counts non-cached input plus output,
      including helper agents; gateway providers without cache reporting burn faster.
      Test: run 3 document goals on the nvidia profile and record tokens per turn.
- [ ] The coding-worded continuation prompt (compiled into Codex) works for business
      agents. Test: run `@generalagent` on a report goal; check it neither stalls nor
      talks about tests or PRs.
- [ ] The platform's pause reaches a model-created goal before its first continuation turn.
      Test: adapter integration test counting turns that slip through (at most one is
      acceptable).
- [ ] Feedback merged into the objective changes what the completion audit accepts. Test:
      request a specific fix and confirm the next completion covers it.
- [ ] An AgentCore session stays alive between goal turns (`/ping` reports `HealthyBusy`
      while a goal is active). Test: run a goal for more than 15 minutes on a deployed
      runtime.

## MVP Scope
In: the copied Codex behaviour, every Truex rule above, and chat-list status badges.
Out: everything in Not Doing.

## Not Doing (and Why)
- Cost-based budgets — tokens first; cost limits replace slot counts later.
- Goals longer than 8 hours — separate project.
- Email or push notifications — badges cover the MVP.
- More than one goal per chat, or replacing a goal — deliberately strict for now.
- Our own continuation loop or prompt — Codex owns both; `vendor/codex` is never modified.
- Shared-adapter engineering (process slots, eviction, adapter-restart recovery) —
  production is one chat per AgentCore session; local is dev only.
- Collapsing earlier goal turns — Codex shows every turn.
- Forking a chat with a goal — the new stack doesn't expose fork; if it does, the fork must
  start paused.

## Open Questions
- None blocking. Migration note: when the AgentCore code is ported, the route allowlist
  (legacy `agent-core/src/agentcore/invocation.ts`) must include the goal routes.
