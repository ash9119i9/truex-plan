# Enterprise authorization plan for Truex

Status: proposed architecture and implementation backlog, 2026-10-08. Three independent reviewers examined identity/integration points, permission architecture, and adversarial failures. This replaces the earlier small-team-only plan. No application behavior, package dependency, identity-provider account, or deployment configuration has been changed.

The user confirmed **shared SaaS with strict tenant isolation**. Enterprise SSO, JWT API access, groups, resource permissions, service accounts, delegated agents, and auditable revocation are now in scope. Private conversations remain the default. Enterprise customers must not depend on implicit administrator access or a shared POC identity.

## 1. Decision and recommended stack

Build one authorization decision path used by the platform, resource lists, runtime admission, model gateway, and protected tool execution. Use a mature identity provider/broker and relationship-based authorization engine; do not implement a custom OAuth server, token cryptography, or general-purpose policy language.

| Responsibility | Recommendation | Decision status |
| --- | --- | --- |
| API access-token verification | `jose`, with trusted issuer/JWKS configuration and strict token-purpose validation | Recommended new dependency; compatibility test before pinning |
| Browser OIDC login | Existing `openid-client`, generalized beyond Gmail; backend-managed sessions | Reuse existing dependency |
| Enterprise federation and provisioning | Managed identity broker supporting customer OIDC/SAML, MFA evidence, OAuth API audiences/client credentials, and SCIM/directory lifecycle | Buy rather than implement federation; Auth0 Organizations and WorkOS are shortlist candidates, not selected vendors |
| Relationship permissions | OpenFGA with `@openfga/sdk`, behind a single application authorization interface | Preferred engine candidate; production selection requires consistency/list/load/outage POC |
| Alternative engine | SpiceDB if its revision-token consistency model better satisfies measured requirements | Evaluate the same acceptance scenarios; do not deploy both engines |
| Permission mutation source of truth | Versioned records, deny fences, audit and durable outbox in the Mongo control plane | New design; production replica-set transactions are a prerequisite |
| Policy persistence | Dedicated durable policy datastore; PostgreSQL is the baseline for an OpenFGA pilot | New dependency/service; keep separate from application Mongo |
| External connector execution | Protected tool/credential broker holding downstream credentials and checking delegated grants | New enforced boundary, not merely a prompt or SDK wrapper |

`jose` supports JWT claim/signature validation and remote JWKS; `openid-client` supplies OAuth/OIDC client flows. Sources: [jose](https://github.com/panva/jose), [openid-client](https://github.com/panva/openid-client). The repository compiles platform and agent-core as CommonJS; verify current package exports, Node runtime and compiled production loading in the first slice rather than assuming an ESM import works everywhere.

OpenFGA supplies a Node SDK and supports relationship modeling and custom roles. Sources: [SDK setup](https://openfga.dev/docs/getting-started/setup-sdk-client), [custom roles](https://openfga.dev/docs/modeling/custom-roles). The engine is a running service, not an npm-only permissions library. The application still owns tenant containment, lifecycle status, execution limits, and approval requirements. Do not add a second generic policy engine such as OPA alongside it initially; add one only if a concrete contextual-policy requirement cannot be safely expressed in the chosen model and bounded application invariants.

Identity-provider selection must verify SSO/SCIM correctness, API token issuance, service accounts, tenant-domain enforcement, regional processing, key rotation, event guarantees, availability, export/migration, support and pricing at projected usage. WorkOS SSO/Directory Sync alone must not be assumed to be an OAuth API authorization server. See [Auth0 Organizations](https://auth0.com/docs/manage-users/organizations), [WorkOS SSO](https://workos.com/docs/sso), and [Directory Sync](https://workos.com/docs/directory-sync).

## 2. Existing system and confirmed gaps

Current request flow in Google mode is cookie session → active user → active membership → tenant database → owner/MCP checks → runtime. That is useful groundwork, but it is not the enterprise target.

| Existing code | Verified behavior / enterprise gap |
| --- | --- |
| `platform/src/auth.ts`, `user.ts`, `index.ts` | Cookie authentication and fresh memberships exist. No API JWT verifier. Only `user` and `admin` roles; missing user context means privileged internal access in `access.ts`. |
| `platform/Dockerfile`, `user.ts` | Image explicitly defaults to shared POC identity. Production enterprise environments must reject POC/dev identity modes and override headers. |
| `platform/src/google.ts:259`, `invites.ts:228` | Sign-in and invitations are Gmail-only; Workspace accounts are rejected. Enterprise federation requires changes to both. |
| `platform/src/auth.ts:81`, `store.ts:214` | User identity is keyed by Google subject. Email normalization removes dots/+tags even outside Gmail; do not extend this rule to corporate identity matching. |
| `frontend/app/auth/[...path]/route.ts`, `frontend/lib/api.ts`, `transport.ts` | `/auth` forwarding exists, `/api` forwarding does not. Direct cross-origin API fetch/EventSource do not opt into credential inclusion. Browser BFF integration is unfinished. |
| `platform/src/store.ts`, `tenant.ts` | Each tenant has its own Mongo database; models/skills are shared catalog entries. Missing tenant context falls back to the default database. |
| `platform/src/access.ts` | Owner-only writes; admins read all; missing visibility defaults to shared reads. New enterprise policy must remove blanket admin reads and enforce explicit privacy. |
| `shared/contracts.ts` Project, `service.ts` project methods | Existing projects are personal conversation folders, not shared enterprise workspaces. Do not silently turn them into IAM boundaries. |
| `platform/src/index.ts:236`, `service.ts:695` | Any tenant member may create agents under the alpha policy. No per-agent grant model exists. |
| `platform/src/index.ts:680` | SSE checks access when opened, without ongoing membership/session policy checks. |
| `shared/gateway-token.ts`, `model-gateway/src/server.ts:130` | Gateway tokens intentionally never expire; tenant is log metadata and grants are profile-scoped, not person/tenant policy-scoped. |
| `platform/src/mcp.ts:172`, `service.ts:512` | MCP credentials are decrypted into runtime configuration. A broker cannot enforce policy while the runtime can bypass it using raw credentials. |
| `platform/src/runtime-transport.ts`, `agent-core/src/index.ts`, `manager.ts:670` | Direct HTTP has no service authentication; thread tenant checks are incomplete/optional. Bedrock transport uses AWS IAM, which authenticates invocation but not the person's resource authority. Network exposure is deployment-dependent. |
| `platform/src/admin.ts:119`, `:460` | Shared admin identity is not individually attributable. Member removal can fail after disabling membership; retry then returns 404 before cleanup converges. |
| `platform/src/service.ts:1801` | History recovery sharing keys include user/role/visibility, not new permission/lifecycle revisions. Revocation must cover these caches too. |

No live deployment exposure is inferred from these code findings.

## 3. Identity, API tokens and browser sessions

### Browser

Use enterprise OIDC authorization-code login with PKCE, state and nonce through a vetted broker. The broker can federate to customer Entra ID, Okta or another supported OIDC/SAML provider. Keep tokens server-side and issue an opaque `HttpOnly`, `Secure`, appropriately `SameSite` browser session cookie. Complete same-origin `/api` forwarding, preserve cookie/Origin/SSE/abort/cache behavior, and keep platform administration isolated from the main-app forwarder. Retain CSRF protections for cookie-authenticated mutations. Do not store refresh tokens in browser localStorage.

### Public/API clients

Support OAuth JWT access tokens in `Authorization: Bearer <access_token>`. Human clients use authorization-code + PKCE; machine clients use client credentials with a registered service principal, preferably asymmetric client authentication when supported. Do not build a password grant. Broker/API issuer trust is administrator-configured, preferably one broker issuer per deployment region rather than accepting arbitrary raw customer issuers.

Before any resource lookup:

1. Bound input size and parse one supported authentication mechanism.
2. If a bearer credential is presented but invalid, fail; never fall back to a cookie. Reject ambiguous credentials with conflicting identities.
3. Verify signature, configured algorithm, issuer, API audience, token purpose, required expiry, not-before and bounded clock tolerance. Reject ID tokens, runtime/gateway tokens and unrelated API tokens.
4. Use only administrator-approved HTTPS JWKS endpoints. Never fetch URLs supplied in token `jku`, `x5u`, issuer or tenant claims.
5. Map verified issuer/subject or registered OAuth client to an internal immutable principal. Treat tenant hints as routing hints until live membership/client binding is verified.
6. Load current principal status, tenant membership/service binding and lifecycle generation. Token scopes cap possible actions; token role/group claims do not bypass current permissions.
7. Resolve the tenant and invoke the same authorization path used by cookie callers.

Target access-token lifetime is five minutes, subject to provider contract and testing. Expiry is not the revocation mechanism. Refresh-token rotation/reuse detection, session rotation, logout and emergency issuer/key disabling belong in the identity lifecycle. An RFC 9068 provider should follow its access-token profile; other issuers need a documented equivalent contract. Sources: [JWT best practices, RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), [JWT OAuth access-token profile, RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html), [OAuth security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

Cache JWKS by trusted issuer/connection, coalesce/rate-limit refreshes and bound key freshness. An unknown key during failed refresh denies. Cached valid keys may work only within the configured freshness limit; failures never extend it. Emergency key/issuer disablement must pass a live deny fence. Cryptographic verification alone must not leave a disabled principal active.

CSRF exemption applies only to a successfully authenticated bearer path, never merely the presence of an Authorization header. CORS is not authorization.

## 4. Shared-SaaS tenant boundary

Use the existing tenant as the organization/security boundary initially. A person may belong to several tenants, but principal membership, groups, role bindings, credentials, resources, grants and audit views are tenant-scoped. No domain auto-join or email-only account linking.

Retain per-tenant Mongo databases initially. Every protected resource query requires an explicit verified tenant; remove default-database fallback from enterprise paths. Shared model/skill catalog visibility remains filtered by tenant policy. Provider credentials stay in trusted services, never catalog responses.

For the initial OpenFGA pilot, prefer **one authorization store per tenant on shared regional infrastructure**, selected from a server-controlled tenant registry. Benchmark store cardinality and model migration at projected tenant count before selecting this for production; managed service limits may affect feasibility. Clients must never select store IDs/model IDs. Tenant-scoped identifiers and relation-write containment checks remain mandatory even with separate stores. If a shared-cell store is proposed later, require a separate decision and adversarial proof that every modeled path remains inside its tenant; do not assume namespaced strings alone establish isolation.

Use bounded regional SaaS cells to limit operational blast radius as traffic warrants it. The region/cell mapping covers Mongo, policy stores, runtime storage, secrets and audit. Do not silently spill to another region on failover. Data-residency and recovery commitments need explicit customer agreements and tested regional recovery.

Runtime folders are not a sufficient hostile-tenant isolation boundary. Bind each execution to its tenant/conversation and use an isolated runtime/session and least-privilege filesystem/network access; verify the actual Bedrock/local execution isolation guarantees. Tenant A must not read tenant B's artifacts, cached history, ingestion records, model/tool credentials or search metadata. Authenticate every runtime operation and require tenant/resource claims, including events, documents, approvals, resume and helper-agent endpoints.

Apply per-tenant/client quotas and fair concurrency limits at API, policy queries, model gateway and tool dispatch. A tenant's large group graph or list query must not starve other tenants.

## 5. Permission model and product rules

Use **roles for permission bundles, relationships for resource access, and a small set of contextual constraints**. Authorization requires all relevant gates:

```text
active verified principal and tenant
  AND token/client scope allows the action
  AND role/resource relationship allows it
  AND principal/resource/grant lifecycle is current
  AND tenant model/tool/security policy allows it
  AND credential identity and business scope allow it
  AND required consent / step-up / separation of duties is satisfied
```

### Proposed records (not existing schemas)

- External identity connection and identity binding: trusted connection/issuer/subject → internal principal. Preserve current user IDs while backfilling Google identity bindings.
- Principal: human or service account; explicit runtime/worker workload identities. Never use absent identity as superuser.
- Organization membership: status and lifecycle generation, independent of fine-grained roles.
- Group and group membership: tenant-scoped, with controlled directory mapping.
- Workspace: explicit shared boundary for approved agents/connectors/projects. Existing personal folders remain personal.
- Role definition and role binding: versioned permission bundle assigned to person/group/service at organization, workspace or resource scope.
- Resource grant: owner/reader/operator/manager relationship plus resource generation and lifecycle.
- Execution grant: initiator, effective principal, workload/delegation chain, tenant, conversation, permitted actions/resources/connectors/models, generation, policy revision, expiry and revocation state.
- Emergency access grant: named requester/independent approver, reason, resource scope, step-up evidence, expiry and cancellation.
- Policy mutation/audit/outbox: durable publication state and reconciliation evidence.

All caller-provided context is untrusted. Proposed schemas need typed validation, unique scoped indexes, bounded group depth/fan-out and rejection of cycles/invalid cross-tenant edges.

### Initial built-in roles

| Role | Intended authority | Excluded implicit authority |
| --- | --- | --- |
| Organization owner | Ownership, administrative delegation, organization security lifecycle | Private content, another person's credentials, bypassing dual approval |
| Organization admin | Membership/group/approved role administration and organization configuration | Private content, platform-admin powers, assigning ungrantable permissions |
| Workspace manager | Manage designated workspace resources and permitted bindings | Other workspaces, private conversations |
| Agent builder | Create/edit/publish permitted agent definitions in assigned scope | Unapproved connectors/models or unrestricted execution |
| Member/operator | Use permitted agents/connectors and manage own conversations | Shared-agent administration, other owners' tool approvals |
| Auditor | View approved audit evidence/configuration in assigned scope | Private transcripts, tokens, credential material, external writes |

Custom roles select from a fixed typed action catalog; they cannot invent policy scripts, arbitrary relation names, platform-admin powers or emergency-content grants. Restrict role assignment to an explicit grantable-permission ceiling; role editing must not turn a previously harmless binding into privilege escalation. Security-sensitive changes may require independent approval. Protect the last organization owner atomically; SCIM cannot assign this role automatically.

For private content, action capability and content relationship are separate required gates: putting `conversation.read` in a role never grants every conversation at that role's organization/workspace scope. The person also needs ownership, an explicit valid share, or a governed emergency grant. Encode this conjunction in the real engine model and test custom-role assignments that attempt to bypass it.

Example action catalog (proposed contract): `organization.members.manage`, `organization.roles.manage`, `workspace.manage`, `agent.read`, `agent.create`, `agent.update`, `agent.publish`, `conversation.read`, `conversation.send`, `conversation.share`, `document.read`, `connector.use`, `connector.manage`, `tool.invoke`, `audit.read`, `support.request_access`. Define distinct actions for approvals, exports, deletion and sensitive execution rather than one generic `write` for everything. `/api/me` may expose evaluated capabilities for UI convenience; the backend remains authoritative.

### Content privacy and sharing

Conversations and personal folders are private by default, including inside a shared workspace. Administrative membership must not grant content access. Permit explicit read-only sharing to current tenant members/groups after permission checks. Shared workspace membership alone does not expose every conversation.

Initial sharing does not grant send/approve/upload/change rights in another person's conversation. Current execution loads the owner's personal connector credentials; collaborative execution must be a later explicit actor-and-credential design. No cross-tenant conversation sharing in the initial release.

Platform support/control-plane administration uses named identities, MFA and separate roles. Customer-content access requires independent approval and a resource-bounded emergency grant, initially at most 15 minutes. Audit must be durable before access; self-approval and grant replay deny. Emergency reading never permits execution with the customer's credentials. Customer-authorized export/discovery can be a separate governed workflow; it is not a hidden admin read-all flag.

## 6. Central authorization interface and policy publication

Introduce one typed application interface for single checks, bounded bulk checks, authorized list/search planning, explainable denial, and policy mutation. Proposed modules are an authorization/principal layer plus a policy-engine adapter; exact filenames are implementation decisions. Service methods enforce guards before persistence or upstream calls. HTTP guards are additional protection, not the sole control.

The relationship engine evaluates owners, groups, role bindings and explicit shares. Application invariants enforce tenant/resource matching, current lifecycle, credential identity, token scope, execution grants, step-up and consent. Avoid duplicating engine permissions in scattered role-name comparisons.

Pin an immutable policy model version per active rollout; never silently use the latest model. Schema/tuple migrations must work while old and new app instances overlap. See [immutable OpenFGA models](https://openfga.dev/docs/getting-started/immutable-models).

### Mongo and policy service are not one transaction

Treat Mongo control-plane mutation records as authoritative desired policy; the engine is a projection used for decisions. Require replica-set transactions for mutation, version update, audit and outbox persistence. If the deployment cannot support this, the release is blocked until a tested durable equivalent is designed; do not emit an event after an unprotected write and call it atomic.

- **Grant/create:** record the desired grant/resource as pending; publish idempotently with stable event IDs; activate only after policy acknowledgement and confirmed consistency. Pending publication does not allow access.
- **Revoke/delete:** commit an authoritative deny fence/lifecycle or policy revision first; invalidate execution admission and stream caches; asynchronously remove relationships/credentials and reconcile. Remains denied while cleanup retries.
- **Group/role change:** initially use a conservative tenant policy fence while projecting the affected revision. This may temporarily deny tenant operations rather than permit stale access. Optimize to narrower fences only after proof and measurement.
- **Recovery:** reconcile desired and projected state after process death, duplicate delivery, restore, or partial writes. Never reuse resource/principal generation IDs, and never reactivate old grants during reinvitation.

Publication must be monotonic, not just deduplicated. Initially serialize projection per tenant with durable ownership/fencing and compare-and-set activation of the exact desired revision and model. An acknowledgement for revision N cannot activate policy or clear a fence when N+1 is current. A late tuple write is a separate risk: the POC must prove revision/generation-isolated projection or an equivalent engine-supported ordering mechanism so an old write cannot modify the policy queried by active decisions. Do not assume OpenFGA tuple writes expose an application-level compare-and-set. Ambiguous projection writes keep the fence set until safe reconciliation; a worker lease alone does not fence an already-submitted external write. Test grant N → revoke N+1 → delayed grant/write/ack N. If the ordering guarantee cannot be demonstrated without unacceptable cost, change the projection design or engine before rollout.

Use high-consistency policy checks and authoritative fence reads for the first protected implementation. OpenFGA's `HIGHER_CONSISTENCY` bypasses its cache; it is not a SpiceDB revision token or a cross-database transaction. The exact database topology and API behavior must be tested. SpiceDB offers revision tokens and `at_least_as_fresh`; if selected, persist the relevant token and propagate it to dependent checks. Sources: [OpenFGA consistency](https://openfga.dev/docs/interacting/consistency), [SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency).

Policy/network failure returns an actionable unavailable error and denies protected work. There is no fallback to POC, admin read-all, undefined-user privilege, or stale positive permissions. Bound timeouts and retries; retrying a permission check is different from replaying a business mutation.

### Lists, search, artifacts and caches

List/get/count/export/download/search/SSE must agree on permissions. For small datasets, use engine-authorized IDs intersected with tenant-scoped Mongo filters. For large search pages, query a bounded tenant-scoped candidate page and bulk-check candidates before emitting any content; continue with bounded scans and explicit continuation semantics. Never load all tenant records, make one remote call per row, or leak titles/counts from unchecked matches. Exact authorized counts and pagination need a tested query strategy; truncated engine results are not the full accessible set. See [search with permissions](https://openfga.dev/docs/interacting/search-with-permissions).

Permission caches, history recovery, SSE cursors, job queues and artifact links include tenant, principal generation, action, resource generation, policy revision/model and relevant context. No shared cache entry may conflate users/tenants. Recheck before delivery when permissions change during a list/stream; cursors do not preserve revoked access. Future RAG/search retrieval must filter access before model context is assembled and preserve source access metadata.

## 7. Agent and SAP/MCP execution authority

Model the human/service principal that initiated the work separately from the workload that performs it. Effective execution authority is the intersection of current actor permissions, parent execution grant, tenant policy, task/resource scope, connector permissions and downstream authorization. A child agent can only narrow authority, expiration and delegation depth.

Issue short-lived, audience-bound invocation tokens or opaque grant handles, backed by live revocable execution records. Bind them to tenant, actor, workload, conversation/thread, resource generation, parent grant, exact permitted operations/targets and policy revision. Runtime/gateway/tool services verify their own audience and service authentication; a human API token is not a runtime credential. Keep API, model-gateway and tool-grant trust domains separate. Use standard verified token libraries and managed key custody/rotation, not the existing bespoke permanent gateway token as the enterprise contract.

Loaded runtime configuration cannot refresh itself merely because we shorten expiry. Design broker-mediated credential renewal/reconfiguration and cold-resume/fork behavior explicitly. An expired/revoked parent prevents further child admissions. Existing threads need a controlled grant migration or restart.

Protected downstream credentials stay in the broker/secrets service. Runtime configuration receives only scoped broker access, not raw long-lived SAP or MCP secrets. Restrict egress so protected services cannot be called around the broker; if a connector cannot meet this boundary, disable it for enterprise protected execution until it can. IAM authenticates Bedrock invocation; an application grant must still bind tenant and resource authority. For remote direct HTTP use authenticated workload transport, verified operation envelopes and network restrictions.

At tool dispatch, evaluate the registered tool/action and normalized business arguments, current principal/tenant/fence, live execution grant and downstream scope. SAP remains authoritative for its own company-code, organizational and business-object rights. Truex permissions can narrow those rights, never expand them. Prefer delegated user identities for user-sensitive SAP operations; shared service credentials require an explicitly constrained business scope and audit of the effective actor.

User approval is additional consent, not permission. Bind approval to action, target and normalized argument hash; changed arguments require reauthorization/reapproval. Do not rely on tool annotations, names or prompts to decide financial-write permissions. Sensitive actions can require fresh MFA or a second approver under tenant policy.

A sensitive write admission must be atomically ordered against the authoritative revocation/policy fence. Admission and revocation must conditionally write the same authoritative fence/epoch document (or another experimentally proven shared serialization point), with the one-use admission receipt persisted in the same transaction. Reading a fence and inserting an unrelated receipt in a transaction is insufficient because write skew is possible. Define replica-set read/write concerns and retry behavior, and test synchronized concurrent commits and failover. Receipts are idempotency-key scoped and have a short bounded dispatch deadline; old admitted work cannot dispatch arbitrarily later. No new admission ordered after the revocation commit is allowed. Operations admitted before that commit or already accepted remotely may still complete; cancellation is best effort and requires result reconciliation. Do not claim that revocation undoes a SAP transaction. A tenant-wide serialization point is a safe initial prototype but may become a hot partition; benchmark it before narrowing the fence scope.

Retries after remote timeout must inspect operation state or use supported downstream idempotency. Do not blindly repeat a financial mutation. The broker owns duplicate suppression, ambiguous-result recovery and business audit.

## 8. Provisioning, deprovisioning and audit

SCIM/directory connections are tenant-bound and separately authenticated. Authenticate incoming webhooks where used, durably ingest before acknowledgement, and make provisioning idempotent. Use scoped immutable external IDs; never rely on email or group names as authority. Group-to-role mappings are approved by the tenant and cannot map to platform support, owner, or emergency-content privileges without the required control.

SCIM providers do not guarantee one universal event order. Use lifecycle generations, tombstones, supported conditional/versioned updates and periodic authoritative reconciliation. A delayed create/add must not revive a deprovisioned generation. Source: [SCIM protocol, RFC 7644](https://www.rfc-editor.org/rfc/rfc7644.html).

Customer SCIM removal commits denial of that tenant membership/binding and an auditable cleanup workflow. It must not disable the person's global identity or access to unrelated tenants. Only a separately authorized platform-security action may globally suspend a principal. Revoke the removed tenant's sessions, API/service/execution grants, shared relationships and connector credentials; close affected streams and stop subsequent child/tool admissions. Cleanup is idempotent after an already-removed membership, and dependency failure never restores access. Rehire/reinvite creates a new tenant authorization generation and explicitly approved fresh bindings.

Audit critical authorization mutations and sensitive admissions durably with named initiating/effective actors, workload/delegation, tenant, action, resource generation, reason, decision, policy model/revision, approval, time, request/trace/operation ID and outcome. No raw JWTs, credentials, document bodies or confidential tool arguments in routine decision logs. Export audit under a separate authorized action, retention/residency policy and tamper-resistant storage controls. Policy changes and emergency access must fail when their required durable audit cannot be written; external-success/local-audit-failure recovery must remain observable and reconcile without duplicate execution.

## 9. Proposed acceptance targets and experiments

These are planning targets, not measured claims or customer SLAs. Final commitments require load, outage, recovery and identity-provider tests.

| Requirement | Initial target / release gate |
| --- | --- |
| Tenant isolation | Zero cross-tenant allows or private metadata leaks across adversarial tests |
| JWT verification | Invalid issuer/audience/signature/type/algorithm/expiry denies; cached-key verification p99 ≤20 ms on production-like hardware |
| Policy latency | Policy-check p99 ≤25 ms and authorized-page overhead p99 ≤100 ms at the agreed workload; include authoritative fence cost separately and end-to-end |
| Read/stream revocation | Stop further protected reads/SSE delivery within 5 seconds of authoritative revocation commit, including cache-invalidation failure |
| Sensitive write revocation | No new admission ordered after revocation commit; explicitly track earlier admitted/remote-accepted work |
| Cleanup recovery | Converge within 60 seconds with healthy dependencies; alert when retries exceed 5 minutes |
| Emergency access | ≤15-minute grant, independent approval, durable audit, early cancellation within read-revocation bound |
| Authorization availability | Target 99.99% for protected admission path; fail closed on dependency loss and measure real end-to-end availability before offering an SLA |
| Recovery | A restored policy projection cannot supersede newer deny fences; backups and restore rehearsals preserve latest revocations or keep the tenant blocked |

Start with a reproducible pilot envelope: 10,000 principals, 100,000 resources and 1,000,000 relationships in a large tenant; 1,000 authorization checks/second mixed with 50 list requests/second across a regional cell. Include highly uneven tenants, maximum supported group depth/fan-out, simultaneous mutations and revocations. These numbers are provisional engineering experiments, not demand forecasts. Record hardware, topology, versions, model, cache modes, data distribution, p50/p95/p99 latency, error rate, query/connection load and cost. Run 10× stress to identify the first limit; do not claim this envelope is supported until measured.

Release-blocking adversarial scenarios:

- Forged/expired/ID-token/wrong-audience tokens, issuer mixup, same `kid` across issuers, unknown-key floods, rotation/JWKS timeout, removed key emergency disablement; invalid bearer never falls back to a cookie.
- Two simultaneous tenants with identical external group/user names and guessed resource IDs; client-supplied tenant/store/model claims; missing principal or tenant in HTTP and workers.
- Cookie mutation CSRF and BFF cookie/SSE/abort behavior, privileged admin-path forwarding, unauthenticated runtime access and forged invocation envelopes.
- Role author/assignment escalation, last-owner races, self-approved emergency access, role mutation widening existing bindings, group cycles and nested-group removal.
- A custom role containing conversation-read capability without ownership/share/emergency relationship still denies private content; one tenant's SCIM removal preserves unrelated tenant access.
- List/count/search/download/export/snapshot/trace/history-cache leaks and permission changes between query, check and delivery.
- Crash after each Mongo/outbox/policy write, duplicate/out-of-order projection, failed acknowledgement, model migration overlap, restored stale allow state and deletes followed by ID reuse attempts.
- Delayed old projection writes/acknowledgements cannot supersede newer revocation; synchronized admission/revocation transactions establish the claimed ordering without write skew.
- SCIM duplicate/reordered events, deprovision during a stream/turn, failed cleanup then retry, reinvite/rehire with old JWTs/connector grants.
- Revoked loaded gateway/MCP config, orphaned helper agents, delegation tenant swap/scope widening/expiry extension, fork/resume replay, approval reuse or argument change.
- Broker bypass/direct egress/raw secret custody, forbidden SAP business scope, remote-success/local-timeout with retries, denied mutations producing zero new dispatches.
- Policy/DB/audit/broker outages, slow dependencies, disconnected invalidation, process restarts, noisy-neighbor tenant load and cleanup backlog.

## 10. Phased backlog and delivery gates

No calendar estimate is asserted before the engine/identity/runtime POCs establish effort. The stages below are dependency-ordered, and enterprise launch is gated on the end-to-end controls rather than a package installation.

| Phase | Concrete deliverable | Exit evidence |
| --- | --- | --- |
| 0 — Security contract and engine POC | Fixed action catalog, tenant/private-content rules, trusted issuer contract, OpenFGA-vs-SpiceDB prototype for checks/lists/custom-role/revoke/outage; replica-set/outbox proof | Reviewed threat model, actual engine consistency and failure traces, workload results and operating-cost estimate |
| 1 — Authentication and explicit actors | Enterprise connection/identity bindings, cookie BFF, JWT verifier, machine-client mapping, normalized explicit human/service/worker principals, named administrators, attributable audit | Cookie and JWT reach identical guards; negative JWT/CSRF/tenant tests; compiled production package compatibility; no implicit actor/default-tenant paths |
| 2 — Engine-backed private resources | Policy adapter/model, tenant policy-store routing, scoped built-in roles/ownership, pending grants, deny fences, outbox/reconciler, protected list/get/search/artifact paths | Real-engine + real replica-set tests prove cross-tenant denial, no blanket admin content access, crash recovery and consistent listings |
| 3 — Enterprise access management | Workspace model, approved read sharing, custom-role bundles and bindings, SSO/SCIM groups/lifecycle, tenant admin UX and governed emergency access | Provisioning/deprovision/role-escalation/last-owner/rehire tests, durable audit, tenant policy transparency |
| 4 — Delegated execution | Protected broker/secret custody and egress, scoped runtime envelopes, gateway grants, child-agent limits, admission/idempotency recovery, active stream/turn revocation | Denied SAP/model/tool action cannot bypass via raw secrets/direct network; revocation measurements; remote-timeout reconciliation and cold-resume tests |
| 5 — Migration and launch validation | Tenant migration/backfill/model pinning, shadow comparison, enforced canary, outage/load/backup/restore rehearsals and security assessment | All release gates, traceable evidence, incident/rollback runbooks and customer isolation commitments |

Before any multi-tenant pilot, prove authenticated tenant-bound runtime/artifact admission and isolation, and deny legacy runtime/model/connector credentials. Until those controls are ready, phases 1–3 may use only a single isolated tenant or isolated synthetic data, with runtime-facing detail recovery, SSE and execution disabled. Disabling sensitive external writes alone does not prevent runtime/history/file leakage. Do not enable enterprise sensitive SAP/MCP execution before phase 4 controls pass. Current shared POC runtime and credentials must not be exposed merely because JWT authentication was added.

### First implementation slice

The first PR-sized slice should establish contracts and an executable POC, not rewrite the entire platform:

1. Add typed principal/action/decision contracts and table-driven policy fixtures for privacy, cross-tenant access and missing-context denial.
2. Prototype the preferred engine and alternative against the same fixture suite, including grant/revoke/list and crash-consistency scenarios.
3. Add strict API token verification producing the same normalized context as browser sessions; include trust/rotation/invalid-bearer tests and compiled-runtime compatibility.
4. Complete same-origin API/SSE browser forwarding and CSRF behavior, using the existing auth-forwarder patterns.
5. Migrate background callers to explicit workload context and server-required tenant selection; keep new external execution disabled until runtime guards/broker are ready.

Sequence these into focused PRs if the combined diff becomes too large. Do not couple dependency upgrades or unrelated UI refactors to this work.

### Repository integration map

- `platform/src/auth.ts`, `google.ts`, `invites.ts`, `user.ts`, `index.ts`: federation, identity mapping, API bearer/cookie selection, active lifecycle and middleware order.
- `platform/src/access.ts`, `service.ts`, `store.ts`, `tenant.ts`, `admin.ts`: central policy adapter/guards, explicit tenancy, schema/indexes, query planning, administration, policy/outbox/audit and removal recovery.
- `frontend/app/auth/[...path]/route.ts`, proposed `frontend/app/api/[...path]/route.ts`, `frontend/lib/api.ts`, `transport.ts`: same-origin browser and stream integration; obey frontend AGENTS instructions during implementation.
- `platform/src/runtime-transport.ts`, `agent-core/src/index.ts`, `agentcore.ts`, `manager.ts`, `business-runtime.ts`, `tenancy.ts`: authenticated invocation, mandatory tenant/resource binding, runtime isolation, credential broker and bounded delegation.
- `shared/gateway-token.ts`, `platform/src/model-route.ts`, `model-gateway/src/server.ts`, MCP configuration modules: separate audience/grant lifecycle and removal of raw protected runtime credentials.
- `shared/contracts.ts` and proposed policy model/migration/test files: additive versioned contracts and engine fixtures. Existing Project remains a personal folder until an explicit workspace migration.

## 11. Migration, rollback and operational ownership

Expand → backfill → reconcile → shadow → enforce per tenant → retire legacy allowances. Shadow results are diagnostics, not enforcement proof. Explicitly map existing visibility and legacy admin reads to desired tenant consent; do not convert all shared records into permanent read grants automatically. New enterprise tenants start private and have no administrator read-all. Shared POC content must be archived or assigned through reviewed ownership migration, never assigned to the first new enterprise login.

Backfill existing Google users to scoped identity bindings without changing their stable IDs. Add membership/resource generations, ownership and publication state. Reconfigure/resume or deliberately restart loaded runtimes before disabling perpetual gateway credentials; close unsupported sessions cleanly with actionable messages. Migrate worker contexts before removing undefined-user access. Only retire old schemas/modes after mixed-version rollout tests pass.

Rollback must preserve private-content rules, tenant binding, deny fences, identity generations and revoked grants. Never roll back to shared POC identity, missing-context privilege, blanket admin reads or perpetual unscoped execution. If compatibility cannot maintain these guarantees, stop protected execution and repair rather than reopen access.

Assign accountable owners before implementation: identity/provisioning, application/policy model, runtime/tool enforcement, and operational/security response. Monitor decision latency/error/outcome, projection lag, revocation latency, failed cleanup, JWKS/key changes, audit delivery and per-tenant quota pressure. Alert on any cross-tenant denial anomaly, missed revocation bound, stale publication gate or cleanup/audit backlog. Restore drills must compare policy projection to authoritative desired state and revocation history before serving traffic.

## 12. Evidence and unresolved decisions

The prior baseline run passed 20 existing auth/ownership/tenancy/MCP/user tests; a reviewer also passed 13 focused access/context tests. Tenancy cleanup logged MongoClientClosedError warnings. These runs validate current behavior only. No enterprise token/provider, policy engine, broker, load, isolation or disaster-recovery implementation has been experimentally validated. No new test pass or production-readiness claim is made for this planning revision.

Before purchase/production selection, settle broker contracts and region support, policy-engine store cardinality/consistency/list costs, actual tenant volumes, supported nested-group bounds, runtime isolation and credential mediation, Mongo transaction topology, audit retention and customer RPO/RTO requirements. These do not block writing or prototyping the proposed architecture, but they do block unsubstantiated enterprise guarantees.

Application code and pre-existing changes in `platform/src/service.ts` remain untouched. This document is the implementation plan, not a certification of enterprise readiness.
