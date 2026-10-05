# Cost tracking plan

Status: implemented on `feat/cost-tracking` (backend, API and UI receipt/activity panel), verified locally with a placeholder price. Not yet reviewed against real provider billing. Resolves `backlog.txt:8` ("cost in dollars per turn/session, needs per-model price table").

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

```text
Codex model call ──usage──▶ agent-core trace.onUsage ──turn.completed (spooled)──▶ platform store
                                  (also keep calls[])                                   │
                                                          price lookup (catalog) ◀──────┤
                                                                                        ▼
                                                              usage_requests (1 doc / model call)
                                                                       │ aggregate (index-backed)
                                                       per conversation ◀┴▶ per user / per period
```

### Collection 1: `truex_model_pricing` (catalog DB, shared across tenants)

Managed in MongoDB like `truex_models` (the repo has no seed command). One document per model **per price period**:

```json
{
  "_id": "price_gpt5_2026_10",
  "modelId": "<truex_models._id>",
  "currency": "USD",
  "inputPerMTok": "1.25",
  "cachedInputPerMTok": "0.125",
  "outputPerMTok": "10.00",
  "effectiveFrom": "2026-10-01T00:00:00Z",
  "effectiveTo": null,
  "note": "source URL / date verified"
}
```

- Rates are USD per 1M tokens, stored as **strings or Decimal128**, never JS floats.
- Index `{ modelId: 1, effectiveFrom: -1 }`. Reject overlapping periods for one model.
- Optional `cacheWritePerMTok` (Anthropic bills cache writes separately). Reasoning tokens: already counted inside output for the providers in use (verify per adapter, step 0). No separate field in v1.
- Why separate from `truex_models`: prices change over time and must not rewrite history. Why not per-tenant: one price list for everyone.

### Collection 2: `usage_requests` (tenant DB, source of truth)

One document per model call:

```json
{
  "_id": "<sessionId>:<turnId>:<callSeq>",
  "userId": "...", "sessionId": "...", "turnId": "...", "agentId": "...",
  "modelId": "...", "modelName": "...",
  "at": "ISO",
  "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0,
  "pricingId": "price_gpt5_2026_10",
  "rates": { "input": "1.25", "cachedInput": "0.125", "output": "10.00" },
  "costMicros": 12345,
  "costStatus": "priced",
  "source": "main"
}
```

- `costMicros` = integer micro-USD (1e-6). Integers avoid float drift when summing.
- Formula: `((input - cached) * rate.input + cached * rate.cachedInput + output * rate.output) / 1e6 tokens`, rounded once per request (not per component).
- **Rates are snapshotted onto the document.** Editing a price later never changes past costs.
- `costStatus`: `priced` | `unpriced` (no price period covers the model/time). Unpriced stores tokens and `costMicros: null`. **Never write 0 for "unknown."**
- `source`: `main` | `helper` (sub-agents). Helper usage today is summed without a model; step 0 decides whether helpers can be priced per call.
- Idempotent: deterministic `_id`, `insertOne` ignoring duplicate-key (E11000). A replayed `turn.completed` never double-counts.
- Indexes: `{ sessionId: 1, at: 1 }`, `{ userId: 1, at: 1 }`.

### Totals (v1: no new collection)

- **Per conversation:** aggregate `usage_requests` by `sessionId` (`$sum costMicros`, tokens, count, and a count of `unpriced`).
- **Per user:** aggregate by `userId` with `at` range (day or month).
- Single source of truth, so no drift and no reconcile job. Bounded by indexes.
- **Upgrade path (only if measured slow):** materialized rollups `usage_user_daily` (`_id = userId:YYYY-MM-DD`) updated with `$inc` only when the request insert succeeds. Do not build this up front.

### Code changes (smallest safe diff)

| Step | File | Change |
|---|---|---|
| 1 | `shared/contracts.ts` | Add `TurnTrace.calls?: { seq, at, usage: TokenCounts }[]`; add `modelId?` to trace. Optional fields, so older consumers keep working. |
| 2 | `agent-core/src/trace.ts` | In `onUsage`, also push the per-call counts into a **bounded** list (cap, e.g. 200/turn; record a `callsTruncated` flag if exceeded). Keep the existing summed `usage` unchanged. |
| 3 | `platform/src/pricing.ts` (new, small) | `resolvePrice(modelId, at)` with a short TTL cache; pure `costMicros(counts, rates)` function. |
| 4 | `platform/src/store.ts` | On `turn.completed`, after the trace upsert, build and insert `usage_requests` for each call. Add indexes to `tenantIndexes`. Failure to price or write **must not fail the turn**: log with ids and continue. |
| 5 | `platform/src/http.ts`, `public.ts` | `GET /api/sessions/:id/cost` (owner only), `GET /api/me/usage?from&to`. Reuse existing owner/tenant checks. Admin per-user view later. |
| 6 | `frontend/components/observability/*` | Show estimated cost per turn and a session total; label "estimated"; show "n unpriced" instead of a number when unpriced. |
| 7 | `docs/mongodb.md` | Document the two collections and how to add a price. |

## Acceptance criteria

1. A turn with 3 model calls produces 3 `usage_requests` and the session total equals their sum.
2. Replaying the same `turn.completed` (retry, spool re-delivery) produces **no duplicate** documents and no change to totals.
3. Changing a model's price creates a new period; previously stored costs are unchanged.
4. A model with no price yields `unpriced`, tokens still recorded, and totals show the unpriced count rather than treating it as zero.
5. A user can read only their own conversation and usage; tenant A cannot see tenant B (separate DBs).
6. Cached tokens are billed at the cached rate, not the input rate. A cost of exactly 0 tokens is `0`, not `null`.
7. Cost for a gateway-routed model and a direct Responses model are both recorded.
8. Pricing lookup failure or Mongo error does not fail, hang or lose the turn's final message.

## Break Mode: worst realistic failures

| Risk | Severity | Protection |
|---|---|---|
| Double counting on retry or re-delivered spool record | High | Deterministic `_id` + duplicate-key ignore; test by replaying events. |
| Silent zero cost for an unpriced or mistyped model, so spend looks lower than reality | High | `unpriced` status, never 0; count surfaced in API and UI; log warning per unpriced model. |
| Wrong formula (cached counted twice, reasoning double-billed) | High | Verify against each provider's usage semantics and compare with a real provider bill before trusting; unit-test the formula per provider. |
| Float drift in totals | Medium | String/Decimal128 rates, integer micro-USD costs. |
| Price edited after the fact rewrites history | Medium | Rates snapshotted on each request; price periods immutable (append new period). |
| Turn crashes or is interrupted mid-way, so its calls are never reported | Medium | Confirm a trace is emitted for failed/interrupted turns (step 0); otherwise cost under-reports. State this as a known limit. |
| `calls[]` grows unbounded on a long tool loop | Medium | Cap per turn with a truncated flag. |
| Cost write slows or blocks the event handler | Medium | Single `insertMany` with `ordered: false`; errors logged, never thrown into the turn path. |
| Cross-tenant or cross-user leakage | High | Reuse existing owner/tenant guards; tests for both. |
| `userId` missing on old sessions | Low | Such rows are attributed to the session only; the user view skips them and reports a count. |
| Users read "cost" as an invoice | Low | Label "estimated"; provider bill is authoritative. |

## Rollout and compatibility

- All changes are **additive** (optional contract fields, new collections). Old and new platform/agent-core versions can run together: old agent-core sends no `calls`, so nothing is recorded for those turns.
- Order: add pricing docs in Mongo, deploy platform (ignores missing `calls`), then deploy agent-core. Rollback = redeploy previous versions; the new collections are inert.
- Historical turns: optional one-off backfill from `traces.usage` as **turn-level** rows (marked `source: "backfill"`, calls unknown). Skip unless needed for history.

## Test plan

- Unit: `costMicros` (cached split, zero, huge counts, rounding, missing fields); price-period lookup boundaries (`effectiveFrom` inclusive, `effectiveTo` exclusive).
- Integration (Mongo): replay idempotency; unpriced path; owner and tenant isolation; aggregation totals; index use.
- Agent-core: `onUsage` produces `calls[]` and still the same summed `usage`; cap behavior.
- End to end: one real turn on a priced model, compare tokens and cost with the provider's usage page.

## Observability

Structured log per turn: `{ sessionId, turnId, calls, pricedCalls, unpricedCalls, costMicros }`. Warn when `unpriced > 0` with the model id. Metric: unpriced request rate, and cost-write failure rate.

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
