# Plan: Organize and decompose agent-core

Status: structural implementation complete; verification completed with repository-wide exceptions documented. The user authorized execution and explicitly limited this pass to restructuring, with optimization and logic changes deferred. See [validation.md](validation.md) for execution evidence and [../agent-core/README.md](../agent-core/README.md) for the actual module map.

Inspected on 2026-10-14 at repository revision `e84a2e4`. Execution tasks are in [todo.md](todo.md).

## Outcome and scope

Make it clear where a behavior lives and which module owns its state, so debugging a conversation, approval, helper, stream, or workspace operation does not require reading the entire manager. Preserve current behavior while changing organization.

This is one TypeScript service with internal modules. Keep the existing Express, EventEmitter, CodexClient inheritance, runtime protocol, and deployment model. No new services, dependency injection framework, event bus, dependencies, database migrations, caching, or performance redesign are needed for this work. Security fixes or behavior changes discovered during extraction should be recorded and handled separately unless they block safe extraction.

## What exists today

There are **18 source files, 6,418 source lines, and 28 top-level test files**. The problem is concentrated responsibilities and a flat directory, rather than literally one source file.

| Current file              | Lines | Responsibilities and proposed treatment                                                                                                                                   |
| ------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/manager.ts`          | 2,269 | Thread lifecycle, concurrency, notifications, projections, SSE, durable records, helpers, approvals, goals, timing, traces. Primary decomposition target.                 |
| `src/workspace-tools.ts`  |   816 | Tool schemas, path containment, file operations, quotas, serialized writes, bounded search. Split cautiously along existing security boundaries.                          |
| `src/file-tools.ts`       |   558 | Tool schemas, file metadata/storage, extraction, generation, visualizations. Separate specifications and format processing from storage.                                  |
| `src/business-runtime.ts` |   556 | Restricted runtime adapter, instruction/configuration policy, tenant markers, helper permissions, tool dispatch. Extract policy and marker storage; preserve the adapter. |
| `src/trace.ts`            |   363 | Trace construction and public projection. Group under telemetry; no rewrite needed.                                                                                       |
| `src/client.ts`           |   296 | Child process, stdio JSON-RPC, timeouts, restart/error handling. Already a useful boundary; mostly move intact.                                                           |
| `src/index.ts`            |   294 | Configuration, dependency construction, routes, errors, listening, process handlers, drain. Separate importable app from executable bootstrap.                            |
| `src/agentcore.ts`        |   263 | AgentCore invocation validation, forwarding, SSE bridge, executable startup. Keep separate from local core HTTP.                                                          |

### Current request and event flow

1. Local development reaches `index.ts` directly. Production starts `agentcore.ts`; its invocation bridge validates the envelope and lazily starts the local core through `AgentCoreServices`.
2. Local HTTP delegates to `ThreadManager` for lifecycle, snapshots, approvals and capabilities, and to `BusinessRuntime` for document operations.
3. `BusinessRuntime` enforces configuration, tenant/workspace and method policy before `CodexClient` sends JSON-RPC to the pinned engine.
4. Runtime notifications/server requests return to `ThreadManager`. It updates state, projects public data, settles approvals, and tracks helpers.
5. Publication redacts data, assigns sequence/cursor, writes durable events when required, retains bounded replay, and broadcasts SSE. Platform consumes and acknowledges adapter records.

The root structural issue is that `ThreadManager` owns both orchestration and most of these mechanisms. Moving the entire notification handler to another large file would preserve that difficulty.

## Proposed ownership and directory structure

Paths below record the proposed design. The implemented map is in `agent-core/README.md`: HTTP handlers use `http/routes/`, shutdown has its own bootstrap file, protocol server-request helpers retain the name `requests.ts`, and reasoning/message projection has `threads/messages.ts`. Security-sensitive WorkspaceFiles methods stayed together. Small, cohesive files moved intact.

```text
agent-core/
  src/
    index.ts                     # stable local executable -> bootstrap
    agentcore.ts                 # stable AgentCore executable + existing exports
    errors.ts                    # common error identity; no generic utils folder
    bootstrap/
      core.ts                    # env/pin, construction, sweeper, listen/drain
    http/
      app.ts                     # createCoreApp(deps), middleware/errors, health
      threads.ts                 # lifecycle, reads/SSE, approvals, capabilities
      artifacts.ts               # document/visualization HTTP handlers
    agentcore/
      app.ts                     # existing createAgentCoreApp behavior
      invocation.ts              # envelope parsing and route allowlist
      services.ts                # existing lazy child-service lifecycle
    threads/
      manager.ts                 # public coordinator and lifecycle ownership
      state.ts                   # internal types and initial thread state
      snapshots.ts               # public/windowed/operational projections
      records.ts                 # synchronous atomic spool write/read/ack
      events.ts                  # redaction, durability choice, replay, publication
      stream.ts                  # SSE frames, cursor/replay, heartbeat, cleanup
      helpers.ts                 # relationships, early events, bounded transcripts
      approvals.ts               # pending requests, reviews, grants, settlement
      approval-policy.ts         # current approval-modes.ts pure policy
      turn-tracker.ts            # timings, traces/context, watchdog, goal accounting
    runtime/
      client.ts                  # current CodexClient and Runtime contract
      business-runtime.ts        # restricted adapter and request dispatch
      policy.ts                  # existing instructions/configuration normalization
      thread-records.ts          # existing marker metadata and workspace lookup
      tenancy.ts                 # existing tenant/skill validation; keep cohesive
      history.ts                 # protocol history and fallback behavior
    tools/
      documents/
        files.ts                 # ConversationFiles, metadata, quotas, revision IDs
        specs.ts                 # existing dynamic tool specifications/validators
        formats.ts               # document rendering and text extraction
      workspace/
        files.ts                 # WorkspaceFiles, serialized mutations, quotas
        specs.ts                 # tool specifications and limits
        paths.ts                 # containment, symlink/hardlink/open protections
        search.ts                # bounded matching and regex isolation
        sweeper.ts               # current workspace cleanup
      scripts.ts                 # current runner contract/Docker runner/tool adapter
    protocol/
      schema.ts                  # pinned schema lookup and validation
      server-requests.ts         # current requests.ts defaults/response validation
    telemetry/
      trace.ts
      redact.ts
  test/                          # organize after recursive discovery is verified
    threads/ runtime/ http/ agentcore/ tools/ security/ telemetry/
    fixtures/                    # retain existing shared fixture paths initially
```

Temporary old-path reexports such as `src/manager.ts`, `src/client.ts`, and `src/business-runtime.ts` preserve external test/script consumers. These must reexport the same class objects, not introduce wrapper subclasses: `instanceof` checks and prototype-based test interception depend on class identity. Internal modules should import their owning modules directly, not cycle through compatibility files. Keep `shared/` generated types and public contracts where they are. Goal accounting starts inside turn tracking; split it further only if it develops a clear independent boundary. Existing pure approval policy remains a coherent file rather than being rewritten.

### Ownership and dependency rules

- Bootstrap constructs dependencies and installs process handlers. Importing the HTTP app must not read environment-dependent files, create runtime directories, start the sweeper, spawn children, listen, or register process handlers. Reading an explicit configuration belongs in bootstrap.
- HTTP owns parsing/status/headers and delegates operations. The AgentCore bridge remains a separate transport with its existing allowlist and envelopes.
- `ThreadManager` remains the public facade. It owns the single thread map, per-thread locks, capacity reservations, lifecycle transitions and runtime listeners. Preserve its existing public methods/properties during extraction; narrowing health/drain access can follow separately.
- Collaborators operate on the authoritative thread record or a small explicit view. Each mutable field has one writer/owner. Do not make parallel thread stores or pass the entire manager into every module.
- Helper relationships belong to the helper registry; pending approval creation/review/settlement belong to the approval coordinator. Where lifecycle code must initiate an action, call the owning operation rather than mutating its private data.
- Events and SSE stay synchronous where they are synchronous now. The publisher alone owns sequence assignment, publication redaction and replay retention; storage and stream modules provide mechanisms. They must not duplicate those operations, call back into the whole manager or independently change lifecycle state. Preserve generation resets on runtime exit.
- Runtime policy and tool implementations may use protocol, telemetry and errors; they must not import HTTP/bootstrap or the thread manager. Tool implementations obtain managed workspace locations through the existing narrow callbacks.
- Share types with `import type` where possible. Avoid universal barrel exports, generic `utils.ts`, giant shared contexts, repository/service layers for simple functions, and artificial class hierarchies.

## Migration sequence

Each numbered task in `todo.md` is a reviewable extraction or a small repeatable move batch. Keep runnable old entrypoints and compatibility paths throughout. Changes to a shared monolith must be sequential even if leaf work is delegated.

1. **Establish the safety net.** Inventory current test discovery, record actual baseline passes/failures/skips, and characterize risky behavior that lacks coverage. Confirm the pinned binary and isolated fixtures. Add recursive discovery before nesting any tests.
2. **Separate startup from HTTP.** Extract `createCoreApp(deps)` with actual route contract coverage, then bootstrap and the AgentCore bridge modules. Keep executable paths, middleware order and lazy initialization unchanged.
3. **Extract low-coupling pieces.** Move internal state types/snapshot projection, runtime policy and marker access. Preserve policy/configuration output and persisted marker bytes/fields.
4. **Decompose event handling incrementally.** Extract record storage, publication, and SSE in that order. Then extract helper ownership, approval coordination, turn tracking and goal accounting. Leave notification orchestration until these owners exist.
5. **Organize tool implementations.** Separate document specifications/formats and workspace specifications/path/search mechanisms. Preserve each mutation queue and security check sequence. Move the transport, history, schema, telemetry, sweeper and script runner largely intact.
6. **Finish navigation and verification.** Move tests in small batches, update external source imports, document the debugging paths, verify dependencies, and retire temporary facades only once consumers are accounted for. Stable executable files remain.

The order deliberately mixes extraction and verification. A change should complete a whole existing behavior through its new owner; do not create all empty folders/interfaces first.

## Behavior that must remain unchanged

| Risk                                    | Invariant and required evidence                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost/double turns — high                | Preserve per-thread serialization and capacity reservations; concurrent create/resume/message/steer and a completion arriving before `turn/start` returns must leave correct state.                                                                                                                   |
| Missing reconnect events — high         | `synchronize()` capture -> encode -> replay/snapshot -> marker -> live subscriber attachment remains within one event-loop turn. Preserve generation, `sourceCovered`, byte/event bounds and window semantics. No new `await`, timer, or queue in this handoff.                                       |
| Lost durable updates — high             | Preserve redaction -> sequence -> synchronous atomic durable write -> replay retention -> broadcast, along with drain/error/disconnect behavior on storage failure. Preserve record filenames, ordering and idempotent acknowledgement behavior. Do not introduce async persistence in this refactor. |
| Unauthorized helper access — high       | Preserve one authoritative permission registry shared with `BusinessRuntime.helpers`, root ownership, deny rules, early-event buffering and transcript limits. Do not register a helper later than events/requests can reach it.                                                                      |
| Duplicate/unsafe approval — high        | Preserve response-schema validation, single settlement, review revision checks, timeout defaults, mode/grant scope and tool-index invalidation on unload/restart. Watchdogs remain paused while questions/approvals wait.                                                                             |
| Expanded runtime access — high          | Preserve enforced config, connector allowlist, disabled host tools, tenant workspace checks and helper restrictions. Preserve instruction composition byte-for-byte where possible.                                                                                                                   |
| Workspace escape/data corruption — high | Keep validation, symlink/hardlink checks, final open checks, quotas, atomic writes and per-thread mutation queues together. Do not reduce them to a string-only path utility. Keep bounded regex execution isolated.                                                                                  |
| Broken production cold start — high     | Preserve AgentCore validation before `ensureServices()`, no storage access on ping/rejected requests, concurrent startup deduplication, readiness and shutdown ordering. Verify emitted child entrypoints, not just source imports.                                                                   |
| Broken existing sessions — high         | Preserve `business-v1`, marker fields/default tenant behavior, workspace locations, file IDs/metadata, revisions, spool format, restart/resume and fork copying. No data migration.                                                                                                                   |
| Silent verification gap — medium        | Existing `test/*.test.ts` excludes nested tests. Compare discovered file identities and test results before/after moves; skipped pinned-runtime tests cannot count as passing integration validation.                                                                                                 |

Also preserve request IDs, HTTP error/status envelopes, SSE framing/backpressure/cancellation, history fallback, MCP fingerprint reload/defer behavior, stale-plan/watchdog-completion handling, goal totals, redaction, and trace/context retention limits.

### Compatibility traps found in this checkout

- Package scripts and Docker execute `dist/agent-core/src/index.js` and `dist/agent-core/src/agentcore.js`. `AgentCoreServices` also constructs the child index path. Keep `tsconfig.json` `rootDir: ".."` and current output layout.
- `PROJECT_ROOT`, package working directory and schema disk lookup are meaningful. Moving files must not switch these paths to source-relative resolution.
- Platform tests and diagnostics import `ThreadManager`, `BusinessRuntime`, `CodexClient`, and `createAgentCoreApp` directly from old source paths. Search repository-wide before removing a facade.
- Several tests intercept `CodexClient.prototype.request` or inspect manager state. Keep those tests initially; improve their interfaces separately rather than rewriting assertions to make a move pass.
- `scripts/demo.mjs` uses `agent-core/test/fixtures/visualization.html`. Keep that fixture stable until its consumer changes atomically.

## Verification and completion criteria

The original planning inspection did not run tests. Execution results, actual pinned-runtime checks, source-equivalence review and repository-wide exceptions are now recorded in [validation.md](validation.md).

At each extraction:

- Run the relevant unchanged characterization/regression suites listed in `todo.md`, followed by `npm --prefix agent-core run build`. Existing skips/failures must be recorded; new skips or reduced assertions are not acceptable substitutes for a passing check.
- Review the actual diff for accidental behavior/configuration/dependency changes. No copied duplicate implementation may remain behind a facade.
- Check import direction and single state ownership. A smaller file alone is not evidence of a better boundary.

At phase checkpoints, run `npm --prefix agent-core test`, the core build, and formatting on affected files. At the final checkpoint run repository `npm test`, `npm run build`, `npm run format:check`, `npm run check:secrets`, and relevant script tests such as `node --test scripts/agentcore-smoke.test.mjs`. Verify the production image locally when its pinned artifact/Docker prerequisites are available. After a separately authorized deployment, the existing AWS smoke command is `npm run agentcore:test -- <runtime-arn>`; it needs AWS CLI access and an explicit test runtime ARN, and checks deployed startup rather than model generation. Report unavailable checks as unverified. Do not invoke live business connectors or production data to validate a structural change.

Acceptance criteria:

1. A developer can locate each responsibility using the directory map and debugging guide. The manager coordinates named owners rather than implementing approvals, helper tracking, record I/O and SSE mechanics itself.
2. Existing API/export contracts, startup commands, generated protocol, persisted data and observable behavior remain compatible. Actual local app routes and the production bridge are covered.
3. All 28 original test files remain discoverable after grouping; original scenarios/assertions remain, alongside justified new regression cases. Required runtime checks actually execute, with skips reported explicitly.
4. There are no new dependency cycles, duplicate state stores, universal manager-context objects, dependencies or schema migrations. Existing retention/queue limits remain intact.
5. Error, concurrency, replay, timeout, filesystem and restart invariants above have evidence. Existing runtime/trace diagnostics still identify the thread/turn and failure source.
6. Add `agent-core/README.md` explaining startup, request/event flow, module ownership, where to debug common failures and how to run focused tests.

Use file size as a review signal, not a reason to scatter a coherent implementation into dozens of trivial modules. Reassess the remaining manager after extraction instead of promising an arbitrary line-count target.

## Rollout, rollback and operational impact

Land focused commits/PRs by concern; every intermediate revision must build and run with the same entrypoints. Keep mechanical move commits separate from responsibility extraction commits. No deployment is authorized by this planning task. Once implemented, deploy through the normal existing process, observe readiness, runtime exits, active threads, durable record errors, stream disconnects, approval timeouts and turn timing with existing instrumentation.

The intended runtime impact is organizational: no extra network hops, scheduled jobs, retries or persistence operations. Do not claim latency/capacity improvements without measurement. Replay bounds and stress suites should show no regressions; compare existing fixture timing only if a changed hot path warrants it.

Because persisted formats stay unchanged, rollback is a code/image rollback with the same runtime-home volume. Preserve the volume and avoid rewriting records during migration. Graceful drain/restart can still interrupt in-flight conversations under existing behavior; this plan does not claim a zero-downtime state migration.

## Remaining uncertainty

- Exact collaborator signatures should be chosen during their small extraction, after identifying all field writers; this plan intentionally does not invent a replacement RPC/type system.
- Core tests, builds and compiled local entrypoint smoke were executed. Docker/deployed AWS checks remain outside this local restructuring pass; the full repository suite has documented platform assertion failures.
- Repository documentation contains historical claims; current code is the basis for this plan. This is not a security certification or a production capacity assessment.
