# Source snapshot and replay synchronization

The runtime previously encoded its retained transcript on every subscription,
even when a client already owned the exact current cursor. Platform recent-window
projection happened after those historical bodies crossed the runtime boundary.
The new capabilities choose snapshot records at the source and replace valid
warm replay's transcript snapshot with an operational synchronization marker.

## Additive runtime contract

| Option         | Local HTTP  | AgentCore invocation envelope | Allowed reads              |
| -------------- | ----------- | ----------------------------- | -------------------------- |
| `window: true` | `?window=1` | Top-level `window: true`      | GET thread snapshot/events |
| `sync: "v1"`   | `?sync=v1`  | Top-level `sync: "v1"`        | GET thread events          |

`RuntimeTransport`, the AgentCore invocation validator and the local routes share
option validation. Wrong types, duplicate/conflicting query options, unsupported
versions and wrong route/method scopes are rejected. GET bodies remain forbidden
in AgentCore; no query-bearing invocation path is accepted. Omitted options keep
the previous full snapshot behavior. Thread creation/resume additionally report
the applied approval mode only when the caller supplied a validated mode.

Source window selection retains the latest ten identified message-turn groups,
active and pending-approval turns, and unfinished entries/their turn groups. It
keeps complete selected messages/reasoning; a large single turn is never silently
truncated. Finalized legacy messages without turn IDs retain a recent tail of
twenty; unfinished identity-less records remain visible. Historical timings and
traces follow the selected turns. The opt-in window omits raw diff text, which the
public chat projection already omits. Defaults retain it. Selection reads raw
identity/final-state fields before any omitted body is mapped or JSON-encoded;
an adversarial historical body getter test proves it is not visited by encoding.
Thread storage itself remains unchanged.

## High-water handoff

Valid opt-in replay captures one runtime high-water sequence, sends retained
events above the requested cursor through that sequence, and then emits:

```json
{
  "type": "sync.completed",
  "threadId": "thread",
  "seq": 7,
  "cursor": "generation:7",
  "at": "publication-time",
  "data": {
    "protocol": 1,
    "mode": "replay",
    "fromCursor": "generation:5",
    "highWaterCursor": "generation:7",
    "snapshot": {
      "cursor": "generation:7",
      "state": { "kind": "running", "turnId": "turn" },
      "pending": [],
      "messages": [],
      "thinking": [],
      "plan": null,
      "goal": null,
      "diff": "",
      "timings": [],
      "traces": [],
      "rateLimits": null,
      "subAgents": []
    }
  }
}
```

The operational snapshot restores actual pending approvals, current turn state,
plan/goal, rate limits, helpers and recent timings/traces. Its transcript arrays
are empty. In a zero-gap replay, the marker is the only frame and constructing it
calls the transcript snapshot method zero times. The marker reuses the captured
high-water cursor, so consumers must exempt it from ordinary event-cursor dedup
and accept it only after applying its operational state.

An absent cursor produces a bounded source snapshot and `mode: "snapshot"`
marker. Invalid, expired, changed-generation, ahead or oversized replay adds a
preceding `resync.required` frame and falls back as a whole: no partial replay is
sent before the fallback decision. Marker reason codes are `missing_cursor`,
`invalid_cursor`, `generation_changed`, `cursor_expired`, `cursor_ahead`,
`replay_event_limit` and `replay_byte_limit`.

Cursors require an exact generation plus canonical nonnegative safe integer,
within the retained contiguous range. Replay bootstrap limits are 500 events and
2 MiB each for raw JSON and SSE-framed encoded bytes. Retained replay queues also
have an 8 MiB encoded-byte ceiling, matching the existing socket-buffer safety
ceiling; oldest prefixes are evicted. A single larger event remains eligible for
ordinary live delivery but is not retained for replay. Old cursors then fall
back; an already-applied current cursor can still do zero-gap synchronization.
This byte retention cap also affects legacy replay under oversized payloads.

Capture, bootstrap publication and live subscriber attachment execute in one
event-loop turn without awaits. Marker delivery follows all replay frames and
precedes later runtime notification tasks. Existing slow-subscriber protection
closes an over-buffered response before readiness can be marked complete; no
live subscriber is attached after bootstrap failure.

This protocol establishes coherence for runtime source projection/operational
state. It does **not** establish a durable Mongo history cursor by attaching a
runtime cursor to a mixed HTTP recovery response. Full `/items` reconciliation
remains unchanged. Client warm-resume authorization, source-cache/cursor pairing,
and separate durable-page ownership are integration requirements with their own
tests. A mixed HTTP timeline alone remains ineligible.

Cold-resumed historical threads cannot currently prove source coverage: resume
restores runtime items but does not reconstruct this manager's message/reasoning
buffers, and its asynchronous response may overlap live notifications. A restored
active prefix followed by a delta would otherwise create a suffix-only buffer.
Threads tracked from creation remain eligible; entering cold resume disables
eligibility conservatively, including configuration reloads. An ineligible
`sync: "v1"` subscription uses legacy replay/snapshot/live delivery without a
completion marker, so the client cannot establish a source pair and keeps full
recovery. The guard remains disabled for that thread's manager lifetime. Coherent
source reconstruction after restart is separate future work.

## Evidence and limits

[next-snapshot-paired-results.json](next-snapshot-paired-results.json) contains
actual pinned baseline manager `d6e3f45a45e6948873b8a64d0a9453fb2c2f4307` and
candidate source hashes, hardware/runtime, timestamp and all raw samples. Both
managers receive identical synthetic notifications and write their durable
records to isolated temporary directories. Each scenario has one warmup and
five measured repetitions. Seeding/disk writes are outside the measured region.
Snapshots assert exact selected text/cursor and the candidate default full
snapshot equals the baseline full snapshot. Zero-gap SSE asserts the unchanged
cursor and the exact expected snapshot-call count (baseline two; candidate zero).

The JSON is authoritative for numerical results. The manager already caps
finalized retained messages at 1,000; the 10,000-input fixture therefore retains
1,000 source messages. This is source selection/serialization CPU and bytes,
not full stored-history recovery cost or end-user latency. It excludes HTTP/AWS
network time, platform public mapping, Mongo, full `/items` reconciliation,
React/Markdown/browser rendering, production p95, frame gaps and long tasks.
The measured idle operational marker is small; an active approval's actual
details may make it larger. Whole oversized current turns remain possible.

| Source fixture                | Scenario     | Baseline median/bytes | Candidate median/bytes |
| ----------------------------- | ------------ | --------------------- | ---------------------- |
| 100 finalized inputs          | Snapshot     | 0.097 ms / 213,561    | 0.018 ms / 21,531      |
| 1,000 finalized inputs        | Snapshot     | 0.928 ms / 2,136,862  | 0.056 ms / 21,562      |
| 10,000 inputs; 1,000 retained | Snapshot     | 0.818 ms / 2,140,193  | 0.036 ms / 21,593      |
| 1,000 finalized inputs        | Zero-gap SSE | 0.876 ms / 2,136,980  | 0.012 ms / 485         |

The zero-gap fixture changes transcript snapshot calls from two to zero;
the marker's operational fields remain authoritative.

The source regression suite demonstrably fails against the pinned manager:
[next-snapshot-red-tests.txt](next-snapshot-red-tests.txt) (four failed assertions)
and [next-sync-red-tests.txt](next-sync-red-tests.txt) (synchronization regressions).
The cold-resume prefix/suffix guard regression also fails against the reviewed
candidate with only its capability guard removed:
[next-sync-coverage-red-tests.txt](next-sync-coverage-red-tests.txt).
Final checks passed all 189 agent-core tests and six focused platform
transport/synchronization tests, with no failures or skips; both builds passed.
Logs: [core tests](next-snapshot-core-tests.txt),
[transport tests](next-snapshot-transport-tests.txt),
[core build](next-snapshot-core-build.txt),
[platform build](next-snapshot-platform-build.txt).

The actual Express source manager and actual AgentCore invocation bridge are
exercised together. Only the provider and AWS network boundary are replaced.
Direct HTTP and deployed-envelope paths return identical complete replay/marker
envelopes apart from publication timestamp, including zero-gap running state
and pending user-input approval. The actual public projection omits internal
thread IDs; the fixture stamps the authenticated session scope and exercises
the frontend source helper's fresh pairing and zero-gap operational restoration.
Both transports also prove the cold-resume coverage guard emits no marker and
the helper cannot authorize the incomplete prefix/suffix projection. Invalid
invocation options do not start services. A focused frontend review run passed
73 source-sync/transport/chat/ordered-batch tests:
[next-sync-frontend-review-tests.txt](next-sync-frontend-review-tests.txt).

Adversarial cases cover missing/invalid/expired/future/generation cursors,
restart, 501-event replay, UTF-8 multibyte text, JSON-escaped NULs, SSE overhead
exceeding 2 MiB while raw JSON alone fits, over-8-MiB retention eviction,
no partial replay on overflow, whole oversized answer preservation, and slow
consumers receiving no completion marker/live subscription. Existing full
snapshot and healthy large-tool replay tests remain passing. No database
migration, stored-message deletion or provider behavior change is introduced.
Rollback disables the additive read options; the retained byte bound can be
reverted separately without altering durable history.

## Reproduction

From the repository root, using Node 24.21.0 in the recorded run:

```sh
node --import ./agent-core/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-snapshot-benchmark.mjs . > docs/performance/t3-chat/next-snapshot-paired-results.json 2> docs/performance/t3-chat/next-snapshot-benchmark-stderr.txt
node --import ./agent-core/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-snapshot-benchmark.mjs . --red-tests > docs/performance/t3-chat/next-snapshot-red-tests.txt 2>&1
node --import ./agent-core/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-snapshot-benchmark.mjs . --sync-red-tests > docs/performance/t3-chat/next-sync-red-tests.txt 2>&1
node --import ./agent-core/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-snapshot-benchmark.mjs . --coverage-red-tests > docs/performance/t3-chat/next-sync-coverage-red-tests.txt 2>&1
npm --prefix agent-core test > docs/performance/t3-chat/next-snapshot-core-tests.txt 2>&1
npm --prefix agent-core run build > docs/performance/t3-chat/next-snapshot-core-build.txt 2>&1
npm --prefix platform run build > docs/performance/t3-chat/next-snapshot-platform-build.txt 2>&1
```

For focused platform fixtures, run from `platform/`:

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test test/runtime-synchronization.test.ts test/runtime-transport.test.ts > ../docs/performance/t3-chat/next-snapshot-transport-tests.txt 2>&1
```
