# Execution checklist: T3 principles for Truex

**Status:** Proposed; every implementation task is pending.  
**Plan:** [t3code-harness-plan.md](t3code-harness-plan.md)  
**Review:** [T3 comparison](../docs/reviews/2026-10-15-t3code-harness-comparison.md)

No source changes are included in this planning pass. File names marked proposed below do not imply those modules or APIs already exist. Larger tasks must be split into focused changes before execution.

## T1 — Characterize first-message delivery through both transports

- [ ] Prove partial and complete answers generated before the first SSE connection appear exactly once, without another `turn/start`.
- [ ] Cover simultaneous duplicate submit, title/project metadata failure, acceptance-write failure and accepted-but-response-lost; count model calls and quota outcomes.
- [ ] Record the existing public create/submit receipt and cursor behavior so later tasks preserve it.

**Verify:** real core/bridge fixtures with substituted provider/AWS boundary; run `first-message.test.ts`, `runtime-synchronization.test.ts`, `runtime-transport.test.ts` and focused core sync tests. Tests must fail when their protection is intentionally disabled in an isolated fixture.

**Likely files:** `platform/test/first-message.test.ts`, `platform/test/runtime-synchronization.test.ts`, `agent-core/test/threads/sync-protocol.test.ts`. **Scope:** M. **Dependencies:** none.

## T2 — Own Codex child lifetime and safe diagnostics

- [ ] One current child identity owns incoming frames; replaced/failed children cannot publish into a newer runtime.
- [ ] Child loss/write failure settles every pending RPC before bounded cleanup; approvals do not block notification reading.
- [ ] Diagnostics contain correlation and timings without raw credentials/config/user content, with explicit RPC/frame limits preserved.

**Verify:** fake-child tests for stale stdout, EPIPE, exit, malformed/large frames, pending approval and timeout; secret-canary capture of logs; existing runtime/error tests.

**Likely files:** `agent-core/src/runtime/client.ts`, `agent-core/test/runtime/error-handling.test.ts`, shared redaction only if needed. **Scope:** M. **Dependencies:** T1. **Prior findings:** R01, R07.

## T2b — Bound live stream authorization

- [ ] A stalled permission check cannot indefinitely retain an authorized stream; checks have a deadline and expiration closes the stream.
- [ ] Revocation, tenant mismatch and session switch terminate delivery without exposing private runtime frames.
- [ ] Failure diagnostics identify the session/check without leaking credentials or message text.

**Verify:** never-resolving authorization dependency, access revocation during generation, expired permission window and cancel/close cleanup in isolated streaming fixtures.

**Likely files:** platform streaming authorization guard and its focused tests. **Scope:** S. **Dependencies:** T1. **Prior finding:** R03. This is a separate fix from the typed contract and child-lifetime tasks.

## T3 — Validate supported runtime commands and receipts

- [ ] Decode create/turn receipts and notification shapes at trust boundaries against the pinned supported protocol subset.
- [ ] Keep public session ID, native thread/turn IDs, runtime owner and AWS session ID distinct; existing confirmed acceptance fields keep their meaning.
- [ ] Both transports return equivalent errors/capabilities and reject malformed results before recording active/accepted state.

**Verify:** malformed/empty responses, protocol drift, wrong AWS session, missing identities and local/AWS parity fixtures; typechecks for shared callers.

**Likely files:** a proposed small shared runtime-contract module, `platform/src/runtime/transport.ts`, `platform/test/runtime-transport.test.ts`; integrate callers in a separate small follow-up. **Scope:** M per slice. **Dependencies:** T1. **Prior findings:** R06, R13.

### Checkpoint A

- [ ] Baseline first-message behavior still works through both transports; logging, child lifetime and receipt validation regressions pass.
- [ ] Final diff has no dependency/framework rewrite, weakened assertions or unrelated changes.

## T4 — Make one durable submission own quota and dispatch intent

- [ ] Stable scoped command ID and input fingerprint admit one winner; duplicate same input returns the recorded state, different input conflicts.
- [ ] User message, dispatch intent and quota ownership commit under one supported transaction/session or an explicitly verified compensation protocol.
- [ ] Creation/title/project side effects have explicit outcomes: ancillary failures cannot wedge an unsent first message or conceal a committed session.

**Verify:** Mongo replica-set integration with concurrent duplicates and injected write failures; assert one dispatch owner, correct quota and unchanged accepted receipt. Rollback must leave no orphan task or spend.

**Likely files:** proposed platform submission service/ledger, `platform/src/persistence/store.ts`, `platform/src/demo/quota.ts`, a focused submission test. Integrate create/submit callers in a separate slice. **Scope:** M per slice. **Dependencies:** T3. **Prior findings:** R02, R04, R05, creation idempotency concern.

## T5 — Separate remote dispatch from honest outcome recovery

- [ ] Dispatch uses saved owner/session and conditional attempt/version writes; no stale worker can accept, refund or overwrite another attempt.
- [ ] Pending work proven unsent is distinct from possibly accepted work; `unknown` never automatically starts a replacement turn.
- [ ] Restart recovery is owner-scoped, preserves live remote work and only retries operations proven safe; uncertain creation is not silently repeated.

**Verify:** two simulated platform instances, lost response after real fixture acceptance, process death before/after sending, stale lease results and native reconciliation supported by the pinned protocol. Count `turn/start` and quota settlement effects.

**Likely files:** proposed dispatch/recovery service, submission ledger, `platform/src/app/platform-service.ts`, focused recovery tests. Split worker scheduling from outcome reconciliation. **Scope:** M per slice. **Dependencies:** T4, T2. **Prior findings:** R02, R08, R09 and ambiguous outcome concerns.

### Checkpoint B

- [ ] Duplicate/concurrent submission and crash-window tests preserve one owner through both runtime transports.
- [ ] Public confirmed-turn receipt remains compatible; queued intent is not mislabeled runtime acceptance.
- [ ] Migration/rollback does not turn accepted or unknown legacy work into retryable jobs.

## T6 — Give durable output an owner independent of subscribers

- [ ] Final answer journaling and platform ingestion work with zero browser connections, and record acknowledgment follows committed idempotent projection.
- [ ] Decide/document partial-checkpoint recovery fidelity; if required, checkpoint at bounded byte/time intervals, with transient source cursors distinct from durable checkpoints.
- [ ] Ingestion/recovery has one owner per session or idempotent bounded coordination; idle/archive scanning and per-tab persistence amplification are removed where unnecessary.

**Verify:** zero-subscriber generation, record write failure, Mongo outage, failed ACK and restart before/after ingestion; fresh source handshake recovers stored content without claiming the prior turn resumed automatically.

**Likely files:** `agent-core/src/threads/events.ts`, `agent-core/src/threads/records.ts`, proposed platform ingestion owner/service, focused persistence tests. Split journal contract and ingestion scheduling changes. **Scope:** M per slice. **Dependencies:** T5, T3. **Prior findings:** R12, storage caveats.

## T7 — Extract a single frontend stream controller

- [ ] Projection, paired cursor, subscription ownership and history merge live in one focused controller; page components render state and initiate commands.
- [ ] Scope change/unmount cancels old work; late history/snapshot responses cannot overwrite newer live content or cursor.
- [ ] Preserve draft ownership, batching, source synchronization and public SSE behavior through extraction.

**Verify:** existing frontend source-resume/composer/source-sync/transport suites plus late-history and switched-session cases. Browser validation belongs to implementation verification, not this source review.

**Likely files:** proposed `frontend/lib/conversation-stream.ts`, `frontend/app/page.tsx`, controller tests. **Scope:** M. **Dependencies:** T3, T6. **Prior findings:** R13.

## T8 — Budget payloads, live queues and retained state

- [ ] Define byte/count limits and an oversized-answer snapshot policy across runtime, AgentCore bridge, platform parser/proxy and browser; complete selected content is recoverable.
- [ ] Retire unused thread/profile/subscription state without invalidating active work or durable transcript recovery.
- [ ] Set expected workload targets and measure long answers, slow consumers, reconnect storms and session churn; preserve efficient delta frames.

**Verify:** multibyte/escaped payload bounds, maximum answer fixtures, slow readers, queue overflow/resume, idle thread disposal and heap/query/invocation measurements. Record actual results and unresolved bottlenecks.

**Likely files:** stream/snapshot modules, platform event-stream parser and frontend batch/cache modules. Split each boundary into at most 3–5-file slices. **Scope:** M per slice. **Dependencies:** T3, T6. **Prior findings:** R10, R11, R12.

## T9 — Verify deployment behavior and prepare rollout

- [ ] Run identical contract scenarios through local HTTP and deployed AWS: late subscribe, disconnect while generating, reconnect, stream expiration, cold start and lost acceptance.
- [ ] Verify session storage, busy-state tracking, tenant mapping and owner recovery; no cross-session state and no platform startup cancels another owner's work.
- [ ] Validate compatible schema rollout/rollback, operational metrics and gated canary criteria before production changes.

**Verify:** applicable repository-required checks, real deployed AgentCore failure tests with isolated test sessions, load/retention measurements and rollback rehearsal. Mock fixtures cannot close this task alone.

**Likely files:** deployment smoke/integration scripts, operational validation note, only configuration required by verified failures. **Scope:** M per experiment. **Dependencies:** T5–T8, T2b.

### Completion checkpoint

- [ ] Required high-risk findings are fixed and tested; remaining accepted risks are explicit.
- [ ] First-answer delivery and recovery are evidenced through both transports, with measured limits and honest uncertainty.
- [ ] No wholesale T3 engine transplant or new framework was introduced without a separate justified decision.
