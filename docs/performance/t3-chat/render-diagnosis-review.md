# Conversation rendering diagnosis, 2026-10-06

This is a read-only source audit and isolated synthetic CPU diagnostic of the
current working tree. No production code was changed, no preview was opened,
and no user/provider call was made. Source hashes and raw timings are in
[render-diagnosis-projection-results.json](render-diagnosis-projection-results.json).
The parent investigation separately reads persisted runtime timing evidence.
These frontend findings must not be substituted for that evidence: prompt
publication can be immediate while the runtime has not emitted its first answer
delta. Optimizing React cannot produce a delta that has not arrived.

## What the current implementation already protects

- Send appends its optimistic user entry, clears the draft and sets dispatch
  state synchronously before `ensureSession`/`transport.send`
  (`frontend/app/page.tsx:1547–1567`). Network acceptance and first answer text
  are separate stages. This audit does not find an intentional timer on plain
  message submission. Suggested-question submission has its own explicit
  350 ms product delay (`:1628–1647`); it is not the typed-message path.
- The actual conversation is virtualized (`chat-messages.tsx:189–243`), with
  stable group objects (`lib/chat-groups.ts:13–53`), memoized user/assistant
  rows and `AnswerBody`/`StreamingMarkdown` (`chat-messages.tsx:381,464,559`,
  `streaming-markdown.tsx:110`). Context consumers do execute as shared state
  changes, but unchanged child props can still bail out. It would be incorrect
  to claim that every historical answer is reparsed on each delta.
- Display/source caches serialize at navigation boundaries, not on every
  delta (`page.tsx:397–458`, `lib/session-cache.ts:31–33,65–81`). Navigation
  still serializes two projections and reads visible row geometry; it is a
  possible switch cost, not an ordinary first-answer gap.
- Collapsed reasoning avoids detailed text; hidden activity projections are
  paused. Existing `next-details.md` records those component checks. Reopening
  details can have a one-time cost, but hidden details are not the default
  streaming explanation.

## Confirmed remaining work and its measured size

The earlier `next-stream-report.md` measures a single maximally coalescible batch
in the display reducer only. The actual page first runs `advanceSourceSync`
(`page.tsx:1077`) and then display chat, helpers, observability and plan
projections (`:1093–1105`), followed by React. The source reducer maintains its
own projection and scans its entry budget (`source-sync.ts:203–240`). The chat
group selector rebuilds candidate groups and a previous-group map on every new
entries array; presentation then traverses the groups twice
(`chat-groups.ts:17–49`, `chat-messages.tsx:108–125`). Virtualization bounds
mounted DOM, not these full-transcript traversals.

The new diagnostic uses actual current reducers and selector, 1,000 same-item
fragments in 20 publication batches of 50, one warmup and five measured runs.
It reproduces the two presentation traversals but does not render React. Source
history has 10 entries for the small case and 1,000 for expanded histories.
Assertions verify exact final text and source terminal cursor. Stage timing and
assertion overhead are included. Results are whole-stream totals, not frame
latencies or production percentiles.

| Display entries | Display reducer only | Source + display + groups/presentation | Groups/presentation portion |
| --------------- | -------------------: | -------------------------------------: | --------------------------: |
| 20              |             0.100 ms |                               0.379 ms |                    0.138 ms |
| 2,000           |             0.421 ms |                              10.131 ms |                    9.071 ms |
| 10,000          |             1.952 ms |                              54.611 ms |                   52.203 ms |

For 10,000 entries this is about 2.73 ms per synthetic publication on average.
Source duplication exists but its measured portion is only 0.611 ms over all
20 batches in that fixture. It is not evidence to remove the independent source
authority or a plausible explanation for seconds before the first delta.

There is one confirmed adverse state with much higher cost:
`visibleEntries` (`chat.ts:701–723`) invokes `entries.some` for each non-final
assistant entry with nonempty text and a turn ID. `turn.completed` marks such
entries `done: true` without setting `final: true` (`:630–639`), and visibility
does not skip `done`. Many interrupted responses can therefore retain the
quadratic scan. A synthetic alternating user/assistant history with distinct
turns, no finals, and assistant entries marked done produces:

| Transcript entries | Actual predicate calls | Uninstrumented visibility median |
| ------------------ | ---------------------: | -------------------------------: |
| 20                 |                    200 |                        0.0029 ms |
| 2,000              |              2,000,000 |                         8.749 ms |
| 10,000             |             50,000,000 |                       215.519 ms |

The final-answer control at 10,000 entries takes 0.0995 ms and invokes no
`some` callbacks. Counts instrument the real function; timings are separately
measured without instrumentation. This demonstrates a main-thread CPU risk if
that state occurs. It does not establish the affected user's transcript has
that state or that every 10,000-message transcript stalls.

## Browser cost hypotheses, with exact mechanisms

1. **Two autoscroll owners and abrupt follow.** The list has boolean
   `maintainScrollAtEnd` (`chat-messages.tsx:204`); the page also requests an
   instant imperative `scrollToEnd` on every entries/pending commit
   (`page.tsx:1310–1313`). The installed Legend 3.3.5 bundle normalizes boolean
   true to data, footer, item and viewport layout triggers, all instant
   (`node_modules/@legendapp/list/react.mjs:7580–7610`). Its imperative path
   cancels prior tokens and may wait for two stable frames, up to 800 ms for
   an unsuperseded request (`:7251–7347,7446–7458`). Continuous commits can
   supersede a pending request. This is a concrete jitter/starvation mechanism
   to trace, not a measured browser starvation claim. T3 uses explicit triggers,
   disables footer-layout follow, and animates only appropriate working updates
   (`t3code/apps/web/src/components/chat/MessagesTimeline.tsx:382–410,1355–1372`).
   Preserve manual-reading cancellation, reduced motion, initial positioning,
   approvals, disclosure changes and restored anchors when simplifying ownership.

2. **Repeated composer geometry.** `SmoothTextarea.update` reads computed style,
   writes mirrored style properties plus sizing, replaces mirror text, then
   reads client rectangles and offsets (`smooth-textarea.tsx:108–139`). It is
   called by value microtasks, selection events, scroll, fonts and ResizeObserver
   (`:167–184`), without a single-frame deduplication guard. The page separately
   writes textarea height then reads scrollHeight on text changes
   (`page.tsx:1304–1308`). This can trigger synchronous style/layout work and
   redundant measurements. It is primarily a typing/composer-resize hypothesis,
   especially for the supported 100,000-character draft limit. It does not run
   on each answer delta solely because the parent rerendered: the value effect's
   dependency remains unchanged. A Send button click also normally moves focus
   away, causing an early return from caret measurement.

3. **Growing single-answer Markdown.** `AnswerBody` scans whole answer text for
   suggestions and visualization references, then Markdown processes the visible
   text (`chat-messages.tsx:568–585`, `suggestions.ts:32–101`,
   `visualization.ts:10–46`). Incremental parsing activates only for streaming
   code fences; prose still full-parses. Even cached fenced prefixes are cloned,
   passed through GFM transforms and rendered; final answers full-parse
   (`markdown-incremental.ts:89–158`, `streaming-markdown.tsx:117–128`). T3 has
   the same fence activation boundary (`ChatMarkdown.tsx:3495–3505`), so adopting
   its parser does not eliminate this cost. Virtualization cannot subdivide a
   single enormous assistant row. Existing Markdown timings are server-render
   CPU measurements, not a browser trace of this user's answer.

4. **Recovery can disable Send after content is visible.** Cold and fallback
   opens publish persisted content before completing recovery and source handoff
   (`page.tsx:671–711`). Resync sets busy/opening state through the same recovery
   and handoff (`:1006–1050`). The source waiter defaults to five seconds
   (`source-sync.ts:315`). Cached text being painted does not prove live pending
   actions and cursor authority are ready. Keep the safety gate, but identify
   which phase is waiting in diagnostics and product status. This hypothesis
   matters for blocked Send after reconnect/navigation; it does not explain a
   healthy already-open follow-up whose prompt is accepted immediately.

## Small prioritized plan

1. Measure the correct timeline on an approved isolated production-build fixture:
   submit event → optimistic prompt commit/next usable frame → HTTP acceptance →
   first raw SSE delta → projection publication → answer DOM commit/next usable
   frame. Also record later raw-delta gaps separately from DOM/frame gaps. Use
   a paced stream with delays, a normal prose answer, a long prose answer and an
   interrupted-history case; the old 1,000-fragment synchronous burst is not
   representative of streamed motion. Record visibility/focus and discard
   throttled native rAF samples. No payload contents or user text in telemetry.
   Runtime/provider first-delta and inter-delta timing should remain a separate
   investigation because frontend improvements cannot eliminate upstream waits.
2. Remove the demonstrated quadratic visibility candidate search using a
   per-turn final-answer index while preserving exact prefix/identity semantics.
   Add regression/oracle tests for done-but-not-final answers, repeated same text
   in different turns, distinct same-turn items, empty/Unicode text and replay.
   Do not simply treat `done` as `final`: that changes duplicate suppression.
3. Give normal live-follow one owner. Adapt T3's explicit layout triggers and
   appropriate smooth policy, reserving imperative calls for navigation, restore
   and explicit user Send. Verify follow at the bottom, manual scroll-up during
   streaming, composer resize, approvals/footer changes and reduced motion.
4. If browser traces attribute material typing delay to caret geometry, batch
   duplicate triggers per frame and reuse mirrored styles until styles/width
   change, or simplify to a native caret. Keep IME, selection, RTL, wrap,
   scroll and keyboard correctness. Profile before making animation more complex.
5. Optimize larger per-publication group/presentation or Markdown work only when
   the recorded flamegraph attributes a missed frame to it. Preserve source/display
   independence, exact terminal text, final full parse and cursor publication
   after all projections. Do not remove recovery safety to make status look ready.

Reproduce the CPU diagnostic from the repository root:

```sh
node docs/performance/t3-chat/render-diagnosis-projection.mjs > docs/performance/t3-chat/render-diagnosis-projection-results.json
```

No frontend build or full repository suite is necessary for these diagnostic-only
artifacts. The script executes final-text/cursor and visibility assertions. It
emits Node's existing typeless-package warning on stderr; production package
configuration was left unchanged. Browser layout/paint, React commit counts,
Safari/mobile behavior and the user's actual transcript remain unmeasured here.
