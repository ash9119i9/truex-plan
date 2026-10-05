# T3-inspired chat performance implementation

This records the first history-loading pass. The subsequent [rendering pass](performance/t3-chat/RENDERING.md) ports the virtualizer, streaming parser, sidebar shelf and ordered stream batching, with separate matched before/after measurements and current verification results.

Implemented against Truex baseline `e44b79e9c5eea2b5de000a0cfca6ffff8a5821ec`, after inspecting local T3 Code commit `cf3e714b0f58e29c8fa8660db50d2187e3263b65`. The [original review](T3_CODE_PERFORMANCE_REVIEW.md) records the inspected T3 mechanisms and their source locations. Three GPT-6.1-Sol agents handled backend recovery, chat rendering, and cache/review work.

## What changed

- **Paint saved history before runtime recovery.** An authorized `persisted=1` read has no runtime calls or writes. The selected chat and its own loading state change immediately. Recovery continues separately; shared initial/resync work avoids a second full recovery from the initial stream snapshot.
- **Recent history and anchored older pages.** `window=1` loads ten ordinary user request groups; “Load earlier messages” requests twenty older groups. Opaque cursors anchor conversation order rather than timestamps. Windowed snapshots retain recent/active messages and reasoning, preserving pending actions, goals, plans and state. Older pages preserve the visible row and offset.
- **Retain thread views.** A page-owned cache retains up to sixteen conversations with five-minute idle expiry and an approximate 16 MiB serialized-size budget. Returning restores the transcript, unsent draft, expanded history and scroll anchor before revalidation. Cached pending actions are never restored. Mutating controls wait for recovery, authorization failures clear the view, and bfcache restores reload for fresh account context.
- **Isolate rendering.** Memoized message groups, answer bodies and sidebar, stable callbacks and unchanged-row references avoid reparsing settled Markdown when typing or updating another row. Indexed hydration replaces repeated transcript-wide identity searches while preserving aliases, ordinals and legacy adoption rules.
- **Batch recovery work.** Runtime history pages use batched identity lookups and ordered Mongo writes. Tenant/user/role/visibility-scoped recovery shares only currently active work. Every caller still authorizes independently. Detail responses expose `Server-Timing`; durable detail/timing/trace reads use private, no-store responses.

These apply T3's verified recent-window, retained-view, stable-row and state-ownership patterns to Truex's existing API and React state. The size budget and Mongo reconciliation batching are Truex-specific improvements, tested against original behavior. No dependency, storage schema, framework, or provider changes were made.

## Before and after

All measurements below use synthetic fixtures on the same Mac. They are not production or provider-latency claims, and they do not measure T3's installed application.

| Measurement                        |           Before |          After | Scope                                                                                            |
| ---------------------------------- | ---------------: | -------------: | ------------------------------------------------------------------------------------------------ |
| Warm A/B chat revisit median       |         636.2 ms |        31.8 ms | Visible browser, production builds, three warm samples                                           |
| Cold A/B history paint             | 634.7 / 645.9 ms | 51.9 / 65.7 ms | Two separate cold threads; recovery continues afterward                                          |
| 1,000-message chat first paint     |           863 ms |        47.5 ms | One browser sample per version; mounts 1,000 versus 20 rows                                      |
| 1,000-turn full recovery median    |        909.03 ms |      278.91 ms | Latest sequential reproduction; actual isolated Mongo, synthetic 8 ms owner calls, three samples |
| Complete / recent durable response |    396,188 bytes |    4,386 bytes | Same after-run modes, 2,000 versus 20 messages; 98.9% smaller                                    |
| 10,000-message hydration median    |       141.087 ms |       5.166 ms | CPU helper only; same harness, five samples                                                      |

The browser fixture holds ordinary runtime recovery at 600 ms and durable reads at 15 ms to distinguish painting from synchronization. “Paint” means target transcript DOM appeared followed by two animation frames in a visible 1280×800 tab. Background-tab frame-throttled experiments were excluded. Small sample counts are retained explicitly; these are development measurements, not a production p95 estimate.

Raw results and runnable fixtures: [backend](performance/t3-chat/README.md), [hydration](performance/t3-chat/FRONTEND_HYDRATION.md), [browser](performance/t3-chat/BROWSER.md), [browser JSON](performance/t3-chat/browser-results.json).

## Verification and adversarial checks

- Root `npm test`: 172 agent-core, 162 platform and 58 gateway tests pass; no skips.
- `npm --prefix frontend test`: 216 tests pass; no skips.
- Builds pass for agent-core, platform, model-gateway and the frontend production webpack build. Frontend type checking passes.
- `git diff --check` passes. The repository-wide formatter still reports 61 files that already failed in the baseline; no new formatting failures were introduced.
- Real isolated Mongo tests cover authorization/tenant isolation, independent caller authorization, shared recovery and retry after failure, ordered partial-write retry, identities/aliases, durable acknowledgements, unchanged legacy responses, equal-time ordering, command anchors, inserted new history and stale/cross-session cursors.
- Frontend regressions cover unchanged row identities, duplicate/legacy identities, old-page overlap, repeated pages, steering with reused turn IDs, stale saved data versus newer live final/delta text, cached partial finalization, cache budgets/TTL and failed shared-read retries.
- Browser checks cover rapid A→B switching with late A responses, denied cached-thread revalidation, draft restoration, older-page prepend, shared recovery while newer text/state arrives, automatic reconnect, and manual reconnect recovering a durable user message absent from the live snapshot. The prepend anchor moved 0.1875 CSS pixels in the measured fixture.

Adversarial review found and corrected stale history truncating a newer streamed answer, freshness being incorrectly reset by callers joining a recovery flight, manual reconnect skipping its durable catch-up, cached mutation controls, stale goal-action callbacks, and bfcache account replay. Recovery freshness belongs to the original shared promise and navigation generation, rather than the joining caller.

## Boundaries and rollout

Database history still loads and orders the complete transcript before selecting its window. Platform SSE projection still receives/parses the full upstream snapshot. Whole user groups, a giant individual turn and command-only histories have no unconditional byte cap. At the end of this first pass, expanded old history mounted its loaded rows. The subsequent [rendering pass](performance/t3-chat/RENDERING.md) implements the T3 LegendList virtualizer and web fixes, goal jumps and approval-card placement.

Drafts and retained views are in memory only, and disappear on reload. This pass does not introduce IndexedDB, a new event-sourcing framework, metadata shell streams, or a production deployment. The cold-path first paint is fast even with a slow runtime, but mutating controls still wait for recovery and its existing timeout.

The API is additive: clients without query parameters retain full-history behavior. Deploy backend before frontend for the performance benefit; old clients still work. Rollback uses the prior application code with unchanged stored data and requires no migration. After a real rollout, compare history Server-Timing, response bytes, duplicate recovery calls, browser interaction latency, error rates and memory with representative accounts. Fixture results alone do not establish production performance.
