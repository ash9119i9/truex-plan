# agent-core

The Express adapter around the project-pinned Codex app-server. This package owns runtime access policy, conversation lifecycle, approvals, helper tracking, document/workspace tools, durable event handoff and SSE delivery. The platform service owns its separate application persistence and public API.

## Entry points

- `src/index.ts` starts the local core HTTP server. `bootstrap/core.ts` constructs the runtime, thread manager and workspace sweeper; `bootstrap/shutdown.ts` installs the existing drain/termination handlers.
- `src/agentcore.ts` starts the production AgentCore invocation bridge. `agentcore/invocation.ts` validates its allowlisted requests; `agentcore/app.ts` forwards HTTP/SSE; `agentcore/services.ts` lazily starts the local core on the first valid invocation.
- `http/app.ts` exports `createCoreApp(dependencies)` for direct HTTP tests. Importing this module does not start the runtime, create runtime directories, listen, start the sweeper or install process handlers.

The executable paths remain `dist/agent-core/src/index.js` and `dist/agent-core/src/agentcore.js`. Keep the existing compiler root/output layout, package working-directory assumptions, `PROJECT_ROOT`, binary pin and runtime-home layout when changing startup code.

## Find the owning module

| Area                                                                             | Owner                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| HTTP status, request IDs, errors and routes                                      | `http/app.ts`, `http/routes/`                                           |
| AgentCore envelopes, validation, forwarding and child startup                    | `agentcore/`                                                            |
| Thread creation/resume, start/steer/interrupt, locks, capacity, runtime dispatch | `threads/manager.ts`                                                    |
| Authoritative thread record types and initialization                             | `threads/state.ts`                                                      |
| Approval creation, reviews, mode changes, grants, expiry and settlement          | `threads/approvals.ts`, `threads/approval-policy.ts`                    |
| Helper relationships, early events, names, transcripts and ownership             | `threads/helpers.ts`                                                    |
| Reasoning and assistant-message projection                                       | `threads/messages.ts`                                                   |
| Full/windowed and operational snapshots                                          | `threads/snapshots.ts`                                                  |
| Redacted event sequencing, durability choice and bounded retention               | `threads/events.ts`                                                     |
| Synchronous atomic durable record write/read/ack                                 | `threads/records.ts`                                                    |
| SSE framing, cursor validation, replay, heartbeat and subscriber cleanup         | `threads/stream.ts`                                                     |
| Timing, traces/context, goal accounting and watchdog timer mechanics             | `threads/turn-tracker.ts`                                               |
| Enforced runtime configuration and instruction composition                       | `runtime/policy.ts`                                                     |
| Restricted method dispatch, tool routing and runtime profile lifecycle           | `runtime/business-runtime.ts`                                           |
| Child process, stdio JSON-RPC, pending requests and runtime errors               | `runtime/client.ts`                                                     |
| Thread markers, tenant/skill policy and history fallback                         | `runtime/thread-records.ts`, `runtime/tenancy.ts`, `runtime/history.ts` |
| Pinned schema validation and server-request defaults                             | `protocol/`                                                             |
| Document storage/metadata, specifications and format processing                  | `tools/documents/`                                                      |
| Workspace files, safety checks, specifications, search and sweeper               | `tools/workspace/`                                                      |
| Script runner and script tool adapter                                            | `tools/scripts.ts`                                                      |
| Trace representation and secret redaction                                        | `telemetry/`                                                            |

Implementation imports use the owning module directly. The former root-level compatibility reexports have been removed after migrating repository consumers. `src/index.ts` and `src/agentcore.ts` remain executable entry points; `src/errors.ts` owns the shared HTTP/runtime error classes. Runtime consumers use the same constructor objects, so `instanceof BusinessRuntime` and existing prototype interception continue to work.

## Request and event flow

1. Local HTTP, or the validated AgentCore bridge, delegates to the thread manager or document runtime methods.
2. The manager owns the single thread map, lifecycle transitions, per-thread serialization and capacity reservations. Its collaborators share the existing authoritative records; they do not maintain copies of thread state.
3. `BusinessRuntime` applies the existing method/configuration/tenant policy. `CodexClient` sends JSON-RPC to the pinned engine over stdio.
4. Runtime listeners in the manager dispatch notifications to helper tracking, message projection, turn tracking and approval coordination.
5. `ThreadEvents` redacts, assigns the sequence/cursor, writes required durable records synchronously, retains bounded replay and publishes to subscribers. Platform ingestion reads and acknowledges those records.

Lifecycle and failure coordination remain in the manager, including termination of a stalled turn. Helper activity and approval transitions call its watchdog operation. Helper permission registration still updates the same `BusinessRuntime.helpers` set used by runtime restrictions.

SSE synchronization captures the high-water cursor, encodes replay or a snapshot, writes `sync.completed` and attaches the live subscriber synchronously. Do not add an `await` or deferred queue between these steps. The publisher is the sole owner of event sequence assignment and replay retention.

## Debugging paths

- **No response or a stalled turn:** inspect `runtime/client.ts` request/exit diagnostics, manager lifecycle/notification handling, then `turn-tracker.ts`. Trace representations and public context live in `telemetry/trace.ts`.
- **Question or tool permission stuck:** follow `approvals.ts` pending request, timer, review revision and settlement; check response schemas/defaults in `protocol/requests.ts` and MCP policy in `approval-policy.ts`.
- **Helper missing or leaking into a root stream:** inspect `helpers.ts` parent/root registration, early buffering and permission registration, then manager notification/server-request dispatch.
- **Missing or duplicate reconnect text:** follow `messages.ts` -> `events.ts` -> `stream.ts`; inspect source coverage, cursor generation and replay bounds before changing projection logic.
- **Final update not saved:** inspect `records.ts` and the publisher's storage-failure path. Write failure stops admission, reports `STORAGE_UNAVAILABLE` and closes subscribers.
- **Resume or connector configuration wrong:** inspect manager MCP fingerprint reload/defer behavior, `runtime/business-runtime.ts`, `runtime/policy.ts` and existing thread markers.
- **Workspace operation denied:** inspect `tools/workspace/files.ts` together with `paths.ts`; filesystem checks, final opens, quotas and mutation queues form one safety boundary. Search execution bounds live in `search.ts`.
- **Document extraction or output wrong:** inspect `tools/documents/formats.ts`; storage, revisions and quotas stay in `files.ts`, while schemas and validation helpers live in `specs.ts`.

## Verification

From the repository root:

```sh
npm --prefix agent-core test
npm --prefix agent-core run build
npm test
npm run build
npm run check:secrets
```

For a focused test, run from this package directory so the existing runtime and schema path assumptions stay valid:

```sh
cd agent-core
./node_modules/.bin/tsx --test test/threads/manager.test.ts test/threads/sync-protocol.test.ts
./node_modules/.bin/tsx --test test/threads/structure.test.ts
./node_modules/.bin/tsx --test test/http/http-app.test.ts
```

Tests are grouped under `test/{agentcore,http,runtime,security,telemetry,threads,tools}`. The package test command uses a quoted recursive glob and includes every group. Keep `test/fixtures/visualization.html` stable: the repository demo also reads it.

Runtime integration tests use the project-pinned binary with local model/MCP fixtures and temporary homes. A missing binary can skip those tests; report skips separately from passes. The structural characterization tests exercise durable storage failure and completion before the start response, and also pass against the original implementation.

This restructuring preserves the existing APIs, logic, policy, limits, persisted formats and deployment commands. Optimization and changes to runtime behavior are separate work.

The [combined restructuring report](../verification-reports/combined-restructure-2026-10-14.md) records platform integration, canonical import cleanup, regression results and existing check failures.
