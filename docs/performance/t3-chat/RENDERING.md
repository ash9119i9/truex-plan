# T3 chat rendering: implementation and measured verification

This second pass compares the preserved first-pass Truex build at
`/tmp/truex-chat-render-before` with the current application. The earlier
[history-loading results](../../T3_CHAT_PERFORMANCE_IMPLEMENTATION.md) compare
against the original Git baseline; these are separate comparisons.

## Measurements

Same Mac, visible 1280×800 native T3 preview, production webpack builds,
same [API fixture](browser-fixture.mjs), and identical
[browser probes](browser-render-probes.mjs) on both builds. Durable reads take
15 ms and recovery takes 600 ms in the fixture. Timing starts at the sidebar
click and ends when the destination transcript is present on an animation frame.

| Measurement                                                                |   Before |   After |
| -------------------------------------------------------------------------- | -------: | ------: |
| Cached revisit of a fully loaded 1,000-message transcript, median of three | 133.5 ms | 33.7 ms |
| Mounted message rows with all 1,000 messages loaded                        |    1,000 |      10 |
| Mounted sidebar rows, three Today and 500 Earlier sessions                 |      503 |      13 |
| Cursor storage writes for the same 1,000 SSE deltas                        |    1,000 |       1 |
| Exact 1,000-character streamed answer                                      |     Pass |    Pass |
| Visible visualization initialization after DOM reordering                  |  2 loads |  1 load |

The three cached long-chat samples were 154.6/133.5/128.6 ms before and
38.3/33.7/25.8 ms after. Raw results, including the initially cold A switch,
are in [browser-render-results.json](browser-render-results.json). The small
development sample establishes an improvement in this controlled fixture; it
does not establish production p95, provider performance, or parity with T3's app.
Mounted-row counts measure rendering work, not session metadata network latency.
DOM mutation observers are not React render counters: React also combined the
original immediate SSE burst into a small number of DOM updates. No claim of
1,000 fewer React renders is made.

Separately, [the streaming Markdown benchmark](STREAMING_MARKDOWN.md) measured
the same intermediate HTML hashes: code-heavy total render median
180.54→55.27 ms and parsed characters 1,754,181→134,286. The prose control showed
no measured improvement, so this optimization activates only for streamed fences.

## Verified T3 mechanisms and adaptations

Reference clone: `/Users/ashok/t3code`, commit
`cf3e714b0f58e29c8fa8660db50d2187e3263b65`.

| T3 source                                                                                                                                             | Truex implementation                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/chat/MessagesTimeline.tsx:1340` uses LegendList, 90 px estimate, stable row identities, and follow/visible-position policies | `frontend/components/chat-messages.tsx` owns the actual scroll viewport, virtual rows, global turn/receipt anchors, history header and approval footer                   |
| `apps/web/src/markdown-incremental.ts` and `ChatMarkdown.tsx`                                                                                         | MIT-attributed incremental parser; caches completed top-level fenced prefixes, parses changing suffixes, falls back for unsafe syntax, full-parses final answers         |
| `apps/web/src/components/Sidebar.tsx:1074`, `:1750`, `:2883`                                                                                          | Memoized rows, content visibility, ten initial Earlier rows, 25 more per expansion, selected-row exemption even while collapsed                                          |
| `packages/client-runtime/src/state/threads.ts:458` and `:931` apply ordered chunks before acknowledging cursor progress                               | Truex adapts individual SSE frames into ordered batches; synchronous model refs apply before checkpointing; final/snapshot/action/status frames flush preceding deltas   |
| `ChatView.tsx:6373` and `:6460` guard user intent and delayed scroll corrections; prepared timelines are cached while cold destinations load          | Bounded navigation cache, guarded index/DOM anchor restoration, manual wheel/touch/pointer/keyboard cancellation, read-only retained transcript during uncached switches |
| `patches/@legendapp__list@3.3.5.patch:1517` web fixes                                                                                                 | Exact pinned 3.3.5; copies only state-preserving `moveBefore` and normalized temporary padding into both web bundles, preserving the MIT notice                          |

The sidebar keeps Truex's Today/Earlier product semantics rather than inventing
T3's settled/snoozed lifecycle. Today remains unbounded. SSE paint scheduling
is a Truex adaptation; T3's state layer batches stream chunks without that timer.
Truex remounts one list per conversation identity to isolate its layout state;
T3 retains one list and refreshes its identity/version. It does not keep sixteen
mounted transcripts. These implementation differences are explicit.

## Acceptance and failure checks

- Loading all 25 older pages retains all 1,000 entries while mounting 10 rows;
  the latest answer remains present. One measured prepend preserved an anchor at
  82 CSS px before and after.
- Cached reading position was -128 CSS px before and after revisiting the chat.
  An earlier browser check exposed reversed initial index offsets and remount
  animations; both were fixed before the final measurements.
- Goal “View turn” found and focused a loaded offscreen turn, placing it at
  12 CSS px. It was absent from the DOM before the click. Streaming while reading
  retained the same 12 px offset and scrollTop 2699.
- An uncached destination retained the outgoing transcript under an inert,
  aria-hidden wrapper with an accessible loading status outside that wrapper.
  Rapid B→A switching kept A selected after B's delayed response. Denied B
  loading cleared retained content and all message rows, and displayed the error.
- A selected Earlier row outside the initial window stays visible: 14 initial
  rows, four while Earlier is collapsed, 39 after showing 25 more.
- A 390 px viewport had document and transcript scroll width 390 px, no horizontal
  overflow, the latest message visible, and zero bottom gap.
- Ordered-batch and transport tests cover semantic barriers, snapshot/final
  ordering, reentrant flushes, 2,048-event bounds, 50 ms background fallback,
  navigation/unsubscribe flushing, stale ownership, malformed frames and
  consumer failures without cursor advancement past rejected work.
- Review caught queued-delta versus HTTP-snapshot duplication. Both history
  installation boundaries flush accepted queued events before freshness checks.
  Four model projections are computed before publishing any of them.
- The iframe fixture reproduced two initializations with the stock library;
  after the actual patched bundle was built, it initialized once and stayed at
  the bottom. Offscreen unmount/remount continuity is not claimed.

## Builds, installation, and reproducibility

All 650 tests pass: 172 agent-core, 162 platform, 58 gateway and 258 frontend,
with no skips. All backend builds, frontend TypeScript, default Turbopack and
webpack production builds pass. `git diff --check` passes. The repository-wide
formatter still fails on 58 pre-existing files; scoped formatting of new files
and formatted components passes. Existing formatting failures were not hidden.

Run the fixture with:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/browser-fixture.mjs
```

Build each frontend with `NEXT_PUBLIC_PLATFORM_URL=http://127.0.0.1:4400`, use
different local ports, open `?session=fixture-long`, and open the sidebar. Seed
500 Earlier sessions through `POST /__sessions` with `{ "older": 500 }`.
Use the same `expandHistory`, `measureWarmSwitches`, and `measureBurst` functions
from the browser probe file in the native preview's `preview_evaluate` tool on
each build. Keep the tab visible and do not benchmark development builds.
For stream checks, open fixture B and wait for recovery before the burst.
The first A sample is cold and is excluded from warm medians.

`npm ci` runs `frontend/scripts/patch-legend-list.mjs` via postinstall. It validates
the pinned version and both original bundle hashes, refuses unknown changes,
and applies the two web fixes idempotently. If it changes a bundle, it archives
the previous webpack cache to the OS temporary directory before writing, since
webpack otherwise reused the unpatched node_modules bundle in a measured build.
`node frontend/scripts/patch-legend-list.mjs --check` verifies without mutation.
Installations using `--ignore-scripts` must apply the patch manually. Regression
tests cover native/fallback moves, fractional CSS normalization, original hash
checks, no partial writes on validation failure, and safe cache invalidation.
An isolated clean `npm ci` with the final package and lock files also passed;
postinstall patched both original web bundles and the read-only check passed.

## Remaining boundaries

This change does not make database reads bounded: history still reads/orders the
full transcript before selecting its API window. Large single turns and upstream
snapshot parsing remain expensive. Queue bounds are event counts, not byte caps.
Ordinary browser find and screen-reader traversal see mounted transcript content,
as with the reference virtualizer. No cross-browser/Safari device or production
load test was performed. No schema migration or deployment was made; rollback
returns to the previous application and dependencies with the same stored data.
