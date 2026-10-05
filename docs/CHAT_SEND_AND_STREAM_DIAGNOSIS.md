# Send-to-answer delay diagnosis and implementation plan

Reviewed 2026-10-06 with three GPT-6.1-Sol sub-agents. Production code remains
unchanged from the previous implementation. This pass adds diagnostic evidence
and a fix plan only. The user reports that both first and follow-up questions
appear immediately, followed by a wait before the agent's answer begins.

## What the evidence establishes

There are two separate waits: platform preparation before the runtime turn starts,
and runtime/model/tool work before the first answer text arrives. Rendering work
can add roughness after arrival, but the measured runtime silence already exists
upstream of the browser. The previous warm-switch and reducer benchmarks did not
measure submit-to-first-answer latency.

| Observation                                                                      | Evidence                                                                   | Meaning and boundary                                                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Optimistic question is appended before creation/network awaits                   | Executed production send callbacks; user confirms immediate question       | Moving that row earlier will not fix this reported delay; callback timing is not browser paint                             |
| Ten existing saved turns: runtime acceptance 14.93–34.83 ms                      | Read-only persisted public timing endpoint                                 | `turn/start` responds quickly once platform preparation has finished                                                       |
| Same sample: first answer 1.87–8.65 seconds, median 3.04 seconds                 | Existing runtime clocks, not a new model request                           | Real waiting after runtime turn start; excludes earlier platform preparation, earlier reasoning/tool output, SSE and paint |
| Latest turn: first answer 1.87 s; stream 2.42 s; largest answer-delta gap 1.53 s | Existing saved timing                                                      | The stream contains upstream pauses before frontend rendering can act                                                      |
| Older sampled largest gap: 3.83 s                                                | Existing saved timing                                                      | No browser animation can produce actual answer text while those runtime deltas are absent                                  |
| Latest manager handler total: 5.97 ms                                            | Existing saved timing                                                      | Manager handler processing is small compared with the observed wait; not a measurement of gateway or provider CPU          |
| Existing configured database: median warmed ping 224.98 ms, five samples         | Direct read-only ping, no index creation/data reads/writes                 | Database round trips are materially expensive in this environment; ping is not a query/send profile                        |
| Healthy owner-scoped send: five serial database finds, then insert and update    | Actual service + isolated Mongo command monitoring                         | Sequential work remains on every follow-up; optional settings, plan, skill, title and MCP branches add work                |
| Actual page batch: 1,000 reasoning/mixed events, 10,000 display entries          | Synthetic source-hashed callback probe, roughly 29/34 ms                   | Burst/catch-up main-thread risk; ordinary 16-event batches stay under 1 ms in the probe                                    |
| Interrupted-answer history: 10,000 entries, 50 million visibility comparisons    | Synthetic actual selector, about 215.5 ms versus 0.10 ms finalized control | A verified adverse-state CPU cost; not proof this user's short conversation has that state                                 |

The sample contains the three newest existing sessions and at most five saved
turn timings from each: ten turns total. No new user message, provider call,
runtime resume, database mutation or environment/credential output was needed.
Only numeric metrics are saved; user text, session IDs and prompts are omitted.
The live browser reported no focus, so no physical frame-gap or paint claim is
made. Read-only API and direct database measurements also ran without browser
timer dependence.

## Why every send still waits

The production path is:

```text
Submit
  → Show question immediately
  → Create session if this is the first message
  → Authorize/read session
  → Rebuild agent/model/MCP/skill configuration
  → Validate connector DNS
  → Resume/confirm runtime configuration
  → Reapply saved model/effort settings when present
  → Persist pending user message and optional title
  → Start runtime turn
  → Runtime/model/reasoning/tools produce answer text
  → SSE parsing and ordered publication
  → Chat projection, Markdown, layout and scrolling
```

`platform/src/service.ts:1492` always awaits `resume(s)` before sending a turn.
`configuration()` first loads the agent, then serially reads the model, tenant
MCPs, owner MCPs, conditional reserved names, and skills. Connector DNS checks
are also serial. These checks are authoritative; skipping them based on stale
browser state would risk configuration, permission and connector safety.

On a warm unchanged runtime, `agent-core/src/manager.ts:545` avoids the underlying
runtime resume RPC but still constructs and returns a full transcript snapshot.
The recent snapshot/SSE improvements do not apply to this default POST response.
This is an unnecessary payload candidate, but its actual long-history send
latency still needs a paired measurement.

`resume()` also sends the saved settings through another runtime capability call
on every send where settings exist. In the isolated actual-service probe,
injecting 20 ms per runtime hop produces 45.47 ms basic acceptance versus
66.65 ms with saved settings; three 25 ms DNS checks produce 124.44 ms. These
demonstrate the sequential gates, not the user's actual send duration. Raw
results are authoritative if a reproduction updates the values.

**Inference, not a measured live send:** if the seven monitored database commands
have round trips comparable to the approximately 225 ms ping, that alone could
contribute about 1.57 seconds. Four configuration reads could contribute about
0.90 seconds. Actual command execution, connection-pool wait, tenant/catalog
routing and concurrency must be timed before claiming this as the live budget.

A controlled actual-service reproduction also injects 225 ms at each of the
seven isolated Mongo operation boundaries and 20 ms per runtime hop. It measured
1.63 seconds to acceptance, with about 911 ms in configuration, while
`platformRoundTripMs` reported only 249 ms. This proves the serial gate and
measurement blind spot under imposed latency; it is not a measured live send.
One warmup precedes three measured samples.

The remaining 1.87–8.65-second runtime first-answer interval cannot yet be split
between provider/network, runtime preparation, reasoning, tools or retries. It
is incorrect to assign all of it to one provider from these metrics alone.

## The metrics currently hide part of the problem

`platformRoundTripMs` begins only immediately before `/turns`; configuration,
resume, DNS and earlier database work are excluded. Runtime `acceptMs` and
`ttftMs` begin later, immediately before `turn/start`. `ttftMs` records the first
agent answer text delta, not the first reasoning event or provider body byte.
Gateway `ttfbMs` records the first emitted response frame; an early
`response.created` can precede answer text. Direct Responses routes bypass that
gateway, so correlation and phase instrumentation must cover the actual route.

## Fix order and verification requirements

1. **Measure the complete send timeline.** Add request-scoped phase timings for
   authorization, configuration database reads, DNS, resume/response bytes,
   settings, persistence, turn acceptance, first reasoning, first answer text and
   publication. Add browser marks for submit, question commit, receipt, first
   answer commit and visible paint in a focused foreground page. Correlate
   request/turn IDs without prompts, keys, configuration bodies or secret data.
   Distinguish first/follow-up, cold/warm, changed/unchanged configuration and
   gateway/direct routes. Keep the existing runtime metrics' meanings intact.

2. **Reduce the serial configuration reads.** Once the authorized agent is known,
   run independent profile, tenant MCP, owner MCP and skill reads concurrently.
   Keep deterministic validation/name precedence and fail-closed policy. Use
   bounded DNS concurrency only while retaining current DNS revalidation and
   rebinding protections. No broad stale configuration cache. Verify identical
   output/error behavior, tenant/owner isolation, simultaneous config changes,
   unavailable dependencies, and paired slow-database/DNS fixtures.

3. **Use a lean, exactly acknowledged send-preparation response.** Add an explicit
   operational/configuration response for send preparation that omits transcript
   bodies. Reuse existing operational state and mode confirmation. Default
   resume/history contracts, cold loading, goals/plans, approvals, pending config
   application and per-thread locking remain intact. Only suppress repeat
   settings application after a validated applied-version/digest acknowledgment;
   the current MCP fingerprint alone does not prove model/effort freshness.
   Measure bytes and input-to-acceptance before/after with short and long chats.

4. **Make the wait understandable and investigate upstream silence.** Show
   truthful preparation, accepted/waiting and streaming states, keeping the
   composer editable and preserving draft/duplicate-send safeguards. Immediate
   local feedback must not falsely report model execution before acceptance.
   Record first provider chunk, first model text, tool/reasoning intervals and
   retry gaps on the actual configured route. Optimize the dominant proven phase
   while retaining answer quality; do not change providers/settings or shorten
   safety timeouts based on an unmeasured guess.

5. **Address verified rendering risks and profile scroll behavior.** Replace the
   nested visibility scan with a precomputed finalized-answer-by-turn set, with
   exact visibility/order equivalence tests for interrupted and aliased answers.
   Add adjacent reasoning coalescing only for identical item/turn/channel and
   boundary semantics, with exact source/display/cursor oracle comparisons.
   Then trace the duplicate scroll owners: Legend automatic following plus
   per-commit imperative `scrollToEnd`. Choose one owner with explicit user
   scroll cancellation. Compare frame gaps and anchor stability before/after.
   Composer geometry and whole-prose Markdown changes remain profile-gated.

Each implementation is a separate focused step. Baseline and candidate must use
the same workload, source/configuration, warmup and failure conditions. Numerical
targets will be assigned after phase measurement; no production improvement is
promised from synthetic CPU or injected-latency results.

## T3 reference and scope

The local T3 reference is `cf3e714b0f58e29c8fa8660db50d2187e3263b65`.
Truex already follows its immediate optimistic send and acceptance-scoped lock
principles. T3's turn command carries draft bootstrap configuration and its
provider session manager separately owns residency. Adopting those principles
does not require replacing Truex's storage/security architecture.

T3's text accumulator and explicit live-scroll policy provide source references
for channel-safe coalescing and following behavior. There is no measurement of
T3's model/provider latency here. The earlier warm-switch gains are real within
their fixture scope, but cannot establish a faster first model answer.

## Evidence and reproduction

- [Existing saved runtime timings](performance/t3-chat/send-diagnosis-live-runtime-timings.json)
- [Configured database ping](performance/t3-chat/send-diagnosis-mongo-ping-results.json)
- [Read-only local API timings](performance/t3-chat/send-diagnosis-live-read-latency.json)
- [Send path report and actual page/service probes](performance/t3-chat/send-diagnosis-report.md)
- [Actual stream batch report/probe/profile](performance/t3-chat/stall-diagnosis-stream.md)
- [Render/visibility review and probe](performance/t3-chat/render-diagnosis-review.md)

Run isolated probes from the repository root:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/send-diagnosis-service-probe.mjs
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/send-diagnosis-page-probe.mjs
node docs/performance/t3-chat/stall-diagnosis-stream-probe.mjs
node docs/performance/t3-chat/render-diagnosis-projection.mjs
```

For the configured database's read-only ping, run from `platform/`:

```sh
node ../docs/performance/t3-chat/send-diagnosis-mongo-ping.mjs
```

That script loads configuration privately, warms the connection, issues only
ping commands and prints numerical timings; it never prints credentials,
connection hosts, database names or error messages. Isolated service/page/stream
probes have their own recorded Node versions and exclude real provider calls.
No production fix or deployment has been performed in this diagnosis pass.
