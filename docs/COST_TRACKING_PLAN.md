# Cost tracking plan

Status: implemented on `feat/cost-tracking` (backend, API and UI receipt/activity panel), verified locally with a placeholder price. Revised: cost is now stored on the turn's own trace and a session's totals on the session (see Design); the earlier per-request `usage_requests` collection was removed. Not yet reviewed against real provider billing. Resolves `backlog.txt:8` ("cost in dollars per turn/session, needs per-model price table").

## Problem

The platform records token counts per turn but no money. We need:

1. A collection of **actual model prices** (per model: input, cached-input and output cost, plus id).
2. A **cost calculated for every model request**.
3. A **total per conversation**.
4. That spend **tracked against a user**.

## What exists today (verified in code)

| Fact | Where |
|---|---|
| Codex reports usage per model call; agent-core **sums** the calls into one `TurnUsage` per turn | `agent-core/src/trace.ts:272` (`onUsage`) |
| Per-turn trace is persisted on `turn.completed`, idempotent upsert `_id = ${sessionId}:${turnId}` | `platform/src/store.ts:445` |
| Final records are spooled to disk by agent-core and consumed by the platform independent of browser streams | README, Features |
| `inputTokens` includes cached tokens (goal budget uses `input - cached + output`) | `agent-core/src/manager.ts:201` |
| Model profiles live in the **shared catalog DB** (`truex_catalog.truex_models`); sessions and traces live in the **per-tenant DB** | `platform/src/store.ts:313`, `:154` |
| Session has an immutable `userId`; model override is in `settings.model` | `shared/contracts.ts:81-96` |
| Trace stores only the model **name** (`model?: string`), not the profile id | `shared/contracts.ts:465` |
| Gateway sees usage per request, but only for gateway-routed profiles and has no user id (token carries `profileId` + `tenantId`) | `model-gateway/src/logging.ts`, `shared/gateway-token.ts` |

**Design consequence:** compute cost from agent-core's per-call usage, not the gateway, so direct Responses profiles and AgentCore runtimes are covered. Carry the per-call list inside the existing trace so it reuses the existing durable handoff.

## Design

Cost lives where the turn already lives. There is no second collection of token counts to drift from the first.

```text
Codex model call ──usage──▶ agent-core trace.onUsage ──turn.completed (spooled)──▶ platform
                                 (also keeps calls[])                                  │
                                                                                       ▼
                                     price the turn once: priceTrace(trace, model, prices)
                                     │                                  │
                  live SSE relay ◀───┤                                  ├───▶ traces  (trace.cost, calls[].costMicros, userId)
          (tokens + cost, one event) │                                  └───▶ sessions (usage: running totals, $inc once per turn)
```

One pure function, `priceTrace` in `platform/src/costs.ts`, prices a finished turn. The live stream and the stored copy both call it, so the cost the browser shows on the receipt is the cost that was saved.

### Collection: `truex_model_pricing` (catalog DB, shared across tenants)

Managed in MongoDB like `truex_models` (the repo has no seed command). One document per model **per price period**, matched by the provider's model name:

```json
{
  "_id": "price_sonnet_2026_10",
  "modelName": "claude-sonnet-5",
  "currency": "USD",
  "inputPerMTok": "3",
  "cachedInputPerMTok": "0.3",
  "cacheWritePerMTok": "3.75",
  "outputPerMTok": "15",
  "effectiveFrom": "2026-10-01T00:00:00.000Z",
  "effectiveTo": null,
  "note": "source URL / date verified"
}
```

- Rates are USD per 1M tokens, stored as **strings**, never JS floats. Cached-input and cache-write default to the input rate.
- Index `{ modelName: 1, effectiveFrom: -1 }`. `effectiveFrom` is inclusive, `effectiveTo` exclusive.
- Prices change over time and must not rewrite history, which is why they are separate from `truex_models`.

### On the trace (`traces`, tenant DB)

`trace.cost` is the turn's total, summed over every request of the turn (main and helper):

```json
{
  "costMicros": 30063, "requests": 1, "unpricedRequests": 0,
  "inputTokens": 7431, "cachedInputTokens": 0, "cacheWriteInputTokens": 0,
  "outputTokens": 518, "reasoningOutputTokens": 0,
  "modelName": "claude-sonnet-5"
}
```

- Each entry of `trace.calls[]` also carries its own `costMicros`, `pricingId` and a `rates` snapshot, so editing a price later never changes past costs.
- `costMicros` is integer micro-USD. Formula: plain input, cached and cache-write tokens at their own rates plus output tokens, rounded once per request (half up).
- A request with no usable price has `costMicros: null` on the call and is counted in `unpricedRequests`. **Never write 0 for "unknown."** A turn with unpriced requests shows "unpriced", not a number it cannot know.
- A runtime that reports no `calls[]` (older agent-core) is priced from the turn's sums as one main and one helper request, without a cache-write split.
- The trace also stores the session owner's `userId`, with indexes `{ userId: 1, startedAt: 1 }` and `{ startedAt: 1 }`.
- Public API: `publicTrace` projects only the totals above. `modelName`, prices, rates and `calls` never leave the platform.

### On the session (`sessions`, tenant DB)

`session.usage` holds the conversation's running totals: `turns`, `costMicros`, `requests`, `unpricedRequests` and the token sums, plus `turnIds`, an internal replay guard that is never public.

- Updated in `Store.persist` on `turn.completed`, with one `updateOne` filtered on `"usage.turnIds": { $ne: turnId }` and an atomic `$inc` plus `$push`. A replayed event finds its turn already counted and changes nothing, the same pattern as `timings`.
- The trace upsert and the session `$inc` are separate writes. Both are safe to repeat, so a failure between them is repaired by the redelivery of the same record.

### Totals

- **Per conversation:** `GET /api/sessions/:id/cost` returns the stored `session.usage` (or sums the session's traces for a conversation that has none yet) and each turn's cost.
- **Per user and for admins:** aggregated from `traces` by `userId` and `startedAt`, with a per-model and per-day split (`GET /api/me/usage`, `GET /api/usage/users`). Traces from before cost was recorded are not counted until `npm run rebuild:usage` prices them.

### One event for tokens and cost

The browser used to get tokens in the live `turn.completed` event and then fetch cost separately, so cost appeared late. Now `PublicEventStream` takes a `prepare` hook that sees each raw runtime event before it is made public. For a finished turn it calls the open stream's `livePricer`, which holds the session's model and that model's price list (loaded when the stream opens and again at `turn.started`), so pricing is synchronous and adds no database wait. If pricing fails the event is sent without a cost; the stored trace still gets one.

A reload must show the same costs as before. The runtime never prices anything, and the page receives traces from three places: the stored traces (`GET /traces`), the conversation load (`GET /api/sessions/:id`) and the live stream's first `snapshot` event. The last two come from the runtime, so the platform prices them too (`livePricer`, `pricedSnapshot`), and a turn that is already stored shows the cost it was stored with, not a new price. Without this a reload replaced stored costs with the runtime's unpriced copies. The browser's `mergeTraces` also never lets a trace without a cost replace one that has it.

### Code changes

| File | Change |
|---|---|
| `shared/contracts.ts` | `UsageCall` gains `costMicros`, `pricingId`, `rates`; `TurnTrace.cost` (`TraceCost`); `Session.usage` (`SessionUsage`); shared `CostTotals`. |
| `agent-core/src/trace.ts` | Keeps a bounded `calls[]` (cap 200, `callsTruncated` flag) next to the unchanged summed `usage`. |
| `platform/src/costs.ts` | Pure `priceTrace`, `stampEvent`, `usageIncrement`, `costMicros`, `priceIn`; `Costs.stamp` (stored path), `Costs.livePricer` (live path), `sessionCost`, `userUsage`, `allUsersUsage`. |
| `platform/src/service.ts` | `ingest` stamps the cost, then persists, passing the owner. |
| `platform/src/store.ts` | `persist` stores `userId` on the trace and applies the guarded session `$inc`; new trace indexes. |
| `platform/src/public.ts` | `publicCost` allowlist; `PublicEventStream` `prepare` hook (best effort: a failure never drops the event). |
| `platform/src/index.ts` | Opens a `livePricer` per event stream. |
| `frontend/app/page.tsx` | Removes the separate cost fetch and merge; the receipt reads `trace.cost`. |
| `scripts/rebuild-usage.mjs` | Prices traces that lack a cost, gives traces their owner, rebuilds each session's `usage`. |

### Repair and backfill

`npm run rebuild:usage` is a dry run; `npm run rebuild:usage -- --confirm rebuild-usage` applies it to every tenant database. It prices only traces that have no cost (recorded rates are never rewritten), and it writes a session's `usage` only when it differs from what the traces add up to, so running it again changes nothing. Run it while the platform is idle.

The `usage_requests` collection from the first version of this work is no longer read or written. Any existing copy is left in place; drop it once nothing needs it.

## Acceptance criteria

1. A turn with 3 model calls stores 3 priced entries in `trace.calls`, `trace.cost` equals their sum, and the session total equals the sum of its turns.
2. Replaying the same `turn.completed` (retry, spool re-delivery) changes neither the trace nor the session totals.
2a. The turn's tokens and cost arrive in the same live event.
3. Changing a model's price creates a new period; previously stored costs are unchanged.
4. A model with no price yields `unpriced`, tokens still recorded, and totals show the unpriced count rather than treating it as zero.
5. A user can read only their own conversation and usage; tenant A cannot see tenant B (separate DBs).
6. Cached tokens are billed at the cached rate, not the input rate. A cost of exactly 0 tokens is `0`, not `null`.
7. Cost for a gateway-routed model and a direct Responses model are both recorded.
8. Pricing lookup failure or Mongo error does not fail, hang or lose the turn's final message.

## Break Mode: worst realistic failures

| Risk | Severity | Protection |
|---|---|---|
| Double counting on retry or re-delivered spool record | High | Trace upsert is idempotent; the session `$inc` is guarded by `usage.turnIds`. Tested by replaying events, including concurrently. |
| Silent zero cost for an unpriced or mistyped model, so spend looks lower than reality | High | `unpriced` status, never 0; count surfaced in API and UI; log warning per unpriced model. |
| Wrong formula (cached counted twice, reasoning double-billed) | High | Verify against each provider's usage semantics and compare with a real provider bill before trusting; unit-test the formula per provider. |
| Float drift in totals | Medium | String/Decimal128 rates, integer micro-USD costs. |
| Price edited after the fact rewrites history | Medium | Rates snapshotted on each request; price periods immutable (append new period). |
| Turn crashes or is interrupted mid-way, so its calls are never reported | Medium | Confirm a trace is emitted for failed/interrupted turns (step 0); otherwise cost under-reports. State this as a known limit. |
| `calls[]` grows unbounded on a long tool loop | Medium | Cap per turn with a truncated flag. |
| Cost stamping slows or blocks the event handler | Medium | Prices come from one small per-model query; a database error leaves the record unacknowledged so it is redelivered. The live relay never waits on the database. |
| Trace and session totals disagree after a partial failure | Medium | Both writes repeat safely; `npm run rebuild:usage` recomputes the session from its traces. |
| Cross-tenant or cross-user leakage | High | Reuse existing owner/tenant guards; tests for both. |
| `userId` missing on old sessions | Low | Such rows are attributed to the session only; the user view skips them and reports a count. |
| Users read "cost" as an invoice | Low | Label "estimated"; provider bill is authoritative. |

## Rollout and compatibility

- All changes are **additive** (optional contract fields and new indexes). Old and new platform/agent-core versions can run together: an old agent-core sends no `calls`, so its turns are priced from the turn sums.
- Order: add pricing docs in Mongo, deploy platform (ignores missing `calls`), then deploy agent-core. Rollback = redeploy previous versions; the extra fields on traces and sessions are ignored.
- Historical turns: `npm run rebuild:usage` prices them from `traces.usage` as turn-level requests (no cache-write split).

## Test plan

- Unit: `costMicros` (cached split, zero, huge counts, rounding, missing fields); price-period lookup boundaries (`effectiveFrom` inclusive, `effectiveTo` exclusive).
- Integration (Mongo): replay idempotency (concurrent too); unpriced path; owner isolation; session, user and admin totals; index use; the rebuild script (dry run, apply, repeat).
- Agent-core: `onUsage` produces `calls[]` and still the same summed `usage`; cap behavior.
- End to end: one real turn on a priced model, compare tokens and cost with the provider's usage page.

## Observability

Structured log per turn: `{ sessionId, turnId, calls, unpricedCalls, truncated }`. Warn when `unpriced > 0` with the model id. Metric: unpriced request rate, and cost-write failure rate.

## Decisions (confirmed)

1. **Currency and scope:** USD only, one global price list shared by all tenants.
2. **Prices are managed directly in MongoDB** (no admin UI in v1).
3. **Helper (sub-agent) usage** is priced with the same model as the main agent.
4. **Views:** a user sees only their own usage; an admin sees a usage report across all users. (An admin report across tenant DBs needs fan-out.)
5. **Spend limits or alerts** (stop a user at $X) are **out of scope**. Existing token budgets stay as they are.
6. **Work happens on branch `feat/cost-tracking`** and is tested locally before anything is deployed.

## Step 0 (before coding): verify, don't assume

1. Confirm `thread/tokenUsage/updated` fires once per model call and does not repeat the same `last` (duplicate notifications would inflate cost). Log one real turn and inspect.
2. Confirm per provider that `inputTokens` includes cached and `outputTokens` includes reasoning (OpenAI vs Anthropic vs Gemini adapters in `model-gateway/src/adapters/`).
3. Confirm failed and interrupted turns still emit a trace on `turn.completed`.
4. Confirm how to get the model profile **id** for a turn (agent config vs `session.settings.model` override).

## Step 0 results (local test, 2026-10-05, claude-sonnet-5 via gateway)

| Check | Result |
|---|---|
| 1. Usage notifications fire once per model call, no repeats | **Confirmed.** A 1-call turn gave 1 notification; a 3-call tool turn gave 3. Each matched the gateway's per-request token counts exactly (7518/0, 7605/0, 7708/65). Sum of `last` equals the stored turn usage. |
| Cross-check available | Each notification also carries cumulative `total` for the thread; it equals the sum of all prior `last` values. Useful to detect missed or duplicated calls. |
| 2. Cached/reasoning semantics | Anthropic path: `inputTokens` is the full input, `cachedInputTokens` was 0 in every call. **Not yet verified with a cache hit**, nor for Gemini. Do not finalize the cached-rate formula until a cached call is observed. |
| New finding: `cacheWriteInputTokens` | Codex usage carries `cacheWriteInputTokens`, but `countsOf` in `agent-core/src/trace.ts` drops it and `TokenCounts` has no field for it. Anthropic bills cache writes at a different rate, so add it (and `cacheWritePerMTok` in pricing). |
| 3. Failed/interrupted turns emit a trace | **Not checked yet.** |
| 4. Model id for a turn | **Stored traces have no `model` (it is `undefined`).** The model profile id must come from the session/agent resolution, or be added to the trace at write time. Decide in step 1. |

Also observed: no prompt caching was used (about 7.4k uncached input tokens on every call), so measured cost on Anthropic is currently the uncached price. That is a separate optimisation, not part of this plan.

## Out of scope

Budgets and cutoffs, invoices, tax, currency conversion, per-tool cost, billing-grade reconciliation with provider invoices.
