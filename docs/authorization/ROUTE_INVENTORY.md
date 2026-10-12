# Authorization surface inventory

Status: requirements inventory, not enforcement evidence. Source-mapped rows are verified by `platform/test/authz-route-coverage.test.ts`. Any new or removed literal Express route fails the check until its mapping is reviewed. Dynamic routes on known routers are rejected. New non-Express transports also require an explicit inventory review.

## HTTP routes

105 platform/runtime routes are mapped, including the new public login descriptor and OIDC start/callback boundaries. `resource` includes bounded list filtering; `admission` includes live checks, ordering and one-use dispatch; `stream` includes bounded revalidation. `capability` resolves the exact allowlisted method to `CAPABILITY_ACTIONS`. Health responses contain no customer content. Other boundaries name identity/bootstrap/blocked/control-plane checks.

| Source/function                                  | Method/path                                            | Required boundary | Actions                                          |
| ------------------------------------------------ | ------------------------------------------------------ | ----------------- | ------------------------------------------------ |
| `platform/src/admin.ts:adminAuthRoutes`          | POST `/auth/admin/login`                               | operator-login    | Boundary-specific                                |
| `platform/src/admin.ts:adminAuthRoutes`          | POST `/auth/admin/logout`                              | operator-session  | Boundary-specific                                |
| `platform/src/admin.ts:adminAuthRoutes`          | GET `/auth/admin/me`                                   | operator-session  | Boundary-specific                                |
| `platform/src/admin.ts:adminApiRoutes`           | GET `/api/admin/demo`                                  | control-plane     | `platform.security.manage`                       |
| `platform/src/admin.ts:adminApiRoutes`           | GET `/api/admin/tenants`                               | control-plane     | `platform.tenants.read`                          |
| `platform/src/admin.ts:adminApiRoutes`           | POST `/api/admin/tenants`                              | control-plane     | `platform.tenants.create`                        |
| `platform/src/admin.ts:adminApiRoutes`           | PATCH `/api/admin/tenants/:id`                         | control-plane     | `platform.tenants.manage`                        |
| `platform/src/admin.ts:adminApiRoutes`           | GET `/api/admin/tenants/:id/invites`                   | control-plane     | `platform.invites.manage`                        |
| `platform/src/admin.ts:adminApiRoutes`           | POST `/api/admin/tenants/:id/invites`                  | control-plane     | `platform.invites.manage`                        |
| `platform/src/admin.ts:adminApiRoutes`           | POST `/api/admin/tenants/:id/invites/:inviteId/resend` | control-plane     | `platform.invites.manage`                        |
| `platform/src/admin.ts:adminApiRoutes`           | DELETE `/api/admin/tenants/:id/invites/:inviteId`      | control-plane     | `platform.invites.manage`                        |
| `platform/src/admin.ts:adminApiRoutes`           | GET `/api/admin/tenants/:id/members`                   | control-plane     | `platform.members.manage`                        |
| `platform/src/admin.ts:adminApiRoutes`           | PATCH `/api/admin/tenants/:id/members/:userId`         | control-plane     | `platform.members.manage`                        |
| `platform/src/admin.ts:adminApiRoutes`           | DELETE `/api/admin/tenants/:id/members/:userId`        | control-plane     | `platform.members.manage`                        |
| `platform/src/auth.ts:authRoutes`                | POST `/auth/logout`                                    | account           | Boundary-specific                                |
| `platform/src/auth.ts:authRoutes`                | GET `/auth/tenants`                                    | account           | Boundary-specific                                |
| `platform/src/auth.ts:authRoutes`                | POST `/auth/switch-tenant`                             | account           | Boundary-specific                                |
| `platform/src/google.ts:googleRoutes`            | GET `/auth/google/start`                               | oidc-flow         | Boundary-specific                                |
| `platform/src/google.ts:googleRoutes`            | GET `/auth/google/callback`                            | oidc-flow         | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/livez`                                           | health            | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/healthz`                                         | health            | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/api/me`                                          | account           | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/api/agents`                                      | resource          | `agent.read`                                     |
| `platform/src/index.ts:main`                     | POST `/api/agents`                                     | resource          | `agent.create`                                   |
| `platform/src/index.ts:main`                     | GET `/api/models`                                      | resource          | `model.read`                                     |
| `platform/src/index.ts:main`                     | GET `/api/features`                                    | account           | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/api/assistant-capabilities`                      | account           | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/documents`                      | resource          | `document.read`                                  |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/documents`                     | admission         | `document.upload`                                |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/documents/:fileId`              | resource          | `document.download`                              |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/visualizations/:fileId`         | resource          | `document.read`                                  |
| `platform/src/index.ts:main`                     | GET `/api/agents/:id/mcp`                              | resource          | `agent.read`, `connector.read`                   |
| `platform/src/index.ts:main`                     | POST `/api/agents/:id/mcp`                             | resource          | `agent.update`, `connector.attach`               |
| `platform/src/index.ts:main`                     | GET `/api/mcp`                                         | resource          | `connector.read`                                 |
| `platform/src/index.ts:main`                     | POST `/api/mcp`                                        | resource          | `connector.create`                               |
| `platform/src/index.ts:main`                     | PATCH `/api/mcp/:id`                                   | resource          | `connector.update`                               |
| `platform/src/index.ts:main`                     | DELETE `/api/mcp/:id`                                  | resource          | `connector.delete`                               |
| `platform/src/index.ts:main`                     | GET `/api/tenant/mcp`                                  | resource          | `connector.read`                                 |
| `platform/src/index.ts:main`                     | POST `/api/tenant/mcp`                                 | resource          | `connector.create`                               |
| `platform/src/index.ts:main`                     | PATCH `/api/tenant/mcp/:id`                            | resource          | `connector.update`                               |
| `platform/src/index.ts:main`                     | DELETE `/api/tenant/mcp/:id`                           | resource          | `connector.delete`                               |
| `platform/src/index.ts:main`                     | GET `/api/agents/:id/tenant-mcp`                       | resource          | `agent.read`, `connector.read`                   |
| `platform/src/index.ts:main`                     | POST `/api/agents/:id/tenant-mcp`                      | resource          | `agent.update`, `connector.attach`               |
| `platform/src/index.ts:main`                     | GET `/api/capabilities`                                | blocked           | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/api/schemas/:name`                               | blocked           | Boundary-specific                                |
| `platform/src/index.ts:main`                     | POST `/api/sessions`                                   | admission         | `conversation.create`, `agent.use`, `model.use`  |
| `platform/src/index.ts:main`                     | GET `/api/sessions`                                    | resource          | `conversation.read`                              |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/project`                       | resource          | `conversation.settings.manage`, `project.update` |
| `platform/src/index.ts:main`                     | GET `/api/projects`                                    | resource          | `project.read`                                   |
| `platform/src/index.ts:main`                     | POST `/api/projects`                                   | resource          | `project.create`                                 |
| `platform/src/index.ts:main`                     | POST `/api/projects/:id`                               | resource          | `project.update`                                 |
| `platform/src/index.ts:main`                     | POST `/api/projects/:id/delete`                        | resource          | `project.delete`                                 |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id`                                | resource          | `conversation.read`                              |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/messages`                      | admission         | `conversation.send`                              |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/agents`                         | resource          | `conversation.read`                              |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/agents/:agentId`                | resource          | `conversation.read`                              |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/agents/:agentId/interrupt`     | admission         | `conversation.interrupt`                         |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/interrupt`                     | admission         | `conversation.interrupt`                         |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/approvals/:requestId`          | admission         | `conversation.approve`                           |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/approval-mode`                 | admission         | `conversation.approval_mode.manage`              |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/capabilities`                  | capability        | Boundary-specific                                |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/goal/history`                   | resource          | `conversation.goal.read`                         |
| `platform/src/index.ts:main`                     | POST `/api/sessions/:id/goal/review`                   | admission         | `conversation.goal.review`                       |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/timings`                        | resource          | `conversation.trace.read`                        |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/traces`                         | resource          | `conversation.trace.read`                        |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/turns/:turnId/context`          | resource          | `conversation.trace.read`                        |
| `platform/src/index.ts:main`                     | GET `/api/sessions/:id/events`                         | stream            | `conversation.read`                              |
| `platform/src/invites.ts:inviteLookupRoutes`     | GET `/auth/invites/:token`                             | invite-token      | Boundary-specific                                |
| `platform/src/workspaces.ts:workspaceRoutes`     | GET `/auth/account`                                    | account           | Boundary-specific                                |
| `platform/src/workspaces.ts:workspaceRoutes`     | POST `/auth/workspaces`                                | blocked           | Boundary-specific                                |
| `platform/src/workspaces.ts:workspaceRoutes`     | GET `/auth/workspaces/:id/invites`                     | resource          | `organization.members.manage`                    |
| `platform/src/workspaces.ts:workspaceRoutes`     | POST `/auth/workspaces/:id/invites`                    | resource          | `organization.members.manage`                    |
| `platform/src/workspaces.ts:workspaceRoutes`     | POST `/auth/workspaces/:id/invites/:inviteId/resend`   | resource          | `organization.members.manage`                    |
| `platform/src/workspaces.ts:workspaceRoutes`     | DELETE `/auth/workspaces/:id/invites/:inviteId`        | resource          | `organization.members.manage`                    |
| `agent-core/src/agentcore.ts:createAgentCoreApp` | GET `/ping`                                            | health            | Boundary-specific                                |
| `agent-core/src/agentcore.ts:createAgentCoreApp` | POST `/invocations`                                    | invocation        | Boundary-specific                                |
| `agent-core/src/index.ts:module`                 | GET `/livez`                                           | health            | Boundary-specific                                |
| `agent-core/src/index.ts:module`                 | GET `/healthz`                                         | health            | Boundary-specific                                |
| `agent-core/src/index.ts:module`                 | GET `/capabilities`                                    | workload-metadata | Boundary-specific                                |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/documents`                           | resource          | `document.read`                                  |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/documents`                          | admission         | `document.upload`                                |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/visualizations/:fileId`              | resource          | `document.read`                                  |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/documents/:fileId`                   | resource          | `document.download`                              |
| `agent-core/src/index.ts:module`                 | GET `/schemas/:name`                                   | workload-metadata | Boundary-specific                                |
| `agent-core/src/index.ts:module`                 | POST `/threads`                                        | admission         | `conversation.create`                            |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/resume`                             | admission         | `conversation.resume`                            |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/approval-mode`                      | admission         | `conversation.approval_mode.manage`              |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/turns`                              | admission         | `conversation.send`                              |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/steer`                              | admission         | `conversation.send`                              |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/interrupt`                          | admission         | `conversation.interrupt`                         |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/events`                              | stream            | `conversation.read`                              |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/snapshot`                            | resource          | `conversation.read`                              |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/records`                             | worker            | `worker.records.read`                            |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/records/ack`                        | worker            | `worker.records.ack`                             |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/approvals/:requestId`               | admission         | `conversation.approve`                           |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/items`                               | resource          | `conversation.read`                              |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/turns/:turnId/context`               | resource          | `conversation.trace.read`                        |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/agents`                              | resource          | `conversation.read`                              |
| `agent-core/src/index.ts:module`                 | GET `/threads/:id/agents/:agentId`                     | resource          | `conversation.read`                              |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/agents/:agentId/interrupt`          | admission         | `conversation.interrupt`                         |
| `agent-core/src/index.ts:module`                 | POST `/threads/:id/capabilities`                       | capability        | Boundary-specific                                |
| `agent-core/src/index.ts:module`                 | DELETE `/threads/:id`                                  | admission         | `conversation.delete`                            |

## Non-Express and dynamic surfaces

| Source                                      | Surface                                                   | Required authority                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `model-gateway/src/server.ts`               | GET `/health`, GET `/ready`                               | Minimal health/readiness; no credentials or tenant content                                                                       |
| `model-gateway/src/server.ts`               | POST `/p/:profileId/v1/responses`                         | Gateway workload identity, model.use, live delegated grant, approved tenant model/profile mapping and bounded streaming rechecks |
| `agent-core/src/agentcore.ts`               | POST `/invocations`, decoded operation envelope           | IAM authenticates transport; verified operation grant additionally binds tenant/conversation/thread/action/generation/digest     |
| `shared/business-capabilities.ts`           | Eight allowlisted thread capabilities                     | Exact `CAPABILITY_ACTIONS` mapping; no arbitrary host capabilities                                                               |
| `platform/src/service.ts:command`           | Conversation commands/help                                | Authorize the backing method; help reads only permitted metadata; no arbitrary RPC                                               |
| `agent-core/src/adaptive-mcp-gateway-v2.ts` | initialize/ping, tools/list, tools/call, cancellation     | Authenticate gateway, bind real execution grant, authorize discovery before serialization and each invocation before dispatch    |
| `agent-core/src/omni-mcp-gateway.ts`        | Same MCP JSON-RPC transport                               | Same protected broker path; no separate credential-bearing bypass                                                                |
| `agent-core/src/mcp-transport-v2.ts`        | Remote initialize/tools/list/tools/call and notifications | Protected connector broker holds credentials and enforces tenant/connector/tool/grant boundaries                                 |
| `agent-core/src/workspace-tools.ts`         | File read/write/download, visualization helpers           | Conversation/document authority, storage namespace containment and path validation                                               |
| `agent-core/src/script-runner.ts`           | Script subprocess and nested connector/file calls         | Restricted execution and egress; broker enforcement survives arbitrary script arguments                                          |
| `agent-core/src/business-runtime.ts`        | Direct runtime RPC, helpers, goals, fork/resume/subagents | Same tenant/resource/grant boundary for direct/native/adaptive/omni modes                                                        |

## Background and operator entries

| Source/entry                                                               | Purpose                                      | Required authority                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `platform/src/service.ts:poll`, `ingest`, `reconcile`                      | Persist/ack records of accepted runtime work | Explicit ingestion workload and tenant; cannot borrow a customer identity or start arbitrary execution                             |
| `platform/src/service.ts:interruptRecent`, `admin.ts:stopRunningTurns`     | Revocation/tenant shutdown cleanup           | Scoped cleanup job, durable outbox/retry/idempotency; removed browser credentials are not required to finish cleanup               |
| `agent-core/src/workspace-sweeper.ts`                                      | Storage cleanup                              | Workload scope, namespace/path containment; never authorize reads by missing user                                                  |
| `scripts/tenant.mjs`, `admin.mjs`                                          | Operator provisioning/password maintenance   | Named operator execution and explicit environment/target; production identity/policy mutations need new audited contracts          |
| `scripts/migrate-tenancy.mjs`, `migrate-mcp-scopes.mjs`, `purge-chats.mjs` | Legacy data operations                       | Explicit operator scope, dry run/confirmation where already implemented, preserve tenant/resource containment and migration safety |
| New policy projector/reconciler/SCIM/cleanup workers                       | Policy/lifecycle work                        | Workload-specific ceiling, stable event IDs, tenant routing and mandatory audit/outbox                                             |

## Review constraints

Inventory is necessary but does not prove a route is guarded. A08/A10/A15/A16 must add enforcement tests, including direct service calls and downstream bypass attempts. Receiver renaming does not hide a literal route from the scanner; manual Node HTTP/JSON-RPC routing requires transport-specific coverage as its enforcement is added.
