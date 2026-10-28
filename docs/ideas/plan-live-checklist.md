# Plan — native `update_plan` checklist for Truex

## Problem Statement
How might we let Truex show a plan for a complex task and work through it live,
by adopting Codex's native `update_plan` exactly, without building plan state of our own?

## Recommended Direction
Mirror Codex's `update_plan` design one-to-one in the new stack (runtime-adapter →
platform-next → frontend). Codex treats a plan as a message, not managed state: a
~40-line stateless handler validates JSON shape only, emits a full snapshot as
`turn/plan/updated`, and returns `"Plan updated"`. Behaviour quality lives in the
prompt; presentation lives in a pure render that defends against messy data.

Decisions:
- **Trigger: model judgment.** No UI toggle. The prompt says when to plan
  (non-trivial, multi-phase, multiple asks) and when not to (no filler plans).
- **Enabled globally.** `"tools.update_plan": { enabled: true }` in the base config
  in `runtime-adapter/src/codex/config.ts`, next to the existing
  `tools.experimental_request_user_input` key, and re-sent on resume.
- **Exactly Codex's behaviour.** No approval gate, no state machine, no transition
  validation. "One step in_progress at a time" stays advisory, as in Codex.

What "exactly Codex" means at each layer (pinned source `1ef30bcbe784`):

| Layer | Codex | Truex port |
|---|---|---|
| Tool | `core/src/tools/handlers/plan.rs`, gated by `tools.update_plan.enabled` | Enable in base config |
| Wire | `turn/plan/updated` `{threadId, turnId, explanation, plan[{step, status}]}`, full snapshot, no itemId | New case in `runtime-adapter/src/runtime/chat.ts` (today dropped at `default`) → contract event |
| Client state | `on_plan_update` appends a new `PlanUpdateCell` per call; keeps `last_plan_progress` (completed, total) | Append a plan entry to the transcript per event; keep latest N/M for a progress indicator |
| Render | `history_cell/plans.rs`: ✔ dim+struck / □ bold accent / □ dim, sorted compact view, `(no steps provided)`, trimmed explanation | Port the same vocabulary into the frontend |
| Persistence | `rollout/src/policy.rs` drops `PlanUpdate`; plans absent on resume | Same for v1 (see Open Questions) |
| Prompt | `## Planning` / `## update_plan` in `default.md`, incl. "do not repeat the plan after calling update_plan" | Same structure, examples rewritten for research/document work |

The one addition beyond Codex: bound step count and per-step text length at the
runtime-adapter boundary. Codex trusts a local model; Truex relays model-authored
data to a multi-tenant web client.

## Key Assumptions to Validate
- [ ] The model plans well for non-coding tasks with the retargeted prompt — run
      3–4 research/document prompts on the nvidia dev profile and read the steps.
- [ ] Model judgment triggers plans at the right rate — no plans on simple asks,
      plans on multi-part asks. Same prompt set, count plan/no-plan.
- [ ] Watching the plan is enough trust without a gate — drive a 5-step task end to end.
- [ ] `tools.update_plan.enabled` survives resume — resume a thread, confirm the tool
      is still offered.
- [ ] Bounds don't clip real plans — caps reject abuse but pass a 7-step plan with
      normal step text.

## MVP Scope
In:
- Global enable in base config, re-sent on resume.
- `turn/plan/updated` → bounded contract event in runtime-adapter.
- platform-next relays the event over the existing turn event stream.
- Frontend: a transcript entry per update using the Codex TUI vocabulary, plus a
  "Tasks N/M" progress indicator from the latest update.
- Retargeted planning prompt section, keeping the "don't repeat the plan" contract.

Out: approval gate, Plan Mode / `<proposed_plan>` / `item/plan/delta`, step editing,
plan-as-document, durable plan storage.

## Not Doing (and Why)
- **Approval gate** — Codex has none for `update_plan`; Truex has no host execution
  to guard, and stop/steer already exist.
- **Plan state machine** — Codex enforces nothing beyond JSON shape; adding one
  re-introduces the complexity the native design avoids.
- **Plan Mode fusion** — separate data path; `update_plan` is rejected in Plan mode.
- **Plan = Goals merge** — a product redesign, not a port. Revisit later.
- **Step steering** — fights the model-authored snapshot model.
- **Durable plan storage** — Codex doesn't persist plans; matching it for v1.

## Open Questions
- **Reload behaviour:** Codex drops plans from history, which is fine in a TUI but
  means a browser reload loses the plan. Check whether platform-next already replays
  stored turn events; if so, keeping plans on reload is cheap and worth the one
  deviation.
- **Bound values:** exact max step count and step length (and whether to truncate
  or reject when exceeded).
- **Ordering:** confirm the frontend handles a final all-`completed` update that
  arrives after `turn/completed`.
