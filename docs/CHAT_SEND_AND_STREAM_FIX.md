# Send and stream delay: implementation and evidence

Implemented after freezing and testing the existing working tree, including all prior uncommitted chat improvements. All 772 original tests passed before production edits. The final suites pass 811 tests: frontend 343, platform 211, agent-core 199, gateway 58. The current-pass diff and source hashes are recorded separately from the earlier optimizations.

## What changed and why

| Layer                             | Change                                                                                                                                                      | Work removed or reduced                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Platform configuration            | Start independent model, tenant connector, owner connector and skill reads after the agent lookup; consume settled results in the original validation order | Serial database waits before creation and every send                                                                    |
| Platform → agent-core preparation | Message sends opt into validated `response: "operational"`; reuse the existing operational snapshot and approval acknowledgment                             | Full transcript materialization, JSON serialization and transfer during preparation                                     |
| Frontend stream projection        | Coalesce only adjacent compatible reasoning deltas, respecting thread, turn, item, method, channel and ordinal boundaries                                   | Repeated whole-list reduction for compatible reasoning fragments                                                        |
| Frontend visibility               | Index final answers by relevant turn; use sorted prefix lookup                                                                                              | Repeated full-transcript scans for unfinished or interrupted answers                                                    |
| Send diagnostics                  | Return numeric authorization, preparation, dispatch, receipt and total phases; expose them through `Server-Timing`                                          | Previously unmeasured preparation: the old `platformRoundTripMs` covered only dispatch and accepted-receipt persistence |

These changes follow the verified local T3 patterns of keeping runtime preparation separate from transcript loading, keyed reasoning channels and publication batching. Truex retains its own lifecycle and contracts. This is not a T3 performance-parity claim. Concrete T3 file references are in the linked workstream reports.

## Before and after

Same Node v24.21.0, inputs and workloads; frozen baseline measured first. HTTP rows use actual PlatformService, isolated Mongo, RuntimeTransport and ThreadManager with extracted production route handlers. Runtime RPCs are fake, with an identical 20 ms HTTP delay. The database-delay rows inject 225 ms before real Mongo awaits to measure the identified serial gate. Each HTTP scenario has one warmup and five measured samples.

| Matched controlled measurement                                                             | Before median |  After median | Interpretation                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------: | ------------: | --------------------------------------------------------------------------------------------------------- |
| Create + first message, 225 ms Mongo waits                                                 |   3,035.77 ms |   2,125.14 ms | 910.64 ms less application acceptance time (30%)                                                          |
| Followup, 225 ms Mongo waits                                                               |   1,644.34 ms |   1,186.50 ms | 457.84 ms less application acceptance time (28%)                                                          |
| Followup, 1,000 synthetic completed answers                                                |      50.68 ms |      44.71 ms | 5.97 ms less local acceptance time                                                                        |
| Fast local empty-history creation + send                                                   |      72.95 ms |      73.43 ms | No improvement in this small sample                                                                       |
| Fast local ordinary followup                                                               |      50.11 ms |      52.75 ms | No improvement in this small sample                                                                       |
| Runtime resume HTTP response, 1,000 answers × 2,048 characters                             | about 2.15 MB | 482–483 bytes | Transcript remains in manager; operational response contains recent diagnostics                           |
| Actual page callback, compatible 1,000-reasoning-event burst with 10,000 displayed entries |      29.02 ms |       1.01 ms | CPU only, five runs after warmup; exact original-event reducer state and cursor checked                   |
| Visibility filtering, 10,000 synthetic entries with unfinished/interrupted assistants      |     205.86 ms |       0.43 ms | Adversarial CPU fixture, identical visibility; not evidence that ordinary user chats contain this history |

Database command counts and runtime request paths match across each HTTP pair. Configuration output hashes match across the dedicated delayed configuration scenarios. Compatible burst output and final cursor match the raw reducer oracle. Alternating message/reasoning events remain ordering barriers: that worst-case CPU burst measured 34.25 → 35.83 ms and has no improvement claim. Normal finalized visibility filtering remains below 0.1 ms in the 10,000-entry fixture.

Acceptance is not first-answer latency. No live model turn was made for these benchmarks. Previously saved real timings showed 1.87–8.65 seconds from runtime turn start to first answer text and answer-delta gaps up to 3.83 seconds. This implementation reduces application overhead; it does not establish a reduction in those runtime/model gaps. Reasoning and tool activity can occur before answer text. Existing runtime timings plus the new application phase timings distinguish these boundaries for manual testing.

## Verification and failure review

New regressions were run against the old implementation and failed before the relevant fixes. Final default full resume compatibility, cold resume, pending configuration, draining, reload failure/retry, source coverage, approval confirmation and cross-tenant denial pass. Configuration checks cover simultaneous failures, authoritative error precedence, unresolved reads, tenant-wide reserved names, duplicate connectors, skill order and DNS rebinding. Invalid resume preferences reject before HTTP/AgentCore dispatch or service startup. Tests preserve duplicate-send guards, optimistic questions, drafts and uncertain-delivery behavior.

The frozen production BusinessRuntime was executed with the new cold-resume option: its existing configuration allowlist removes the field before the runtime RPC and retains the approval acknowledgment. The installed pinned binary also accepted the extra parameter during decoding without starting a model turn. An older runtime returning a full response remains accepted; contradictory approval acknowledgments still fail closed. Ordinary read/history resume keeps its full default response.

Production frontend build, frontend typecheck, all three backend builds and `git diff --check` pass. The full formatting gate still reports the same **55 existing warning paths before and after, with zero introduced warnings**; this debt was not hidden or fixed through unrelated edits. New tests/helpers and the changed files that were already formatted pass scoped checks. There is no separate lint script in these packages.

A native T3 browser smoke check used an isolated production frontend and fixture API. It observed the question during a 750 ms simulated acceptance wait, retained a draft typed during sending, made one message POST, and displayed all 1,000 reasoning characters and all 1,000 answer characters without an error. This is a functional smoke check, not a matched browser paint benchmark. The live user app also loaded without a visible error; no user chat was sent.

An initial focused ownership test invocation used the repository root instead of the package working directory and failed to locate its files. Its raw log is retained; the corrected package invocation passes all 15 focused tests, and the final full platform suite passes 211. The initial frozen formatting context omitted unchanged scripts; the corrected full context has the same 55 warning paths as the candidate. These are harness corrections, not suppressed application test failures.

## Limits and operational impact

Per-request configuration read concurrency rises to at most four; database pool contention can limit real gains. Already-started read-only queries finish after an early validation failure, with their rejections observed. Fresh connector DNS validation remains sequential and runs on every build. Saved model/effort updates still execute before sending because the operational acknowledgment does not prove those settings were applied. No new retries, permissions cache, dependencies, schema changes or migration were introduced.

Changes apply to the web frontend and API/runtime services, including the desktop browser embedding the same frontend. No Electron-specific optimization is required. Reverting this pass requires no data migration; the default response and additive timing fields support rolling versions. Revert platform opt-in and core response selection together if desired. No push, deployment or user-owned server shutdown was performed.

For manual testing, refresh `http://localhost:3000`, send a first question, then a followup. In Network, inspect `/api/sessions/<id>/messages`: `platformTiming` and `Server-Timing` show application acceptance phases. Existing completed-turn timings measure runtime-to-first-answer separately. Duplicate accepted retries do not include a new acceptance timing. Do not compare development compilation or different prompts as if they were matched model benchmarks.

## Evidence and reproduction

- [HTTP before/after report](performance/t3-chat/send-fix-http-report.md), [raw comparison](performance/t3-chat/send-fix-http-comparison.json), [checks](performance/t3-chat/send-fix-http-checks.txt).
- [Configuration equivalence and concurrency report](performance/t3-chat/send-fix-config-report.md).
- [Operational resume report](performance/t3-chat/send-prepare-report.md), [cold compatibility](performance/t3-chat/send-prepare-compatibility.json).
- [Stream before](performance/t3-chat/send-fix-before-stream.json), [stream after](performance/t3-chat/send-fix-after-stream.json), [visibility before](performance/t3-chat/send-fix-before-render.json), [visibility after](performance/t3-chat/send-fix-after-render.json).
- [Final tests](performance/t3-chat/send-fix-final-tests.json), [build gates](performance/t3-chat/send-fix-final-gates.json), [format comparison](performance/t3-chat/send-fix-format-results.json), [browser smoke](performance/t3-chat/send-fix-browser-smoke.json).
- [Baseline hashes](performance/t3-chat/send-fix-before-manifest.json), [changed-source hashes](performance/t3-chat/send-fix-after-manifest.json), [this-pass diff](performance/t3-chat/send-fix-current-layer.diff), [archived changed sources before this pass](performance/t3-chat/send-fix-before-changed-sources.tar.gz).

The frozen baseline remains `/tmp/truex-send-fix-before-20261006`. HTTP reproduction commands and workload exclusions are in its report. Existing diagnostic probes were run unchanged before and after; exact commands and exit results are in `send-fix-before-probes.json` and `send-fix-after-probes.json`. Scope-specific numbers should not be combined into a single claimed user first-answer speedup.
