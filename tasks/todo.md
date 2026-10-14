# Platform restructuring tasks

Status: structural-only scope completed. Current source map: [platform/README.md](../platform/README.md). Results and baseline blockers: [verification report](../verification-reports/platform-structure.md). Original design and risks: [plan.md](plan.md).

The user reserved code refactoring and performance fixes for separate work. Tasks 15–17 below remain explicitly recorded as that future scope; current runtime/history/ingestion method bodies and singleton state are preserved together in `app/platform-service.ts`.

All tasks preserve behavior. Run focused suites from `platform/` with `node node_modules/tsx/dist/cli.mjs --test test/<name>.test.ts`; run `npm --prefix platform run build` from root after source changes. Run the full platform suite at the checkpoints and after significant service/state extractions. Do not weaken tests, guards or failure handling.

## 01. Baseline and security coverage migration

Record current API/test inventories and check results. Prepare the filename-sensitive route/access guards to follow real implementations across extractions.

- [x] Record all routes, all 47 current test paths, current failures/skips and representative JSON/SSE output.
- [x] Preserve exact session/MCP inventory and access-mode coverage; make empty/missing discovery fail and prove a missing-authorization negative control is detected.
- [x] Retain behavioral unauthorized-route matrices and add only missing high-risk characterization.

Verification: `ownership`, `mcp-scopes-http`, `private-access`, `http`, full platform tests/build, root format/secrets checks. Dependencies: none. Likely files: `platform/test/ownership.test.ts`, `mcp-scopes-http.test.ts`, a focused discovery helper/test and a baseline report. Scope: medium; split baseline capture from guard implementation if needed.

## 02. Agent and metadata routes

- [x] Extract `/api/agents`, `/api/models` and metadata registration with full existing paths.
- [x] Preserve handler bodies, statuses and middleware position.
- [x] Keep route-discovery coverage complete.

Verification: `agents`, `persona`, `general-agent`, `http`, `auth`. Dependencies: 01. Likely files: `src/index.ts`, `src/agents/routes.ts`, `src/http/metadata.routes.ts`, focused route tests. Scope: medium.

## 03. Project routes

- [x] Extract project CRUD and session-project assignment registration.
- [x] Preserve read/write ownership checks and exact response shapes.
- [x] Keep assignment to a missing/foreign project covered.

Verification: `projects`, `ownership`, `private-access`. Dependencies: 01. Likely files: `src/index.ts`, `src/projects/routes.ts`, route guard/helper and focused tests. Scope: medium.

## 04. MCP routes

- [x] Extract user/tenant MCP CRUD and agent attachments without changing paths or roles.
- [x] Preserve admin scope, owner hiding, validation and duplicate-name responses.
- [x] Enumerate the same MCP routes after extraction.

Verification: `mcp-scopes-http`, `mcp-scopes`, `mcp-legacy`. Dependencies: 01. Likely files: `src/index.ts`, `src/mcp/routes.ts`, MCP discovery/helper tests. Scope: medium.

## Checkpoint A: HTTP extraction pattern

- [x] Full platform tests retain the same baseline failure only; build passes and route/test inventories are complete.
- [x] Move-aware diff shows unchanged handler behavior and security order.

## 05. Conversation read routes

- [x] Extract session list/details, history, helper-agent reads, traces/timings and goal reads.
- [x] Preserve read access, passive-view behavior and history options.
- [x] Route/access scanner follows the extracted code rather than shims.

Verification: `ownership`, `private-access`, `history`, `history-read`, `traces`. Dependencies: 01 and pattern from 02–04. Likely files: `src/index.ts`, `src/conversations/read.routes.ts`, discovery helper/tests. Scope: medium; split telemetry routes if extraction is too large.

## 06. Conversation write routes

- [x] Extract create/send, interrupts, approvals, capability dispatch and goal review registration.
- [x] Preserve validation, access modes and response/error contracts.
- [x] Keep method-dependent capability access covered.

Verification: `ownership`, `approval-modes`, `resume-approval`, `goals`, `commands`, `http`. Dependencies: 05. Likely files: `src/index.ts`, `src/conversations/write.routes.ts`, guard/helper and focused tests. Scope: medium; split mutation groups if needed.

## 07. Document and visualization proxy routes

- [x] Extract document upload/download/list and visualization proxy handlers.
- [x] Preserve ownership, content headers, byte relay and upstream error handling.
- [x] Keep all session routes in expected access coverage.

Verification: `ownership`, `http`, `public`, proxy characterization if missing. Dependencies: 05. Likely files: `src/index.ts`, `src/conversations/documents.routes.ts`, focused tests/helper. Scope: medium.

## 08. SSE endpoint

- [x] Move the full endpoint lifecycle together: capacity, authorization, access watcher, stream transformation and persistence.
- [x] Preserve passive views, cursor/framing/redaction and saved plan/goal behavior.
- [x] Disconnect, abort, revocation and upstream failure stop watchers and release capacity.

Verification: `auth`, `private-access`, `ownership`, `public`, `sync-public`, `goal-replay`, SSE cleanup characterization. Dependencies: 01 and 05. Likely files: `src/index.ts`, `src/streaming/events.route.ts`, guard/helper and SSE tests. Scope: medium, high risk.

## Checkpoint B: Routes complete

- [x] Full platform results introduce no new failures/skips and build passes; API route inventory and read/write coverage match baseline.
- [x] Google/dev/POC, admin isolation and stream cleanup tests pass.

## 09. Bootstrap and lifecycle

- [x] Extract construction, health routes, ordered security assembly and shutdown in small sub-slices.
- [x] Keep `src/index.ts` and emitted entrypoint stable, including environment/metadata initialization order.
- [x] One Store/service/transport/worker is started; HTTP closes before Mongo and shutdown retains its timeout.

Verification: `dev-startup`, `auth`, `admin`, `google`, `http`; isolated compiled-entry smoke. Dependencies: 02–08. Likely files: `src/index.ts`, `src/app/bootstrap.ts`, `security.ts`, `lifecycle.ts`, `health.routes.ts`; a separate smoke-test sub-slice. Scope: medium per sub-slice.

## 10. Project operations

- [x] Move project CRUD/assignment operations from the facade and reuse access validation.
- [x] Preserve missing/foreign project handling and session touching.
- [x] Retain public service signatures while delegation replaces business logic.

Verification: `projects`, `private-access`, `ownership`. Dependencies: 03 and 01. Likely files: `src/service.ts`, `src/projects/operations.ts`, focused tests/helper. Scope: medium.

## 11. Agent catalog

- [x] Extract agent/model listing, agent resolution and agent CRUD; reuse current validators.
- [x] Preserve general-agent handling, user-specific filtering, limits and secret-free summaries.
- [x] Facade signatures and test overrides remain effective.

Verification: `agents`, `general-agent`, `persona`, `private-access`, `configuration-reads`. Dependencies: 02 and 01. Likely files: `src/service.ts`, `src/agents/catalog.ts`, existing/new focused tests. Scope: medium.

## 12. MCP management

- [x] Extract connector CRUD/attachments separately from runtime configuration building.
- [x] Preserve user/tenant scope, name conflicts, secret storage and agent permission checks.
- [x] Keep limits, URL validation and legacy refusal paths intact.

Verification: `mcp`, `mcp-scopes`, `mcp-scopes-http`, `mcp-legacy`, `private-access`. Dependencies: 04 and 11. Likely files: `src/service.ts`, `src/mcp/management.ts`, focused tests/helper. Scope: medium, high risk.

## Checkpoint C: Contained services

- [x] Full platform results introduce no new failures/skips and build passes and mutable facade seams remain compatible.
- [x] No new collection caches, dependency container or route-service cycle introduced.

## 13. Runtime configuration

- [x] Extract model/skill/owner-specific MCP configuration and gateway options.
- [x] Preserve stored owner identity, fresh profile reads, URL revalidation and fingerprinting.
- [x] Keep parallel reads, request counts and validation/error order.

Verification: `configuration-reads`, `mcp-scopes`, `model-route`, `runtime-resume-transport`, `send-preparation`. Dependencies: 11–12. Likely files: `src/service.ts`, `src/runtime/configuration.ts`, focused tests. Scope: medium, high risk.

## 14. Goal persistence

- [x] Extract pure goal helpers and persistence/ordering logic below history and ingestion.
- [x] Preserve stale replay rejection, token monotonicity, goal identity and history bounds.
- [x] Keep review/capability dispatch explicit without a dependency cycle.

Verification: `goals`, `goal-replay`, `plan`. Dependencies: 01. Likely files: `src/service.ts`, `src/conversations/goals.ts`, focused tests. Scope: medium, high risk.

## Future refactoring: 15. History and reconciliation

Excluded from this structural migration by the user’s clarified scope; keep these items for the separate refactoring work.

- [ ] Extract recovery/reconciliation with one map of in-flight work using the unchanged key.
- [ ] Preserve per-request authorization/persisted reads, pagination and passive/persisted-only behavior.
- [ ] Coalesced recovery failure clears in-flight state and retains public recovery errors.

Verification: `history`, `history-read`, `history-window`, `private-access`, `runtime-synchronization`. Dependencies: 13–14. Likely files: `src/service.ts`, `src/conversations/history.ts`, focused tests. Scope: medium, high risk.

## Future refactoring: 16. Ingestion worker

Excluded from this structural migration by the user’s clarified scope; keep these items for the separate refactoring work.

- [ ] Extract one timer/polling guard with explicit start/stop and current tenant iteration.
- [ ] Finish all currently required persistence steps before batch acknowledgement; thrown failures remain replayable and no-op/stale-event behavior is unchanged.
- [ ] Keep goal/plan ordering and no-subscriber persistence behavior intact.

Verification: `persistence`, `goal-replay`, `plan`, `http`, failure-injection characterization. Dependencies: 14–15. Likely files: `src/service.ts`, `src/runtime/ingestion.ts`, focused tests. Scope: medium, high risk.

## Checkpoint D: Recovery and workers

- [x] Full platform results introduce no new failures/skips and build passes, including concurrent tenant/recovery fixtures.
- [x] Mid-record write failure results in no acknowledgement; replay remains safe.
- [x] No extra worker, transport, context instance or retained conversation cache exists.

## Future refactoring: 17. Session lifecycle, sending and commands

Excluded from this structural migration by the user’s clarified scope; keep these items for the separate refactoring work.

Implement these as distinct sub-slices, one central-facade editor at a time:

- [ ] **17a:** extract client/owned/create/resume/interruption while preserving host selection, owner credentials, approval reconciliation and lifecycle state transitions.
- [ ] **17b:** extract message dispatch and quota handling; preserve validation, authorization, dispatch guard, durable client IDs and pending/accepted/failed/unknown outcomes.
- [ ] **17c:** extract commands/capabilities/helper-agent operations; retain persisted command receipts, method access rules and uncertain side-effect semantics.

Verification: `session-creation`, `send-preparation`, `approval-modes`, `resume-approval`, `runtime-error`, `runtime-transport`, `runtime-resume-transport`, `commands`, `goals`, `safety`, `demo`, `private-access`, `ownership`; compare calls/receipts for duplicates and timeout-after-acceptance. Dependencies: 09, 13–16. Likely files per sub-slice: facade, one/two named runtime/conversation modules and focused tests. Scope: medium per sub-slice, high risk.

## 18. Public projections and stream decoding

- [x] Separate conversation/approval/telemetry/event projections from SSE decoding and relay, one concern per sub-slice.
- [x] Keep one policy constant and unchanged allowlists/fallbacks.
- [x] Unicode/chunk boundaries, malformed events and runtime-private fields retain current behavior.

Verification: `public`, `sync-public`, `runtime-error`, `traces`, `plan`, stream characterization if absent. Dependencies: 08 and 17. Likely files per sub-slice: `src/public.ts`, one/two public/streaming modules, focused tests. Scope: medium per sub-slice, high risk.

## 19. Persistence internals

- [x] Extract unchanged indexes/document types and then plan/event persistence as separate sub-slices.
- [x] Share one Mongo client/cache set and preserve late tenant-aware collection lookup.
- [x] Preserve transactions, unique keys, update filters and write/ack ordering; no migration.

Verification: `persistence`, `tenancy`, `plan`, `goal-replay`, `mcp-scopes`, `agents`, `google`, `admin`. Dependencies: 16 and 18. Likely files per sub-slice: `src/store.ts`, one/two `src/persistence/` modules, focused tests. Scope: medium per sub-slice, high risk.

## Checkpoint E: Stateful extraction complete

- [x] Full platform results introduce no new failures/skips and build passes with equivalent JSON/SSE contracts.
- [x] Call counts/fixture measurements show no extra sequential work; any discrepancy is explained and fixed.
- [x] Facade contains delegation/composition and documented compatibility seams.

## 20. Remaining moves and consumer migration

- [x] Move leaf modules by small identity/tenancy/admin/demo/core cohorts; do not rewrite them.
- [x] Update benchmark/profiler/import consumers and remove temporary single-source shims after tracking every consumer.
- [x] Keep tests flat and prove test/route inventories are complete; preserve compiled output paths.

Verification: tests for each moved feature, build, search for obsolete paths, full platform suite and benchmark import smoke. Dependencies: 09–19. Likely files per cohort: one/two moved modules and explicit consumer batches; high-fan-out mechanical import edits isolated from extraction logic. Scope: small/medium per cohort, mechanical exceptions documented.

## 21. Documentation and final validation

- [x] Write `platform/README.md` with module ownership, create/send/history/SSE flows, test commands and debugging entrypoints; correct stale root README architecture claims.
- [x] Run all service suites, the root build, frontend test/typecheck, format/secrets checks and isolated compiled startup/shutdown verification; record baseline issues and unavailable Docker validation.
- [x] Review final move-aware diff, security/performance/lifecycle risks and code/image rollback; preserve existing observability.

Verification: all commands and acceptance criteria in `tasks/plan.md`; compiled/container smoke includes protected-route refusal and health. Dependencies: 20. Likely files: `platform/README.md`, root `README.md`, implementation validation report and any focused compiled-smoke fixture. Scope: medium.

## Final review checkpoint

- [x] Structural-scope acceptance recorded with evidence; baseline gate failures remain explicit blockers to merge/deployment readiness.
- [x] No API/schema/protocol/auth/retry/timeout/dependency behavior changes are mixed into refactoring.
- [x] No skipped/deleted protections, missing tests or empty compatibility-shell checks.
- [x] Remaining risks and rollout/rollback evidence reviewed before merge.

## Remaining validation outside the completed structural scope

- [ ] Resolve or separately accept the existing demo-provisioning wording assertion failure.
- [ ] Resolve the 42 pre-existing formatting failures; no new formatting failures were introduced.
- [ ] Run Docker build/container smoke when a Docker daemon is available.
- [ ] Perform production rollout/observation if deployment is later requested.
