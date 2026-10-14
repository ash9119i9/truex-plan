# Platform backend

The platform remains one NestJS process using its Express adapter, MongoDB, the existing HTTP/AWS AgentCore transport, and SSE. Source is organized by responsibility. API routes, permission rules, configuration freshness, persistence ordering and runtime behavior are unchanged by the structural migration.

## Source map

| Directory        | Responsibility                                                                                     | Start here                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `app/`           | Startup, ordered middleware assembly, shutdown and platform orchestration                          | `bootstrap.ts`, `security.ts`, `lifecycle.ts`, `platform-service.ts` |
| `agents/`        | Agent validation, built-in agents, catalog operations and routes                                   | `catalog.ts`, `agents.ts`, `routes.ts`                               |
| `mcp/`           | Connector validation, scoped CRUD/attachments, secrets and routes                                  | `profiles.ts`, `management.ts`, `routes.ts`                          |
| `projects/`      | Project validation, CRUD/session assignment and routes                                             | `operations.ts`, `routes.ts`                                         |
| `conversations/` | Conversation routes, goals, history reading/windows, approval helpers and trace summaries          | `routes.ts`, `documents.routes.ts`, `goals.ts`                       |
| `identity/`      | Authentication, Google sign-in, user context, invitations and workspace entry                      | `auth.ts`, `google.ts`, `user.ts`                                    |
| `tenancy/`       | Tenant context/resolution, access decisions and audit behavior                                     | `tenant.ts`, `access.ts`, `audit.ts`                                 |
| `admin/`         | Admin session and tenant/account management                                                        | `admin.ts`                                                           |
| `runtime/`       | Existing transport, runtime configuration, model routing, upstream errors and helper-agent options | `transport.ts`, `configuration.ts`                                   |
| `persistence/`   | Mongo connection/context-aware collections, document types, indexes and plan/event persistence     | `store.ts`, `plans.ts`, `records.ts`                                 |
| `streaming/`     | Complete SSE endpoint lifecycle, access guards, frame decoder and byte relay                       | `events.route.ts`, `guards.ts`, `event-stream.ts`                    |
| `public/`        | Allowlisted browser-facing projections, approvals, telemetry and events                            | `conversation.ts`, `approvals.ts`, `telemetry.ts`, `events.ts`       |
| `demo/`          | Demo admission and turn quotas                                                                     | `demo.ts`, `quota.ts`                                                |
| `core/`          | Errors, feature settings and one request-context instance                                          | `errors.ts`, `features.ts`, `request-context.ts`                     |
| `http/`          | Fail-closed route wrapper, error/middleware helpers and metadata routes                            | `handlers.ts`, `metadata.routes.ts`                                  |

`src/index.ts` is the stable executable entrypoint. Its compiled path remains `dist/platform/src/index.js`, so package scripts and Docker startup continue to use the same entrypoint. Root `shared/` still owns cross-service contracts and protocol artifacts.

Diagnostic scripts and executable fixtures under `docs/performance/t3-chat/` use the canonical imports. Shared tooling path resolution in `scripts/source-paths.mjs` also preserves probes that target older checkout layouts for comparison.

`PlatformService` preserves its existing constructor, public methods/properties and helper exports. It delegates contained operations to `AgentCatalog`, `ConnectorService`, `ProjectService`, `RuntimeConfiguration` and `GoalService`. The tightly coupled session dispatch, recovery, reconciliation and ingestion orchestration remains together in `app/platform-service.ts`; separating or redesigning that logic belongs to later refactoring work.

## Follow a request

All route modules register full existing paths. They do not add Router mount prefixes. Startup invokes registration functions in the original order.

```text
src/index.ts
  -> app/bootstrap.ts
     -> app/security.ts (ordered authentication/context middleware)
     -> feature route registration
        -> http/handlers.ts: route() creates request/user/tenant contexts
        -> app/platform-service.ts or its feature collaborator
        -> persistence/store.ts and runtime/transport.ts
        -> public projection or streaming response
```

| Flow                | Code path                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create conversation | `conversations/routes.ts` → `PlatformService.create` → `runtime/configuration.ts` → existing runtime call → session persistence                                                                   |
| Send message        | `conversations/routes.ts` → `PlatformService.message` → validation/access/quota → resume/dispatch guard → durable client ID → runtime dispatch → delivery receipt                                 |
| Load history        | `conversations/routes.ts` → `PlatformService.history` → access/passive-view decision → in-flight recovery/reconciliation when allowed → `history-read.ts`/`history-window.ts` → public projection |
| Stream events       | `streaming/events.route.ts` → session access/capacity → existing runtime event stream → access watcher + `event-stream.ts`/`public/events.ts` → SSE → cleanup                                     |
| Manage connectors   | `mcp/routes.ts` → facade → `mcp/management.ts` → scope/access/name validation → tenant-aware Store                                                                                                |

## State and failure ownership

- One Store owns the Mongo client, tenant-reference cache and index promises. Collection getters resolve the tenant when used. Feature collaborators never retain a tenant collection across requests.
- One platform service owns the host-selection counter, in-flight history recovery map, ingestion timer/polling guard, transport, optional quota and dispatch guard. Extracted collaborators do not start workers.
- Tenant, user and request `AsyncLocalStorage` instances each have one defining module. API handlers fail closed if user/tenant context is absent. Admin routing stays ahead of development identity resolution.
- Passive administrative views retain authorized reads/live streams and required audit events, but do not resume/reconcile/ingest or write the owner's conversation state.
- Message and command receipts retain their existing idempotency rules. A remote timeout can mean the operation was accepted; the existing unknown delivery state and quota handling remain intact.
- Ingestion acknowledges a batch only after its required persistence steps complete. Plan/goal ordering and stale-event handling are unchanged.
- Stream close, upstream failure and revocation retain watcher cancellation, upstream abort and capacity release.

For debugging, start at the feature route, then follow the named facade operation. Existing structured logs carry request/session/tenant context; error codes and timing fields retain their current meanings.

## Development and verification

From the repository root:

```sh
npm --prefix platform run dev
npm --prefix platform test
npm --prefix platform run build
npm --prefix platform run test:compiled
```

`test:compiled` launches the emitted JavaScript entrypoint against isolated MongoDB and a fake runtime. It checks health, middleware refusals, create/send, duplicate receipts, persistence and clean shutdown. It does not use the developer's platform `.env` or database. Build first. This smoke check verifies packaging/startup, not live provider capacity or production deployment.

Tests remain flat under `test/`: the existing `test/*.test.ts` discovery includes all 47 original files plus two new source/preservation guard suites. Source guards recursively inspect the real implementation files, preserve the exact session/MCP route inventories and trace access through delegation. Negative controls verify that missing/wrong access checks and empty discovery fail.

The explicit structural verifier compares route/method AST bodies, signatures, forwarding arguments and expanded startup order with an original source snapshot:

```sh
cd platform
node node_modules/tsx/dist/cli.mjs test/verify-structure.ts /path/to/original/platform/src
```

Full repository checks, known baseline failures and remaining deployment validation are recorded in [the structural verification report](../verification-reports/platform-structure.md). The report also records the original Git revision for reproducing that snapshot.

The [combined restructuring report](../verification-reports/combined-restructure-2026-10-14.md) records integration with the agent-core restructuring and subsequent export/dead-code cleanup.

## Change discipline

Keep behavior changes, further runtime/service decomposition and performance fixes separate from this structural migration. Preserve the public API, Mongo layout, context boundaries and operational ordering when doing that later work. The existing service/Store facades and regression suites provide the compatibility boundary.
