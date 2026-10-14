# Platform source restructuring plan

Date: 2026-10-14. Status: structural implementation complete; validation results and existing blockers are recorded in `verification-reports/platform-structure.md`.
Scope: `platform/` backend. Frontend, agent-core, model-gateway and shared protocol ownership stay as they are; update consumers only when source imports require it.

The user clarified the implementation scope after approving this plan: structural organization only, with code refactoring and performance fixes handled separately. The implemented source map is in `platform/README.md`. Contained feature operations, routes, public output and persistence blocks were extracted without changing their bodies. Tightly coupled session/history/ingestion orchestration stays in `app/platform-service.ts`; deeper decomposition in the original proposal below is future refactoring work, not an unfinished part of the authorized structural migration.

## Recommendation

Organize the existing platform by feature, extract cohesive responsibilities from the large files, and keep one running platform process. Preserve existing Express registration within NestJS, MongoDB layout, runtime transport and public API. Use small, independently reversible changes. A folder move helps navigation; reducing the responsibilities of `PlatformService` and `main()` is what makes debugging easier.

This is a structural refactor. API changes, permission changes, database migrations, new retry/cache behavior, Nest controller conversion, dependency upgrades and performance redesign are separate work.

## Evidence from the current source

There are 29 top-level source TypeScript files, 10,941 source lines, and 47 top-level `*.test.ts` files.

| File                      | Lines | Current responsibilities                                                                                             |
| ------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------- |
| `platform/src/service.ts` | 2,703 | Agents/models, MCP CRUD, runtime configuration, projects, sessions, sending, recovery, ingestion, commands and goals |
| `platform/src/index.ts`   | 1,118 | Startup, middleware, health, route registration, the full SSE endpoint and shutdown                                  |
| `platform/src/public.ts`  |   922 | Public projections/redaction, event mapping, SSE decoding and relay                                                  |
| `platform/src/google.ts`  |   847 | Google configuration, OIDC and account/workspace admission                                                           |
| `platform/src/admin.ts`   |   702 | Admin authentication, tenant/account operations and routes                                                           |
| `platform/src/auth.ts`    |   659 | Account sessions, token helpers, authorization, CSRF and rate limiting                                               |
| `platform/src/store.ts`   |   628 | Mongo connection, tenant resolution/cache, indexes, collections, plan/event persistence                              |

`http.ts` is 195 lines and already has a coherent purpose. Move it to a meaningful folder; do not fragment every small helper simply to reduce line counts.

Current flow:

```text
index.ts: middleware and route registration
  -> http.ts: fail-closed route wrapper and request/user/tenant context
  -> PlatformService: access checks and orchestration
  -> Store: context-dependent Mongo collections
     RuntimeTransport: HTTP or AWS AgentCore invocation
  -> public.ts: allowlisted output and stream transformations
  -> JSON or SSE response
```

Useful anchors: `service.ts:335` service/state ownership; `service.ts:489` runtime configuration; `service.ts:997` MCP management; `service.ts:1587` projects; `service.ts:1823` message dispatch; `service.ts:2117` history; `service.ts:2213` ingestion; `index.ts:817` SSE; `store.ts:220` context-dependent database selection. These refer to the source inspected on the date above.

The README introduction says authentication and tenancy are absent, while the current implementation contains both. Use live code and tests as the source of truth and correct that introduction during documentation cleanup.

## Original proposal (broader future refactoring included)

The tree names responsibilities, not mandatory classes. Use plain functions for stateless work and a class only where state/lifecycle or cohesive operations justify it. Some entries are new extractions; current leaf modules move with their existing behavior.

```text
platform/
  src/
    index.ts                         # stable executable entry; imports bootstrap
    app/
      bootstrap.ts                   # constructs shared instances and starts HTTP
      platform-service.ts            # compatibility facade over extracted operations
      security.ts                    # ordered auth/middleware assembly
      lifecycle.ts                   # ingestion startup and signal shutdown
      health.routes.ts
    core/
      errors.ts
      request-context.ts             # one request AsyncLocalStorage instance
      features.ts
    http/
      handlers.ts                    # existing route/error/middleware helpers
      metadata.routes.ts             # /me, features and assistant capabilities
    identity/
      auth.ts
      google.ts
      user.ts
      invites.ts
      workspaces.ts
    tenancy/
      tenant.ts
      access.ts
      audit.ts
    admin/
      admin.ts                       # move existing module before considering splits
    agents/
      agents.ts                      # existing validation and built-in agent rules
      catalog.ts                     # agent/model listing and agent CRUD
      routes.ts
    mcp/
      profiles.ts                    # current mcp.ts validation/config helpers
      management.ts                  # user/tenant CRUD and attachment operations
      secrets.ts
      routes.ts
    projects/
      operations.ts
      routes.ts
    conversations/
      sessions.ts                    # create/list/load/access/approval-mode operations
      messages.ts                    # validate, reserve, dispatch, record delivery
      history.ts                     # recovery coordination and reconciliation
      history-read.ts
      history-window.ts
      goals.ts                       # goal ordering, persistence and review
      commands.ts                    # command receipts and capability dispatch
      session-creation.ts            # existing approval helpers
      traces.ts
      read.routes.ts
      write.routes.ts
      documents.routes.ts            # document/visualization proxy endpoints
    runtime/
      client.ts                      # configured owner calls and error translation
      transport.ts                   # existing HTTP/AgentCore transport
      configuration.ts               # agent/model/MCP/skill runtime config
      model-route.ts
      session-runtime.ts             # owned/resume/interrupt and helper agents
      ingestion.ts                   # one worker, record persistence then acknowledgement
    streaming/
      events.route.ts                # complete SSE acquisition-to-cleanup lifecycle
      guards.ts                      # current streams.ts
      event-stream.ts                # PublicEventStream decoding
      relay.ts
    public/
      conversation.ts                # sessions, snapshots, plans, goals, helper agents
      approvals.ts
      telemetry.ts
      events.ts                      # allowlisted event transformation
      policy.ts                      # current POLICY_VERSION constant
    persistence/
      store.ts                       # one Mongo client; context-aware collection facade
      documents.ts                   # existing document definitions
      indexes.ts                     # unchanged index definitions
      plans.ts                       # stored-plan types, ordering and save behavior
      records.ts                     # current event persistence behavior
    demo/
      demo.ts
      quota.ts
  test/                              # keep all 47 discovered test files flat initially
  scripts/                           # profiling/diagnostic entrypoints remain here
```

Keep `shared/` at the repository root: shared contracts/protocol belong to the services together. Do not move platform internals into it. Avoid a miscellaneous `utils/` folder, a new dependency container, a repository class per collection, and blanket barrel exports.

## Boundaries and state ownership

- `app/` wires dependencies; route modules perform HTTP parsing/response handling and call operations. Operations must not import route-registration modules.
- Move `requestContext` and `currentRequestId` from HTTP into a leaf module; the tenant and user context instances remain in their existing owner modules. Re-exports reference the same instance, never a new instance.
- Keep `PlatformService` constructor, exports, method signatures and externally used properties through initial extractions. It delegates to named collaborators rather than retaining business logic. Preserve `quota` and `dispatchGuard` assignments made after construction.
- Existing tests replace `call`, `owned`, `resume`, `configuration`, `capability`, `ingest` and `reconcile`. Where compatibility requires callbacks, use narrow callbacks that read the current facade method at call time. A bound method captured in a constructor can bypass later replacements. Avoid passing the entire facade into every module or creating callback cycles.
- One `Store` owns Mongo connection, tenant cache and index promises. Resolve tenant collections inside the current context when used; never capture a tenant collection once in a singleton constructor.
- Session creation owns `nextHost`. History owns the in-flight recovery map, with its existing tenant/user/role/visibility/runtime/window key. This remains an in-flight coordinator, not a response cache.
- Ingestion owns one timer and one polling guard. Runtime transport owns its existing clients and cleanup. Construction alone must not start background workers.
- Goal update/persistence functions and plan persistence sit below recovery and ingestion. Both can call them; neither should call back into higher-level history orchestration.
- Separate connection/index plumbing from persistence operations without changing collections, schemas, index options, transactions, CAS filters or acknowledgement ordering. `Store` can remain a small compatibility facade; do not add speculative repositories.

## Observable acceptance criteria

1. Existing API paths, methods, status codes, error codes, headers, auth modes and response shapes match baseline fixtures. Timing values may vary; their fields and meanings do not.
2. Every session route retains the same read/write/method-dependent access rule. Unknown admin routes stay behind the admin gate, and missing user/tenant context fails closed.
3. Passive administrative views never resume/reconcile/ingest the owner's runtime, persist stream state or use owner credentials.
4. Duplicate messages and commands preserve existing receipts/delivery states. An uncertain remote timeout remains uncertain; no new retry dispatches work a second time.
5. All currently required persistence steps complete before batch acknowledgement. Thrown write failures leave records replayable; existing no-op/stale-event behavior remains unchanged. Plans and goals retain stale/replay/concurrency guards.
6. SSE events retain redaction, cursor framing, plan/goal behavior and cleanup on disconnect, upstream failure and access revocation.
7. Tenant/user/request contexts remain isolated under concurrent requests. Shared lifecycle components are created and stopped once.
8. Existing test inventory is retained; new tests increase it. The refactor adds no failures/skips, deleted protections or weaker thresholds. Required gates must pass before claiming merge readiness; unresolved baseline failures/skips remain documented blockers.
9. `src/index.ts`, the emitted `dist/platform/src/index.js`, package scripts and Docker startup remain valid. A compiled-entry smoke test complements source-based tests.
10. A developer can follow create, send, history and SSE from an architecture map to named files. Bootstrap contains startup wiring; the facade delegates contained feature operations and preserves existing runtime/history/ingestion orchestration for the later refactoring scope.

## Ordered implementation stages

The task checklist is in `tasks/todo.md`. Each numbered item is a separate reviewable slice; split it further when a responsibility still spans too much code.

### Stage 1: Establish and strengthen the baseline

Record the route inventory, current test discovery, existing checks/failures/skips and representative public outputs. Run baseline tests before moving code. Inspect the current security matrices and add only missing characterization for high-risk behavior.

Migrate the source-scanning guards in `ownership.test.ts:81` and `mcp-scopes-http.test.ts:44` before/as routes move. They currently scan `index.ts` and `service.ts`. Extend discovery across real implementation modules, preserve exact expected route coverage and read/write checks, and fail if discovery is empty/incomplete. Add a negative control proving a route without access enforcement is rejected. Do not point the guard at compatibility stubs. Behavioral unauthorized-route tests remain in place.

### Stage 2: Extract HTTP registration and startup

Move agents, projects, MCP, conversation reads, writes, document proxies and the SSE endpoint one group at a time. Keep each handler body intact initially. Register full existing paths using an explicit HTTP instance and named dependencies. Do not introduce new Router mount prefixes during extraction: changing `req.path` could change session tagging or context behavior in `http.ts`.

Extract SSE as one lifecycle unit. Preserve access revalidation, cancellation, persistence and cleanup together. Keep existing auth/admin/workspace routers and mount order. Then extract bootstrap/security/lifecycle while retaining the same entrypoint and initialization order (`reflect-metadata`, environment loading, app construction, storage connection, workers, listen).

### Stage 3: Extract contained service responsibilities

Start with projects, agent catalog, MCP management and runtime configuration. Keep public facade methods. Reuse current validation in `agents.ts`, `mcp.ts`, `access.ts`, document types and model routing. Preserve configuration read parallelism and existing freshness rules.

Each extraction gets focused tests and a before/after call/response comparison. Review permissions, owner identity and audit failures alongside happy paths.

### Stage 4: Extract stateful and sensitive paths

Extract goal persistence, history/reconciliation and the ingestion worker in dependency order. Then extract session creation/resume, message sending, commands/capabilities and helper-agent operations as separate slices. Preserve existing side-effect order and uncertain outcome handling.

Split public projections/SSE decoding and persistence internals only after their callers have stable boundaries. Keep security redaction and persistence ordering covered throughout.

### Stage 5: Finish folders, validation and documentation

Move remaining leaf modules in small cohorts. Use temporary single-source re-export shims for imports with large fan-out, with a checklist of consumers and a removal task. Never leave two implementations. Migrate benchmark/profiler imports and remove shims once all consumers use the intended paths. Keep test files flat for this refactor; test reorganization can follow separately with verified recursive discovery.

Write `platform/README.md` with the module map, create/send/history/SSE call flows, test commands and failure/ownership notes. Correct the root README architecture description. Run compiled and container startup checks with isolated configuration. Review final diff for behavior changes and unrelated edits.

## Validation plan

From repository root, capture baseline and final results:

```sh
npm --prefix platform test
npm --prefix platform run build
npm run format:check
npm run check:secrets
npm test
npm --prefix frontend test
npm --prefix frontend run typecheck
npm run build
docker build -f platform/Dockerfile -t truex-platform:restructure .
```

There is no platform lint script or separately configured platform typecheck script. `platform run build` invokes strict TypeScript compilation of source; it excludes tests. Do not invent or claim nonexistent gates. Root `npm test` omits frontend tests, hence the explicit frontend command.

Run focused tests from `platform/` using:

```sh
node node_modules/tsx/dist/cli.mjs --test test/<name>.test.ts
```

Use existing suites named in the task checklist, then the full platform suite after each significant extraction. Capture skipped cases explicitly: the runtime suite can skip when the pinned binary is missing, which does not satisfy runtime release validation. Mongo-backed tests use isolated test processes/databases; auth transaction tests need the replica-set harness.

Before final merge, validate the emitted entrypoint and container start with isolated Mongo and a fake core, exercise `/livez`, `/healthz`, a protected route and shutdown. A Docker build alone does not prove startup. Keep dev/source startup coverage too.

For send/history/SSE extraction, compare upstream call counts, Mongo operation counts where practical, event output and cleanup against the baseline fixture. Reuse `scripts/benchmark-chat-history.mjs` after verifying its options and isolated configuration. This is regression evidence, not a production scalability certification.

If formatting or a baseline check already fails, record the original failure and ensure the refactor adds none. Existing failures/skips remain blockers to a readiness claim until resolved or explicitly accepted; documenting them does not waive a required gate. Do not weaken or broadly autoformat unrelated source to hide it. This statement described the planning turn; implementation results are now recorded in `verification-reports/platform-structure.md`.

## Adversarial review and rollback

| Risk                                                            | Priority | Concrete guard                                                                                                                                                               |
| --------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth middleware moved after an API handler                      | Critical | Preserve ordered mounts, missing-context fail-closed tests, admin unknown-path tests                                                                                         |
| Cached collection/context selects another tenant's data         | Critical | One ALS instance per context; concurrent two-tenant/two-user fixtures; late collection lookup                                                                                |
| Security scanner discovers zero moved routes                    | High     | Expected route inventory equality, nonempty discovery and a failing negative-control fixture                                                                                 |
| Timeout causes a second message/fork or refunds uncertain quota | High     | Preserve receipts and dispatch order; assert remote call count/delivery/quotas under duplicate and timeout cases                                                             |
| Failed persist acknowledged to runtime                          | High     | Inject a failure in a required persistence step; assert no batch ack and safe replay, preserving no-op/stale-event semantics                                                 |
| Passive view starts runtime or writes owner data                | High     | Assert no resume, reconciliation, ingestion, owner-credential configuration or conversation writes; preserve authorized runtime reads/live streams and required audit events |
| Duplicated worker/transport or leaked stream slot               | High     | Single instance/lifecycle ownership; abort/close/error/revocation cleanup tests                                                                                              |
| Moving tests removes them from execution                        | High     | Keep flat test layout; compare all 47 baseline paths plus added tests                                                                                                        |
| Source tests pass but built artifact cannot start               | High     | Stable compiled entrypoint plus isolated compiled/container smoke                                                                                                            |
| Helpers introduce extra sequential calls or unbounded buffering | Medium   | Preserve current parallel reads, call counts, bounded windows and stream behavior; compare fixture measurements                                                              |

Worst realistic chains to test: lost tenant context -> default database selection -> another user's data; uncertain dispatch -> retry -> duplicated side effect; Mongo write fails -> runtime record acknowledged -> lost transcript. Prioritize these over cosmetic folder preferences.

Revert an individual extraction or deploy the previous platform image to roll back. With no data/schema/protocol changes, no data migration rollback is needed. After deployment, verify health, auth refusals, ingestion failures, delivery states, SSE termination reasons and latency using existing structured logs. Preserve request IDs, tenant/session identifiers and current timing fields without logging secrets.

## Review discipline and parallel work

Keep mechanical moves separate from behavior changes. For large mechanical edits, use a verified script/AST-based transform with a dry-run manifest and review move-aware diffs; do not manually rewrite thousands of lines. Most task slices should touch a few implementation files; high-fan-out import migration is an explicitly mechanical exception and should be isolated.

Only one agent changes the central facade/bootstrap at a time. After contracts and source guards are established, independent leaf moves, characterization tests and documentation can run in parallel. Agents should not concurrently extract clusters from the same `service.ts` or reorder `index.ts`.

Two read-only sub-agents audited module boundaries and refactor safety for this plan. They did not modify code. Static review establishes the plan's grounding; runtime correctness remains to be proved during implementation.

## Decisions for implementation

- First scope is the platform backend; a wider monorepo restructure requires a separate audit.
- Keep current deployment/framework/database and test layout.
- Preserve the facade through initial migration; relocate its canonical implementation to `app/` only after consumers are tracked.
- Treat filenames in the proposed tree as a concrete starting point, refined by each extraction's actual dependencies. Do not create empty folders or unused abstractions to match the diagram.
