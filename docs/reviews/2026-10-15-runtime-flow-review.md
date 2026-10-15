# Runtime flow review and test results

**Review date:** 2026-10-15 (Asia/Kolkata)  
**Status:** Findings recorded; fixes not implemented  
**Baseline commit:** `783417346fef41cc5b4b8803e5795dcc3f12c465`  
**Reviewed state:** Working tree, including uncommitted implementation changes, debug logs, and explanatory comments  
**Tracked diff SHA-256 during the review:** `9f848c4738b06afe767255d2f2e459b633ea2731572791923bf1ee411a0f9e69`

This report preserves the independent review findings, executed checks, and failure-injection evidence for a later remediation pass. Three sub-agents reviewed submission/persistence, runtime/security, and streaming/frontend behavior. The primary reviewer inspected the findings and independently reran the consequential probes.

No repository code was changed during the review. Custom probes used temporary files outside the repository or in-memory dependency replacements. This Markdown report is documentation only.

Source line references describe the reviewed working tree and will move as fixes are made. The baseline commit alone does not reproduce that uncommitted state. Temporary probe scripts are not committed and may not remain available; the scenarios and assertions below preserve their essential behavior.

## Scope and verdict

Reviewed paths include:

- Platform conversation creation, message submission, quota, runtime calls, recovery, reconciliation, and ingestion.
- Agent-core process transport, business runtime policy, thread management, message projection, snapshots, event replay, and record files.
- Platform streaming, public projections, and stream authorization guards.
- Frontend creation receipts, composer ownership, SSE transport, source synchronization, reducers, batching, and caches.

**Overall implementation rating: 6/10. Core architectural approach: approximately 8/10.**

The acknowledgment-plus-SSE design is appropriate. Snapshot catch-up, explicit uncertain delivery, durable message identity, and persistence-before-acknowledgment are valuable protections. The main weaknesses are inconsistent ownership and partial-failure boundaries, retained process/thread state, payload limits, raw logging, and oversized orchestration units.

Retain the fundamental architecture. Address the high-priority findings before broader production use. Ratings are subjective engineering judgments, not measured production-capacity scores or a complete security certification.

| Dimension                      | Score / 10 | Assessment                                                                 |
| ------------------------------ | ---------: | -------------------------------------------------------------------------- |
| Correctness and reliability    |        6.5 | Good normal flow; reproduced races and partial-failure defects             |
| Simplicity and maintainability |          5 | Large orchestration units and interacting state machines                   |
| Scalability                    |        4.5 | Lifetime state, all-session polling, and payload limits need work          |
| Security                       |        4.5 | Strong policy controls undermined by raw logs and stalled authority checks |
| Idiomatic TypeScript / React   |        5.5 | Appropriate primitives; weak boundary types and oversized integration      |
| Duplication and cohesion       |          6 | Useful shared helpers; multiple projection and persistence owners          |
| Testing discipline             |        7.5 | Substantial coverage; important interleavings missing                      |
| User experience                |          7 | Draft preservation and catch-up are strong; recovery has awkward edges     |
| Operational readiness          |        5.5 | Timeout awareness; cleanup and resource ownership gaps                     |

## Executed verification

These are historical results from the review. They are not a claim that the entire repository suite passed. Some batches overlap; do not add their counts together as unique coverage.

| Check                                                                 | Result              | Evidence boundary                                                  |
| --------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Frontend dispatch, transport, source synchronization, batching, cache | 70 passed, 0 failed | Five focused test files; no real-browser run                       |
| Agent-core runtime errors and security                                | 24 passed, 0 failed | Includes fake process behavior and pinned-runtime security denials |
| Agent-core synchronization and snapshot windows                       | 16 passed, 0 failed | Protocol fixtures, not production traffic                          |
| Platform first message, history, persistence                          | 16 passed, 0 failed | Isolated dependencies/database fixtures                            |
| Platform synchronized public events and runtime options               | 6 passed, 0 failed  | Local/simulated transport checks                                   |
| Platform synchronization/safety batch                                 | 17 passed, 1 failed | Error-message assertion failure described below                    |
| Isolated rerun of the failing safety test                             | 0 passed, 1 failed  | Same assertion mismatch reproduced independently                   |
| Platform TypeScript check                                             | Passed              | `tsc --noEmit`                                                     |
| Agent-core TypeScript check                                           | Passed              | `tsc --noEmit`                                                     |
| Frontend TypeScript check                                             | Passed              | `tsc --noEmit --incremental false`                                 |
| Scoped formatting check                                               | Issues in 2 files   | `platform-service.ts` and `manager.ts`; not autoformatted          |

### Commands

Run each command from the stated package directory, using the installed dependencies. These tests can create isolated database processes or temporary fixtures. Do not point them at production data.

```sh
# cwd: frontend
node --experimental-strip-types --test \
  test/transport.test.ts test/source-sync.test.ts \
  test/ordered-batch.test.ts test/session-cache.test.ts \
  test/composer-dispatch.test.ts
./node_modules/.bin/tsc --noEmit --incremental false
```

```sh
# cwd: agent-core
./node_modules/.bin/tsx --test \
  test/runtime/error-handling.test.ts \
  test/security/business-security.test.ts \
  test/security/tenancy.test.ts
./node_modules/.bin/tsx --test \
  test/threads/sync-protocol.test.ts \
  test/threads/snapshot-window.test.ts
./node_modules/.bin/tsc --noEmit
```

```sh
# cwd: platform
npm exec -- tsx --test \
  test/first-message.test.ts test/history.test.ts test/persistence.test.ts
./node_modules/.bin/tsx --test \
  test/sync-public.test.ts test/runtime-synchronization.test.ts \
  test/runtime-resume-transport.test.ts
./node_modules/.bin/tsx --test \
  test/sync-public.test.ts test/runtime-synchronization.test.ts \
  test/safety.test.ts
./node_modules/.bin/tsx --test \
  --test-name-pattern='provision-demo: dry run' test/safety.test.ts
./node_modules/.bin/tsc --noEmit
```

```sh
# cwd: repository root
./node_modules/.bin/prettier --check \
  platform/src/app/platform-service.ts \
  agent-core/src/runtime/client.ts agent-core/src/threads/manager.ts \
  frontend/app/page.tsx platform/src/streaming/events.route.ts
```

Package working directories matter: an initial sub-agent invocation from the repository root failed schema discovery. The corrected package-directory runs produced the results above.

### Known failing check

`platform/test/safety.test.ts:635`, in the test starting at line 545:

```text
provision-demo: dry run changes nothing; refuses populated or foreign databases; is repeatable

Expected regex: /cannot be the implicit "default"/
Actual output: error: public signup cannot use the implicit legacy "default" tenant
```

The observed failure is a message expectation mismatch. It does not demonstrate a broken streaming implementation, but the check remains red and must be resolved rather than hidden.

## Confirmed defects and required regression scenarios

### R01 — High: raw RPC logging exposes credentials and user text

**References:** `agent-core/src/runtime/client.ts:309`; `platform/src/runtime/configuration.ts:113-117`; `agent-core/src/runtime/business-runtime.ts:240`.

`CodexClient.send()` logs the outgoing parameters unconditionally. Direct provider configuration contains `experimental_bearer_token`; turn parameters contain user input. This bypasses both redaction and log-level filtering.

**Reproduction:** capture the actual console formatting while sending a fake-runtime request with a fabricated token in the provider configuration. Observed: `DUMMY_SECRET_LOGGED true`. No genuine credentials were used.

**Recommended fix:** log only approved metadata. Exclude payloads. Assess retained logs and affected keys if this instrumentation ran with genuine credentials.

**Regression acceptance:** a create/resume/turn request containing dummy model credentials, connector headers, and user text must not expose those values in captured logs.

### R02 — High: concurrent duplicate requests can refund a dispatched turn

**References:** `platform/src/app/platform-service.ts:835-854,952-970`; `platform/src/demo/quota.ts:108,155-166`.

Quota reservation ownership and durable message/dispatch ownership can belong to different requests.

**Reproduction:** A reserves and waits in preparation. B uses the same session/clientId, observes the existing reservation, wins the message insert, and dispatches. A then fails preparation and releases the shared reservation.

```text
delivery: accepted
dispatches: 1
quota releases: 1
```

The harness executed actual service methods with a quota mock matching the current reserve/release contract. It did not exercise real MongoDB transaction concurrency.

**Recommended fix:** establish one durable submission owner and make reservation, dispatch, and release follow that owner. Duplicate callers should observe the owning attempt.

**Regression acceptance:** deterministically exercise the interleaving above with barriers; the accepted turn must remain charged, and exactly one dispatch must occur. Follow with a real transactional integration test.

### R03 — High under a stalled dependency: stream authority checks have no deadline

**References:** `platform/src/streaming/guards.ts:37-49`; `platform/src/streaming/events.route.ts:140-159`.

An unresolved authorization promise leaves `running=true`, blocking all later checks while the stream remains open. Interval clamping alone cannot guarantee timely revocation.

**Reproduction:** `intervalMs=5`, check returns a never-settling promise. After 40 ms: `checks=1, ended=0`. The absence of a deadline is demonstrated; production impact depends on an authority operation stalling.

**Recommended fix:** bounded authority checks or an expiring authority lease, fail closed on timeout, and database operation timeouts. Late successful results must not restore an ended stream.

**Regression acceptance:** a stalled check must end the stream within the configured deadline; `onEnd` runs once; late resolution cannot reopen it.

### R04 — Medium: title failure leaves an undispatched message stuck

**References:** `platform/src/app/platform-service.ts:863,887,895,1569`.

The pending message is saved before `titleIfUntitled()`, which is outside the dispatch failure handling.

**Reproduction:** fail the title update after message insertion.

```text
delivery: pending
dispatches: 0
quota releases: 0
retry: DUPLICATE_MESSAGE
```

**Recommended fix:** make title maintenance best-effort or handle its definite pre-dispatch failure explicitly, including delivery state and quota release.

**Regression acceptance:** a title database failure must not permanently wedge an undispatched submission or spend its quota without dispatch.

### R05 — Medium: project metadata failure makes committed creation appear to fail

**References:** `platform/src/app/platform-service.ts:517,538,548`.

`touchProject()` runs after session insertion but before initial-message submission, outside cleanup/receipt handling.

**Reproduction:** fail the project activity update after saving the session.

```text
durable sessions: 1
initial-message dispatches: 0
returned error: activity write failed
```

**Recommended fix:** ancillary metadata maintenance should not determine the success of an already committed creation. Return the created conversation, with an explicit warning if necessary.

**Regression acceptance:** project activity failure preserves a coherent creation result and explicit first-message outcome; retry must not silently duplicate creation.

### R06 — Medium: malformed creation responses become active sessions

**References:** `platform/src/app/platform-service.ts:223,453,482,517`.

`call()` checks that JSON is an object, but create/acceptance result fields are not validated before use.

**Reproduction:** mock the runtime creation response as `{}`. The actual orchestration saves a session with `threadId` undefined in the in-memory store and returns `status: active`.

**Recommended fix:** validate required creation/acceptance fields at the transport boundary, then pass typed values downstream.

**Regression acceptance:** reject missing, empty, wrong-type, or invalid runtime identities before saving an active session or marking a message accepted. Actual MongoDB serialization of undefined can differ from the harness; the defect is absence of a usable identity.

### R07 — Medium: a retired Codex process can emit into its replacement

**References:** `agent-core/src/runtime/client.ts:183,202,370`; `agent-core/src/threads/manager.ts:163`.

`fail()` does not terminate/retire the child. The stdout callback lacks the current-child identity guard used by lifecycle handlers.

**Reproduction:** use a fake Codex process, inject a stdin EPIPE error, start a replacement, and emit a delayed notification from the old process.

```text
oldAlive: true
newProcess: true
receivedOldNotification: true
```

**Recommended fix:** explicit process retirement, listener disposal, termination, and generation checks on incoming frames.

**Regression acceptance:** delayed stdout from a failed/replaced child must be ignored, the old process must terminate, and current pending requests must settle correctly.

### R08 — Medium: accepted runtime creation is not compensated after metadata failure

**References:** `agent-core/src/runtime/business-runtime.ts:237-263`; `agent-core/src/threads/manager.ts:367`.

Engine thread creation precedes local metadata storage. Metadata failure removes the profile but does not compensate the engine operation. The platform never receives the created ID.

**Reproduction:** stub engine acceptance and obstruct the local metadata directory with a file.

```text
creation failed: true
runtime methods: ["thread/start"]
workspace count: 1
profiles size: 0
```

**Recommended fix:** compensate known created IDs at the adapter layer and record cleanup failure for reconciliation. Distinguish unknown timeout outcomes. Review fork for the same boundary.

**Regression acceptance:** metadata failure after engine acceptance attempts cleanup for the known ID and reports unsuccessful cleanup explicitly; admission accounting must not pretend the engine resource disappeared.

### R09 — Medium: concurrent host selection skips healthy failover targets

**References:** `platform/src/app/platform-service.ts:447-469`.

The shared round-robin counter advances on every retry, allowing another creation request to change the first request's next target.

**Reproduction:** two hosts, h1 full and h2 healthy. A waits on h1, B succeeds on h2, then A retries h1.

```text
calls: ["h1", "h2", "h1"]
A: CAPACITY
B: created
```

**Recommended fix:** allocate one starting offset per request and iterate distinct hosts locally.

**Regression acceptance:** concurrent creations must not make a request skip an available host or revisit a refused host before exhausting distinct targets.

## Confirmed structural limits and conditional risks

### R10 — High scale risk: root thread and profile retention has no lifetime budget

**References:** `agent-core/src/threads/manager.ts:89,302,1006-1017`; `agent-core/src/runtime/business-runtime.ts:174`; `agent-core/src/threads/messages.ts:33,94`; `agent-core/src/threads/events.ts:87-94`.

Delete/archive/unsubscribe marks root threads unloaded but does not remove root map entries. Profiles are also retained. Admission capacity counts loaded threads, not lifetime retained objects. Count limits on messages/reasoning and per-thread replay limits do not establish a global byte budget.

**Evidence:** confirmed through code inspection; no heap soak benchmark was performed.

**Recommended fix/test:** dispose deleted state and auxiliary maps; use bounded inactive caches. Create/archive/delete many threads and assert retained state shrinks. Measure heap over sustained churn.

### R11 — Medium: snapshot contracts exceed downstream limits

**References:** `agent-core/src/threads/snapshots.ts:16-49`; `platform/src/public/conversation.ts:195-197`; `platform/src/streaming/event-stream.ts:15-16`.

Recent snapshots preserve whole turns rather than imposing an encoded-byte budget. The platform rejects a buffer over `4 * 1024 * 1024` JavaScript string characters before parsing/projecting. Core socket and frontend source limits use different units/bounds.

**Reproduction:** a valid ASCII snapshot of 4,194,443 encoded bytes was rejected by the primary reviewer's probe with `Event exceeds stream limit`. A sub-agent's equivalent payload was 4,194,482 bytes. Reconnection can repeat the same oversized snapshot.

**Recommended fix/test:** define an end-to-end encoded-byte contract and explicit oversized cold synchronization. Test long individual answers, multiple recent turns, Unicode, and chunk boundaries. Preserve authoritative unfinished text rather than silently truncating it.

### R12 — Medium scale risk: polling and stream observers amplify background work

**References:** `platform/src/app/platform-service.ts:1275-1298`; `platform/src/streaming/events.route.ts:211-269`; `platform/src/streaming/guards.ts:58-61`.

Polling visits all eligible nondead sessions serially, including idle/archived sessions. Every platform process runs its own poll. Browser streams independently initiate some goal/plan persistence, alongside ingestion, without bounding outstanding persistence promises.

A two-second timer is not a two-second sweep guarantee. Sweep time is approximately the sum of session request times. For illustration, 1,000 sequential requests averaging 10 ms require about 10 seconds before other overhead; this is arithmetic, not measured production capacity.

**Recommended fix/test:** pending/active work selection, bounded concurrency, multi-worker ownership, and coalesced per-session live persistence. Preserve live-only updates that ingestion does not otherwise retain. Test slow runtimes/databases and multiple subscribers/instances.

### R13 — Medium maintainability risk: large integration units and weak contracts

At review time, `PlatformService` had 1,599 lines, the frontend page 2,921, and `ThreadManager` 1,030. File length is a signal, not proof; the responsibility breadth and interacting state machines create the change risk.

`any` and string-dispatched commands weaken the runtime boundaries. Recent-window selection, identity matching, source/display projections, and persistence ownership have parallel implementations.

**Recommended fix:** typed creation/acceptance/event contracts, cohesive submission and synchronization ownership, and explicit transitions. Extract responsibilities that eliminate concepts; do not merely relocate callbacks into many wrappers. Benchmark reducer work separately from virtualized DOM work.

## Additional contract and operational concerns

- Creation lacks a server-side, authenticated creation idempotency key. A lost successful response followed by another create request can produce another conversation; message IDs are scoped to a session.
- Reusing an accepted message identity with changed text returns the earlier result without detecting a payload conflict.
- History recovery can fetch/reconcile the entire runtime transcript even when returning a recent window.
- Error-state database writes can mask the original dispatch failure and interfere with justified quota release.
- Agent-core HTTP routes rely on private network isolation rather than caller authentication. Loopback binding is a useful default defense; exposing the service to less-trusted callers changes the security assessment.
- Atomic temporary-file rename provides visibility guarantees but does not alone establish power-loss durability. Persistent storage and crash recovery were not validated.

## Strengths to preserve during remediation

- Command acceptance separate from streamed completion and first-message errors separate from session creation.
- Snapshot/replay high-water capture and subscriber attachment without an await gap.
- Cursor paired with applied source state; checkpoint only after successful delivery.
- Ordered frontend batching with paint/timer scheduling, queue bounds, and barrier flushes.
- Mongo message identity claimed before runtime dispatch.
- Explicit unknown delivery and no blind retry of ambiguous remote side effects.
- Approval acknowledgment checked before persistence/first dispatch.
- Persistence of records before acknowledgment, idempotent upserts, and reconciliation batching.
- Tenant-scoped database context, public allowlists, and dispatch access revalidation.
- Restricted runtime tools/environment, safe error translation, and admission/backpressure safeguards.
- Bounded frontend display caches and protection of drafts from stale asynchronous results.

## Remediation checklist

Keep these items open until implementation and regression evidence exist. A passing happy-path suite alone does not close a reproduced failure.

- [ ] R01: Remove/redact sensitive logs; assess retained logs/credentials where applicable.
- [ ] R02: Align durable submission and quota ownership; add duplicate concurrency coverage.
- [ ] R03: Bound authority checks and enforce stream expiration on stalled authorization.
- [ ] R04: Handle title failure without wedging undispatched messages or spending quota.
- [ ] R05: Keep ancillary project metadata failure consistent with committed creation.
- [ ] R06: Validate runtime creation and turn acceptance result shapes.
- [ ] R07: Retire failed child processes and reject stale frames.
- [ ] R08: Compensate accepted engine creation after local metadata failure.
- [ ] R09: Iterate distinct failover hosts per creation request.
- [ ] R10: Dispose/budget inactive thread state and profiles; measure churn/heap behavior.
- [ ] R11: Agree payload bounds and support oversized cold synchronization explicitly.
- [ ] R12: Bound ingestion and live persistence work; define multi-instance ownership.
- [ ] R13: Reduce orchestration breadth with typed, cohesive lifecycle boundaries.
- [ ] Resolve the failing safety message assertion without weakening its refusal check.
- [ ] Resolve scoped formatting issues without unrelated refactoring.
- [ ] Decide creation idempotency and changed-payload message-key semantics.
- [ ] Validate representative concurrency, slow dependencies, restart recovery, and heap/load behavior.

Suggested order: security/logging and submission correctness; runtime result/lifecycle/compensation; resource and payload limits; bounded workers; structural simplification and measured optimization.

## Probe provenance and limitations

Temporary scripts used during the review:

```sh
# cwd: platform; script may no longer exist in a future session
node --import tsx /tmp/truex-submission-review.mjs

# cwd: repository root; scripts may no longer exist in a future session
./agent-core/node_modules/.bin/tsx /tmp/truex-review-runtime/probe.ts
./agent-core/node_modules/.bin/tsx /tmp/truex-review-runtime/create-failure.ts
```

The first script exercised actual `PlatformService` methods with in-memory stores, runtime replies, and quota contract mocks. The runtime scripts used a fake executable/dummy token and a stubbed engine request with filesystem fault injection. Stalled authorization and oversized-frame probes were inline, using the actual guard/parser.

These probes establish behavior under their specified fault conditions. They do not establish incident frequency, real transactional concurrency behavior, throughput, full tenant isolation, or production readiness.

No production load test, heap soak, live-provider answer generation, or crash/power-loss recovery test was performed. Existing benchmark documents under `docs/performance/t3-chat/` provide useful fixture operation/payload evidence, with their own stated limits. No fixes, deployment, or production sign-off are implied by this report.
