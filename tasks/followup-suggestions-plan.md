# Implementation Plan: Follow Up suggestions with behaviour tracking

Status: planned 2026-10-25, not started. Build starts only when the user says "build". Tasks: [followup-suggestions-todo.md](followup-suggestions-todo.md). Mockup: [../docs/mockups/follow-up-suggestions.html](../docs/mockups/follow-up-suggestions.html).

## Overview

Under the latest completed answer in a platform-next chat, show up to three "Follow Up" rows (Perplexity style). A click sends that row as the next message. From the first release, record what people do with each set of rows so that later changes (per-agent mixes, dropped intents, personalisation) rest on data instead of guesses.

The model writes the rows itself at the end of its answer. platform-next removes them from the saved answer, checks them and stores them on the run. Tracking adds no event pipeline and no browser analytics: every signal comes from runs and messages the platform already writes, plus a few fields.

## Decisions

Agreed in ideation (2026-10-24/25):

| Topic | Decision |
|---|---|
| Generation | The model appends a `[truex-suggestions]` block (option A). No second model call. |
| Reach | All agents, new chats only (prompt v5). One default rule; per-agent override waits for data. |
| Rows | Max 3, full-width rows, label "Follow Up", click sends immediately. |
| Framing | Six intents (act ↗; deepen, verify, next, compare, reply ↳), answer-shape mix table, slot-1 forward rule along understand → locate → design → build → test → transport → operate, per-row rules (anchor, one ask, user's voice, only what the agent can do, no yes/no, no repeats). |
| Steered runs | Rows for the combined answer. |
| Shape/stage line | Yes: the block starts with one line naming the answer shape and SAP stage (~5 tokens). |
| Report audience | Operators only, through the operator CLI. Tenant admins see nothing in v1. |
| "Typed something close" | Yes: word overlap between a typed message and the previous rows. |

Recommended here (user asked for the best option):

- **Holdout: build the switch, start at 0%, then 10% for four weeks.** Phase 0 needs every new chat to show rows so format bugs surface quickly. Once format failures are below 10% for every model in use, set 10% of new chats to receive no rows for four weeks. That is the only clean answer to "do suggestions help at all?". Assignment is decided once at chat creation and stored on the chat, so it never flips mid-chat. If weekly new-chat volume is under ~500, four weeks won't separate the groups; extend the window rather than read noise.
- **Store the row text on the run.** It is required anyway: rows must survive a reload, and the "typed something close" score needs the text. The text is derived from the answer, which is already stored, so it carries the same privacy class and lives and goes with the chat.

## Architecture decisions

- **Block format** (one contract shared by prompt, server parser and browser parser):

  ```text
  [truex-suggestions]
  shape: how-to; stage: build
  act: Draft an ABAP report that calls the BAPI and commits the work
  verify: Check which authorisation objects BAPI_PO_CREATE1 needs
  deepen: Explain how the return table reports partial failures
  [/truex-suggestions]
  ```

  The model always ends with a block. An empty block means "no rows" (greetings, refusals, pure chit-chat). This lets us tell a deliberate "none" from a format failure.
- **Run status for the block:** `ok` (1–3 valid rows), `none` (empty block), `missing` (no block), `invalid` (block present, no valid rows). Unknown shape or stage values become `unknown`; unknown or missing intents become `ask`.
- **Where the rule goes:** appended after the agent's own instructions in `chatPrompt`, so it is the last thing the model reads and a member-written agent prompt cannot sit after it. v5 base text equals v4; only the appended rule differs.
- **Stripping happens at settle, for every run that settles, through every path** (live stream end, history reconcile of `uncertain` runs, recovery sweep). It removes the block, and a half-written block, from every assistant message in the run. Rows are stored only for `completed` runs of chats with follow-ups on. Codex's own thread history keeps the block; that is harmless and invisible.
- **Click tracking adds no database read to the send path.** The browser sends `followUp: { fromRunId, slot }` with the message; platform-next validates the shape only and writes it on the new run's existing insert. The report verifies the claim later against the stored rows (a mismatch counts as typed). Reason: each Mongo round trip costs ~280 ms from a laptop to us-east-1, and send latency was already tuned down. A follow-up claim has no effect on permissions or behaviour, only on counts, so deferring the check is safe.
- **"Typed something close" is computed in the report**, not at send time, for the same reason: word-set overlap (NFKC, lowercase, stop words dropped) between the next typed message and each stored row; "close" at ≥ 0.6. The threshold is a report flag, so it can change without touching stored data.
- **Two parsers, one contract.** platform-next does not import `shared/`, so the server parser lives in platform-next and the browser keeps `frontend/lib/suggestions.ts` (updated for intents). Both suites run the same list of golden cases, copied verbatim, so drift shows up as a failing test.
- **Switches** (platform-next chat config, read at chat creation): `FOLLOW_UPS=on|off` (default `on`) and `FOLLOW_UPS_HOLDOUT_PERCENT` (0–50, default 0). Each new chat stores `followUps: "on" | "holdout" | "off"`; chats created before v5 have no field and are read as off. Turning `FOLLOW_UPS=off` also makes the API stop returning rows for every chat, which gives an immediate kill switch; stripping always continues.

## What gets stored

On the chat (once, at creation): `followUps: "on" | "holdout" | "off"`.

On a run that suggested (`run.followUps`):

| Field | Example | Used for |
|---|---|---|
| `status` | `ok` / `none` / `missing` / `invalid` | format reliability per model |
| `shape`, `stage` | `how-to`, `build` | intent mix by answer type and SAP stage |
| `items[]` | `{ slot: 1, intent: "act", text: "…" }` | rows on reload, overlap score, later learning |

On a run started from a row (`run.origin`): `{ source: "suggestion", fromRunId, slot }`. A typed message stores nothing new.

Everything else is derived by the report from fields that already exist: agent, model, prompt version, tenant (from the DB), turn number (message `seq`), steer flag (`run.steers`), connectors (chat snapshot), timings, and the next run's status.

| Signal | How the report derives it |
|---|---|
| Shown | A `completed` run with `followUps.status = ok`, counted once per run |
| Clicked | The next run in the chat has a verified `origin` |
| Typed instead | The next run has no verified origin; overlap score attached |
| Left | No next run within 30 minutes of the suggesting run's `completedAt` |
| Clicked turn went badly | The clicked run ended `stopped` within 15 s, `failed`, or took a steer |
| Time to click | Next run `acceptedAt` minus suggesting run `completedAt` |

## Report (operator CLI)

`npm run operator -- followups-report --since 7d [--tenant <id>] [--min-sets 200] [--close 0.6]`

- Cells: agent × model × intent × shape/stage, plus per-model format failure rate and the holdout comparison (turns per chat, chats with ≥ 2 turns, stop rate, 7-day return).
- Cells with fewer than `--min-sets` sets are hidden, not shown as tiny percentages.
- Counts and rates only. No suggestion or message text is printed, in any mode. Cross-tenant output aggregates counts and never names a member.
- Read-only. Each tenant DB is scanned through a new partial index on runs (`{ createdAt: 1 }` where `followUps` exists), added through the existing `ensure-tenant-indexes` command.

## Decision thresholds (fixed before data arrives)

| Trigger | Action |
|---|---|
| Overall click rate < 5% after 2,000 shown sets | Reconsider the feature or its placement |
| An intent < 2% clicks for an agent | Drop it from that agent's mix (needs the per-agent override) |
| > 20% of clicked `act` turns go badly | Tighten the `act` rule |
| > 10% format failures for a model | Stop asking that model for rows, or use a separate-call fallback |
| "Typed close" rate > click rate | Rework the wording rules, not the intent mix |

Phases: 0 check it works (weeks 1–2) → 1 learn, report only (months 1–2) → 2 adapt per agent at ~200+ sets per agent → 3 personalise much later.

## Task list

Full tasks with acceptance criteria and verification: [followup-suggestions-todo.md](followup-suggestions-todo.md).

### Phase 0: Prove the format
- [ ] Task 1: Probe block compliance on the real models

### Phase 1: Server foundation
- [ ] Task 2: Block contract and server parser
- [ ] Task 3: Prompt v5 and per-chat assignment
- [ ] Task 4: Strip and store at settle

### Checkpoint A: rows exist in data, saved answers are clean

### Phase 2: In the chat
- [ ] Task 5: Hide the block while streaming
- [ ] Task 6: Follow Up rows
- [ ] Task 7: Click sends with origin

### Checkpoint B: end-to-end in the real app

### Phase 3: Learn from it
- [ ] Task 8: Operator report
- [ ] Task 9: Runbook and thresholds doc
- [ ] Task 10: Quality eval on real models

### Checkpoint C: ready to ship

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A model ignores or breaks the format | Med | Task 1 measures it first; `missing`/`invalid` statuses counted per model; > 10% → excluded |
| The block leaks into a saved answer, copy or export | High | Strip on every settle path including reconcile and stopped/failed runs; half-block test; Task 4 integration test reads stored text |
| An `act` row triggers a write without asking | High | Rows only send text; before ship, verify every platform-next write path raises an approval card (Checkpoint B) |
| A member-written agent prompt contradicts the rule | Med | Rule goes last; Task 10 includes agents with hostile instructions |
| Prompt injection through a row (the model echoes user content) | Med | Rows are plain text, validated like messages (no control/bidi chars, ≤ 160 chars), rendered as text in a `<button>`, never Markdown or HTML |
| Position bias: slot 1 gets clicks because it is first | Med | Report shows clicks by slot and by intent separately; shuffling slots 2–3 is a later experiment, not v1 |
| A forged `origin` inflates counts | Low | Analytics only; the report verifies it against stored rows |
| Report scans grow with data | Low | Partial index; report is operator-run and read-only; `--since` bounds the window |
| Low traffic makes the holdout meaningless | Med | Holdout starts after phase 0; extend the window if volume is under ~500 new chats/week |
| Extra tokens on every reply | Low | ~250 prompt tokens (cached after turn 1) + 40–80 output tokens; measured in Task 1 |

## Rollback

`FOLLOW_UPS=off` stops new chats from getting the rule and hides rows everywhere at once; stripping keeps saved answers clean. Stored fields are additive (`chat.followUps`, `run.followUps`, `run.origin`), so older code ignores them and a code rollback needs no data change. The partial index can stay.

## Open questions

- Thresholds above (5% / 2% / 20% / 10%, 200 sets, overlap 0.6, 30 min "left") are starting values. Confirm or change before Task 8.
- v4 keeps the DEV ONLY "don't mention Kiro" sentence. v5 copies v4, so it carries the sentence unless removed in the same version bump.
- Which models go into the Task 1 probe: every enabled catalog model, or only those agents use today?
