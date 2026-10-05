# Stream stall diagnosis, current working tree

This investigation makes no production changes. It inspects the existing
uncommitted implementation and measures an extracted current `applyBatch`
callback with its real reducers. The reproducible probe, raw results and CPU
profile summary are `stall-diagnosis-stream-probe.mjs`,
`stall-diagnosis-stream-results.json`, and
`stall-diagnosis-stream-profile.json` in this directory.

## What is demonstrated

The prior isolated chat benchmark proved an optimization for uninterrupted
`message.delta` bursts. It did not establish that reasoning or mixed streaming
is smooth. The current helper combines only adjacent compatible message deltas
(`frontend/lib/chat-batch.ts:25`). Reasoning bypasses it. Alternating message
and reasoning events also prevent adjacent message coalescing.

Current `applyBatch` computes source synchronization, display entries, helper
agents, observability and plan, then updates refs and publishes React state
(`frontend/app/page.tsx:1054`, `1079`, `1093`, `1097`, `1101`, `1105`, `1112`).
Our probe executes that actual callback extracted through the TypeScript AST;
only React setters, ownership refs and unrelated side effects are simulated.
Follow policy uses the real `followTab`/`noteSeen` helpers. It verifies full
display and source entry state against the original raw-event reducer oracle,
all original event/revision accounting and the original terminal cursor.

The source pair **already uses the coalescer**
(`frontend/lib/source-sync.ts:217`); the uncoalesced-source-message hypothesis
is rejected for this working tree. Raw other projections do process 1,000
events, but observability and plan return the same state for text deltas
(`frontend/lib/observability.ts:419`, `frontend/lib/plan.ts:29`). Helper-agent
skew learning parses timestamps, yet is not the measured dominant cost.

Five measured runs after one warmup, 10,000 display entries, 1,000 synthetic
events in one publication, source pair containing the latest 10 assistant
turns:

| Event mix                                    | Actual callback, legacy | Actual callback, ready source | Isolated chat projection |
| -------------------------------------------- | ----------------------: | ----------------------------: | -----------------------: |
| 100% message                                 |                0.689 ms |                      0.885 ms |                 0.059 ms |
| 100% raw reasoning                           |               27.955 ms |                     28.559 ms |                29.491 ms |
| 50% message / 50% raw reasoning, alternating |               33.683 ms |                     33.633 ms |                33.452 ms |

The authoritative values and all samples are in the JSON. Fixture order and
JIT warmup can affect small differences between phases; these numbers do not
prove that one phase is faster than another. Both phases exhibit the same
large-history reasoning/mixed problem.

`applyChatEvent` scans for the reasoning row then maps the full transcript on
every fragment (`frontend/lib/chat.ts:648`, `672`). With 1,000 reasoning events
and 10,000 entries this means roughly 10 million entry visits/copies before
publishing. The alternating fixture also performs 1,000 display reductions.
Sampling the diagnostic's **actual callback subtree**, separately from oracle
checks, attributes 2,096 of 2,314 samples (~90.6%) to `applyChatEvent` itself.
That supports the independently measured callback timings; it does not measure
React render work. The whole-process profile also contains assertions,
transpilation and setup and must not be interpreted as a production profile.

## Burst size matters

The 1,000-event fixture represents replay/catch-up or a burst, not a measured
production event distribution. We also deliver the same 1,000 events in
different publication sizes, verify the same final state and measure each
actual callback independently:

| Mix         | Events/publication | Median largest callback | Median total callback CPU |
| ----------- | -----------------: | ----------------------: | ------------------------: |
| Message     |                  1 |                0.224 ms |                 42.398 ms |
| Message     |                 16 |                0.093 ms |                  3.441 ms |
| Message     |                 64 |                0.131 ms |                  1.450 ms |
| Message     |              1,000 |                0.792 ms |                  0.792 ms |
| Reasoning   |                 16 |                0.619 ms |                 28.932 ms |
| Reasoning   |                 64 |                1.943 ms |                 28.442 ms |
| Reasoning   |              1,000 |               28.398 ms |                 28.398 ms |
| Alternating |                 16 |                0.773 ms |                 34.440 ms |
| Alternating |                 64 |                2.580 ms |                 36.677 ms |
| Alternating |              1,000 |               33.964 ms |                 33.964 ms |

This demonstrates a frame-budget hazard for large reasoning/mixed publications,
but does not demonstrate a large synchronous stall for small publications.
The total CPU is synchronous callback time only; publications here run back to
back, without real time, React commits or paints between them. Do not infer a
production frame gap or a long task from these measurements alone.

## Existing transport and scheduling behavior

Runtime notification → manager state update/emit → SSE frame → platform public
projection/relay → browser EventSource JSON parsing → ordered batch → source
and display projections → React → Markdown/DOM/paint.

The manager redacts every emitted event (`agent-core/src/manager.ts:1460`),
assigns a cursor (`1465`), encodes/retains a frame (`1514`) and writes each to
subscribers (`1527`). Text deltas are not individually durable-file writes;
the durable list at `1471` covers finals, completion, approval resolution,
goal clearing and plan changes. Platform `PublicEventStream` parses each raw
frame and re-encodes accepted public events (`platform/src/public.ts:868`,
`896`); `relay` forwards incoming chunks without a coalescing timer (`908`).
It honors socket backpressure (`910`). SSE buffering is disabled in application
headers (`platform/src/index.ts:718`). No measured backend/socket/proxy delay
is available from this CPU probe.

Frontend parsing is per frame (`frontend/lib/transport.ts:178`), while text
publication is coalesced at the existing paint boundary (`212`). Finals,
approvals, snapshots and status events first flush text, then publish themselves
(`215`). Those barriers can reduce the number of fragments combined but
preserve event order. Cursor checkpointing uses the last original frame and
occurs after successful synchronous publication (`148`); sessionStorage is
synchronous and excluded from the callback benchmark.

The first text is intentionally queued for the next animation frame; a 50 ms
timer also progresses hidden tabs (`frontend/lib/ordered-batch.ts:46`). At
2,048 queued frames it synchronously flushes (`45`), so the event-count bound
is not a CPU-time bound. Deterministic scheduler probes show publication at
the supplied next frame (16.67 ms at modeled 60 Hz), 50 ms for a modeled hidden
timer, and immediate publication when a barrier flushes. These are code-policy
measurements, not observed browser wall times. Hidden-tab timer clamping,
event-loop contention and paint latency still need browser measurements.

## Recovery risks and unsupported hypotheses

An ordinary existing-session send does not read/recover the transcript:
`ensureSession` returns the current session (`frontend/app/page.tsx:1481`) and
the send dispatches at `1567`. Successful send refreshes the sidebar (`1569`);
this is separate from chat recovery. Suggestions deliberately wait 350 ms
(`1641`), but typed Send does not use that path.

Reconnect snapshot handling can reload durable history (`1152`). Source
handoff opens another stream and waits for a completion marker (`569`–`589`),
with a default 5,000 ms deadline (`frontend/lib/source-sync.ts:315`). Resync
sets the UI busy and performs recovery/handoff (`frontend/app/page.tsx:1014`).
Those boundaries can explain a visible syncing phase if exercised; this
investigation does not establish that a specific reported delay took that
path. Track their frequency/reason before altering safe recovery.

Source entries are checked against 2,000 entries / 8 MiB (`source-sync.ts:239`).
No pruning occurs in steady ready-phase advance. A continuously open long
session can therefore eventually hit `projection_limit`, triggering safe
recovery. This is a code-derived risk, not a reproduced user incident. Never
silently drop retained source data to make the limit disappear.

No evidence here establishes provider slowness, network buffering, browser
render cost, sidebar contention, synchronous storage cost, hidden-tab stalls,
or user-perceived pause duration. Plain-message reducer CPU is already small
in the measured burst. Browser measures must distinguish generation gaps from
receipt-to-paint gaps before attributing all pauses to rendering.

## T3 comparison and ordered plan

T3 accumulates text before provider events reach downstream persistence/live
projections. Its Codex adapter coalesces reasoning, explicitly keeping raw and
summary indexed parts separate
(`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:2929`), and
assistant messages (`3020`), with a 50 ms interval (`213`). The shared
`ProviderTextDeltaCoalescer.ts:100` buffers by turn/item and emits accumulated
text; completion/turn flushes preserve terminal content (`131`, `148`).
This reduces downstream event work, whereas Truex's current helper reduces
display projection work only. T3's separate assistant filter also waits for
stable Markdown boundaries and uses a 400 ms cadence
(`orchestration-v2/assistantStreaming.ts:114`–`119`); copying that policy could
increase perceived pauses, so it is not an automatic fix.

1. Instrument one safe local/browser run with stage timestamps: event receipt,
   batch start/end/size/type mix, source phase, React commit and next visible
   paint; capture reconnect/resync reasons and durations. Measure an actual
   foreground tab and explicitly distinguish hidden/visible/focus state.
   Acceptance: counts/cursors/content remain exact, and generation silence is
   separable from browser publication silence. Keep content and credentials
   out of diagnostic logs.
2. Extend the projection helper to adjacent compatible reasoning deltas, keyed
   by public session/turn/item and exact channel identity. Keep raw and summary
   separate, retain every original frame for cursors/telemetry and preserve
   final/snapshot/approval/error barriers. Acceptance: full seeded oracle
   equivalence, both source/display reducers tested, malformed/missing identity
   passthrough, Unicode, late/completed reasoning and navigation flush coverage;
   repeat this actual callback benchmark, not only the isolated message test.
3. If mixed streams are common in measured traces, adjacent coalescing alone
   will not solve them. Evaluate a transient text-batch reducer that maintains
   sequential identity/order semantics while avoiding repeated history scans
   and array copies. Compare against the raw reducer on adversarial interleaved
   fixtures and all publication boundaries. Avoid cross-channel concatenation
   or merging cursors. Set a concrete callback CPU target (e.g. ≤4 ms at the
   measured worst batch/history) and validate it on the target device.
4. Only if observed burst publications still exceed the frame budget, evaluate
   a time/event budget for publication. All projections and original cursor
   checkpoints must remain atomic per accepted publication. Splitting alone
   lowers single-callback CPU but can create more React/Markdown work, so judge
   total CPU and visible frame gaps together.
5. Review upstream accumulation only after showing per-frame parsing/redaction
   or wire volume dominates. A manager/public coalescer must retain redaction,
   source cursor/replay authority, terminal flushes, client backpressure and
   rollback compatibility. It is a larger protocol/reliability change than
   the projection fixes and should not be the first intervention.

Reproduce without a provider or server:

```sh
node --experimental-strip-types docs/performance/t3-chat/stall-diagnosis-stream-probe.mjs > docs/performance/t3-chat/stall-diagnosis-stream-results.json
```

Only diagnostic docs/probe artifacts were added. No permission, authentication,
tenant, provider, migration, persistence or production behavior was changed.
