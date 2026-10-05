# Adjacent chat delta projection

The existing transport already gathers ordered events for a paint or a 50 ms
background timer. The chat projection still called `applyChatEvent` for every
fragment, scanning/copying the transcript repeatedly. The new
`frontend/lib/chat-batch.ts` concatenates adjacent `message.delta` fragments
before that projection, within the existing publication boundary.

This adapts the text accumulation principle from T3's
`apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts`
at reference `cf3e714b0f58e29c8fa8660db50d2187e3263b65`. It adds no timer,
cross-batch buffer, provider change, or wire protocol. T3 buffers by turn/item
and emits accumulated text; Truex instead joins adjacent compatible fragments
for its existing append reducer.

Only string deltas with matching nonempty thread, turn and item IDs and an
exact matching ordinal are combined. An absent ordinal is supported; an
invalid ordinal or missing identity is passed through unchanged. Every other
event is a barrier. Raw and summary reasoning stay untouched. Singleton frames
retain their original object; a merged frame is projection-only, retaining the
first frame's metadata. Its cursor must never replace original event accounting.

The page changes only the input of its `nextEntries` reduction. Its deduplicated
original `batch` remains the input to other projections, cursor tracking,
`liveRevision`, follow policy and side effects. All projections still finish
before any state/cursor publication. Reverting that one reduction restores the
previous behavior without touching stored data.

## Paired CPU evidence

The reproducible harness reads actual `chat.ts` at baseline
`d6e3f45a45e6948873b8a64d0a9453fb2c2f4307` with `git show`, and the candidate
chat reducer/helper from the working tree. Both use the same importer and loop.
The fixture exactly matches the earlier probe: alternating saved user/assistant
entries (`old-N`, text `Saved text`, turn `old-turn-N`, item `old-item-N`, final
true) followed by 1,000 `x` deltas for thread `fixture`, turn `new-turn`, item
`new-item`, ordinal 0, cursors `g:1` through `g:1000`.

Each mode/size has one warmup then five measured runs. Candidate timings include
coalescing and reduction. Every run asserts deep equality with the original
reducer's final state, 1,000 final characters, history length plus one and
untouched original event count/cursor. Raw samples, process CPU, source hashes,
Node/V8/platform/hardware and timestamp are in
[next-stream-cpu-results.json](next-stream-cpu-results.json).

| Existing entries | Baseline median | Candidate median, including join | Reducer applications, baseline → candidate |
| ---------------- | --------------- | -------------------------------- | ------------------------------------------ |
| 20               | 0.647 ms        | 0.084 ms                         | 1,000 → 1                                  |
| 2,000            | 19.651 ms       | 0.025 ms                         | 1,000 → 1                                  |
| 10,000           | 92.313 ms       | 0.067 ms                         | 1,000 → 1                                  |

The focused reducer/scheduler/transport suite passed 64 tests with no failures
or skips, and the frontend typecheck passed. Logs are
[next-stream-focused-tests.txt](next-stream-focused-tests.txt) and
[next-stream-typecheck.txt](next-stream-typecheck.txt).

The checked-in JSON is authoritative for timings; the earlier plan baseline's
medians were a separate run. This is synchronous projection CPU evidence only,
excluding React, Markdown, DOM, network and provider work. Process CPU can include
Node/V8 worker activity. The uninterrupted same-item fixture permits maximum
coalescing; smaller/interleaved production batches may combine fewer events.
There is no measured browser frame-gap, long-task, render-latency or production
p95 claim, nor a claim of fewer React paints. Real browser measurements remain
an outstanding release check.

## Regression and adversarial coverage

[next-stream-red-tests.txt](next-stream-red-tests.txt) captures the focused
performance/compatibility regressions failing when the helper simply returns
the original frames. This is an optimization regression, not evidence that the
old reducer returned incorrect content. The final tests compare full reducer
state across 200 seeded mixed fixtures and publication boundaries, aliases,
conflicting ordinal matches, completed replay, Unicode/empty fragments,
missing identities, malformed data, finals, snapshots, approvals, errors,
completion, and separate reasoning channels.

The actual transport and ordered scheduler are exercised through an isolated
fake EventSource: paint, hidden-tab timer and navigation flush retain all
original events and the original terminal cursor. Rejected navigation ownership
publishes/acknowledges nothing. Malformed frames flush accepted preceding text
and cannot advance to the rejected cursor. Existing transport and scheduler
regressions are included in the focused run.

No permissions, API, persistent state or provider behavior changes. The helper
uses linear work and transient arrays only within existing bounded event batches
(transport count limit 2,048); it does not add retained state or asynchronous
work. Mixed frames retain original order; malformed data retains the oracle's
original result/error rather than being repaired or silently dropped. Existing
transport validation remains authoritative.

## Reproduction

Run from the repository root (Node 24.21.0 in the recorded run):

```sh
node docs/performance/t3-chat/next-stream-benchmark.mjs . > docs/performance/t3-chat/next-stream-cpu-results.json 2> docs/performance/t3-chat/next-stream-benchmark-stderr.txt
node --experimental-strip-types --test frontend/test/chat-batch.test.ts frontend/test/chat.test.ts frontend/test/ordered-batch.test.ts frontend/test/transport.test.ts > docs/performance/t3-chat/next-stream-focused-tests.txt 2>&1
npm --prefix frontend run typecheck > docs/performance/t3-chat/next-stream-typecheck.txt 2>&1
node_modules/.bin/prettier --check frontend/lib/chat-batch.ts frontend/test/chat-batch.test.ts docs/performance/t3-chat/next-stream-benchmark.mjs docs/performance/t3-chat/next-stream-report.md
```
