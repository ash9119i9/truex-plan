# Implementation Plan: Chat observability card (DESIGN-SPEC 12.8)

Added 2026-10-30 · Idea: `docs/ideas/chat-observability-card.md` · Tasks: `tasks/chat-observability-todo.md`

## Overview

Bring the receipt line and trace card (`frontend/components/tenant/receipt.tsx`) to spec parity with `system/DESIGN-SPEC.md` 12.8. Everything lives in one stored **run trace record** on `RunDoc`, which the Activity Panel Insights tab (14.8) will later read too. Three sources fill it:

- **Slice A:** runtime-adapter step timings, the context snapshot it already sends, and Codex compaction.
- **Slice C:** a server-side privacy scan.
- **Slice B:** a model-gateway meter for context layers and the admin-only Model context tab.

## Existing flow (2026-10-30)

```text
Codex item/* + thread/tokenUsage/updated
  → runtime-adapter Run (runtime/run.ts, runtime/chat.ts)
      emits tool.completed{durationMs}, command.completed{durationMs},
      usage{last,total,turn,contextWindow}, compaction{itemId}, run.completed{timings,usage}
  → platform-next run-executor.ts
      keeps usage via turnUsageOf (drops last + contextWindow), tool/command durationMs
  → RunDoc {usage, timings{acceptedAt,dispatchedAt,firstTextAt,completedAt}, helperCount}
  → frontend lib/tenant-chat.ts parseRun → Receipt / TraceCard
```

Facts the tasks rely on:
- Tool and command items already carry `durationMs` (`runtime-adapter/src/runtime/run.ts:421`, `platform-next/src/modules/chats/chat-store.ts:216`). Reasoning and message items carry no timing.
- `usage.contextWindow` and `usage.last` arrive from runtime-adapter (`runtime/chat.ts:1099`). `turnUsageOf` drops them (`run-executor.ts:2192`).
- runtime-adapter's `run.completed.timings.completedAt` is when the turn ended. platform-next's `timings.completedAt` is when the run settled (`chat-store.ts:671`). Their difference is **Finalize**.
- Codex offers `thread/compact/start` and `thread/compacted` (`docs/protocol.md:49`, `:249`). Neither runtime-adapter nor platform-next exposes it. The frontend `/compact` slash command (`frontend/lib/slash-commands.ts:127`) names the method but has no route behind it.
- Gateway token claims are `{p: profileId, t: tenantId}` only (`shared/gateway-token.ts:18`, signed in `platform-next/src/modules/chats/chats.service.ts:1636`). No run id reaches the gateway.
- runtime-adapter never keeps tool result text (`runtime/run.ts:393`), so a privacy scan of tool results has to run there.
- The access token carries the member's `role` (`platform-next/src/modules/sessions/access-token.ts:37`), which is enough for an admin gate.

## Architecture Decisions

- **One record, optional fields.** New `RunDoc` fields (`steps`, `context`, `timings.longestGapMs`, `timings.turnCompletedAt`, `privacy`) are all optional. This is an expand-only change with no migration, and old runs render only what they have (frontend Task 21 rule: no placeholders).
- **Steps come from runtime-adapter**, the layer that sees every Codex item. Each step is `{itemId, kind, startMs, endMs}`, with times relative to `acceptedAt`. No text or arguments are kept. Steps are capped per run, and the rest merge into one overflow step with a count.
- **The trace stays a settled-turn view.** The receipt appears at the end of a settled turn (spec 12.8), so steps are delivered in `run.completed` and stored at settle. Live streaming of steps belongs to the Activity Panel and is out of scope.
- **Compaction is Codex's.** Truex only routes `thread/compact/start` and maps its outcomes onto the spec's four button states.
- **Privacy findings are kinds plus a step, never values.** A run gets `privacy.scanned: true` only when the scan ran, and the empty state shows only then.
- **Model context is live-only and admin-only.** Numbers (layer token counts) are stored on the run. The masked preview stays in gateway memory with a time limit and is never written to MongoDB or logs.
- **"Where it went" is labelled estimated.** Output tokens per model call are credited to the items that call produced. Input tokens are not split by step.

## Task List

### Phase 0: Probes (fail fast)
- [ ] Task 1: Probe the pin for item timing and compaction behaviour
- [ ] Task 2: Probe how a gateway request maps to a run and to request sections

### Checkpoint: Probes
- [ ] Findings written into the todo; tasks adjusted where a probe disproved an assumption
- [ ] Review with human before Phase 1

### Phase 1: Slice A, run trace record
- [ ] Task 3: Receipt copy, Rate, turn number and number format (frontend only)
- [ ] Task 4: Store the context snapshot the adapter already sends
- [ ] Task 5: Context jar fill with 75% / 90% lines and tip
- [ ] Task 6: runtime-adapter step timings in the contract
- [ ] Task 7: platform-next stores steps, Longest gap and Finalize

### Checkpoint: Record in place
- [ ] All package checks pass; a reloaded run returns steps, context and timing

### Phase 1 (cont.)
- [ ] Task 8: Steps waterfall, legend, table twin and summary sentence
- [ ] Task 9: Compact route through runtime-adapter and platform-next
- [ ] Task 10: Compact button with its four states
- [ ] Task 11: Token slip artwork

### Checkpoint: Slice A complete
- [ ] Trace tab matches spec 12.8 for every Slice A element in light and dark
- [ ] Review with human before Slice C

### Phase 2: Slice C, privacy
- [ ] Task 12: runtime-adapter privacy scan and `privacy` contract field
- [ ] Task 13: platform-next stores findings per step
- [ ] Task 14: Receipt privacy pill and trace Privacy section

### Checkpoint: Slice C complete
- [ ] Findings appear for a fixture with personal data; no matched value in DB, events or logs

### Phase 3: Slice B, gateway meter
- [ ] Task 15: Gateway token carries the run id
- [ ] Task 16: Gateway counts request sections and keeps a masked preview
- [ ] Task 17: platform-next stores layers and serves the Dev preview to admins
- [ ] Task 18: Jar layers, Trace / Model context tabs and the Dev tab
- [ ] Task 19: "Where it went" estimate by step kind

### Checkpoint: Complete
- [ ] Every 12.8 element is on screen with real data
- [ ] Jar layers sum to reported input tokens within rounding on each provider adapter
- [ ] Model context hidden from non-admin members (server-enforced)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The pin doesn't send `item/started` for reasoning or message items | High (waterfall incomplete) | Task 1 probe. Fallback: derive a reasoning step from delta arrival in runtime-adapter, labelled as such |
| Long turns make `steps[]` large | Medium | Cap per run with an overflow step; Task 7 measures document size at 500 items |
| Gateway runs as several instances, so an in-memory preview misses | Medium (Dev tab empty) | Task 2 decides; "Captured for live turns only" already allows a miss; show "Not captured" instead of an error |
| Section split differs per provider adapter | Medium | One fixture per adapter in Task 16; scale to reported input tokens |
| Privacy scan overclaims | Medium (misleading) | Empty state only when `scanned`; wording names pattern checks |
| Model context exposes instructions | High (data exposure) | Admin role checked in platform-next; masked server-side; never stored or logged; tests for the 403 |
| Compaction during a running turn | Low | platform-next refuses while a run is active (button shows "Wait for the reply") |

## Open Questions

- Model context: admin role only, or also a per-member dev-mode flag? (Plan assumes admin role.)
- Compact: trace card only, or also elsewhere once the jar passes 75%? (Plan builds the trace card only.)
- Privacy empty-state wording. Proposed: "No personal data patterns found in what it read."
