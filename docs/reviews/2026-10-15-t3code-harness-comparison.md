# T3 Code harness comparison: reuse principles for Truex

**Date:** 2026-10-15, Asia/Kolkata  
**Status:** Source review completed; implementation proposed, not performed  
**T3 clone:** `/Users/ashok/t3code`, commit `adb04202b25c1c45255e76be9f03f0b346b9c5c4`, clean tracked working tree  
**Truex:** `/Users/ashok/truex-plan`, HEAD `783417346fef41cc5b4b8803e5795dcc3f12c465`, reviewed including existing uncommitted changes  
**Truex tracked diff SHA-256:** `9f848c4738b06afe767255d2f2e459b633ea2731572791923bf1ee411a0f9e69`

Three independent agents reviewed the active T3 V2 Codex adapter, durable orchestration, and client subscriptions. The primary reviewer checked the consequential boundaries against source, inspected Truex's AWS bridge and persistence, and ran transport parity tests. No application source was edited, no live T3 userdata was opened, and no real model or AWS invocation was performed.

This is a scoped engineering assessment of the conversation harness. It is not a comprehensive audit of all T3 features or a measured production capacity score. Line numbers describe the reviewed checkout and can move.

## Recommendation and rating

**Usefulness as an architectural reference: 8.5/10. Suitability for copying the entire implementation into Truex: 3/10.**

Yes, T3 invokes the same kind of Codex app-server protocol we use: native thread creation, turn start, and asynchronous notifications. Its stronger contribution is the system around those calls: typed boundaries, durable command intent, explicit execution ownership, ordered persistence/publication, and connection-independent ingestion.

Adopt those invariants in our existing TypeScript, MongoDB, HTTP, SSE, and AWS design. Do not port its entire Effect runtime, WebSocket RPC system, SQLite architecture, coding checkpoints, or large orchestration engine merely to resemble it.

| Area                                    | Reference usefulness / 10 | Assessment for Truex                                                                                                  |
| --------------------------------------- | ------------------------: | --------------------------------------------------------------------------------------------------------------------- |
| Codex adapter and subprocess lifecycle  |                         9 | Strong typed RPC, pending-turn correlation, scoped cleanup, internal ingestion before execution                       |
| Durable acceptance and recovery         |                         9 | Transactional receipt/event/projection/outbox is valuable; remote unknown outcomes still need explicit handling       |
| Client state and streaming              |                         8 | Useful ownership, bounded delivery, history merge and reconnect patterns; SSE already provides our required transport |
| Simplicity as a template                |                         5 | Mature functionality, but many more identities, services and state transitions than our current product requires      |
| Direct fit for local HTTP deployment    |                         8 | Server-owned subprocess principles transfer readily; retain Truex authorization and quotas                            |
| Direct fit for AWS AgentCore deployment |                         5 | Provider principles transfer, but T3's single-process recovery and local storage assumptions need adaptation          |

These scores are subjective and concern transferability, not a blanket score for the T3 product. The prior [Truex runtime review](2026-10-15-runtime-flow-review.md) remains the defect record; this comparison does not claim its findings have been fixed.

## The two boundaries we must keep distinct

1. **Provider adapter:** how agent core invokes Codex and turns its native notifications into our domain events.
2. **Runtime transport:** how platform reaches the runtime that owns a conversation: local HTTP or AWS AgentCore invocation.

AWS AgentCore hosts our runtime; it does not replace the Codex provider protocol inside it. Both deployment paths should execute the same thread/turn/message code and expose the same normalized results.

Existing Truex transport evidence:

- [RuntimeTransport.request](../../platform/src/runtime/transport.ts:56): common request boundary.
- HTTP branch at [line 106](../../platform/src/runtime/transport.ts:106): ordinary `fetch()`.
- AWS branch at [line 143](../../platform/src/runtime/transport.ts:143): `InvokeAgentRuntimeCommand`, saved runtime session ID, operation envelope and JSON/SSE response handling.
- [createAgentCoreApp](../../agent-core/src/agentcore/app.ts:16): `/invocations` forwards the operation to the same local core routes; `/ping` reports busy work.
- [PlatformService.events](../../platform/src/app/platform-service.ts:684): public session maps to saved runtime owner and internal thread ID.

The platform must continue authorizing users and tenants. Neither a runtime session ID nor a native Codex thread ID is a user authorization token.

## Exact T3 invocation flow

Paths in this section refer to the T3 clone, not Truex. This is the active `orchestration-v2` implementation.

1. [Orchestrator.dispatchWithReceipt](../../../t3code/apps/server/src/orchestration-v2/Orchestrator.ts:11233) serializes the command under a per-thread lock and decides domain changes.
2. [EventSink.commitCommandEffect](../../../t3code/apps/server/src/orchestration-v2/EventSink.ts:527) reserves the receipt, appends events, applies projections and enqueues execution effects in one SQL transaction. The accepted receipt is written at line 568. Publication and worker notification happen after commit.
3. [EffectWorker](../../../t3code/apps/server/src/orchestration-v2/EffectWorker.ts:152) handles `provider-turn.start` and calls `ProviderTurnStartService`.
4. [ProviderTurnStartService](../../../t3code/apps/server/src/orchestration-v2/ProviderTurnStartService.ts:646) ensures/resumes the native thread, then calls `RunExecutionService.startRootRun` at line 1227.
5. [RunExecutionService](../../../t3code/apps/server/src/orchestration-v2/RunExecutionService.ts:943) subscribes internally to provider events. Its ingestion fiber starts at line 1227, before `session.startTurn()` at line 1453. This subscription belongs to the server, not the browser.
6. [CodexAdapterV2.openSession](../../../t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:1715) uses the app-server client factory. Actual subprocess spawn is at line 1543; the client and child belong to the session scope.
7. [CodexAdapterV2.ensureThread](../../../t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:6475) calls `client.request("thread/start", ...)` at line 6479. Resume calls `thread/resume` at line 6511.
8. [startNativeTurn](../../../t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:6192) registers pending root-turn identity before the RPC at lines 6210–6213. Actual `client.request("turn/start", ...)` is at line 6222; the native turn ID is registered after acknowledgment.
9. [Typed client.request](../../../t3code/packages/effect-codex-app-server/src/client.ts:208) encodes parameters, invokes the transport and decodes the response. [Protocol request](../../../t3code/packages/effect-codex-app-server/src/protocol.ts:450) registers its correlated waiter before sending. [Stdio transport](../../../t3code/packages/effect-codex-app-server/src/_internal/stdio.ts:13) connects child stdin/stdout.

**Two different acknowledgments:** T3 command acceptance means durable intent committed. Native `turn/start` acknowledgment means Codex accepted a turn. Neither contains the finished answer. Truex currently returns a confirmed runtime receipt containing `turnId`; adopting durable intent must not silently change that public meaning.

## Where T3 stores the first answer before a UI subscription

The browser does not initiate output ingestion. Generation and ingestion are already active.

1. [Codex delta handler](../../../t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4258) receives `item/agentMessage/delta` and calls the assistant accumulator.
2. [makeProviderTextDeltaCoalescer](../../../t3code/apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts:40) holds text in an in-memory `Ref<Map>` at line 45. Line 114 appends new text. The Codex adapter configures a 50 ms flush interval.
3. [Accumulator emission](../../../t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:3364) emits cumulative `turn_item.updated` text at line 3414. `message.updated` is emitted on completion at line 3407; streaming text belongs to turn items, not the final message table.
4. **A flush is not automatically a database write.** [makeAssistantStreamingFilter](../../../t3code/apps/server/src/orchestration-v2/assistantStreaming.ts:92) sits before ingestion. Turn mode suppresses interim text; paragraph mode throttles and exposes complete Markdown prefixes. Final text bypasses this suppression at lines 113–115. The default response streaming mode is paragraph in [settings](../../../t3code/packages/contracts/src/settings.ts:1123).
5. [RunExecutionService](../../../t3code/apps/server/src/orchestration-v2/RunExecutionService.ts:1226) applies that filter and calls `ProviderEventIngestor.ingestNormalized()` at line 1248, independent of any UI.
6. [ProviderEventIngestor](../../../t3code/apps/server/src/orchestration-v2/ProviderEventIngestor.ts:737) writes normalized events. [EventSink.writeEffect](../../../t3code/apps/server/src/orchestration-v2/EventSink.ts:362) commits events/projections before publication. Actual event SQL insert is in [OrchestrationEventStore](../../../t3code/apps/server/src/persistence/OrchestrationEventStore.ts:513).
7. [Turn-item projection](../../../t3code/apps/server/src/orchestration-v2/ProjectionStore.ts:2448) stores permitted streaming prefixes. [Message projection](../../../t3code/apps/server/src/orchestration-v2/ProjectionStore.ts:2377) stores the completed message.

Thus the newest buffered or suppressed suffix remains transient; committed prefixes and final answers are in SQLite. A browser connecting late reads the existing projection. T3 does not regenerate the answer or require a browser connection to persist the final text.

It does not promise zero lost tokens across a crash: the coalescer, filters and ingestion backlog can contain uncommitted text. Nor does a normal SQL commit imply power-loss durability under every configuration.

## Actual T3 client subscription and delivery

- Web mounts [shared thread state](../../../t3code/apps/web/src/state/threads.ts:24), with common logic in `packages/client-runtime`.
- [makeEnvironmentThreadState](../../../t3code/packages/client-runtime/src/state/threads.ts:170) loads an HTTP snapshot at line 831 and atomically installs projection plus `snapshotSequence` at lines 841–855.
- It calls `subscribeDynamic()` with `afterSequence` and negotiated capabilities around lines 797–901. The [RPC contract](../../../t3code/packages/contracts/src/rpc.ts:1725) declares the streaming method.
- [subscribeOrchestrationV2Thread](../../../t3code/apps/server/src/ws.ts:753) returns snapshot/replay and the live tail. [ProjectionStore.getThreadSnapshot](../../../t3code/apps/server/src/orchestration-v2/ProjectionStore.ts:4812) reads projection and sequence together in a transaction.
- [EventSink.stream](../../../t3code/apps/server/src/orchestration-v2/EventSink.ts:716) closes the asynchronous gap: subscribe to live events, capture high water, replay persisted events, then filter overlapping live events. The bounded variant uses [LiveStreamBudget](../../../t3code/apps/server/src/orchestration-v2/LiveStreamBudget.ts:286).
- [Client applyItems](../../../t3code/packages/client-runtime/src/state/threads.ts:613) reduces batches under a semaphore. Applied sequence and projection move together; duplicate events at or below the sequence are ignored. History merge checks the request's cursor before installing late results.

The transferable invariant is **projection and cursor correspond to the same applied state**. WebSocket is T3's implementation choice, not a prerequisite for this invariant.

## What we already do correctly

Do not spend migration effort rebuilding protections already present:

- [Truex message projection](../../agent-core/src/threads/messages.ts:35) accumulates `t.messages` before any SSE subscriber. Completed Codex text replaces the projected message at line 63.
- [ThreadEvents.emit](../../agent-core/src/threads/events.ts:40) writes final-message and other durable record files independently of subscribers, before live publication.
- [ThreadStream.synchronize](../../agent-core/src/threads/stream.ts:94) sends snapshot/replay, a synchronization marker, and attaches the subscriber without an intervening await.
- Replay is bounded by count and bytes. An 8 MiB response-buffer threshold already exists at [stream.ts:13](../../agent-core/src/threads/stream.ts:13).
- [Frontend ordered batching](../../frontend/lib/ordered-batch.ts) already reduces browser update churn and caps queued events.
- Stable message IDs, explicit unknown delivery and disabled automatic AWS retries already reduce accidental duplicate execution.
- AgentCore `/ping` already reports busy active threads. The ARM64 image points `CODEX_HOME` and workspace storage at `/mnt/state`; actual persistence requires configured AWS session storage.

Our main gaps concern inconsistent ownership and partial-failure boundaries, typed results, lifetime retention, whole-pipeline payload limits, and efficient client-independent ingestion. SSE itself is not the defect.

## Principles to adopt and what they solve

| Principle                                | T3 evidence                                     | Minimal Truex adaptation                                                                                                           |
| ---------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Atomic durable intent and receipt        | `EventSink.ts:527`                              | Persist submission identity, fingerprint, user message and dispatch intent together; align quota ownership with that winner        |
| Execution follows committed intent       | `EffectWorker.ts:152`                           | A small dispatch service/worker with explicit pending, sending, accepted, refused and unknown states                               |
| Provider ingestion does not depend on UI | `RunExecutionService.ts:1227`                   | Preserve runtime notification listener and journal; ingestion owner must be independent of connected SSE tabs                      |
| Typed native and public boundaries       | `client.ts:208`, contracts RPC                  | Validate the supported pinned Codex subset and our runtime receipts/events; do not import T3's entire protocol indiscriminately    |
| One owner for process lifetime           | session scopes, `protocol.ts:196`               | Retire failed children, fail pending RPCs and reject stale-child frames; preserve explicit timeouts                                |
| Commit before durable cursor publication | `EventSink.ts:240`                              | Distinguish transient delta cursors from durable recovery checkpoints; avoid advertising an uncommitted checkpoint as recoverable  |
| Catch-up plus live without gaps          | `EventSink.ts:716`                              | Keep current synchronous SSE attachment; if persistence introduces awaits, subscribe/buffer before reading a consistent checkpoint |
| Bounded delivery and history             | `LiveStreamBudget.ts:40`, `ThreadStream.ts:106` | Budget every queue and snapshot path, retain delta efficiency, and page older history without overwriting live state               |
| Connection state outside page UI         | `client-runtime/state/threads.ts:170`           | Extract one focused stream controller rather than duplicating a second state machine                                               |
| Explicit unsafe replay policy            | `EffectOutbox.ts:123`, `:135`, `:517`           | No blind retry of a possibly accepted Codex/AWS operation; reconcile by submission/owner/attempt identity                          |

Do not label all accepted content as one globally atomic operation: MongoDB, the remote runtime and Codex cannot share a transaction. A local outbox closes the intent-to-scheduling gap; it does not make remote execution exactly once.

## Limits and patterns we should not copy

### Single-process recovery is not distributed ownership

[ThreadCommandExecutor](../../../t3code/apps/server/src/orchestration-v2/ThreadCommandExecutor.ts:12) uses an in-process keyed lock. [EffectOutbox](../../../t3code/apps/server/src/orchestration-v2/EffectOutbox.ts:345) claims pending rows; expired running rows are intentionally not reclaimed. Its [process-loss reconciliation](../../../t3code/apps/server/src/orchestration-v2/EffectOutbox.ts:517) cancels pending/running process-bound effects and requeues replay-safe work.

This assumes the previous owning process is gone. A Truex platform instance must not globally cancel another live instance's dispatch tasks at startup. Use owner-scoped recovery and conditional attempt/version writes. An expired platform lease alone does not prove the remote Codex turn stopped.

### Outbox retry is not safe turn retry

T3 distinguishes process-bound provider work from replay-safe maintenance. Its worker retries do not establish that an accepted native turn can be resubmitted safely after a lost response. Truex must keep `unknown` separate from refusal. `clientUserMessageId` is already passed to Codex in [manager.ts:570](../../agent-core/src/threads/manager.ts:570); prove reconciliation against the pinned protocol rather than assuming it is an exactly-once key.

T3 receipts guard command identity and thread, but this review did not find a request fingerprint in receipt storage. Our proposed contract should reject key reuse with different validated input.

### Durability policy must match our deployment

[T3 SQLite configuration](../../../t3code/apps/server/src/persistence/Sqlite.ts:21) uses WAL with `synchronous = NORMAL` at line 27, deliberately trading per-commit fsync for performance. Its comments accept rollback of recent commits after OS crash/power loss. We should define our own acknowledgment durability and recovery policy rather than inherit a desktop tradeoff.

T3's event sink assumes its event log and projections are local to the owning environment. Truex has platform MongoDB plus runtime files and native Codex history. State ownership across those stores must be explicit; introducing a second competing canonical event log is not automatically an improvement.

### Bounded replay is not bounded everything

T3 limits replay to 128 events and 1 MiB raw/encoded bytes. Its ordinary snapshots preserve complete selected user turns and report `payloadBudgetExceeded`, so they are not a strict 1 MiB guarantee. Provider text accumulators and some outgoing/internal event queues remain unbounded. Full accumulated-text upserts can amplify work for long answers, although filtering and coalescing reduce frequency.

Keep our delta frames. Add a deliberate oversized-message/snapshot strategy and budgets through runtime, AWS bridge, platform parser, proxy and client; do not claim a single socket threshold bounds process memory.

### More machinery is not automatically more maintainable

The inspected T3 orchestrator is 11,716 lines and Codex adapter is 7,379 lines. Much of this supports provider switching, goals, subagents, background terminals, checkpoints, MCP and multiple clients. These requirements explain the breadth, but importing it would create substantially more concepts for our team to maintain.

Also preserve our explicit RPC deadlines and error observability: T3's protocol delegates deadlines to callers/scopes, and some typed notification failures end in `Effect.ignore`. Strong typing alone does not guarantee actionable errors.

## AWS constraints for the proposed design

The official [AWS HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html) supports JSON/SSE through `/invocations` and documents `HealthyBusy` for background work. We can retain the existing SSE bridge; WebSocket migration is unnecessary for this plan.

The official [AWS session guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html) states that session IDs must be reused for related calls, user/session mappings remain our responsibility, and memory/default filesystem state is ephemeral across compute termination. Persistent session storage is separately configured. These are requirements to validate on the deployed runtime, not proof that this clone or our image has the necessary cloud configuration.

Plan constraints:

- Persist the owner, native thread and AgentCore runtime session mapping; reconnect, status, ingestion and resume use that saved mapping.
- Preserve signed AWS invocation credentials in platform, and provider credentials/policy in their existing owners.
- Active work must remain busy even if the browser disconnects or no SSE invocation is open.
- Verify cold restart with and without storage, runtime-version changes, stream expiration, and canceled SDK response bodies.
- A service error confidently returned before execution can have a narrow retry policy; an ambiguous timeout after sending cannot be retried just because it was an HTTP/AWS error.
- A replacement runtime must recover or settle the prior attempt explicitly. Do not silently route a possibly running turn to another owner.

## Verification performed

| Command scope                                        | Result                   | What it establishes                                                                                            |
| ---------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| T3 typed Codex client/protocol/stdio                 | 3 files, 24 tests passed | Mock RPC correlation, fragmented frames, approvals not blocking reader, termination and structural diagnostics |
| T3 thread stream/coalescer/client sync/history merge | 4 files, 81 tests passed | Isolated replay/snapshot and client state ownership/history behavior                                           |
| T3 stream budget/event sequence/SQLite               | 4 files, 32 tests passed | Isolated byte budgets, cancellation, persisted sequence and configuration                                      |
| Truex runtime synchronization/transport/resume       | 3 files, 8 tests passed  | Real local runtime/bridge fixtures and substituted AWS SDK boundary preserve HTTP/AWS contract parity          |

Some T3 batches overlap. Do not add their counts as unique coverage. None demonstrates live model execution, deployed AWS behavior, distributed failover, peak load, soak behavior, or power-loss durability. Full builds and full repository suites were not run for this documentation-only review.

Commands, run from `/Users/ashok/t3code`:

```sh
./node_modules/.bin/vp test run \
  packages/effect-codex-app-server/src/client.test.ts \
  packages/effect-codex-app-server/src/protocol.test.ts \
  packages/effect-codex-app-server/src/_internal/stdio.test.ts

./node_modules/.bin/vp test run \
  apps/server/src/orchestration-v2/ThreadStream.test.ts \
  apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.test.ts \
  packages/client-runtime/src/state/threads-sync.test.ts \
  packages/client-runtime/src/state/threadHistoryMerge.test.ts

./node_modules/.bin/vp test run \
  apps/server/src/orchestration-v2/ThreadStream.test.ts \
  apps/server/src/orchestration-v2/LiveStreamBudget.test.ts \
  apps/server/src/persistence/OrchestrationEventStore.sequence.test.ts \
  apps/server/src/persistence/Sqlite.test.ts
```

From `/Users/ashok/truex-plan/platform`:

```sh
./node_modules/.bin/tsx --test \
  test/runtime-synchronization.test.ts \
  test/runtime-transport.test.ts \
  test/runtime-resume-transport.test.ts
```

### Verification gaps, not passing suites

Attempted deeper suites were blocked by missing imports in the installed T3 clone:

- `EffectWorker.test.ts`: `@t3tools/provider-core/server/pathExpansion`.
- `ProjectionRecovery.test.ts` and `FoundationPersistence.test.ts`: `@t3tools/source-control-azure-devops/client/definition`.
- `ProviderEventIngestor.test.ts`: `mdast-util-directive`.

Those suites did not execute. No dependency installation, assertion bypass or test suppression was applied. Transactional acceptance and recovery conclusions above are source-grounded; their deeper integration tests remain an explicit validation gap.

## Ordered adoption plan

The full proposed plan is [tasks/t3code-harness-plan.md](../../tasks/t3code-harness-plan.md), with its canonical execution checklist in [tasks/t3code-harness-todo.md](../../tasks/t3code-harness-todo.md). Existing structural plans and the previous defect report are preserved.

1. Characterize first-answer late subscription and failure windows through both transports.
2. Fix raw logging/child lifetime and validate runtime receipts against the pinned Codex subset.
3. Make one submission owner responsible for quota, durable intent and scheduling; then handle remote unknown outcomes explicitly.
4. Separate client-independent ingestion/recovery from stream observers; define transient versus durable content checkpoints.
5. Extract frontend stream state and bound the complete payload/queue path.
6. Verify multi-instance ownership, local process loss and real AgentCore termination/reconnect before rollout.

Start with the first-message vertical slice. It can prove the architectural invariants without replacing the whole platform. No production scalability claim should be made until load/retention measurements and deployed-cloud failure tests support it.
