# Follow Up suggestions

Status: implemented 2026-10-25. Plan:
[`tasks/followup-suggestions-plan.md`](../tasks/followup-suggestions-plan.md).
Mockup: [`docs/mockups/follow-up-suggestions.html`](mockups/follow-up-suggestions.html).

Every completed answer in a new chat can end with up to three **Follow Up**
rows. A click sends the row as the next message, through the normal send path,
with an origin claim for the report. Nothing about the feature adds an event
pipeline: the report reads runs, chats and messages the platform already
writes.

## Block format

The model writes the block at the end of its answer, outside any code fence:

```text
[truex-suggestions]
shape: how-to; stage: build
act: Draft an ABAP report that calls the BAPI and commits the work
verify: Check which authorisation objects BAPI_PO_CREATE1 needs
deepen: Explain how the return table reports partial failures
[/truex-suggestions]
```

- One `shape: <shape>; stage: <stage>` line, then 1–3 `<intent>: <row>` lines.
- `shape`: `explain`, `how-to`, `troubleshoot`, `compare`, `verify`, `locate`,
  `decide`, `reference`, `chat`.
- `stage`: `understand`, `locate`, `design`, `build`, `test`, `transport`,
  `operate`, `none`.
- `intent`: `act`, `deepen`, `verify`, `next`, `compare`, `reply`.
- An empty block is deliberate `none` (greetings, thanks, small talk,
  refusals). The model must still write the block, so a missing block is
  distinguishable from "no rows wanted".
- Unknown shape or stage values, and unknown or missing intents, are stored as
  `unknown` / `ask`. An unknown lowercase or bolded tag (`suggest:`) is
  dropped; a capitalised word before a colon (`SAP: How does MIGO post…`) is
  kept as part of the row. Rows are NFC, trimmed, ≤ 160 characters, with
  control and bidi-override characters, lone surrogates and rows with no
  letter or digit refused, duplicates dropped.
- Quotes, backticks and `*`/`_` emphasis wrapping a whole row are removed only
  as a matching pair at both ends, and only when the same character does not
  also appear inside (except between letters, as in `doesn't` or
  `BAPI_PO_CREATE1`). `Explain "COMMIT WORK"` keeps both quotes.
- A complete block ending the reply is still read when the model left a code
  fence above it unclosed; a block inside a fence with anything after it is
  content.
- The browser renders ↗ for `act` and ↳ for the rest. Rows are plain text in
  a real `<button>`; never Markdown or HTML.

The contract lives in two copies because platform-next does not import the
frontend: [`platform-next/src/modules/chats/followups.ts`](../platform-next/src/modules/chats/followups.ts)
and [`frontend/lib/suggestions.ts`](../frontend/lib/suggestions.ts). Both run
the same golden file, copied verbatim to
`test/support/followups-golden.json` in each package.

## Where the rule goes

prompt v5 is v4 with one appended rule. `chatPrompt` puts the rule **after**
the agent's own instructions, so a member-written agent prompt cannot sit
after it. v1–v4 are unchanged byte for byte. The rule asks for a slot-1 move
along `understand → locate → design → build → test → transport → operate`,
an answer-shape mix, one ask per row, the user's language, no yes/no
questions and no Markdown. See
[`platform-next/src/modules/chats/chat-prompt.ts`](../platform-next/src/modules/chats/chat-prompt.ts).

## What is stored

On the chat, once at creation: `followUps: "on" | "holdout" | "off"`. Chats
created before v5 have no field and are read as `off`.

On a run that suggested (only for a `completed` run in an `on` chat):

```json
{
  "followUps": {
    "status": "ok",
    "shape": "how-to",
    "stage": "build",
    "items": [{ "slot": 1, "intent": "act", "text": "Draft an ABAP report" }]
  }
}
```

`status` is `ok` (1–3 valid rows), `none` (a complete empty block), `missing`
(no complete block) or `invalid` (a block with rows, none valid). It is the
format-reliability signal per model.

A run started by a row also stores:

```json
{ "origin": { "source": "suggestion", "fromRunId": "<run id>", "slot": 1 } }
```

The send path validates only the shape (`fromRunId` is a wire ID, `slot` is
1–3) and writes the claim on the run insert it already does. **No extra
database read or write is added.** The report verifies the claim later against
the stored rows; a wrong run or slot counts as a typed message. A send that
becomes a steer stores no origin.

Every assistant reply is stripped of the block **before it is saved**, on
every settle path: the live stream end, history reconciliation of an
`uncertain` run, and recovery after a process died. A half-written block on a
stopped or failed run is stripped too. Rows are read from the last non-empty
answer of the run. `RunView` exposes only `followUps.items` (slot, intent,
text), and only while `FOLLOW_UPS` is on; status, shape and stage stay in the
database for the report.

## Show rules

Rows appear under the latest completed answer only, and:

- not while a reply is streaming, waiting on an approval, or the chat has an
  active run;
- not after a stopped or failed answer, or a read-only chat;
- not on older answers, or when a newer pending message exists;
- after a reload, because the rows come from the run.

The browser also hides the block during streaming with the same parser, so no
marker or row text flickers into view at a chunk boundary. Saved text is
already clean even if an older record still had a block.

## Switches

Read at chat creation, both in `platform-next/src/config/chat-config.ts`:

| Variable | Default | Meaning |
|---|---|---|
| `FOLLOW_UPS=on\|off` | `on` | Off gives new chats `off`, hides stored rows in every API view, and leaves stripping on. This is the kill switch. |
| `FOLLOW_UPS_HOLDOUT_PERCENT=0–50` | `0` | Share of new chats that get no rule and no rows. The draw happens once, inside chat creation; a retried first send keeps it. |

Invalid values stop startup with the problem named. A holdout assignment is
stored as `holdout`, never flips mid-chat, and is counted in the report's
comparison. Assignment groups: `on` (rule + rows), `holdout` (no rule, no
rows), `off` (feature disabled).

### Holdout plan

1. **Phase 0 (weeks 1–2):** holdout `0%`; every new chat shows rows so format
   problems surface quickly.
2. Once format failures are below 10% for every model in use, set the holdout
   to **10% for four weeks**. Assignment is per chat, fixed at creation.
3. If weekly new-chat volume is under ~500, four weeks will not separate the
   groups; extend the window rather than read noise.
4. The holdout comparison, not a guess, answers "do the rows help at all?".

## Report

```sh
npm run operator -- followups-report --operator <name> \
  --since 7d [--tenant <id>] [--min-sets 200] [--close 0.6]
```

- `--since` takes `d`, `h` or `m` (default `7d`).
- `--tenant` scans one ready tenant; otherwise every ready tenant is grouped
  into one set of counts.
- `--min-sets` hides agent/model, intent and full cells (agent × model ×
  answer shape × stage × intent) with fewer sets instead of printing tiny
  percentages. Totals and per-model format rates stay.
- `--close` is the word-set (Jaccard, NFKC, lowercase, stop words dropped)
  threshold at which a typed message counts as "typed something close".
- Read-only. It uses the partial index `followups_created` on runs
  (`{ createdAt: 1 }` where `followUps` exists), added at tenant index version
  6. Run `ensure-tenant-indexes --all` as a deploy step.
- **Privacy:** output is counts and rates only. It never prints a suggestion,
  a member's message, a member's name or a tenant name. Cross-tenant output is
  one aggregate; IDs are agent/model IDs, not names.

| Signal | How it is derived |
|---|---|
| Shown | A `completed` run with `followUps.status = "ok"`, once per run |
| Clicked | The next run in the chat has an origin that verifies against this run's stored rows |
| Typed instead | The next run has no verified origin; the overlap score is attached |
| Typed close | Word-set overlap ≥ `--close` with any row |
| Left | No next run within 30 minutes of the suggesting run's `completedAt` |
| Pending | No next run yet and the set is under 30 minutes old at the report's end; counted in `totals.pending` and left out of `sets` and every rate |
| Clicked turn went badly | The next run failed, was stopped within 15 s, or took a steer |
| Time to click | Next run's `acceptedAt` − suggesting run's `completedAt` (p50 / p90) |
| Format rate | `missing + invalid` over every run that stored `followUps`, per model |
| Holdout | Turns per chat, chats with ≥ 2 turns, stop rate, 7-day return, for `on` vs `holdout` chats. `return7Rate` is over `return7Chats`: chats at least 7 days old at the report's end |

`typedCloseRate` is close typed / typed; `clickRate` etc. are over shown sets.

## Decision thresholds (fixed before data arrives)

| Trigger | Action |
|---|---|
| Overall click rate < 5% after 2,000 shown sets | Reconsider the feature or its placement |
| An intent < 2% clicks for an agent | Drop it from that agent's mix (needs a per-agent override) |
| > 20% of clicked `act` turns go badly | Tighten the `act` rule |
| > 10% format failures for a model | Stop asking that model for rows, or use a separate-call fallback |
| "Typed close" rate > click rate | Rework the wording rules, not the intent mix |

Phases: 0 check it works (weeks 1–2) → 1 learn, report only (months 1–2) →
2 adapt per agent at ~200+ sets per agent → 3 personalise much later.

## Probes and quality eval

Both commands need a reachable model gateway and gateway secret. They write
dated JSON under `bench/`; nothing is sent anywhere else. Every prompt is a
fixed bench prompt, never member content.

```sh
MODEL_GATEWAY_URL=https://gateway.example \
MODEL_GATEWAY_SECRET=... \
FOLLOWUPS_BENCH_TENANT=<tenant id> \
npm run bench:followups -- --models <profileId,...>

MODEL_GATEWAY_URL=... MODEL_GATEWAY_SECRET=... \
FOLLOWUPS_BENCH_TENANT=<tenant id> \
npm run bench:followups-eval -- --models <profileId,...>
```

- `FOLLOWUPS_BENCH_TENANT` labels the token for the gateway's usage logs and is
  required by a profile whose prompt cache is tenant-scoped (the gateway
  otherwise refuses the request).
- The probe runs 22 prompts (every answer shape, two languages, a greeting,
  refusals, a question-ending answer) and reports per model: compliant share,
  `none` on none prompts, `missing`, `invalid`, median output tokens. A model
  is `keep` at ≥ 90%. The raw replies are saved for the manual read.
- The eval runs 40 prompts, including German cases and hostile agent
  instructions ("never add anything after your answer"). It scores format,
  anchoring, distinct intents, the slot-1 forward rule, language match and the
  no-yes/no rule. A model under 90% format compliance is listed for exclusion.
- Neither command runs in `npm test`; they make real model calls and cost
  tokens.

## Rollback

`FOLLOW_UPS=off` stops new chats from getting the rule and hides rows
everywhere immediately. Stripping continues, so saved answers stay clean.
Stored fields are additive (`chat.followUps`, `run.followUps`, `run.origin`);
older code ignores them and a code rollback needs no data change. The partial
index can stay.

A **code** rollback is the one case that loses stripping: a v5 thread keeps
the rule for the thread's life, and the older code saves whatever the model
writes. Prefer `FOLLOW_UPS=off` on the new code. If a code rollback is
unavoidable, stop letting v5 chats run before it; already-saved answers are
unaffected, but a reply settled by the older code is not cleaned later.

## Known limits and open questions

- Thresholds above are starting values (5% / 2% / 20% / 10%, 200 sets, overlap
  0.6, 30 min). Revisit before the first report-driven decision.
- v5 keeps the DEV ONLY "don't mention Kiro" sentence, copied from v4; remove
  it in the same version bump when the gateway is no longer a dev constraint.
- Model compliance is not yet measured in production: run the probe before
  relying on rows for every enabled model.
- Per-agent intent mixes and personalisation wait for the report (phase 2/3).
