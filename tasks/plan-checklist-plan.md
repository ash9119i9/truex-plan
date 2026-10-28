# Implementation Plan: Plan checklist (native `update_plan`)

Idea one-pager: [../docs/ideas/plan-live-checklist.md](../docs/ideas/plan-live-checklist.md).
Tasks: [plan-checklist-todo.md](plan-checklist-todo.md). Codex pin `1ef30bcbe784`.

## Overview

Enable Codex's native `update_plan` tool for every chat. When the model decides a
task is complex, it publishes a checklist and updates it as it works. The plan
travels the same path as `skill.used` and `agent.*` today:

```
Codex update_plan → turn/plan/updated (full snapshot)
  → runtime-adapter  chat.ts case → Run.updatePlan → "plan.updated" + run.snapshot.plan
  → platform-next    run-executor case → LiveRun.setPlan → broadcast {type:"plan"} → saved on settle
  → frontend         tenant-chat.ts "plan" → reply.plan (replace) → PlanChecklist in the reply
```

## Architecture Decisions

- **Codex behaviour, unchanged:** model decides when to plan, enabled globally, no
  approval gate, no state machine. "One step in progress" stays advisory.
- **Latest snapshot wins, one checklist per reply.** Each `turn/plan/updated` replaces
  the previous plan. (Codex's TUI appends a cell per update because scrollback can't be
  edited; a web reply can.)
- **The plan is a field, not an ordered item.** Stored like `agents` (one per run), not
  in `items`. No position semantics, and readers that don't know the field ignore it,
  so old app versions are unaffected during rollout.
- **Saved with the reply.** Codex doesn't persist plans; we do so a reload keeps it.
  Additive optional field, no migration.
- **Bounded at the adapter.** Model-authored data: max 50 steps, 500 chars per step,
  2,000 chars of explanation. Truncate, never reject (Codex never rejects a plan).
  Malformed steps are dropped.
- **Planning guidance travels with the tool, in the adapter.** Truex replaces Codex's
  base prompt, so Codex's `## Planning` guidance never reaches the model. The adapter
  adds a Truex version (research/document examples, "don't repeat the plan after
  calling update_plan") as developer instructions, sent on start and every resume,
  the same way `codingInstructions` is. Old threads get it on resume too.
- **Lead only.** Helper plans arrive on helper threads and are not shown in v1.
- **Unfinished plans stay unfinished.** A stopped or failed run keeps its last
  snapshot as is. No rewriting of statuses.

## Task List

### Phase 1: Runtime — prove it on the pin (fail fast)
- [x] Task 1: Enable `update_plan` and pin its behaviour
- [x] Task 2: Planning guidance as developer instructions
- [x] Task 3: Map `turn/plan/updated` to a bounded `plan.updated` event

### Checkpoint 1: Runtime + real model
- [x] Adapter tests, typecheck, format pass
- [x] Live nvidia run: plans on multi-part asks, none on simple ones (2026-10-28,
      `test/codex/plan-real.test.ts`, 3 runs × 6 prompts, all pass; see findings below)
- [ ] Human go/no-go on plan quality before Phase 2

#### Checkpoint 1 findings (nemotron-3-ultra via the local gateway)

- Simple asks: 0/6 planned. Multi-part asks: 2/4 then 3/4 on the final guidance;
  the month-end checklist draft never planned.
- First guidance: steps were long ("Analyze SAP S/4HANA licensing, implementation
  time, risks for 200-person manufacturer") and one reply ended at 1/5 with the
  rest unticked. Guidance now asks for 5–7-word steps, ticking each step after
  writing its part of the reply, and all steps completed before finishing.
- Final guidance, 2 runs: steps shorter, no plan restated in any reply. Three
  plans end fully ticked. The vendor comparison plans all 5 steps, ticks 4 before
  writing anything, then writes the whole reply and never ticks the last step
  (`P0/5 … P4/5 T`, both runs): the finished reply shows "4/5 complete" with one
  step still in progress. Per the plan, Truex does not rewrite statuses.
- Root cause of the unticked last step (wire capture, Codex → gateway, 2 runs):
  every model request offered `update_plan`; the model returned one tick per
  request, then a final request containing only the reply message and no tool
  call. Nothing is dropped by the gateway or adapter. The model writes the whole
  reply in one final message and never makes another model call after text, so
  "write the part, then tick" can't be followed for the last step.
- Tried "tick every remaining step, then write the reply" (2 runs × 4 asks):
  1 of 8 plans ended fully ticked, 5 ended with a step in progress, 2 had no
  plan. No better than the current guidance, so it was reverted. Prompt wording
  doesn't reliably fix this on nemotron.
- The `claude-opus-5.5` dev profile can't evaluate this: its upstream
  (`localhost:8000`) is a kiro-cli ACP shim. Its own tests say kiro-cli ignores
  client-declared tools (it forwards them only under `_meta`), so Truex's tools
  never reach the model (captured reasoning: "There's no update_plan tool
  available to me, but I do have todo_list").

#### Phase 1 hardening (2026-10-28)

- Fixed: `bounded()` (chat.ts) could cut an emoji in half at a cap, leaving a
  lone surrogate in a step, explanation or any other bounded field. Regression
  test in `unit.test.ts`.
- Pinned on the real pin (`plan.test.ts`): a stop or a model timeout after
  `update_plan` ends `stopped`/`failed` with the plan as sent and one
  `run.completed`; four malformed calls fail only the tool call; the guidance
  stays at one copy per request across repeated resumes (measured over 3).
- 13 hand mutations of the plan guards, all caught (two needed stronger tests:
  plan after finish, guidance resent on resume).
- README contract now lists `plan.updated` and `plan` on snapshot/completed.
- Seen once in 5 full runs, not reproduced in 8 isolated runs: the existing
  `subagents-hard` "helper whose model fails" test ended `failed` after 75 s
  (normally 15 s). Not investigated further; outside this change.

#### Phase 1 security review (2026-10-28)

- No High/Critical. Abuse tests in `plan.test.ts` ("plan isolation"): another
  tenant or chat gets the same `404 RUN_NOT_FOUND` as an unknown run on the
  stream (start and cursor), stop and steer, and the run keeps its plan; an
  injection-shaped `update_plan` only updates the checklist (no approval, item
  or extra model call), with control and bidi characters stripped. Unit test
  pins `bounded()`'s stripped ranges at both ends. 9 weakenings, all caught.
- Low, existing (P1): `bounded()` and the input validators keep zero-width,
  LRM/RLM/ALM, `\uFEFF` and `\u2028/9`. Separate change.
- Carry to Task 4: re-parse the plan in the platform. Task 7: render steps and
  explanation as text nodes, never markdown (no CSP, F-8); a step may contain
  a newline (`"Review\n✔ Approved"`), so it must not look like an approval.

### Phase 2: Platform
- [ ] Task 4: Relay the plan live (event + snapshot)
- [ ] Task 5: Save the plan with the reply and return it on read

### Checkpoint 2: Platform
- [ ] platform-next tests, typecheck, format pass

### Phase 3: Frontend
- [ ] Task 6: Plan state in the chat client
- [ ] Task 7: Render the checklist

### Checkpoint 3: Complete
- [ ] End to end in the real app on nvidia: live updates, reload, mid-run reconnect
- [ ] All three packages build; final diff reviewed

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Model plans poorly or too often on non-coding work | High (feature has no value) | Checkpoint 1 live run before building UI; adjust guidance only |
| Helpers inherit the tool config and get `update_plan` | Med (child tool pins change, extra tool) | Task 1 measures it on the pin; their events are already filtered by thread |
| Developer instructions on text-only runs change start params | Low | Pin tests updated deliberately; coding path already proves start+resume behaviour |
| Tool must survive resume | Med (silent loss) | `sessionSettings` is shared by start and resume; Task 1 pins it |
| Final plan arrives after `turn/completed` | Low | Run ignores events after finish; tests cover order in adapter and frontend |
| Older frontend reads a reply with `plan` | Low | Optional field; unknown fields ignored; verified in Task 5 |

## Open Questions

- Bound values (50 / 500 / 2,000) are a starting point; confirm after Checkpoint 1.
- Checklist placement in the reply: top of the reply (proposed) or where it first
  appeared in the stream.
