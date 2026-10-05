# Next T3-derived chat improvements

Implementation followed this review. Completed changes, final checks, measured
before/after results and remaining restrictions are recorded in
[T3_CHAT_NEXT_IMPLEMENTATION.md](T3_CHAT_NEXT_IMPLEMENTATION.md). The plan and
baseline below are retained as the original review record.

Review date: 2026-10-05. Three GPT-6.1-Sol agents independently reviewed session
creation/sending, stream/recovery, and rendering/experience; the primary agent
checked source references and measured the current baseline.

Truex source: `d6e3f45a45e6948873b8a64d0a9453fb2c2f4307`.
T3 reference: `cf3e714b0f58e29c8fa8660db50d2187e3263b65`.
This pass produces a plan and baseline artifacts only. Proposed improvements
have not been implemented or measured against a candidate. No live chat,
provider, database, or developer server was changed.

## Findings and fresh baseline

The existing virtualizer, incremental fenced Markdown, memoized message groups,
bounded navigation cache, first durable paint, ordered paint batching, sidebar
shelf, indexed hydration, Mongo bulk reconciliation, and concurrent opening
remain useful. They are already implemented and are not new recommendations.

Two remaining costs have fresh measurements:

| Current controlled measurement                      | Result                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1,000-turn full recovery, repeat-open median        | 284.10 ms; 22 runtime calls; 20 bulk writes containing 2,000 message operations |
| Same fixture, durable recent-window read            | 20 returned messages; 4,386 bytes; zero runtime calls                           |
| 1,000 one-character deltas, 2,000 existing entries  | 19.11 ms chat-reducer CPU; 1,000 reducer applications                           |
| 1,000 one-character deltas, 10,000 existing entries | 92.92 ms chat-reducer CPU; 1,000 reducer applications                           |
| Current frontend tests                              | 261 passed, zero failures or skips                                              |

The recovery harness uses actual PlatformService/Store and isolated Mongo;
runtime calls have a fixed synthetic8 ms delay. Its full-recovery rows exercise
the existing full-history method, not real-app browser opening latency. The
window response is small, but source inspection confirms the database read
still fetches the full transcript before selecting it. The CPU probe tests
only `applyChatEvent`, excluding React, network, Markdown and provider work.
Neither probe measures T3 itself or establishes production p95.

Raw evidence: [history](performance/t3-chat/next-plan-history-baseline.jsonl),
[delta CPU](performance/t3-chat/next-plan-delta-baseline.json),
[frontend tests](performance/t3-chat/next-plan-frontend-baseline.txt).

Reproduce the history baseline with the existing harness:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs scripts/benchmark-chat-history.mjs --persisted --window
npm --prefix frontend test
```

The delta baseline uses1,000 `message.delta` events with one-character `x`,
the same new turn/item and message ordinal0, applied through the existing
`applyChatEvent` reducer to20/2,000/10,000 alternating saved user/assistant
entries. Five measured repetitions follow one warm-up; the exact1,000-character
answer and unchanged history length are asserted. Node is24.21.0. Candidate
measurements must reuse these identities, text, counts and warm-up conditions.

## Proposed implementation order

| Step | Change                                                             | Observable result                                                                           | Scope                                  |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1    | First-send configuration and input guards                          | No turn runs after chosen approval settings fail; invalid text remains editable             | Small correctness change               |
| 2    | Draft editing and dispatch status                                  | Type while agent lookup/creation waits; see Creating/Sending/Steering states                | Small frontend change                  |
| 3    | Coalesce compatible text runs before chat projection               | Fewer reducer applications with identical text, state and cursors                           | Small frontend performance change      |
| 4    | Lazy reasoning/activity details and truthful completion state      | Collapsed content stays cheap; failures do not show a success-looking100% bar               | Small rendering/UX change              |
| 5    | Indexed bounded persisted history reads                            | Recent pages load bounded payload documents rather than every old message                   | Backend ordering/migration work        |
| 6    | Bounded snapshots at their source                                  | Cold/reconnect transport avoids serializing old history only to discard it later            | Both runtime transports + contracts    |
| 7    | Paired projection/cursor, synchronization marker, fast warm resume | Valid warm chats replay only missing events; full recovery becomes a fallback               | Highest synchronization complexity     |
| 8    | Configured creation, then conditional single first-send bootstrap  | Fewer sequential writes before the first turn; uncertain responses recover the same session | Backend idempotency/state-machine work |
| 9    | Scoped metadata updates and narrower render subscriptions          | Sidebar/status updates avoid repeated full list refreshes and unrelated row work            | Profile-gated follow-up                |

Steps1–4 can ship as focused changes with existing APIs. Steps5–7 require
separate reviewable increments and compatibility fallbacks. Step8's configured
creation is independent of cursor work; its larger bootstrap command proceeds
only if first-send measurements justify it. No elapsed-time estimate or latency
promise is assigned before those measurements.

## 1. Fail closed on selected settings; validate before dispatch

Truex `frontend/app/page.tsx:1138` catches approval-mode change failures, while
`:1223` awaits that call and continues first send. `platform/src/service.ts:1389`
updates the saved mode before the runtime update, so UI rollback alone cannot
prove which mode the runtime will use. T3's `apps/web/src/components/ChatView.tsx:9416`
blocks dispatch after settings failure.

Return an explicit outcome or propagate the first-send failure, preserve the
already created session, and require confirmed effective settings before any
turn dispatch. Cover goal/capability/keyboard/suggestion entry points sharing
creation, not only the main Send button. Define failure behavior for stored and
runtime disagreement; do not silently claim that the UI restored it.

Truex's1–100,000-character validation is currently server-side at
`platform/src/service.ts:1438`; optimistic submission clears text before a
definite invalid-input response. T3 `chat/composerSubmission.ts:12` validates
before dispatch. Reuse Truex's existing limit and string-length semantics in
a shared validation boundary; preserve authoritative server validation.

Tests before/after: injected settings failure must produce zero message/goal
dispatches; disabled modes, `readOnly`, partial runtime failure, navigation,
reusing the existing session, whitespace,100,000/100,001 characters and Unicode.
Invalid input must create no session/request/pending row and preserve the draft.
These source-identified paths require executable red regressions before fixing;
they were not exercised against a live provider during this review.

## 2. Keep editing responsive; make local dispatch visible

Truex `page.tsx:1931` disables drafting during agent loading and initial session
creation; `:1597` lacks explicit creating/submitting state. The ref lock at
`:1241` protects execution but does not by itself update the button label.
T3 `ChatComposer.tsx:7386` permits drafting during lookup/submission;
`ChatView.tsx:829` owns local dispatch state separately, and
`chat/ComposerPrimaryActions.tsx:254` exposes submission/steering labels.

Keep the synchronous duplicate-send guard, add observable dispatch state, and
separate editor availability from send availability. Freeze the submitted text,
configuration and draft revision. A late success/failure may clear or restore
only that unchanged revision; text typed afterward must survive. Use existing
runtime `running` state for steering. Do not add unsupported queue semantics or
speculative runtime prewarming.

Test slow/failed agent lookup, double Enter, type B while A provisions, failure
after B is typed, switching during provisioning, IME composition and goal/slash
command paths. Measure time to an editable composer, optimistic-row paint,
submit-to-status, submit-to-acceptance, first delta and first visible response
separately. Do not attribute provider generation time to this UI change.

## 3. Reduce projection CPU inside existing ordered batches

Truex `page.tsx:870` still reduces every frame through its state projections;
`frontend/lib/chat.ts:623` upserts once per text delta. T3's
`Adapters/ProviderTextDeltaCoalescer.ts:100` accumulates text by turn/item before
emission. Adapt that mechanism initially inside the existing client projection
batch: concatenate only adjacent compatible deltas with matching conversation,
turn, item and message ordinal. Raw and summary reasoning are different channels.

Preserve original events for cursor deduplication, follow policy and telemetry.
Final/snapshot/approval/error/turn boundaries flush prior work. Compute all
projections before publishing/checkpointing as today. No wire protocol change
is needed for the first version.

Compare the candidate to the existing reducer as an oracle. One uninterrupted
1,000-delta same-item run should require one chat projection application while
retaining exact output. Test interleaved items, aliases, reasoning channels,
finals, malformed frames, hidden-tab fallback, navigation mid-batch and rejected
consumer ownership. Record reducer applications and CPU at20/2,000/10,000 entries,
then production-browser frame gaps/long tasks and terminal cursor. No claim of
1,000 fewer React paints: existing React paint batching already works.

## 4. Lazy details and honest activity state

Truex `frontend/components/thinking-block.tsx:49` mounts the full body even when
hidden; `chat-messages.tsx:486` joins its full text. T3
`MessagesTimeline.tsx:5342` mounts reasoning content only when expanded;
`:5147` builds expanded tool bodies on demand; `:3336` virtualizes expanded work.

Start by retaining a cheap accessible disclosure while only mounting detailed
reasoning when opened. Calculate body joins/counts only when needed. Keep detail
state keyed to stable item identity. Profile closed activity panes before
visibility-gating their expensive derived work; keep authoritative live state
up to date so reopening never requires a stale display cache.

Truex `session-activity.tsx:405` displays100% for the latest completed event even
when its label/icon identifies failed/interrupted state. Derive result
presentation from actual outcome and plan progress; show neither fake percentages
nor guessed completion. T3's explicit turn-state/detail design is the principle;
the Truex progress correction is a local adaptation, not a copied widget.

Measure a large collapsed reasoning response, expand/collapse latency, mounted
text/DOM bytes and layout work. Test keyboard/ARIA, streamed reasoning while
closed, virtual remounts, failed/interrupted/completed outcomes, hidden activity
panes and reopening. Preserve offscreen goal jumps, iframe state and reading anchors.

Also profile scroll ownership: Truex enables list following at
`chat-messages.tsx:206` and explicitly calls `scrollToEnd` on entry/pending changes
at `page.tsx:1039`. T3 `MessagesTimeline.tsx:381` defines follow triggers and avoids
footer-induced movement, while`:647` suspends following during disclosures.
If traces show conflicting writes or jumps, retain one ordinary streaming-follow
owner and the existing guarded navigation/restoration paths. Measure scroll writes,
anchor drift, bottom gap and media reloads for late images, approval footers,
composer growth, disclosures, wheel/touch/keyboard and late reasoning insertion.
Do not change the conversation remount boundary without a separate experiment.

## 5. Bound database payload reads with correct ordering

Truex `platform/src/service.ts:1729` reads all saved messages, calls authoritative
`orderConversation`, then selects the window. T3
`orchestration-v2/ProjectionStore.ts:4756` reads a bounded stored projection and
sequence; `:2963` restricts payload reads to selected cohorts/active runs.

An arbitrary `.sort({order:-1}).limit(20)` is unsafe: commands follow a saved
predecessor (`shared/command-history.ts:3`), timestamps can tie, pending records
lack runtime order, and one request group can have many messages. First define
a queryable canonical ordering compatible with these rules, then add its index
and versioned backfill/dual-read fallback. Choose a compact ordering projection
only if existing fields cannot represent that order. Do not assume an index
on timestamps alone fixes it.

Tests: concatenated pages equal current authoritative history exactly; command
chains, unset order, equal timestamps, pending/uncertain delivery, late runtime
adoption, stale/cross-session cursors, concurrent append and interrupted backfill.
Measure Mongo `totalDocsExamined`, payload documents decoded, bytes, CPU/memory
and Server-Timing at100/1,000/10,000 turns. The ordinary recent-window payload
read must not grow with unrelated old turns. Preserve complete request groups;
report oversized groups instead of silently truncating user/AI messages.

## 6–7. Source-bounded snapshots and safe warm resume

Truex `agent-core/src/manager.ts:1126` replays retained events and then always
sends the full snapshot at`:1147`. Platform filters only after receiving/parsing
it (`platform/src/index.ts:784`). T3 `ThreadStream.ts:9` chooses bounded replay
or snapshot, `ws.ts:816` emits synchronization completion, and client-runtime
`state/threads.ts:235` keeps projection and applied sequence together.

Implement as separate stages:

1. Extend a validated opt-in bounded snapshot capability at the source, using
   existing public projection rules and retaining pending/current-turn state.
   Keep heavy details available through explicit authorized reads where needed.
2. Pair the retained conversation with its committed cursor and history metadata.
   Commit the data/cursor pair only after applying accepted events. Current
   `SavedConversation` and independent sessionStorage cursor are insufficient
   evidence to skip recovery.
3. Add opt-in replay-to-high-water and a completion marker that cannot overtake
   queued deltas. Receive authoritative current-turn/pending operational state
   captured at that same boundary before promoting readiness. Bound both event
   count and raw/encoded bytes; keep old defaults.
4. Fast-resume only compatible authorized warm state with a retained same-generation
   cursor. Missing cache, stale/gapped cursor, restart, old server or unsafe replay
   use current recovery. Ready requires applied synchronization, not stream headers.
5. Add restart-safe durable projection/watermark consistency separately. Current
   durable records do not contain a complete replayable live event history.

The initial baseline also needs a defined coverage boundary: today's HTTP result
can combine a runtime snapshot captured before ingestion with subsequently read
Mongo messages. Adding a cursor field to that mixed result does not make it a
coherent projection. Define and test an authoritative snapshot/replay handoff
before enabling the warm path; preserve conservative full recovery until it holds.

Zero-event replay is an important case: today's display cache does not contain
pending approvals or running state, and opening clears both. A marker alone
cannot restore an unchanged running turn or pending approval. Prefer a lightweight
authoritative operational-state frame at the synchronization high-water while
keeping cached actions unavailable. Retaining a complete operational projection
is an alternative only if it is validated through replay before becoming live.
Explicitly test a running/awaiting-approval chat with no missed events; it must
restore working/approval state, not become falsely idle or lose the request.

Both local HTTP and deployed AgentCore invocation must work. The transport
(`platform/src/runtime-transport.ts:63`) currently allows only a cursor query;
the AgentCore envelope (`agent-core/src/agentcore.ts:56`) rejects query-bearing
paths and GET bodies. Extend contracts/validators and both paths deliberately;
adding a local-only `?window=1` option would break the deployed path.

Keep server authorization on every subscription; clear cached content on access
revocation; never restore cached pending actions as live authority. Preserve
generation guards and newer live state when a late HTTP response arrives.

Acceptance: valid unchanged warm chat makes zero `/items` calls/full recovery
requests; small gaps apply missing events once before ready; oversized/expired
gaps fall back correctly. Measure click-to-paint and click-to-ready separately,
runtime page calls, SSE raw/projected bytes, memory and fallback reasons. Test
capture/replay/live race, restart, byte overflow, runtime outage, A→B→A, revocation,
pending approval resolution during navigation, older-page load during reset,
slow consumers and mixed old/new client/server versions. Retain full recovery
until those cases pass; a time-to-live cache shortcut cannot establish freshness.

## 8. Reduce first-send round trips with explicit idempotency

T3 `ChatView.tsx:9446` puts `bootstrap.createThread` inside the turn command at
`:9480`. Truex creates first, optionally changes approval mode, then sends;
`platform/src/service.ts:1451` resumes/rebuilds configuration before dispatch.

First measure those phases and let the existing create contract validate/apply
the selected existing approval mode during configuration. That support does not
exist today; changing `projects.ts:66` alone is not sufficient. Only then consider
an additive Truex first-send service/command accepting a stable creation identity
and existing message client ID, reusing current authorization/configuration/
persistence. Do not invent a T3 endpoint or claim runtime/Mongo writes are atomic.

Lost responses must recover the same created session/message, including across
process restart. Keep accepted, failed and uncertain outcomes distinct; do not
automatically retry uncertain writes with new identities. Remove redundant resume
work only after configuration changes and runtime lifecycle tests prove it safe.

Test duplicate bootstrap, same identity/different payload, lost response after
creation or turn acceptance, restart, invalid input before provisioning, forbidden
project, database failure after runtime creation, navigation and existing-session
fallback. Compare write/runtime/configuration query counts and submit-to-accept/
first-delta/paint p50/p95 under identical injected delays. Provider tests require
explicitly controlled prompts and identical routing; model latency remains separate.

## 9. Follow-up candidates gated by profiling

T3 `state/threadDetail.ts:40` exposes narrow derived state; Truex still owns much
of the chat in Home and broadcasts `TimelineContext` at `chat-messages.tsx:258`.
Profile which mounted rows rerender on usage, goal, helper or typing changes;
introduce smaller subscriptions/props only where that evidence warrants it.
Reusing the existing reducers is preferable to adopting another state framework.

T3 `ShellStream.ts` and `ws.ts:1005` publish scoped, coalesced navigation metadata.
Truex `page.tsx:333` refreshes the session list when sidebar/search opens. Plan an
authorized metadata projection/update path if profiles show repeated list work:
title/running/goal changes should patch affected rows, with full refresh on gaps.
Avoid one subscription per sidebar row; preserve ownership/tenant visibility.

Additional verified experience improvements for a later focused pass:

- **Copy answer/code and optional code wrapping.** T3 `MessageCopyButton.tsx:29`
  and `ChatMarkdown.tsx:997` implement these controls. Truex currently renders
  ordinary Markdown without them. Verify exact clipboard bytes, denied clipboard
  feedback, keyboard access, selection and390 px code/table layouts. These are
  product improvements, not claims of faster Markdown parsing.
- **Long prompt disclosure and message-level rows for giant turns.** T3
  `MessagesTimeline.tsx:4318` collapses long user text; its message rows have stable
  message IDs (`MessagesTimeline.logic.ts:1652`). Truex `chat-groups.ts:23` can put
  hundreds of answers into one virtualized turn row. Benchmark100/500 messages
  within one turn separately from one giant Markdown document; split rows only
  when justified, preserving turn anchors, receipts, suggestions and helper order.
  Test late reasoning insertion without answer-media/disclosure remounts.
- **Visible animation and sidebar continuity.** T3 `lib/visibleAnimation.ts:10`
  considers viewport, document visibility and reduced motion; `Sidebar.tsx:2916`
  retains shelf state and`:2870` schedules classification changes. Apply the
  visibility policy to Truex visuals, profile hidden-panel timers, retain shelf
  choice safely, and reclassify Today/Earlier at local midnight/visibility return.
  Test DST, reduced motion, hidden-tab resume and large Today lists. Visibility-
  gated timers and Truex's date grouping are adaptations, not exact T3 copies.
- **Composer ownership and geometry.** T3's composer is memoized and subscribes
  to its targeted draft (`ChatComposer.tsx:1684,:1798`). Profile Truex page-wide
  typing updates and SmoothTextarea mirror measurements before extracting state
  ownership or coalescing geometry invalidations. Use1 KB/10 KB/large allowed
  prompts idle and streaming; preserve IME, undo, selection, fonts and immediate
  submit. Never debounce authoritative input or copy T3's editor merely to look alike.

Persistent browser transcript caches, queued turns, provider switching, and
hover-prefetch are not automatically included. They need separate capabilities,
retention decisions or evidence. T3's current sidebar is not generally a virtualized
list and current PR/VCS visibility leases are not universal chat hover-prefetch.

## Measurement and release gates for every increment

- Freeze before/candidate builds and run identical production-browser fixtures in
  a visible tab. Separate local and injected remote delay, cold and warm sessions,
  short history and fully loaded large history. Use at least30 repeated runs for
  planned p50/p95 comparisons; report raw samples, warmup and hardware/runtime.
- Record editable composer, optimistic paint, acceptance, first delta, first rendered
  text, steady stream frame gaps/long tasks, final paint, and thread time-to-ready.
- CPU, payload, request count and query-operation claims need their own measures;
  DOM mutation count is not React commit count. Exact final state/text/cursors are
  hard acceptance requirements regardless of a faster timing.
- Include Chromium and Safari, mobile-width browser, IME, keyboard, reduced motion,
  background tabs, slow network, rapid navigation, large single turns and partial
  failures. Prior measurements do not establish cross-browser coverage.
- Add regressions that fail before each bug fix; run relevant units/integration/
  end-to-end checks, frontend type check and both production builds, scoped format
  and final diff review. Run broader repository tests for shared/backend changes.
- Roll out backend capabilities before enabling clients; use additive/versioned
  contracts and old-path fallback. Expand→backfill→verify→enable for storage changes.
  Rollback must remain available without deleting existing conversation data.

Recommended first implementation: steps1–4 in separate small changes, followed
by the bounded-read/source-snapshot foundations and cursor-resume protocol.
The largest structural goal is less recovery work; the first measurable streaming
goal is less reducer work. Neither requires replacing Next, React, Mongo or SSE.
