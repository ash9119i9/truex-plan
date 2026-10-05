# Production-build chat switching comparison

Both frontend builds use Next's production Turbopack build and the same isolated
API fixture on port 4400. Baseline is
`d6e3f45a45e6948873b8a64d0a9453fb2c2f4307`; the final candidate source is pinned
by `next-final-manifest.json`. No user database, credentials or provider is used.

The fixture intentionally delays persisted reads 15 ms, full recovery 600 ms,
and SSE bootstrap 30 ms. It contains 40-message A and 1,000-message LONG chats.
After both chats are opened, each build switches A/LONG thirty times at
1280×800 in the native T3 Code Chromium preview. Cached display remains a
separate concern from synchronization readiness. Before/after share the same
data, delays, observer, and warmed chats. Their runs are sequential.

| Measurement                                  |    Before |    After |
| -------------------------------------------- | --------: | -------: |
| Median first matching transcript DOM         |  20.30 ms |  7.90 ms |
| Median matching transcript + ready header    | 630.05 ms | 40.80 ms |
| Observed p95 ready, nearest rank, 30 samples | 638.60 ms | 43.00 ms |
| Requests over thirty switches                |       150 |       60 |
| Full recovery requests over thirty switches  |        30 |        0 |
| Mounted message nodes per measured switch    |         9 |        9 |

Each candidate switch still makes an authenticated persisted read and a source
SSE subscription. The baseline additionally requests full recovery, traces and
timings. Candidate replay restores current operational state before opening
finishes; it does not merely change the status label early.

Raw results: [before](next-browser-before.json), [after](next-browser-after.json),
[failure/operational checks](next-browser-failures-after.json).

This proves DOM publication/readiness and avoided requests under these fixture
conditions. It is **not** physical paint, frame gaps, production p95, actual T3
latency or provider generation speed. Both pages reported `document.hasFocus()`
false and visible document state. Background timer/rAF throttling made earlier
timer-polling exploration unsuitable; the recorded probe uses MutationObserver
directly. Baseline polling explorations are excluded. DOM children are recycled
by the virtualizer and their DOM order is not their visual order; chronological
authoritative entries and visible geometry were separately checked.

## Additional candidate checks

- Warm same-cursor marker restores running state and the current public
  requestUserInput approval in 45.70 ms, using only persisted history and SSE.
  The approval was never observed while the header still reported syncing.
- Failed full recovery shows its error and the next open still requests full
  recovery; it cannot become a warm pair. Observed retry readiness 616.70 ms.
- A 403 clears cached transcript and leaves no revoked message content visible.
  Deferred-response resurrection is separately covered by executable page tests.
- A fresh legacy-server open with no marker completes normal recovery in
  611.80 ms, without adding the five-second marker deadline.
- A 1,000-fragment burst renders exactly 1,000 `x` characters, one final answer,
  no error boundary, and 21 authoritative entries (20 recent + answer).
- Long-window projection tests preserve every ID/text and request/answer order
  across thirty warm overlays. Browser fiber inspection confirmed the exact
  authoritative 980–999 sequence; visible top and bottom rows follow it.

An exploratory pending fixture accidentally used raw `params` instead of the
public `detail.questions` contract and hit the existing error boundary; it was
corrected and is excluded from acceptance results. Restoring fixture access
while an earlier full-read flight was still returning 403 retained that old
failure conservatively; legacy verification used a fresh page, not that flight.

## Reproduce

Install each checkout's normal dependencies. Build and start the detached
baseline and candidate in isolated directories, setting
`NEXT_PUBLIC_PLATFORM_URL=http://127.0.0.1:4400` during both builds. Run:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-chat-browser-fixture.mjs
```

Open each build through the native preview, select Sidebar, and evaluate
`installSwitchObserver` from `next-chat-browser-probes.mjs`. Open A/LONG once
each, warm A/LONG again, clear `/__metrics` with DELETE, reset
`window.__observedSwitches`, and invoke `tenSwitches` three times. Save the
samples and `/__metrics`. Ensure the matching transcript has mounted message
nodes as well as a ready header. All recorded measured switches had nine.

The actual source manager, both runtime transports, strict public projection and
source reducer are independently integration-tested. This browser fixture is
not evidence for the manager's replay ring or restart coverage. Cold-loaded
runtime threads remain on full recovery, as documented in
[source resume](next-source-resume.md).
