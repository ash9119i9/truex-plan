# Plan checklist tasks

Plan: [plan-checklist-plan.md](plan-checklist-plan.md). Tasks are sequential.
Commands run inside each package: `npm test`, `npm run typecheck`, `npm run format:check`
(frontend: `npm test`, `npm run typecheck`, `npm run build`).

## Task 1: Enable `update_plan` and pin its behaviour

**Description:** Add `"tools.update_plan": { enabled: true }` to `TEXT_ONLY` in the
adapter config so every chat (text, MCP, coding, resumed) offers the native tool.
Update the pinned tool-list tests on purpose and add a plan pin test.

**Acceptance criteria:**
- [ ] A text-only run offers exactly `["update_plan"]`; coding runs offer it next to
      `apply_patch`, `exec_command`, `write_stdin`.
- [ ] A resumed thread still offers `update_plan`.
- [ ] Helper tool list on the pin is measured and the probe test asserts what it is.

**Verification:**
- [ ] `runtime-adapter`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** None

**Files likely touched:**
- `runtime-adapter/src/codex/config.ts`
- `runtime-adapter/test/codex/lifecycle.test.ts`
- `runtime-adapter/test/codex/coding.test.ts`
- `runtime-adapter/test/codex/subagents-probe.test.ts`
- `runtime-adapter/test/codex/plan.test.ts` (new)

**Estimated scope:** Medium

## Task 2: Planning guidance as developer instructions

**Description:** Write Truex's version of Codex's `## Planning` / `## update_plan`
section (when to plan, when not to, one step in progress, short steps, explain a
changed plan, never repeat the plan after calling the tool) with research and
document examples. Send it as developer instructions on start and every resume:
alone for text chats, appended to `codingInstructions` for coding chats.

**Acceptance criteria:**
- [ ] The model request contains the guidance on start and after resume, for text
      and coding chats.
- [ ] The agent prompt (`baseInstructions`) is unchanged.
- [ ] Coding instructions are still present in coding runs.

**Verification:**
- [ ] `runtime-adapter`: `npm test`, `npm run typecheck`

**Dependencies:** Task 1

**Files likely touched:**
- `runtime-adapter/src/codex/config.ts`
- `runtime-adapter/test/codex/plan.test.ts`
- `runtime-adapter/test/codex/coding.test.ts`

**Estimated scope:** Small

## Task 3: Map `turn/plan/updated` to a bounded `plan.updated` event

**Description:** Add a `turn/plan/updated` case to the lead-turn switch in
`chat.ts`. Parse and bound the data (50 steps, 500 chars per step, 2,000 chars of
explanation; drop malformed steps; blank explanation → null) and call a new
`Run.updatePlan()`, which replaces the stored plan, emits `plan.updated`, and adds
`plan` to `run.snapshot` and to `run.completed`.

**Acceptance criteria:**
- [ ] A fixture model calling `update_plan` twice yields two `plan.updated` events;
      the snapshot and completed event carry only the second plan.
- [ ] Oversized and malformed input is truncated/dropped, never an error; an empty
      plan is passed through as `[]`.
- [ ] A plan from a helper thread or another turn is ignored; nothing is emitted
      after the run finishes.

**Verification:**
- [ ] `runtime-adapter`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 1

**Files likely touched:**
- `runtime-adapter/src/runtime/chat.ts`
- `runtime-adapter/src/runtime/run.ts`
- `runtime-adapter/test/unit/unit.test.ts`
- `runtime-adapter/test/codex/plan.test.ts`

**Estimated scope:** Medium

## Checkpoint 1: Runtime + real model
- [x] All adapter checks pass
- [x] Live run on the nvidia dev profile with 3–4 multi-part research/document prompts
      and 2 simple prompts: plans appear on the first group, not the second; steps are
      short and sensible
- [ ] Human go/no-go on plan quality before Phase 2

## Task 4: Relay the plan live

**Description:** In `run-executor.ts`, handle `plan.updated` and `plan` in
`run.snapshot`: parse it again (the platform does not trust the adapter's shape),
store the latest on `LiveRun`, and broadcast `{ type: "plan", data }` to chat
subscribers, plus include it in the live snapshot sent to a reconnecting browser.

**Acceptance criteria:**
- [x] Live subscribers get one `plan` event per update, latest wins.
- [x] A browser that subscribes mid-run gets the current plan in its snapshot.
- [x] The same snapshot applied twice leaves one plan.

**Verification:**
- [ ] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 3

**Files likely touched:**
- `platform-next/src/modules/chats/run-executor.ts`
- `platform-next/test/integration/chats.test.ts`

**Estimated scope:** Small

## Task 5: Save the plan with the reply

**Description:** Add an optional `plan` to the settled reply (like `agents`), write
it on settle, and return it when messages are read. Stopped and failed runs keep
their last plan unchanged.

**Acceptance criteria:**
- [x] After a run settles, reading the chat returns the reply with its final plan.
- [x] Replies without a plan have no `plan` field (stored documents unchanged).
- [x] A stopped run's reply keeps its last plan as sent.

**Verification:**
- [ ] `platform-next`: `npm test`, `npm run typecheck`, `npm run format:check`

**Dependencies:** Task 4

**Files likely touched:**
- `platform-next/src/modules/chats/chat.ts`
- `platform-next/src/modules/chats/chat-store.ts`
- `platform-next/src/modules/chats/run-executor.ts`
- `platform-next/test/integration/chats.test.ts`

**Estimated scope:** Medium

## Checkpoint 2: Platform
- [ ] platform-next checks pass
  typecheck and format:check pass. Full `npm test`: 681/683; two
  integration tests that never plan failed under the full run and pass alone
  (restart recovery: 401 after 569 s; claim race: 3 of 4 sends taken).
- [x] Adapter + platform run together: plan visible over SSE and on chat read

## Task 6: Plan state in the chat client

**Description:** In `tenant-chat.ts`, parse the `plan` stream event and the plan in
the snapshot and saved replies (bounded and shape-checked again), store it as
`reply.plan`, and replace it on each update.

**Acceptance criteria:**
- [x] Each `plan` event replaces `reply.plan`; malformed data is ignored.
- [x] A plan arriving after `completed` still applies to that reply.
- [x] A saved reply loads with its plan.

**Verification:**
- [x] `frontend`: `npm test`, `npm run typecheck`

**Dependencies:** Task 5

**Files likely touched:**
- `frontend/lib/tenant-chat.ts`
- `frontend/test/tenant-chat.test.ts`

**Estimated scope:** Small

## Task 7: Render the checklist

**Description:** A `PlanChecklist` at the top of the reply, using the Codex TUI
vocabulary: ✔ dim and struck through (completed), □ bold accent (in progress), □ dim
(pending), "N/M complete", `(no steps provided)` for an empty plan, explanation only
when not blank. Accessible: a list with each step's status in text, not only in the
marker.

**Acceptance criteria:**
- [x] Renders the three statuses, the count, the empty case and the explanation rule.
- [x] Screen readers hear each step's status.
- [x] Long steps wrap; no layout break on narrow widths.

**Verification:**
- [x] `frontend`: `npm test`, `npm run typecheck`, `npm run build`
- [ ] Manual check in the real app

**Dependencies:** Task 6

**Files likely touched:**
- `frontend/components/tenant/chat-transcript.tsx`
- `frontend/styles/v2/` (chat styles)
- `frontend/test/plan-render.test.ts` (new, same pattern as `subagents-render.test.ts`)

**Estimated scope:** Medium

## Checkpoint 3: Complete
- [ ] End to end in the real app on nvidia: plan appears and ticks off live; reload
      keeps the final plan; reconnecting mid-run shows the current plan
- [ ] All three packages pass checks and build
- [ ] Final diff reviewed
