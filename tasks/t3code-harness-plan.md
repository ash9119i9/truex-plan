# Proposed plan: adopt T3 harness principles in Truex

**Status:** Proposed; no implementation started  
**Date:** 2026-10-15  
**Evidence:** [T3 comparison](../docs/reviews/2026-10-15-t3code-harness-comparison.md) and [existing Truex defect review](../docs/reviews/2026-10-15-runtime-flow-review.md)  
**Canonical execution checklist:** [t3code-harness-todo.md](t3code-harness-todo.md)

This is a separate plan because the existing `tasks/plan.md` and `tasks/todo.md` belong to the agent-core structural work. They are not replaced or silently marked complete.

## Outcome

A first message is submitted once, has an honest durable delivery state, and its generated answer reaches a client even when the client subscribes late. Both local HTTP and AWS AgentCore use the same execution and event semantics. Failures, runtime replacement and disconnects must not duplicate model/tool execution or silently lose a committed final answer.

## Decisions proposed

- Keep Express/TypeScript, MongoDB, existing public session APIs, SSE and the two `RuntimeTransport` branches.
- Keep Codex invocation inside agent core. Transport choice must not branch native thread/turn semantics.
- Preserve the current confirmed-turn receipt: `{ turnId, steer }` means runtime acceptance, not merely queued intent. If asynchronous queued acceptance is later exposed, use an explicitly negotiated/additive contract; do not repurpose existing `accepted` fields or fabricate a turn ID.
- Use the smallest typed command/receipt and dispatch ledger needed for create plus first message. Do not introduce T3's entire event-sourcing engine, Effect dependency, SQLite stack, or coding checkpoint model.
- Platform MongoDB owns public session mapping, submitted intent, quota accounting and durable transcript projection. Runtime owns active provider execution, native Codex context, warm message projection and unacknowledged output records. Browser state is derived. Each store's recovery obligation must be documented.
- Keep current generation-scoped SSE cursor semantics initially. A runtime cursor and a durable platform checkpoint are different identities; never treat them as interchangeable. A change to durable cursor ownership needs capability negotiation and snapshot/replay parity tests.
- Keep transient efficient delta delivery. Commit final text independently of subscribers. Introduce bounded partial checkpoints only if the required crash-recovery fidelity justifies them; do not persist every token or promise lossless uncommitted output.
- Use stable command identity plus validated request fingerprint. Owner/attempt/version guards control all completion and quota settlement writes. Reusing an ID with different input is a conflict.
- Neither a lease timeout nor platform process death proves a remote runtime stopped. Unknown execution must be reconciled or explicitly settled, never silently resubmitted.

## Invariants to verify

1. Browser subscription neither starts generation nor owns persistence.
2. Command acknowledgment, native turn acceptance and generation completion remain separate milestones.
3. One durable winner owns dispatch and quota settlement for a logical submission.
4. A committed transcript checkpoint cannot be advertised before its persistence completes.
5. Snapshot and cursor describe one state; reconnect cannot skip or append the same text twice.
6. Runtime owner and AgentCore session mapping remain stable throughout one attempt.
7. Stale process/worker/turn results cannot mutate a newer attempt.
8. History paging and stale HTTP responses cannot overwrite newer streamed text.
9. Resource limits apply across queue, snapshot, parser, bridge and browser boundaries.
10. New and old versions can coexist during rollout; no destructive migration is required for initial adoption.

## Implementation order and dependency graph

Execution tasks and their detailed acceptance criteria live in the checklist file. The ordering is:

```text
T1 characterization
 ├─ T2 child lifecycle / safe diagnostics
 ├─ T2b bounded stream authorization
 └─ T3 validated runtime contracts
       └─ T4 durable submission ownership
             └─ T5 dispatch outcome and recovery
                   └─ T6 client-independent durable output
T3 + T6 ─ T7 frontend stream controller
T3 + T6 ─ T8 payload and retention budgets
T5 + T6 + T7 + T8 ─ T9 real deployment verification
```

T2, T2b and T3 may proceed in parallel after characterization. T7 and T8 may proceed independently only after their shared source/cursor contract is fixed. T4/T5 share persistence and ownership changes and must be sequential. T9 also requires T2b. Do not parallelize edits to the same platform orchestration file.

## Submission transaction and remote execution

Proposed submission states distinguish `recorded`, `sending`, `accepted`, `refused` and `unknown`. Exact names must be mapped additively to the existing public delivery contract during T3/T4; these are proposed internal states, not existing fields.

Atomic submission intent should include a scoped command ID, input fingerprint, user message, dispatch record and quota ownership. The current store uses one MongoClient for catalog and tenant databases, so a supported MongoDB transaction can address both with the same session. Confirm deployment topology and transaction prerequisites before implementing this; do not invoke an independently committed quota transaction inside another transaction. If those records move to separate clusters, use an explicit reservation/compensation protocol instead of claiming atomicity.

Provider/network I/O stays outside that transaction. A narrow dispatch component claims the committed task and calls the persisted owner. The request can continue waiting for confirmed runtime acceptance to preserve today's response. The ledger closes crash windows even before introducing a standalone worker.

Before resending any claimed task, recovery must determine whether it was definitely unsent or whether execution may have happened. `clientUserMessageId` already reaches Codex, but its recovery/idempotency behavior must be proven against our pinned binary. If no proof is available, expose unresolved delivery and prevent automatic re-execution. Outbox presence does not establish exactly-once Codex/tool effects.

Thread creation needs the same stable public intent identity. Remote provisioning and Mongo session insertion cannot be atomic: record provisioning progress, compensate only a thread positively owned by that attempt, and retain uncertain creation state after ambiguous errors. A title/project metadata failure must not disguise a successfully created session or block its first dispatch.

## Storage and late subscription

Retain the existing warm path: Codex notifications update `t.messages`, first SSE sends that snapshot, and live updates follow. Existing final records are client-independent. Strengthen acknowledgment, retention and recovery around that path rather than replacing it.

If partial checkpointing is selected, specify a byte/time bounded flush, identifiable content revision, and acceptable lost suffix. Journal checkpoints and final answers independently of browser connections; idempotent platform ingestion commits them before acknowledging/removing runtime records. The configured runtime storage must survive the failure model. Cross-runtime-version durability requires a separately tested retention/recovery policy.

Prefer one canonical projected transcript in platform MongoDB and native execution history in the runtime. Do not create overlapping event logs with undocumented authority. A process-local source cursor is invalidated on restart; restored transcript and fresh source handshake must reconcile that safely.

## Transport parity requirements

| Scenario                         | Local HTTP                                                               | AWS AgentCore                                                                           |
| -------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Create/submit                    | Same validated command and confirmed turn receipt                        | Same operation via invocation envelope and persisted runtime session                    |
| Early/finished output before SSE | Warm runtime snapshot/journal catch-up                                   | Same core behavior through SDK response stream and invocation bridge                    |
| Disconnect                       | Close subscriber; generation and persistence continue                    | Cancel stream body; busy generation remains tracked independently                       |
| Reconnect                        | Cursor validation, replay or snapshot                                    | Reuse saved session ID and same cursor semantics                                        |
| Unknown turn start               | Reconcile on original runtime owner                                      | Reconcile original ARN/session/attempt; do not change owner and resend                  |
| Runtime process/compute loss     | Invalidate stale child/source generation; restore supported native state | Verify configured storage, cold start and native resume; explicitly settle lost attempt |
| Platform instance restart        | Recover only tasks owned by dead instance                                | A live remote turn remains authoritative; no global process-loss cancellation           |

Fixture parity is necessary but insufficient. Deployed tests must verify the AWS behavior the fixture substitutes.

## Migration, rollout and rollback

- Add ledger/index/schema fields compatibly; existing sessions and public receipts remain readable.
- Run characterization and existing first-message/transport/sync suites before and after each behavioral slice.
- Introduce new command ownership behind a deployment capability/feature gate only if mixed versions require it. Define one executing owner; never dual-dispatch old and new paths.
- Existing accepted or unknown submissions are reconciled before migration; do not backfill them as retryable pending jobs.
- Rollback may disable new dispatch, but must retain and resolve committed tasks/receipts. Old code must not redispatch them.
- Release local HTTP first after parity checks, then a bounded AgentCore canary after real cloud failure tests. Production rollout and AWS resource changes are separate actions from this plan.

## Measures and operational checks

Record submit-to-accept and accept-to-first-visible-text latency separately. Measure query/invocation counts per active and idle session, pending/unknown task age, recovery outcomes, record backlog, stream disconnect reasons, parser/snapshot sizes, retained thread count and heap after churn.

Choose numeric throughput/latency/retention targets from the expected deployment workload in T8 before testing. No unmeasured claim of 10x scalability belongs in completion notes. Test slow consumers and database/runtime outages as well as the happy path.

## Explicit decisions still needed during implementation

- Required partial-answer recovery fidelity after process/compute loss: final-answer recovery only, or a bounded recent suffix loss.
- Deployment peak concurrency, maximum answer/snapshot sizes, and retention periods.
- Transaction support and persistent AgentCore session storage actually configured in the target environment.
- Whether the pinned Codex protocol can prove acceptance from a stable submission identity after a lost turn-start response.

These questions do not block this review or plan. Dependent implementation must resolve them explicitly; defaults must not create a false durability or retry guarantee.
