# Implemented T3-derived chat improvements

Implemented against Truex `d6e3f45a45e6948873b8a64d0a9453fb2c2f4307`, using the
local T3 reference `cf3e714b0f58e29c8fa8660db50d2187e3263b65` and three
GPT-6.1-Sol implementation agents. The original
[plan](T3_CHAT_NEXT_IMPLEMENTATION_PLAN.md) records the verified T3 source
locations. These are adaptations to Truex's web/runtime architecture; they do
not claim a wholesale copy of T3's state model or measured T3 performance.

## Changes and purpose

| Layer                     | Implemented change                                                                                                                                              | Why                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Creation and submission   | Shared existing text validation before optimistic dispatch; exact runtime approval confirmation on creation, changes and resume                                 | Prevent invalid sends and execution after selected configuration failed                                                       |
| Composer                  | Editable during catalog/creation waits, explicit Creating/Sending/Steering status, revision-owned draft restoration                                             | Preserve a newer draft typed while the previous submission waits; retain duplicate-send and uncertain-receipt protection      |
| Stream projection         | Join only adjacent compatible message deltas inside the existing publication batch                                                                              | Avoid repeated transcript scans while preserving exact text, identity, barriers, raw events and cursor accounting             |
| Message/details rendering | Lazy collapsed reasoning; React Activity for hidden expensive details; truthful terminal progress; exact answer/code copy, wrap control, long-prompt disclosure | Reduce invisible work and make copying/reading long responses usable                                                          |
| Persisted history         | Small histories keep one query; large histories load ordering headers and selected page bodies                                                                  | Avoid decoding every old body while preserving authoritative command ordering and complete request groups                     |
| Runtime snapshots         | Select complete recent/current/unfinished source groups before serialization, for explicit window reads only                                                    | Avoid transporting old bodies that the public recent window discards                                                          |
| Thread switching          | Separate source projection/cursor pairs from durable/display caches; high-water replay marker restores live state                                               | Eligible warm opens avoid full recovery while retaining an authenticated durable read and authoritative pending/running state |
| Configured creation       | Optional validated approval mode carried through existing creation and exactly acknowledged                                                                     | Remove a separate mode-update hop before the first turn; old runtimes/platforms retain verified fallbacks                     |
| Sidebar                   | Classification refresh at local midnight/focus/visibility; validated Earlier-shelf preference across remounts                                                   | Keep labels correct without frequent polling and preserve the user's shelf choice                                             |

The existing virtualization, incremental Markdown, scroll anchors, grouped
timeline, independent follow controls, approval policy, permission checks,
durable reconciliation and development startup configuration remain in use.
No dependencies, configuration secrets, database migration, provider behavior,
commit, push or deployment were introduced by this pass.

## Measured before/after

| Controlled measurement                                                       |                                    Before |                                    After | Evidence                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------: | ---------------------------------------: | ----------------------------------------------------------- |
| Warm switch median DOM + ready header, 30 native production-browser switches |                                 630.05 ms |                                 40.80 ms | [Browser](performance/t3-chat/next-browser-report.md)       |
| Requests over those 30 switches                                              |         150, including 30 full recoveries |                 60, zero full recoveries | [Raw pair](performance/t3-chat/next-browser-after.json)     |
| Projection CPU: 1,000 adjacent deltas, 10,000 existing entries               |            92.313 ms, 1,000 reducer calls |               0.067 ms, one reducer call | [Stream](performance/t3-chat/next-stream-report.md)         |
| Recent-history service median, 10,000 turns                                  |           72.97 ms; 20,000 bodies decoded |             27.85 ms; 271 bodies decoded | [History](performance/t3-chat/next-history-report.md)       |
| Runtime snapshot median/bytes, 1,000 retained finalized inputs               |                0.928 ms / 2,136,862 bytes |                  0.056 ms / 21,562 bytes | [Snapshot](performance/t3-chat/next-snapshot-report.md)     |
| Zero-gap runtime SSE median/bytes                                            |                0.876 ms / 2,136,980 bytes |                     0.012 ms / 485 bytes | [Snapshot](performance/t3-chat/next-snapshot-report.md)     |
| First acceptance, separate create/mode/send versus configured create/send    | 3 client / 4 runtime calls; 111.08 ms p50 | 2 client / 3 runtime calls; 78.66 ms p50 | [Creation](performance/t3-chat/next-first-send-evidence.md) |
| Collapsed 900k-character reasoning SSR markup                                |                             900,781 bytes |                                779 bytes | [Details](performance/t3-chat/next-details.md)              |

These measurements have different scopes and must not be added together. Browser
results use deliberate 15/600/30 ms API/recovery/SSE delays; stream results are
CPU only. History uses actual isolated Mongo and identical text/pages. Creation
compares two request sequences on the final candidate with injected 20 ms/client
and 8 ms/runtime delays. No production latency, physical-paint/frame-gap, Safari,
mobile IME, provider TTFT, or T3 performance claim is made. Raw samples and
reproduction instructions accompany each report.

## Correctness and failure review

Red/green regressions cover selected-mode failure, invalid/Unicode/oversized text,
duplicate submissions, newer drafts, uncertain acceptance, exact message/cursor
equivalence, malformed frames, replay bounds, generation/retention gaps, hidden
details, clipboard denial, DST/local-midnight transitions, command cycles,
complete oversized history groups, missing bodies, authorization and live
pending restoration.

The final review found and fixed four integration hazards: failed full recovery
qualifying a source pair, revoked ownership surviving in refs, delayed authorized
HTTP history resurrecting revoked display, and source-only AI rows painting
before their durable users. Executable tests run actual production page
callbacks against archived pre-fix callbacks, not a duplicated implementation.
Public stream scope comes from the authorized subscription URL; private runtime
thread IDs remain omitted. Malformed source frames cannot be skipped before a
high-water acknowledgment. Source and durable caches remain separate.

Runtime restart review reproduced a restored answer prefix missing from the
in-memory source projection while later suffix deltas were present. The runtime
now withholds source synchronization markers after any cold load rather than
authorizing incomplete replay. Full `/items` reconciliation remains complete.

## Verification and remaining limits

Final frontend: 331 tests, typecheck, and isolated production Turbopack build
pass. Core: 189 tests and build pass. Gateway: 58 tests and build pass. Final
platform results and source hashes are recorded in
[verification manifest](performance/t3-chat/next-final-manifest.json), alongside
the complete logs. Both baseline and candidate browser builds passed. Final diff
checks pass; there are no lockfile/dependency or unrelated startup changes.

The repository-wide format gate remains failing on pre-existing files: baseline
58 warnings, candidate 55, with zero newly introduced warning paths. New source
helpers/tests and owned formatted components pass scoped checks. An earlier
core run encountered the existing MCP fixture cleanup ENOTEMPTY race; the full
sequential retry and final 189-test run passed. The failed run is retained in the
evidence rather than hidden. There is no separate lint/security script in the
package gates; no production release certification is implied.

- Cold-loaded/runtime-restarted/config-reloaded threads stay on full recovery
  for that manager lifetime until coherent source reconstruction is implemented.
- Automatic EventSource reconnect with a different subscription origin cursor
  conservatively invalidates the pair and performs full recovery.
- Oversized/expired/uncovered pairs and invalid/late markers use existing full
  recovery. Cache limits disqualify whole pairs rather than truncating messages.
- History body decoding is bounded for ordinary pages, but its compact metadata
  scan and ordering still grow with history. Whole oversized turns remain whole.
- A combined idempotent first-send bootstrap was conditional in the plan. The
  measured safe hop removal is implemented; an atomic cross-service transaction
  and durable creation-identity protocol were not added without evidence.
- Further sidebar metadata APIs/render extraction and scroll geometry changes
  remain profile-gated. The existing sidebar props are stable; no measured
  bottleneck justified those extra changes.

Rollback is ordinary code rollback, with no data migration. Runtime options are
additive and old clients retain defaults; mismatched/older components fall back
conservatively. Creation and sending remain separate operations; uncertain
requests are not automatically repeated.

## Try it locally

Restart `npm run dev`, open `http://localhost:3000`, and hard-refresh once. Create
two fresh chats, open both, then alternate them while checking the header and
Network panel. Continuously tracked eligible chats should use persisted history
plus SSE and avoid the full recovery request on warm switching. Existing chats
loaded after a runtime restart deliberately retain full recovery.

Also try drafting a second message during creation, opening/closing reasoning
and activity details, copying a code block, scrolling older history, and
switching away/back while a response or approval is active. The synthetic
benchmark fixture is separate from normal development and does not replace your
backend.
