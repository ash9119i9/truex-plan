# Gallery prompt and runtime failure verification — 2026-10-07

## Scope and incident

Reported ID `01a11359-1531-7dd2-b112-2884329454d2` identifies a turn in thread
`01a1133a-4107-70b3-b672-9bdf7eb3add0`. Its retained local runtime record shows
`codex_error_info: "other"` and:

```text
stream disconnected before completion: The connection to the model provider was interrupted.
```

The turn ran from 04:02:47 to 04:20:39 IST. Runtime-reported active duration is
1,027,758 ms; timestamp-to-timestamp wall time is 1,071,902 ms. The original
thread, workspace, model profile and deployment configuration were not modified
by these tests.

The original request was:

> I am testing the render feature can you render What are things you can render with a simple example like
> card, table, pie chart, bar chart every feature you can render Completely covering all

Its follow-up was:

> Can we make a gallery much more Elaborate full gallery UI controls?

The failed turn itself followed interruptions and contained:

> Bro what happened why were in running in loop[

## Evidence and reproduction

The initial gallery had already published successfully. The failed turn made
workspace calls to reconstruct the elaborate gallery, then read 420 of its 838
lines (28,513 characters). The last successful request reported 82,862 input
tokens. No `html_render` call occurred in the failed turn. Six subsequent model
attempts received HTTP 200 streaming headers and failed approximately 121–134
seconds later; the runtime retried five times before ending the turn.

Live tests used the configured Claude Sonnet 5 Anthropic provider through a
private ephemeral gateway, with disposable runtime homes. Credentials stayed in
memory. Engine stream retries were set to zero for diagnostic runs to bound
cost and avoid repeating the original multi-minute retry loop. Preview was
disabled in the live conversations, matching the original tool availability.

| Test | Observed result |
| --- | --- |
| Exact original prompt, fresh thread | Published one 14,685-byte visual; completed in 55.38 seconds with two model requests |
| Exact original prompt followed by the elaborate-gallery request, second fresh thread | Initial visual completed in 53.41 seconds; follow-up made 18 model requests over a 240-second diagnostic budget without publishing a revised visual |
| Published fresh visual, real isolated Chromium | No console errors at 390 and 1280 px; preview times 1.30 and 1.18 seconds |
| Saved conversation reconstructed through the last successful file read, first probe | Completed in 7.13 seconds; proposed a workspace export |
| Same reconstructed history, second probe | Failed after 125.06 seconds: HTTP 200, 33 body chunks, then no data for 120 seconds |
| Controlled Anthropic provider stalls, real SDK | Reproduced first-byte and mid-stream timeout masking with 150 ms limits |
| Real pinned runtime + Anthropic SDK + public-event mapping after the fix | A controlled 150 ms mid-stream stall produced public `PROVIDER_TIMEOUT` with a safe message instead of `RUNTIME_FAILED` |
| Saved 48,202-byte elaborate gallery | Complete HTML structure, but JavaScript fails with `Unexpected end of input`; only title/description render |
| Repaired copy of saved gallery | No console errors at 390 and 1280 px; 137 DOM interaction assertions passed at each width |

History probes restore the exact user text and saved response items, but are not
byte-for-byte captures of the original provider request. The reconstructed
request had 63 Anthropic messages and 383,795 bytes; the successful probe reported
114,190 input tokens. This larger replay context and changed provider timing
limit causal conclusions about context size. One success and one failure show
that the failure is intermittent; neither proves that the prompt is invalid or
that large context alone causes the stall.

The failing live probe received headers in 3.70 seconds and its last body chunk
at 5.04 seconds. The gateway's 120-second idle watchdog then emitted:

```text
upstream stream failed: no data from the model provider within 120000ms
```

This verifies the provider-stall/idle-timeout mechanism. The remote proxy's
internal logs were not available, so the reason it stopped delivering data is
still unknown.

The follow-up sequence used the exact two user prompts. Its plan approval was
answered automatically by the harness; engine retries remained
disabled. It wrote and edited `tmp/gallery.html`, made an out-of-range file read,
then corrected that read. Its first `html_render` attempt supplied
`PLACEHOLDER_WILL_BE_REPLACED` as the HTML. The existing document validator
correctly rejected that input. The harness interrupted the next provider request
at the four-minute follow-up limit. This is an incomplete test, not evidence that
the provider timed out on that turn; the deliberate interruption and subsequent
runtime-process shutdown are diagnostic cleanup, not additional incidents. The
elaborate generation/publication flow cannot be marked as passing.

## Separate gallery defect

The outer `(function() {` at source line 157 was never closed. The `})();` at
line 835 closes a nested panel function, leaving the outer function unfinished.
Adding one `})();` before `</script>` repairs the syntax. Node syntax checking
fails on the original and passes on the repaired copy. Both browser widths also
pass after that repair. The original artifact was preserved.

Interaction checks cover seven tabs, keyboard tab wrapping, sortable table
columns, eight populated chart SVGs, range/toggle/select/email controls, chips,
ratings, submit completion, modal dismissal, accordions, toast creation and
DOM/reference integrity. The artifact has no table search or chart controls.
Real timer timing, tooltip appearance, pointer hitboxes and a full accessibility
audit remain unverified. Source review also found missing modal focus trapping
and restoration, star arrow-key navigation and `aria-sort` updates.

## Corrections and remaining work

The Anthropic adapter now preserves gateway-generated first-byte/idle timeout
details in failed streams, keeping the retryable `server_error` code. SDK
timeouts before headers return HTTP 504 instead of being mislabeled as an
unreachable provider (502). Ordinary connection failures and cancellation retain
their behavior. Three regression tests failed before the adapter correction and
passed after it. Six new integration cases cover stalls, steady streaming,
connection reset and cancellation. All 67 gateway tests and its TypeScript build
passed; scoped formatting and diff checks passed.

Public error mapping also recognizes the exact gateway-owned timeout and
interruption messages when the pinned runtime classifies them as `other`.
They now become `PROVIDER_TIMEOUT` or `PROVIDER_CONNECTION_FAILED` with fixed,
safe recovery messages instead of `RUNTIME_FAILED`. Foreign diagnostics and
near-matches remain private generic failures; typed error/status classifications
retain precedence. Mapping tests include appended secrets, URLs, newline and
foreign-error negatives. Full repository tests, all 356 frontend tests and all
four application production builds passed after these changes. The agent-core
suite had 208 passes and five opt-in skips; real Docker previews were exercised
separately above. A final integration probe through the actual pinned runtime,
gateway, Anthropic SDK and public-event mapping confirmed that a controlled idle
stall now reaches clients as `PROVIDER_TIMEOUT`, with no raw timeout duration,
provider address or private diagnostics in the public event. The adapter and
public-mapping corrections add no requests, dependencies, state or retry changes.

This correction identifies the failure; it does not make a stalled provider
complete a response. Additional reliability work should:

1. Inspect remote proxy/provider logs for the failing request times and request
   IDs. Distinguish an upstream stall from a proxy buffering or forwarding issue.
2. Bound runtime stream retries and the total turn wait. The current default
   allows five retries; repeating a silent 120-second request creates a long
   apparent loop. Choose a budget explicitly instead of increasing timeouts
   without evidence.
3. Configure the isolated `html_preview` worker using
   [the deployment instructions](../../VISUAL_REPLIES.md). The original thread
   had no preview tool, so the model could not detect the JavaScript defect in a
   browser before publication.
4. Keep resumable gallery drafts outside `tmp/`, which is cleared on turn
   completion or interruption. Use small targeted reads while editing. Consider
   managed-workspace publication so a large saved document need not be reread
   and regenerated in a tool argument; that API change is not part of this fix.

No retry limits, provider credentials, live profile settings or deployment were
changed. The repaired artifact is a separate local copy, not a replacement
attachment in the reported thread.

## Local evidence

Ignored `.runtime/visual-live-replay/` contains the diagnostic runners and raw
results: `fresh.json`, `history.json`, `history-clean.json`,
`anthropic-stall-results.json`, `timeout-runtime-test.json`, `gallery.json`, `gallery-repaired.json`,
`gallery-interaction-test.json`, `fresh-gallery.json`, repaired HTML and preview
PNGs. `sequence.json` records the incomplete follow-up test; `elaborate.json`
records an earlier 180-second probe that spent 120 seconds waiting for a scope
answer before diagnostic interruption. These are local incident artifacts, not
shipped fixtures. The first probe's
observer recorded a closed-controller error during successful stream cleanup;
that was a diagnostic-wrapper issue, not a provider failure. The observer was
corrected before the failing replay.

Re-run the deterministic timeout regressions without credentials or live data:

```sh
PROJECT_ROOT="$PWD" agent-core/node_modules/.bin/tsx \
  --test model-gateway/test/upstream.test.ts
```

Live replay runners intentionally require the configured local model catalog;
they must not be put in routine CI or interpreted as production load tests.
