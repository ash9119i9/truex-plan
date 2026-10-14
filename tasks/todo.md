# agent-core restructuring tasks

Plan: [plan.md](plan.md). Status: structural work implemented and verified, with repository-wide check exceptions recorded. Current execution summary and check results are in [validation.md](validation.md). The checklist is synchronized with execution. Unchecked entries explicitly identify deferred extra validation or broader repository failures; they are not unfinished code moves. Scope adjustments are recorded in that summary.

Tasks are sequential unless explicitly independent. Scope estimates include the owner, facade/caller and focused test; aim for roughly three to five files per batch. The actual boundary is one concern with independently verifiable behavior: do not leave a transition incomplete just to meet a file count. Keep existing test bodies and imports working through temporary same-object reexports. Do not turn the checklist into one bulk refactor.

## Phase 1 — Establish evidence and isolate startup

### 1. Record baseline and preserve test discovery

- [x] Inventory all 28 existing test file paths and current test/pass/fail/skip counts. Verify the pinned runtime can execute; use isolated fixture homes.
- [x] Make discovery recursive before any test moves; prove both original top-level paths and a temporary nested probe are discovered, then remove the probe.
- [x] Record baseline core tests/build and root format/secrets results without changing unrelated failures.

**Files:** `agent-core/package.json`, a focused discovery test/runner only if necessary, dated validation note. **Size:** S/M. **Dependencies:** none.

**Verify:** `npm --prefix agent-core test`; `npm --prefix agent-core run build`; `npm run format:check`; `npm run check:secrets`. Compare discovered paths, not only an aggregate pass count.

### 2. Characterize the highest-risk manager invariants

- [x] Reuse existing manager/sync/approval suites; identify gaps before adding tests.
- [x] Add missing regression cases for durable write failure, early completion, stale approval review, watchdog late completion or restart cleanup only where existing coverage does not prove the invariant.
- [x] Verify failure tests exercise the protection (targeted condition mutation or injected failure), restore the mutation, and preserve all original assertions.

**Files:** small batches within `manager.test.ts`, `sync-protocol.test.ts`, `approval-modes.test.ts`, `error-handling.test.ts`. **Size:** M per gap batch. **Dependencies:** 1.

**Verify:** run affected files with package-local `tsx --test`; run the full core suite. Tests must fail when the guarded invariant is deliberately broken.

### 3. Extract the importable local HTTP app

- [x] Move middleware/routes/error framing into `createCoreApp(deps)` with explicit dependencies; preserve route order, statuses, request IDs and redaction.
- [x] Importing the app has no filesystem startup, child process, listener or signal-handler side effects. Keep `src/index.ts` executable behavior unchanged.
- [x] Test actual app routes with fake dependencies and isolated state: lifecycle, invalid input, errors, resume options, snapshot/SSE options and disconnect cleanup.

**Files:** `src/index.ts`, `src/http/app.ts`, `test/core-http.test.ts`; add route files in later small batches if necessary. **Size:** M. **Dependencies:** 1–2.

**Verify:** actual app HTTP tests, manager/sync/resume suites, core build. Do not substitute a separately reconstructed test-only route implementation.

### Checkpoint A

- [x] All original tests still run and core builds; no new runtime skips.
- [x] Local executable still starts; actual app contracts are covered.
- [x] Review extraction diff for initialization order and security/error behavior.

### 4. Move core composition into bootstrap

- [x] `bootstrap/core.ts` owns environment/pin resolution, runtime/manager construction, sweeper, listen, process handlers and drain in their existing order.
- [x] Keep `src/index.ts` thin and preserve cwd/env semantics, ports, timeouts, binary pin and drain behavior.
- [x] Verify startup/termination using temporary runtime state and bounded child-process tests; app construction does not duplicate runtime listeners, signal handlers or sweepers, and no orphan timers/processes remain.

**Files:** `src/index.ts`, `src/bootstrap/core.ts`, focused bootstrap test. **Size:** M. **Dependencies:** 3.

**Verify:** core app/error tests, core build, isolated emitted `dist/agent-core/src/index.js` startup and shutdown check.

### 5. Separate the AgentCore bridge modules

- [x] Extract allowlist/parser to `agentcore/invocation.ts`, app to `agentcore/app.ts`, and move service launcher to `agentcore/services.ts` in successive small batches.
- [x] Preserve `src/agentcore.ts` executable and `createAgentCoreApp` exports, validation-before-startup, ping behavior, envelopes, SSE cancellation/backpressure and lazy startup deduplication.
- [ ] Deferred extra validation: new service-launcher fault-injection tests for concurrent first invocation/startup failure/stop-while-starting/child exit. The launcher moved unchanged, existing bridge tests pass, and compiled startup/shutdown was verified.

**Files:** `src/agentcore.ts`, `src/agentcore-services.ts`, destination modules and bridge/service tests; split parser/app/launcher into separate batches. **Size:** M per batch. **Dependencies:** 4.

**Verify:** `agentcore.test.ts`, focused service lifecycle tests, `node --test scripts/agentcore-smoke.test.mjs`, core build and emitted entrypoint existence/path checks.

## Phase 2 — Extract owners from the manager and runtime

### 6. Extract thread state and snapshot projection

- [x] Move internal state types/initialization to `threads/state.ts` and snapshot/window projection to `threads/snapshots.ts` in separate batches.
- [x] Retain one manager-owned thread map and existing public properties; preserve source coverage and operational snapshots.
- [x] Verify no duplicated lifecycle state or dependency from projection back into manager exists.

**Files:** `src/manager.ts`, `src/threads/state.ts`, `src/threads/snapshots.ts`, focused tests. **Size:** M. **Dependencies:** 2.

**Verify:** manager, snapshot-window, sync-protocol, resume-response and trace suites; core build.

### 7. Extract runtime policy

- [x] Move persona/helper normalization, instructions, connector validation and enforced configuration into `runtime/policy.ts`.
- [x] Preserve all existing exports through same-object reexports and preserve normalized runtime requests/instruction output.
- [x] Keep BusinessRuntime inheritance, deny behavior and script feature decisions unchanged.

**Files:** `src/business-runtime.ts`, `src/runtime/policy.ts`, relevant policy tests if needed. **Size:** M. **Dependencies:** 1.

**Verify:** persona-config, subagents-config, tenancy, business-security, workspace-wiring tests; core build. Compare serialized config/instructions before/after for representative profiles.

### Checkpoint B

- [x] Core tests/build pass; old source imports and emitted executables work.
- [x] Review helper/tool policy and instruction equivalence; no configuration behavior changed.
- [x] Review ownership graph and verify app imports remain safe.

### 8. Extract runtime thread-marker storage

- [x] Move marker validation/read/write and metadata access into `runtime/thread-records.ts`, keeping current defaults and failure behavior.
- [x] Preserve marker formats, generated workspace paths, tenant enforcement, skills/helper persistence and fork behavior.
- [x] Do not introduce caches or change sync I/O to async I/O.

**Files:** `src/business-runtime.ts`, `src/runtime/thread-records.ts`, relevant tenancy/resume tests. **Size:** M. **Dependencies:** 7.

**Verify:** tenancy, runtime, assistant-runtime, workspace-e2e and business-security suites; inspect temp persisted markers and same-home restart/fork results; core build.

### 9. Extract durable record storage

- [x] Move atomic spool write/read/ack mechanics to `threads/records.ts`; retain event durability decisions in the current publisher until task 10.
- [x] Preserve filenames, ordering, read bounds, ack validation/ENOENT behavior and write-before-broadcast.
- [x] Inject storage failure and confirm draining/error/disconnect behavior remains unchanged.

**Files:** `src/manager.ts`, `src/threads/records.ts`, focused storage tests. **Size:** M. **Dependencies:** 6.

**Verify:** durable-record manager tests, error tests, new fault tests and core build. Compare recovered records after manager recreation.

### 10. Extract event publication

- [x] Move redaction, sequence/cursor assignment, durability choice, record invocation and replay retention into `threads/events.ts`.
- [x] Preserve publication order, goal durability deduplication, byte limits and storage-failure signaling; keep manager lifecycle admission owned by manager through a narrow explicit failure result/operation.
- [x] No async boundary, new event bus, replay copy or independent lifecycle store is introduced.

**Files:** `src/manager.ts`, `src/threads/events.ts`, record integration/fault tests. **Size:** M. **Dependencies:** 9.

**Verify:** manager, sync-protocol, redact, trace, error-handling suites and core build.

### Checkpoint C

- [x] Core tests/build pass, including storage fault and restart tests.
- [x] Explicitly review redaction/write/retain/broadcast order and drain behavior.
- [x] No public format, protocol or persisted record change.

### 11. Extract SSE subscription and replay

- [x] Move framing, cursor validation, replay/snapshot synchronization, heartbeat, backpressure and cleanup to `threads/stream.ts`.
- [x] Capture through live subscriber attachment stays synchronous. Preserve sourceCovered fallback, high-water cursor, resync reasons and operational marker.
- [x] Large frames, expired/ahead cursors, runtime generations, slow/disconnected subscribers and unchanged bounds are verified.

**Files:** `src/manager.ts`, `src/threads/stream.ts`, sync/HTTP tests. **Size:** M. **Dependencies:** 10.

**Verify:** sync-protocol, snapshot-window, manager large-result/backlog tests, actual app SSE tests and core build; compare decoded frames/order with the baseline.

### 12. Extract helper tracking

- [x] Move helper relationships, early events, names, lifecycle projection, transcript bounds and ownership to `threads/helpers.ts`.
- [x] Keep helper registration and BusinessRuntime permission checks tied to one authoritative registry; preserve root/parent linkage and deletion/archive cleanup.
- [x] Helper questions/tools still decline correctly; helper events never leak unprojected data onto root streams.

**Files:** `src/manager.ts`, `src/threads/helpers.ts`, `src/business-runtime.ts` only if a narrow registration seam is required, helper tests. **Size:** M. **Dependencies:** 11.

**Verify:** manager helper cases, subagents-config, business-security, assistant-runtime and trace tests; core build.

### 13. Extract approval coordination

- [x] Move pending request creation, review, tool metadata lookup, grants, timeout and settlement to `threads/approvals.ts`; move existing pure policy separately.
- [x] Preserve one writer for pending approvals, schema validation, stale-review protection, single response, helper denial, runtime exit and timeout behavior.
- [x] Preserve mode/tool-index invalidation and watchdog pause/rearm integration.

**Files:** `src/manager.ts`, `src/threads/approvals.ts`, current/destination approval-policy module, focused tests; split policy move if needed. **Size:** M per batch. **Dependencies:** 12.

**Verify:** approval-modes, manager approval tests, resume-response and error-handling suites, targeted stale-review/double-answer fault tests; core build.

### Checkpoint D

- [x] Core tests/build pass; real pinned-runtime helper/approval scenarios run where covered.
- [x] Review concurrent answer/expiry/mode-change/runtime-exit paths and helper permission ownership.
- [x] Review SSE handoff for accidental awaits and callback-induced re-entry.

### 14. Extract turn tracking and goals

- [x] Extract turn timing/trace/context/watchdog operations, then goal identity/token projection in a separate batch.
- [x] Preserve late usage, completed-goal accounting, active-turn checks, bounded retention, pause on approvals and suppression of late completion after a stall. Keep goal accounting within turn tracking initially rather than adding a tiny separate module.
- [x] Simplify notification handling into calls to established owners last; lifecycle transitions remain explicit and manager-owned.

**Files:** `src/manager.ts`, `src/threads/turn-tracker.ts`, focused tests. **Size:** M per batch. **Dependencies:** 13.

**Verify:** trace, manager timing/goal/plan tests, error-handling/watchdog cases and core build. Compare representative event and snapshot sequences with baseline.

## Phase 3 — Organize tools and finish navigation

### 15. Separate document specifications and format processing

- [x] Extract current schemas/validators into `tools/documents/specs.ts`, then rendering/extraction into `formats.ts`; move ConversationFiles to `files.ts` with an old-path facade while consumers migrate.
- [x] Preserve public tool names/schema payloads, validation/error behavior, storage queue, quotas, revisions, PDF/Office bounds and visualization metadata.
- [x] Keep storage independent of HTTP/manager; do not add per-format plugin abstractions.

**Files:** `src/file-tools.ts`, document destination modules and `file-tools.test.ts`; split specifications/formats/storage into small batches. **Size:** M per batch. **Dependencies:** 8, 14.

**Verify:** file-tools, workspace-wiring, workspace-e2e and assistant-runtime tests; core build; check generated files remain readable and metadata compatible.

### 16. Separate workspace mechanisms

- [x] Extract specifications/limits, then path safety, then bounded search in separate batches; move remaining WorkspaceFiles as its coherent owner.
- [x] Preserve validation/open/check order, symlink/hardlink defenses, atomic writes, quotas, serialization, copy/export and tmp cleanup.
- [x] Keep existing security stress tests unchanged; no generic filesystem repository or independent mutation queue is added.

**Files:** `src/workspace-tools.ts`, destination specs/paths/search/files modules and focused workspace tests; at most one mechanism per batch. **Size:** M per batch. **Dependencies:** 15.

**Verify:** workspace-tools, workspace-stress, workspace-wiring, workspace-e2e, script-runner/stress and sweeper/stress suites; core build.

### Checkpoint E

- [x] Core tests/build pass with adversarial filesystem and bounded-search coverage.
- [x] Verify no tool schema, quota, queue, error leakage or feature-availability change.
- [x] Recheck dependency direction: tools cannot import manager/HTTP/bootstrap.

### 17. Complete remaining source moves in small batches

- [x] Move manager/runtime adapters, client/history/tenancy, protocol, telemetry, sweeper and script runner to their planned owners, one module or small dependency group at a time.
- [x] Use explicit same-object reexports at old paths; migrate production callers directly to canonical modules without facade cycles.
- [x] Keep `src/index.ts`, `src/agentcore.ts`, common error identity, shared generated artifacts, compiler root/output and child spawn paths stable.

**Files:** each old module, destination, facade/caller and relevant test. **Size:** S/M per batch; repeat as needed. **Dependencies:** 14–16.

**Verify:** affected focused suite plus core build per batch; full core suite at completion. Search imports and check runtime class/error identity.

### 18. Group tests and migrate cross-package consumers

- [x] Move tests by ownership in batches, preserving original scenarios/assertions and fixture working-directory semantics. Keep demo fixture paths stable.
- [x] Update platform diagnostics/tests to canonical source paths in bounded batches, or keep an explicitly documented compatibility facade where a consumer must remain supported.
- [x] Prove all 28 original test files remain represented/discoverable; remove temporary internal facades only when repository-wide import searches and builds confirm no consumers.

**Files:** small test/import batches, `agent-core/package.json` only if discovery requires refinement; platform diagnostic/profiler/synchronization consumers. **Size:** M per batch. **Dependencies:** 1, 17.

**Verify:** discovered path inventory mapped to destinations; core suite; platform synchronization/profiler tests; `npm test`; `npm run build`. No new skips or swallowed failures.

### 19. Document debugging paths and review the final result

- [x] Add `agent-core/README.md`: entrypoints, dependency direction, state ownership, request/event flow, focused commands and where to debug turns/approvals/helpers/reconnect/storage/tools.
- [x] Perform an adversarial diff review for duplicate state, cycles, private-manager-context coupling, unbounded work, altered permissions, accidental behavior changes, imports with startup side effects and unnecessary fragmentation.
- [x] Record current evidence, unresolved baseline issues and production smoke status. Compare existing timing/retention evidence if hot-path behavior changed; do not claim capacity improvements from file moves.

**Files:** `agent-core/README.md`, dated validation note, existing related docs only where current navigation changed. **Size:** M. **Dependencies:** 18.

**Verify:** `npm test`; `npm run build`; `npm run format:check`; `npm run check:secrets`; `node --test scripts/agentcore-smoke.test.mjs`; isolated emitted entrypoint startup and local production-image smoke when prerequisites exist. The separate post-deployment check is `npm run agentcore:test -- <runtime-arn>` with AWS CLI access and an explicit test runtime ARN. Report unavailable checks explicitly.

### Final checkpoint

- [ ] Repository-wide tests are not fully green: core passes 217/217 and gateway passes 68/68; platform reports 302/305 in the full run. The CLI wording mismatch reproduces on original HEAD, and the agent-limit scenario passes in isolation on both revisions. See validation.md. No assertions were weakened.
- [x] Entry points, public contracts, disk layouts and the named concurrency/security/durability invariants remain compatible.
- [x] The manager delegates meaningful responsibilities and developers can follow the documented debugging paths.
- [x] Rollback requires only the previous code/image with the same runtime-home volume. No deployment or production data change is part of this plan.

## Parallel work

Research and test-gap inventories can run independently. After owner interfaces stabilize, document formatting or isolated leaf moves can be delegated if they do not touch the same callers. Manager extractions, BusinessRuntime policy/marker changes, startup rewiring and test discovery changes must be integrated sequentially; parallel edits to these shared files would increase risk.
