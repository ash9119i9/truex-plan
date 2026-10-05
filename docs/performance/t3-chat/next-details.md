# Lazy chat details and message controls

Source baseline: `d6e3f45a45e6948873b8a64d0a9453fb2c2f4307`. T3 reference:
`cf3e714b0f58e29c8fa8660db50d2187e3263b65`, locally inspected at
`apps/web/src/components/chat/MessagesTimeline.tsx:5147,5342,4318`,
`apps/web/src/components/ChatMarkdown.tsx:997`, and
`apps/web/src/components/chat/MessageCopyButton.tsx:29`.

Reasoning now passes its existing entries to the disclosure, joins/counts only
when open, and mounts no detailed text while closed. The closed label says
“Reasoning · Complete”; the word count remains available when expanded.
Activity retains its local detail state behind the installed React19.2 Activity
boundary; a memoized body stops incoming event projections while hidden and
reopening receives the latest authoritative props. No cache owns live authority.

Terminal activity percentages now describe actual plan progress only. A failed,
stopped, or completed run without a plan displays no invented100% bar. Unknown
outcomes say “Request ended” and receive no successful completion icon. Actual
completed plans may still show100% as plan progress independently of run outcome.

Answer/code controls copy exact answer Markdown excluding the existing hidden
suggestion suffix, or exact rendered code text (including whitespace and terminal
newlines). Denied/unavailable clipboard access gives an accessible recovery
message and allows retry. Code wrapping is local to each stable code renderer.
Long prompts retain their complete selectable text behind a height disclosure.
No group keys, turn/request anchors, receipts, approval controls, visualization
mount boundaries, or scrolling/follow policies were changed.

## Evidence

| Controlled observation                                         |           Baseline | Candidate |
| -------------------------------------------------------------- | -----------------: | --------: |
| 900,000-character collapsed reasoning markup                   |      900,781 bytes | 779 bytes |
| Collapsed detailed reasoning text mounted                      | 899,999 characters |         0 |
| Hidden activity map/forEach calls over30 forced updates        |                 60 |         0 |
| Failed terminal card without plan shows100%                    |                Yes |        No |
| Stopped terminal card without plan shows100%                   |                Yes |        No |
| Focused Enter opens newest streamed reasoning                  |                  — |    Passed |
| Expanded activity state survives hide/reopen with fresh events |                  — |    Passed |
| Exact Unicode/whitespace answer and code clipboard bytes       |                  — |    Passed |
| Denied clipboard status and retry control                      |                  — |    Passed |
| 390px viewport,500-character code token wraps inside page      |                  — |    Passed |

Raw evidence: `next-details-ssr-{before,after}.json`,
`next-details-tests-{before,after}.txt`, `next-details-browser-results.json`.
The7 actual React server-render regressions fail against frozen originals and
pass against the candidate. The full frontend suite at this checkpoint passed303
tests. Typecheck passed before concurrent project-creation tests temporarily
changed their API arguments; final integrated checks belong to the root task.

Browser evidence uses the native T3 Code Electron Chromium152 preview at1280px
and390px, production React and actual components in an isolated esbuild fixture.
No real chat, provider, API, developer server or deployment was used. The30 raw
timing samples use forced flushSync commits and have zero warmups: they measure
CPU/DOM updates, exclude layout/frame scheduling, and support no production
latency or p95 claim. Native rAF sampling stalled, so it was discarded. Safari,
real mobile hardware, virtual-row remount behavior and production scroll/media
stability remain outside this isolated component measurement.

## Reproduce

```sh
node --experimental-strip-types --test frontend/test/next-details.test.ts
node --experimental-strip-types docs/performance/t3-chat/next-details-ssr.mjs
node docs/performance/t3-chat/next-details-fixture.mjs
```

Open a separate native preview tab at `http://127.0.0.1:4494/?before=1`, then the
same URL without `before`. Evaluate `projectionProbe` from
`next-details-browser-probes.mjs`. For a red regression run, export the four
baseline component files with `git show BASELINE:frontend/components/FILE` to a
temporary directory, set `NEXT_DETAILS_BASELINE_DIR` to it, and rerun the tests.
Baseline projection probes preserve the legacy hidden mounts and percentages;
the test fixture never substitutes the production implementation itself.
