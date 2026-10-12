# Enterprise authorization: step-by-step build plan

Status: Steps 01–03 foundations implemented; Step 04 evidence gathered but its exit gate is on HOLD (see [engine decision](authorization/ENGINE_DECISION.md)); Step 05 additive identity records/backfill implemented; Step 06 API verification and generic broker browser login implemented with synthetic tests; live broker integration remains open. Full production implementation remains incomplete. Prepared 2026-10-12 against repository revision `8501163c7f3fd53a7406b2f0f560ea8130f5663f`.

This is the execution companion to the [authorization implementation plan](ENTERPRISE_AUTHORIZATION_IMPLEMENTATION_PLAN.md). Use that document for the architecture, endpoint/action inventory, current-code findings and security invariants. Use this document to build, test, review and track the work in order.

## 1. Estimates and milestones

Estimates below are provisional engineering effort, not promised delivery dates. Assume one engineer familiar with TypeScript, this repository and the selected identity/policy infrastructure. A focused engineering day includes implementation, relevant tests, documentation and review fixes. Vendor procurement, approval waiting, customer coordination, independent security assessment and major runtime redesign are excluded. Broker/runtime estimates have the greatest uncertainty.

The initial budget is **97–166 engineering days**, approximately **20–34 weeks at five focused engineering days per week** for one engineer. After the Step 04 evidence the provisional engineering-judgement budget is approximately 102–174 days (Steps 08 and 09 raised; see ENGINE_DECISION.md); the per-milestone table below still shows the original figures. Real calendar duration can be longer. Do not halve this number merely by adding a second engineer: the security contracts, state model and integration gates are dependencies. Re-estimate after M0, then after runtime isolation is demonstrated in M2. A failed consistency or sandbox proof can invalidate later estimates.

| Milestone                           | Steps / PRs     | Effort     | Reviewable result                                                                                          | Release boundary                                      |
| ----------------------------------- | --------------- | ---------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| M0: contracts and proofs            | 01–04 / A00–A03 | 12–20 days | Hermetic baseline, action/actor contracts, Mongo concurrency proof, selected engine and publication design | Synthetic data only                                   |
| M1: identity and explicit context   | 05–07 / A04–A06 | 13–22 days | Stable identity bindings, OIDC/JWT, scoped workers, named administration                                   | Isolated tenant; execution remains blocked            |
| M2: resource and runtime protection | 08–11 / A07–A10 | 22–39 days | Real policy guards, safe lists, revocation delivery controls, authenticated isolated runtime               | No multi-tenant runtime pilot before isolation passes |
| M3: enterprise access lifecycle     | 12–14 / A11–A13 | 16–27 days | Read sharing, scoped/custom roles, governed emergency access, groups/SCIM and convergent removal           | Resource pilot only with M2 controls enforced         |
| M4: contained execution             | 15–17 / A14–A16 | 21–36 days | Delegation grants, protected tool broker/egress, model mediation and renewal                               | Protected execution only after every M4 gate          |
| M5: experience and launch           | 18–19 / A17–A18 | 13–22 days | Access UI, migration, canary, load/outage/recovery evidence and runbooks                                   | Enterprise launch only after end-to-end gates         |

Allocate an owner and review date at the start of each milestone. Leave customer dates unset until the relevant proofs pass. Splitting frontend work earlier is acceptable after its backend contracts stabilize; it does not move a release gate earlier.

## 2. Execution rules and command conventions

Use the dependency order for a single engineer. An unmet rollout gate does not block reversible implementation against isolated synthetic data; record the hold and preserve the release boundaries. Each step is one focused PR outcome; split it further when the diff becomes difficult to review. Do not combine dependency upgrades, UI redesign or general refactoring with these changes.

For every step:

1. Read the listed code and confirm the acceptance criteria against current behavior.
2. Record the owner, dependencies, scope and failure cases before editing.
3. Implement the ordered checklist using existing abstractions.
4. Add meaningful positive, denial, tenant-crossing and failure-path tests.
5. Run the specified checks; then inspect the worst realistic race/outage/bypass.
6. Review security, bounded resource use, the final diff and rollback behavior.
7. Attach commands/results and artifacts to the PR. Mark complete only after the exit gate passes.

All commands below run from the repository root unless a working directory is stated. Existing npm commands are executable now. Files labeled **new** and npm scripts labeled **proposed** must be created by their assigned step before use. Suggested filenames identify concrete responsibilities; they may be adjusted without changing the acceptance criteria.

Do not run customer migrations, provision vendor accounts, deploy, or invoke real SAP/MCP/model services as part of local tests. Test subprocesses must use explicit isolated settings and fixture endpoints. The prior baseline found `.env` could override fixture runtime routing; Step 01 fixes that before further tests.

### Existing commands

```bash
# Inspect; preserve pre-existing changes.
git status --short
git rev-parse HEAD
node --version

# Install only when dependencies are missing or package files change.
npm ci
npm run install:all

# Component builds/checks.
npm --prefix platform run build
npm --prefix agent-core run build
npm --prefix model-gateway run build
npm --prefix frontend run typecheck
npm --prefix frontend test

# Full implementation release checks, after harness isolation is fixed.
npm run format:check
npm test
npm --prefix frontend test
npm --prefix frontend run typecheck
npm run build
git diff --check
```

Root `npm test` does not include frontend. There is no lint script in the existing packages. Add checks only when a real tool/configuration has been introduced. Existing formatting failures must be recorded separately from changes caused by the PR; do not conceal them or rewrite unrelated files.

### Proposed focused checks

Create `test:authz` in each affected package when its first `test/authz-*.test.ts` file is added, using that package's existing runner. Backend packages use `tsx --test`; frontend uses `node --experimental-strip-types --test`. Flat test files remain included in existing `test/*.test.ts` commands.

Step 03 adds platform `test:authz:integration` for `test/authz-integration/*.test.ts`. Step 04 adds `test:authz:faults` for `test/authz-faults/*.test.ts` and `authz:benchmark` for `scripts/authz-benchmark.ts`. These explicit suites must run in the release/CI pipeline; existing globs will not discover nested tests. Register scripts only alongside runnable tests, not empty placeholders. Failure to reach required infrastructure must fail the integration job, not produce a passing skipped suite.

After those scripts exist:

```bash
npm --prefix platform run test:authz
npm --prefix platform run test:authz:integration
npm --prefix platform run test:authz:faults
npm --prefix platform run authz:benchmark
npm --prefix agent-core run test:authz
npm --prefix model-gateway run test:authz
npm --prefix frontend run test:authz
```

Implementation checkpoint (2026-10-12): A00–A02 and A04 are implemented and locally verified; A05 is partly implemented (bearer verification, gate and BFF refusal; no browser broker login). A03 evidence is gathered but selection is on HOLD; no production engine or identity broker is selected. These foundations are not yet wired into legacy routes. See [baseline evidence](authorization/BASELINE.md), [security contract](authorization/SECURITY_CONTRACT.md), [route inventory](authorization/ROUTE_INVENTORY.md) and [engine experiments](authorization/ENGINE_DECISION.md). The full authorization implementation and launch remain incomplete.

## 3. Step-by-step execution

### Step 01 — Establish a reliable baseline and inventory

**PR:** A00. **Prerequisites:** none. **Effort:** 1–2 days. **Owner:** unassigned.

**Files:** existing `platform/test/harness.ts`, `ownership.test.ts`, backend subprocess test helpers, `platform/src/index.ts`, `admin.ts`, `workspaces.ts`, `agent-core/src/index.ts`, `agentcore.ts`; **new** `platform/test/authz-route-coverage.test.ts`, `docs/authorization/ROUTE_INVENTORY.md`, `docs/authorization/BASELINE.md`.

- [x] Inspect every protected route, allowed capability method, runtime operation and worker entry point; map each to the implementation plan's action inventory.
- [x] Centralize fixture subprocess environments: prevent project `.env` loading, clear deployment routing/settings and inject explicit fixture issuer, Mongo, runtime and credentials. Do not print secrets.
- [x] Assert the selected runtime is the fixture host; reject unintended external traffic in the harness. Cover both direct and mocked Bedrock transport.
- [x] Run the existing auth/ownership/tenancy/private-access, forwarder and gateway suites; record full commands and results. Add route coverage that fails when a protected surface lacks a mapping.
- [x] Register platform `test:authz`. Record existing quality-gate failures without silently weakening assertions.

**Run:** existing focused suites plus `npm --prefix platform run test:authz`; platform build. The previous 72 focused passes are prior evidence only; obtain the post-harness baseline again.

```bash
# Working directory: platform/ (after fixing fixture isolation).
AGENTCORE_RUNTIME_ARN= ./node_modules/.bin/tsx --test \
  test/auth.test.ts test/ownership.test.ts test/tenancy.test.ts \
  test/user.test.ts test/tenant.test.ts test/google.test.ts \
  test/private-access.test.ts

# Working directory: frontend/.
node --experimental-strip-types --test test/forward.test.ts

# Working directory: model-gateway/.
./node_modules/.bin/tsx --test test/server.test.ts
```

**Done when:** tests cannot route through local deployment configuration; every protected route/method/worker is inventoried and every failure is reproducible. **Hold if:** an endpoint or background path lacks an identified authority boundary.

### Step 02 — Define actors, actions and authorization contracts

**PR:** A01. **Prerequisites:** Step 01. **Effort:** 2–3 days. **Owner:** unassigned.

**Files:** **new** `shared/authorization.ts`, `platform/test/authz-contracts.test.ts`, `docs/authorization/SECURITY_CONTRACT.md`; inspect existing `user.ts`, `tenant.ts`, `http.ts`, `access.ts`, shared/database contracts.

- [x] Define human/service/workload principal variants, required verified tenant context, credential scope ceilings and principal/membership generations.
- [x] Define fixed actions for resource reads, send/interrupt, approval, document operations, goals, fork/resume, connectors, model use, membership/roles, audit and support access.
- [x] Define server-loaded resource references, typed allow/deny/unavailable decisions and the authenticated internal check/admission protocol.
- [x] Define bounded worker privileges: ingestion may persist/ack accepted records; it cannot start arbitrary turns or use customer credentials as a missing user.
- [x] Add fixtures for private content requiring both action capability and ownership/share/emergency relationship. Document owner/service-account conversation behavior and initial read-only sharing.
- [x] Extend formatting coverage to the new shared file; the current root formatter names only selected shared files.

**Run:** platform `test:authz`; build platform, agent-core and model-gateway to validate shared imports.

**Done when:** missing actor/tenant, wrong generation, tenant mismatch and admin-without-content-grant all deny in contract fixtures. **Hold if:** any proposed contract uses absence or a caller-chosen role/store/model as authority.

### Step 03 — Prove authoritative state and admission ordering

**PR:** A02. **Prerequisites:** Step 02. **Effort:** 4–7 days. **Owner:** unassigned.

**Files:** existing `platform/src/store.ts`, `audit.ts`; **new** `policy-state.ts`, `platform/test/authz-integration/state.test.ts`, `admission.test.ts` and replica-set harness under that directory.

- [x] Extend the existing transaction helper for desired policy state, tenant epoch/fence, lifecycle generations, mandatory audit and outbox writes using the same Mongo session.
- [x] Prototype pending grant/create and deny-first revoke/delete states; define exact-revision activation without a production engine yet.
- [x] Persist admission receipts/idempotency digests while conditionally writing the same fence document used by revocation. Keep remote effects outside retryable callbacks.
- [x] Test simultaneous grant/revoke and admission/revoke using synchronized transactions; verify retry/ambiguous-commit behavior does not duplicate receipts.
- [x] Test Mongo/audit failure at each boundary. Register `test:authz:integration`; standalone Mongo must fail closed for required mutations.

**Run:** platform build, `test:authz`, `test:authz:integration` against actual mongod replica-set processes. Use a multi-member topology for failover evidence before release; a single member does not prove that case.

**Done when:** no grant becomes active without publication; revoke commits durable denial; every later ordered sensitive admission denies; state/audit/outbox commit together. **Hold if:** the design merely reads a fence and inserts an unrelated receipt.

### Step 04 — Select the engine through real consistency experiments

**PR:** A03. **Prerequisites:** Steps 02–03. **Effort:** 5–8 days. **Owner:** unassigned.

**Files:** **new** `infra/authz/compose.poc.yml`, `platform/policy/` engine models/fixtures, `platform/test/authz-integration/engine.test.ts`, `platform/test/authz-faults/engine.test.ts`, `projector.test.ts`, `platform/scripts/authz-benchmark.ts`, `docs/authorization/ENGINE_DECISION.md`; package files only for verified POC dependencies.

- [x] Create isolated, version-pinned OpenFGA/PostgreSQL POC infrastructure and run the alternative engine against the same acceptance cases. _SpiceDB is selected for local implementation; production rollout remains on HOLD._
- [x] Load actual engine-validated models for roles, groups, ownership and the capability-AND-content relationship. Test lists and custom-role attempts to bypass private content.
- [x] Test grant N, revoke N+1, delayed write/ack N; model overlap; dropped response; crashed/restarted projector; restored stale graph.
- [x] Prove late writes cannot alter the policy queried by active decisions. Evaluate revision-isolated snapshots/graph namespaces or an equivalent mechanism; measure cost and every traversable edge.
- [x] Benchmark the proposed 10k principals/100k resources/1m relationships, uneven tenants and store cardinality. Register faults/benchmark scripts and capture reproducible results.
- [x] Record the implementation engine, proposed topology, consistency mode, tenant routing, publication fence and fallback denial behavior in the ADR; re-estimate M1–M5. Production launch remains on HOLD for the recorded latency/publication/list/HA/recovery gates. _Proposal and provisional re-estimate recorded in ENGINE_DECISION.md; final selection waits on the open gates there (notably the p99 ≤25 ms policy-check target, which the measured graph misses)._

**Run after creating the compose file:**

```bash
docker compose -f infra/authz/compose.poc.yml up -d
npm --prefix platform run test:authz:integration
npm --prefix platform run test:authz:faults
npm --prefix platform run authz:benchmark
docker compose -f infra/authz/compose.poc.yml down
```

**Done when:** M0 evidence demonstrates privacy, consistency, lists and crash recovery using a real selected engine. **Hold if:** old tuple writes can resurrect access, costs are unacceptable, or guarantees depend only on a worker lease. Do not purchase/roll out an engine on untested assumptions.

### Step 05 — Expand identity records without breaking stable IDs

**PR:** A04. **Prerequisites:** Step 02; execute after the engine implementation decision; M0 rollout holds still apply. **Status:** implemented and tested; verified browser/API paths use canonical records while generationless legacy login remains separate. **Effort:** 3–5 days. **Owner:** unassigned.

**Files:** existing `auth.ts`, `store.ts`, `google.ts`, `documents.ts`; **new** `identity.ts`, `platform/test/authz-identities.test.ts`, migration dry-run tooling under `platform/scripts/`.

- [x] Add trusted connection/issuer/subject bindings and explicit service principal/registered client records (`platform/src/identity.ts`). Preserve existing human `users._id` values.
- [x] Add principal/membership/session generations, tombstones and revocation-cohort contracts (`CredentialCohort`, `validateCredential`). _Issuing cohorts into real sessions/tokens is Step 06; `AuthSessionDocument.authorization` is the reserved field._
- [x] Backfill Google bindings using subject, not email (`identity-migration.ts`, `npm --prefix platform run authz:identity:backfill -- <catalog db> <google connection id> [--apply]` with explicit `AUTHZ_MIGRATION_MONGO_URI`). Reports duplicate/collision/partial-migration cases; corporate dots/tags unchanged. Run only against synthetic databases; no customer migration performed.
- [x] Non-Google/service principals are representable without touching `googleSub`/`emailKey` unique indexes: identities live in separate additive `identity_*` collections, so those legacy indexes stay until their readers migrate.
- [x] Test old/new schema overlap, repeatable dry runs and removed→reinvited lifecycle (`authz-identities.test.ts`, `authz-integration/identities.test.ts`, `identity-standalone.test.ts`). Tests reject independently stale generations, real CLI dry-run/apply failures and missing transaction support. Old credentials cannot acquire a new membership generation. See [identity contract](authorization/IDENTITY_DATA_CONTRACT.md).

**Run:** platform build, `test:authz`, `test:authz:integration`; existing auth/Google/tenancy tests in the isolated harness.

**Done when:** identity migration is additive, stable IDs survive and issuer/subject/client binding is unambiguous. **Hold if:** provider tokens cannot distinguish removed credentials from approved fresh credentials.

### Step 06 — Add broker login and strict API token verification

**PR:** A05. **Prerequisites:** Step 05. **Effort:** 5–9 days. **Owner:** unassigned. **Status:** local browser/API implementation complete; live broker contract/validation open. See [API auth contract](authorization/API_AUTH_CONTRACT.md) and [browser auth contract](authorization/BROWSER_AUTH_CONTRACT.md).

**Files:** existing `auth.ts`, `google.ts`, `invites.ts`, `index.ts`, frontend `forward.ts`; **new** `api-auth.ts`, `oidc.ts`, `browser-auth.ts`, `platform/test/authz-api-auth.test.ts`, `authz-oidc.test.ts`, `authz-oidc-startup.test.ts`, frontend login/forwarder tests and tenant-selection screen, `scripts/authz-compiled-smoke.mjs`.

- [ ] Finalize the trusted broker issuer/API audience, token purpose, service-client, SSO/SCIM/MFA and rehire contracts; use synthetic issuer tests until vendor configuration exists. _Token, client and rehire contract written and tested with synthetic issuers (API_AUTH_CONTRACT.md); SSO/SCIM/MFA and the broker's ability to emit generation claims remain open vendor requirements._
- [x] Reuse `openid-client` for backend-managed PKCE/state/nonce login and opaque cookies. Add a compatibility-tested `jose` version; keep exchange tokens server-side. _Generic `oidc.ts` and cohort-bound sessions implemented, including tenant selection/rotation, mandatory audit and canonical non-Google human profiles. Unused OAuth tokens are discarded rather than stored. Compiled CommonJS loading constructs the installed SDK configuration on Node 24.11.0. Vendor-specific routing parameters and live provider claims still need validation._
- [x] Verify bounded JWT inputs, approved algorithms/issuer/JWKS, audience, access-token purpose, expiry/not-before and live principal/client/membership binding (`platform/src/api-auth.ts`).
- [x] Reject invalid bearer and conflicting mechanisms before resource lookup. Reorder API authentication/CSRF so exemption applies only to verified bearer requests (`bearerGate` runs before CSRF; per-route scope ceiling from the route inventory).
- [x] Keep cookie-only BFF semantics explicit: reject incoming Authorization rather than drop it and fall back (`frontend/lib/forward.ts`, `frontend/test/authz-forward.test.ts`); existing forwarder suite still passes.
- [x] Test trusted JWKS rotation, same kid across issuers, unknown-key flood/outage and emergency disable fences (`platform/test/authz-api-auth.test.ts`, 8 tests; guard mutations for typ, audience and ambiguity fail the suite). Compiled smoke: `scripts/authz-compiled-smoke.mjs`.

**Run:** platform build and `test:authz`; frontend `test:authz` and existing forwarder tests; `node scripts/authz-compiled-smoke.mjs` after that script exists.

**Done when:** browser and API callers produce the same verified context; malformed/unrelated credentials cannot reach resource code; CommonJS production loading works. **Hold if:** an ID token, unregistered client or cached disabled identity is accepted.

### Step 07 — Remove implicit privilege and insecure enterprise startup

**PR:** A06. **Prerequisites:** Steps 02, 05–06. **Effort:** 5–8 days. **Owner:** unassigned. **Status:** request context and tenant-storage boundary implemented; worker/service/named-administration migration remains.

**Files:** existing `user.ts`, `tenant.ts`, `http.ts`, `access.ts`, `store.ts`, `service.ts`, `admin.ts`, `platform/Dockerfile`, scripts with internal Store/service calls; **new** `platform/test/authz-context.test.ts`, `authz-storage.test.ts`, `authz-startup.test.ts`.

- [ ] Install explicit bounded workload contexts in polling, ingestion, reconciliation, cleanup, administration and maintenance scripts. _Verified HTTP contexts now propagate through an isolated immutable async scope; enterprise wrappers reject missing/mismatched actor or tenant generation and workload impersonation. Mechanical scope/purpose checks are available, but do not grant engine authority. See `authorization-context.ts` and `authz-context.test.ts`._
- [ ] Migrate every caller before making protected service/storage entry points reject missing actor/tenant. Pre-tenant login remains limited to catalog identity access.
- [ ] Remove absence-as-superuser and protected default-database fallback. Make resource DB selection come from a verified server registry/context. _OIDC Store tenant collections/index helpers now reject missing, forged, expired and mismatched contexts; only immutable references minted by the same Store are accepted. Enterprise resolution requires a live generation-bearing registry record, including for default. `access.ts` implicit privileges, direct service/client callers and bounded worker migration remain unfinished; this combined gate stays unchecked. See [storage contract](authorization/STORAGE_CONTEXT_CONTRACT.md)._
- [ ] Replace shared null-identity platform administration with named identities, separate app/audience and approved MFA evidence.
- [ ] Reject POC/dev identities and override headers in enterprise production; test startup plus server-side refusal of old/insecure application versions for enforced tenants.
- [ ] Keep ingestion of already accepted records bounded and working when a browser disconnects; it must not obtain permission to start new work.

**Run:** platform build, `test:authz`, integration suite, existing user/http/tenancy/admin tests with updated explicit fixture contexts.

**Done when:** M1 contains no protected implicit-actor/default-tenant path and every audit actor is attributable. **Hold if:** a cleanup/worker convenience path can run end-user operations.

### Step 08 — Implement the selected policy adapter and publisher

**PR:** A07. **Prerequisites:** Steps 03–04, 07. **Effort:** 6–10 days. **Owner:** unassigned.

**Files:** existing `access.ts`, `store.ts`, `tenant.ts`, `audit.ts`; **new** `authorization.ts`, `policy-engine.ts`, `policy-worker.ts`, `platform/test/authz-policy.test.ts`, integration/fault tests.

- [ ] Implement one asynchronous permission interface and authenticated internal decision/admission service using the contracts from M0.
- [ ] Route tenants to server-pinned store/model/revision; combine live lifecycle/scopes/fences with engine capability/content checks.
- [ ] Implement transactional desired state, durable audit/outbox, pending publication and exact-revision activation using the proven projection design.
- [ ] Add bounded workers, backoff/jitter, leases, reconciliation and quarantine of ambiguous publications. Old acks never clear newer fences.
- [ ] Simulate engine/Mongo/audit outages, model migration and restored stale allow state. Add decision/projection latency and fence/backlog metrics.

**Run:** platform build; all platform authz unit, integration and fault suites.

**Done when:** protected mutations/decisions use real engine state and live authoritative fences; outages deny with actionable errors. **Hold if:** a fake engine or stale-positive fallback is on the production path.

### Step 09 — Guard every resource and implement safe pagination

**PR:** A08. **Prerequisites:** Step 08. **Effort:** 5–9 days. **Owner:** unassigned.

**Files:** existing `service.ts`, `index.ts`, `access.ts`, `store.ts`, public response projections; **new** `platform/test/authz-resources.test.ts`, `authz-lists.test.ts`, `authz-capabilities.test.ts`.

- [ ] Replace owner/admin shortcuts with fixed actions at service boundaries, including methods accepting loaded sessions and direct route DB reads.
- [ ] Map capability/command methods individually; starting/resuming goals, fork and settings changes require their own authority. Unknown methods deny.
- [ ] Protect sessions/projects/agents/models/skills, MCP profiles/attachments, history/titles/timings/traces/helpers and documents/visualizations.
- [ ] Implement bounded tenant-scoped candidate pages plus bulk checks and authorized continuation semantics. Omit unproven exact counts; never scan/load all IDs.
- [ ] Recheck before delivery and include actor/resource generations and policy revision/model in recovery keys. Non-owner reads do not wake the owner's runtime.
- [ ] Extend route coverage with a spy proving denied calls produce no resource writes or upstream dispatch.

**Run:** platform build and authz suites; existing ownership/projects/history/commands/goals/MCP tests with explicit enterprise/legacy expectations.

**Done when:** list/detail/download/search-like metadata paths agree and hidden content/IDs/counts do not escape. **Hold if:** a route passes a session to `owned()` as a substitute for checking authority.

### Step 10 — Bound read and stream revocation

**PR:** A09. **Prerequisites:** Steps 06, 08–09. **Effort:** 3–5 days. **Owner:** unassigned.

**Files:** existing `streams.ts`, `index.ts`, `service.ts`, frontend `transport.ts`, `identity.ts`, session caches; **new** `platform/test/authz-revocation.test.ts`, `frontend/test/authz-revocation.test.ts`.

- [ ] Add expiring read leases and independent deadlines to the existing stream revalidation guard; terminate on expired/unavailable authority.
- [ ] Gate each protected output batch and bound buffers so a hung check cannot allow continued delivery.
- [ ] Include principal/membership/resource/grant generations, current policy and tenant status in stream/recovery checks.
- [ ] Clear frontend streams/caches on identity/tenant change and revoked access; cursor replay never preserves authority.
- [ ] Measure from authoritative revocation commit to final protected server/proxy emission with lost invalidation, hanging dependencies, reconnect and restart.

**Run:** platform/frontend authz suites and frontend forwarder/session-cache tests; record measured revocation traces. Use synthetic runtime fixtures until Step 11 passes.

**Done when:** the five-second target passes with margin under the chosen intervals/deadlines, including failures. **Hold if:** only the happy-path timer was tested or already-sent bytes are claimed to be recalled.

### Step 11 — Authenticate and isolate every runtime operation

**PR:** A10. **Prerequisites:** Steps 02, 06–08. **Effort:** 8–15 days. **Owner:** unassigned.

**Files:** existing `runtime-transport.ts`, agent-core `index.ts`, `agentcore.ts`, `manager.ts`, `business-runtime.ts`, `tenancy.ts`, `file-tools.ts`, workspace helpers; **new** `agent-core/test/authz-invocation.test.ts`, `authz-isolation.test.ts`, platform transport tests.

- [ ] Bind direct HTTP and Bedrock envelopes to authenticated workload, tenant/conversation/thread/resource generation, operation and bounded read/execution grant.
- [ ] Verify the envelope before route dispatch. IAM invocation is additional service authentication; it is not resource authority.
- [ ] Require tenant matching on every manager operation. Guard document/visualization/file endpoints that bypass the manager today; cover records/ack, approvals and helper endpoints.
- [ ] Persist immutable runtime/resource bindings and explicitly migrate or reject legacy markers. Reject foreign/caller-supplied workspace paths.
- [ ] Test two malicious tenants against storage/history/artifacts, helper threads, symlink/path attempts, process state, credentials and network boundaries.
- [ ] Document actual local/Bedrock process, filesystem, sandbox and egress guarantees; redesign isolation if shared-process/session assumptions fail.

**Run:** build platform/agent-core, both authz suites; existing runtime-transport/tenancy/file-tools/business-security tests plus isolation fault scenarios.

**Done when:** M2 has proof for every runtime/file/helper surface and hostile tenant isolation. **Hold if:** folder names or optional tenant arguments are the only isolation control. A failed proof triggers a new estimate and architecture decision.

### Step 12 — Add scoped workspaces, built-in roles and read sharing

**PR:** A11. **Prerequisites:** Steps 08–09. **Effort:** 5–8 days. **Owner:** unassigned.

**Files:** existing `workspaces.ts`, `service.ts`, `store.ts`, shared contracts and selected model; **new** access-management service/routes and `platform/test/authz-sharing.test.ts`.

- [ ] Add an explicit resource-workspace model separate from existing tenant onboarding and personal Project folders; choose clear UI/API terminology.
- [ ] Seed reviewed built-in action bundles and scoped bindings without implicit private-content readership.
- [ ] Add ownership/publish/use relationships for agents and approved connector placement; changing a resource scope requires management authority.
- [ ] Add explicit read-only shares to current same-tenant users/groups; publication/revocation follows Step 08.
- [ ] Test member/admin/owner/shared-reader roles across every content subresource. Shared readers cannot send, upload, approve, fork, resume or load owner credentials.

**Run:** platform authz/integration suites plus existing projects/workspaces/agents tests.

**Done when:** private defaults and read-only shares work with real engine decisions; personal folders have no new inherited sharing. **Hold if:** workspace membership alone reveals every conversation.

### Step 13 — Add custom roles and governed emergency access

**PR:** A12. **Prerequisites:** Steps 07, 12. **Effort:** 5–9 days. **Owner:** unassigned.

**Files:** access-management service/routes, `admin.ts`, `audit.ts`, policy models; **new** `platform/test/authz-roles.test.ts`, `authz-emergency.test.ts`.

- [ ] Implement immutable custom-role versions built from the fixed action catalog and bounded scoped bindings.
- [ ] Enforce grantable permission ceilings for role authors/editors/assigners. A role edit cannot silently widen existing assignments.
- [ ] Protect voluntary last-owner removal atomically. Define governed recovery when authoritative directory deprovision removes the final eligible owner; never keep that principal active.
- [ ] Implement named independent requester/approver, verified step-up, reason, resource-bounded ≤15-minute emergency read grants and early cancellation.
- [ ] Persist mandatory audit before mutation/disclosure; deny self-approval, replay and emergency execution using customer credentials.

**Run:** authz/integration/fault suites with role escalation, owner races, expiry/cancellation and audit outage cases.

**Done when:** scope ceilings and independent approval survive races and outages. **Hold if:** role scripts/arbitrary relations or an administrator bypass are exposed.

### Step 14 — Implement SCIM/groups and convergent deprovisioning

**PR:** A13. **Prerequisites:** Steps 05, 08, 12; Step 13 owner-recovery contract. **Effort:** 6–10 days. **Owner:** unassigned.

**Files:** existing `admin.ts`, `auth.ts`, `store.ts`, `service.ts`, audit/outbox workers; **new** provisioning inbox/connection handlers, cleanup worker, `platform/test/authz-provisioning.test.ts`, `authz-removal.test.ts`.

- [ ] Authenticate tenant-bound directory requests/events and durably record the inbox before acknowledgement. Use immutable scoped external IDs, not email/group names.
- [ ] Enforce approved group/role mappings, bounded nesting/fan-out and transactional cycle checks; SCIM cannot assign protected owner/support/emergency privileges.
- [ ] Apply tombstones, generation/version checks and periodic authoritative reconciliation so reordered events cannot revive removed access.
- [ ] Replace removal's current partial-cleanup flow with a transaction committing denial, session/grant invalidation intent, audit and cleanup job.
- [ ] Make repeated removal/resume cleanup idempotent; revoke tenant-specific connectors/shares/execution and close streams without disabling unrelated memberships.
- [ ] Test failure after each cleanup boundary, rehire with old credentials, duplicate events and a deprovisioned last owner entering recovery.

**Run:** authz/integration/fault suites; existing admin/workspaces/Google tests; measure cleanup convergence with healthy and failed dependencies.

**Done when:** M3 supports removal retry without restoring access; healthy cleanup meets the proposed 60-second target. **Hold if:** retry returns 404 before unfinished cleanup can resume or one tenant suspends a global identity.

### Step 15 — Issue revocable execution and child-agent grants

**PR:** A14. **Prerequisites:** Steps 08, 11–12. **Effort:** 6–10 days. **Owner:** unassigned.

**Files:** existing `service.ts`, `runtime-transport.ts`, agent-core manager/business runtime and child-agent hooks; **new** grant store/service/client modules and `platform/test/authz-execution.test.ts`, `agent-core/test/authz-delegation.test.ts`.

- [ ] Persist initiator/effective actor/workload, tenant/resource generation, parent grant, allowed models/connectors/actions, policy revision, expiry and revocation state.
- [ ] Issue audience-bound grant handles/tokens through managed key custody or opaque live records; API tokens are not runtime credentials.
- [ ] Intersect each child grant with current actor authority and parent scope; enforce depth/concurrency/budget limits and prohibit expiry extension.
- [ ] Require current grants for message/goal/helper admissions, renewal, cold resume and fork; bind replay/idempotency to current resource state.
- [ ] Stop later admissions on parent/membership revoke; reconcile already accepted work. Persistence workers must not inherit execution authority.

**Run:** platform/agent-core builds and authz suites; existing subagent/runtime/goal tests plus orphaned-child and restart fault cases.

**Done when:** no child/goal/replay widens parent authority or survives expired/revoked grants through cached configuration. **Hold if:** a synthetic gateway UUID substitutes for the real initiating/effective actor.

### Step 16 — Build protected tool dispatch and credential custody

**PR:** A15. **Prerequisites:** Steps 03, 13, 15. **Effort:** 10–18 days. **Owner:** unassigned.

**Files:** existing `mcp.ts`, `service.ts`, agent-core direct/omni/adaptive MCP integration; **new** `tool-broker/` service/package, secret/grant/admission adapters and broker tests. Update root install/build/test/format coverage when adding the package.

- [ ] Implement broker-authenticated discovery/resources/templates and tool execution using the central authority and live grants.
- [ ] Move downstream secret custody to the broker; runtime config and on-disk profiles receive only bounded broker credentials. Test direct, omni and adaptive paths.
- [ ] Bind each registered tool to a reviewed business action and normalized arguments/targets; enforce connector identity and SAP business scope.
- [ ] Bind approval/step-up/second approver to action/target/argument digest; changed arguments require new authorization and consent.
- [ ] Use Step 03's ordered admission/idempotency receipts with dispatch deadlines. Remote timeout becomes unknown pending reconciliation; never blindly replay a financial write.
- [ ] Enforce egress so runtime cannot bypass the broker or access protected credentials. Disable connectors that cannot meet that boundary.
- [ ] Run denied-dispatch, raw-secret-custody, argument change, business-scope, remote-success/local-timeout and broker/audit outage tests.

**Run:** platform/agent-core authz suites plus **new** `npm --prefix tool-broker run build` and `npm --prefix tool-broker test` after creating its scripts; real network enforcement tests against a synthetic downstream service.

**Done when:** denied work dispatches zero calls; protected credentials and network routes cannot bypass the broker; ambiguous operations reconcile without duplicate mutation. **Hold if:** enforcement is only a prompt, tool annotation or in-process routing callback.

### Step 17 — Enforce model authority and loaded-config renewal

**PR:** A16. **Prerequisites:** Step 15. **Effort:** 5–8 days. **Owner:** unassigned.

**Files:** existing `shared/gateway-token.ts`, platform `model-route.ts`, `service.ts`, gateway `server.ts`, agent-core model relay/config reload; **new** `model-gateway/test/authz-grants.test.ts`, runtime renewal tests.

- [ ] Replace the enterprise permanent HMAC token path with a separate audience/workload-bound credential and live execution-grant checks.
- [ ] Enforce tenant/model/action/lifecycle limits at every provider dispatch; keep provider secrets in trusted mediation services.
- [ ] Route enterprise direct Responses model configurations through enforced mediation; fixing only translated providers is insufficient.
- [ ] Implement bounded credential renewal/reconfiguration for loaded threads, resume/fork and long-running goals. Do not shorten expiry without renewal.
- [ ] Reject legacy credentials for enforced tenants; migrate/restart existing profiles under a controlled rollout.
- [ ] Test wrong audience/tenant/model, revoked parent, expired token, provider outage, cold resume and renewal races across all supported model routes.

**Run:** gateway/agent-core/platform builds and authz suites; existing gateway adapter/runtime tests with explicit enterprise versus legacy behavior.

**Done when:** M4 mediates every protected provider/tool route with current revocable authority. **Hold if:** any direct provider key or permanent enterprise gateway credential remains in runtime custody.

### Step 18 — Build the access-management experience

**PR:** A17. **Prerequisites:** Steps 06, 09–14. **Effort:** 6–10 days. **Owner:** unassigned.

**Files:** existing `/api/me`, access-management API, frontend tenant selection, agents/connectors, `api.ts`, `transport.ts`, identity/cache modules; **new** scoped settings/share/access components and `frontend/test/authz-access-ui.test.ts`.

- [ ] Read `frontend/AGENTS.md` and the installed Next.js guides for touched routing/components before implementation.
- [ ] Expose evaluated capabilities and scoped access state from the backend; hide unavailable controls without making UI visibility a security gate.
- [ ] Add members/groups/roles/service-client settings, agent scope/publishing and read-only conversation sharing/revocation.
- [ ] Present pending policy publication, denied/revoked access and dependency outages with actionable recovery text; no secret values or engine IDs.
- [ ] Clear identity-dependent caches/streams on tenant switch and removal. Keep personal folders and organization/resource workspaces visually distinct.
- [ ] Verify owner/member/admin/auditor/service management and direct API denial; test keyboard/accessibility and core chat/download flows with authorized actors.

**Run:** frontend `test:authz`, full frontend tests, typecheck and build; platform authz endpoint suites. Use integration fixtures until full launch gating is satisfied.

**Done when:** ordinary users can understand their access without policy-engine knowledge and UI/backend behavior agree. **Hold if:** a hidden button is the only restriction or shares imply collaborative execution.

### Step 19 — Migrate, rehearse recovery and release by tenant

**PR:** A18. **Prerequisites:** Steps 10–18, all earlier milestone evidence. **Effort:** 7–12 days. **Owner:** unassigned.

**Files:** **new** authorization migration/reconciliation scripts, deployment configuration, `docs/authorization/ROLLOUT.md`, `RUNBOOK.md`, `RELEASE_EVIDENCE.md`; existing root scripts/packages, Dockerfiles and readiness checks.

- [ ] Dry-run additive backfills/indexes on a representative isolated snapshot. Report identity conflicts, ownerless content, legacy shared visibility, raw credentials and unbound runtime markers.
- [ ] Reconcile desired/projected policy and isolate/quarantine unresolved content. Preserve stable IDs/generations; no automatic ownership assignment to the first enterprise login.
- [ ] Test mixed-version deployment, pinned model migration and server-side refusal of legacy application/credential paths for enforced tenants.
- [ ] Shadow decisions for diagnostics, then enforce a canary tenant; close/restart incompatible runtime sessions with actionable messages.
- [ ] Run load/noisy-neighbor tests, engine/DB/audit/broker outages, lost invalidation, failover, backup restore and stale-policy recovery. Add cross-instance tenant/client quotas where required by the measured envelope.
- [ ] Complete independent security assessment, incident ownership, customer residency/retention/RPO/RTO commitments and safe rollback rehearsal.
- [ ] Run all required checks including explicit engine/fault suites, frontend and broker; record commit, images, model versions, environment and results without secrets.
- [ ] After approved deployment, observe critical success/deny/error/latency, projection/cleanup/audit backlog, revocation and broker unknown outcomes for the agreed canary window.

**Run:** full existing release checks plus all new authz/integration/fault suites, broker build/tests and benchmark. Run migration/restore/deployment commands only against explicitly approved target environments using the created runbook.

**Done when:** every release gate in the implementation plan has traceable evidence; rollback preserves privacy, tenant binding, generations and deny fences. **Hold if:** restoring availability requires POC identity, admin read-all, stale grants or unbrokered execution.

## 4. Tracking board

### Check commands by step

Use this table for the minimum repeatable package checks. Run the additional existing regression cases named in each step with the package's existing runner. New scripts in this table are usable only after their defining step creates them; tests against real infrastructure also require the isolated fixtures/topology to be running. The benchmark is rerun when policy/publication/list design changes or at the release gate, not after every cosmetic edit.

| Step | Commands from repository root                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `npm --prefix platform run build`; `npm --prefix platform run test:authz`; focused baseline commands above                                                                              |
| 02   | `npm --prefix platform run test:authz`; `npm --prefix platform run build`; `npm --prefix agent-core run build`; `npm --prefix model-gateway run build`                                  |
| 03   | `npm --prefix platform run build`; `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`                                                           |
| 04   | Compose commands above; `npm --prefix platform run test:authz:integration`; `npm --prefix platform run test:authz:faults`; `npm --prefix platform run authz:benchmark`                  |
| 05   | `npm --prefix platform run build`; `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`                                                           |
| 06   | `npm --prefix platform run build`; `npm --prefix platform run test:authz`; `npm --prefix frontend run test:authz`; `node scripts/authz-compiled-smoke.mjs`                              |
| 07   | `npm --prefix platform run build`; `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`                                                           |
| 08   | `npm --prefix platform run build`; `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`; `npm --prefix platform run test:authz:faults`            |
| 09   | `npm --prefix platform run build`; `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`; `npm --prefix platform run test:authz:faults`            |
| 10   | `npm --prefix platform run test:authz`; `npm --prefix frontend run test:authz`; `npm --prefix platform run test:authz:integration`                                                      |
| 11   | `npm --prefix platform run build`; `npm --prefix agent-core run build`; `npm --prefix platform run test:authz`; `npm --prefix agent-core run test:authz`; runtime isolation evidence    |
| 12   | `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`                                                                                              |
| 13   | `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`; `npm --prefix platform run test:authz:faults`                                               |
| 14   | `npm --prefix platform run test:authz`; `npm --prefix platform run test:authz:integration`; `npm --prefix platform run test:authz:faults`; cleanup convergence evidence                 |
| 15   | `npm --prefix platform run build`; `npm --prefix agent-core run build`; `npm --prefix platform run test:authz`; `npm --prefix agent-core run test:authz`                                |
| 16   | `npm --prefix tool-broker run build`; `npm --prefix tool-broker test`; `npm --prefix platform run test:authz`; `npm --prefix agent-core run test:authz`; egress/remote-outcome evidence |
| 17   | `npm --prefix model-gateway run build`; `npm --prefix agent-core run build`; `npm --prefix platform run build`; all three packages' `test:authz` scripts                                |
| 18   | `npm --prefix frontend run test:authz`; `npm --prefix frontend test`; `npm --prefix frontend run typecheck`; `npm --prefix frontend run build`; `npm --prefix platform run test:authz`  |
| 19   | Full existing release commands from Section 2; all added authz/integration/fault and broker checks; `npm --prefix platform run authz:benchmark`; migration/restore/canary evidence      |

### Completion tracker

Unchecked means the step has not satisfied every acceptance/release gate; some unchecked steps have local implementation evidence. Completion of this document does not complete any build step. Replace owner/evidence fields when work begins; track actual effort separately from estimates.

| Done | Step / PR                       | Owner      | Estimate   | Actual effort | Evidence / blockers                                     |
| ---- | ------------------------------- | ---------- | ---------- | ------------- | ------------------------------------------------------- |
| [x]  | 01 / A00 Baseline and inventory | Unassigned | 1–2 days   | —             | —                                                       |
| [x]  | 02 / A01 Contracts              | Unassigned | 2–3 days   | —             | —                                                       |
| [x]  | 03 / A02 Mongo/admission proof  | Unassigned | 4–7 days   | —             | —                                                       |
| [ ]  | 04 / A03 Engine proof           | Unassigned | 5–8 days   | —             | HOLD: p99 target missed, list/HA gates open             |
| [x]  | 05 / A04 Identity expansion     | Unassigned | 3–5 days   | —             | Additive records tested; no customer backfill           |
| [ ]  | 06 / A05 OIDC/JWT               | Unassigned | 5–9 days   | —             | Browser/API tested; live broker attestation pending     |
| [ ]  | 07 / A06 Explicit contexts      | Unassigned | 5–8 days   | —             | Request propagation tested; worker/storage/admin remain |
| [ ]  | 08 / A07 Policy/publication     | Unassigned | 9–15 days  | —             | —                                                       |
| [ ]  | 09 / A08 Resources/lists        | Unassigned | 7–12 days  | —             | —                                                       |
| [ ]  | 10 / A09 Read revocation        | Unassigned | 3–5 days   | —             | Measured emission bound required                        |
| [ ]  | 11 / A10 Runtime isolation      | Unassigned | 8–15 days  | —             | Re-estimate after actual isolation proof                |
| [ ]  | 12 / A11 Roles/sharing          | Unassigned | 5–8 days   | —             | —                                                       |
| [ ]  | 13 / A12 Custom/emergency       | Unassigned | 5–9 days   | —             | —                                                       |
| [ ]  | 14 / A13 SCIM/removal           | Unassigned | 6–10 days  | —             | Directory lifecycle/recovery contract                   |
| [ ]  | 15 / A14 Execution/delegation   | Unassigned | 6–10 days  | —             | —                                                       |
| [ ]  | 16 / A15 Tool broker            | Unassigned | 10–18 days | —             | Downstream idempotency/scope and egress proof           |
| [ ]  | 17 / A16 Model mediation        | Unassigned | 5–8 days   | —             | —                                                       |
| [ ]  | 18 / A17 Access UX              | Unassigned | 6–10 days  | —             | —                                                       |
| [ ]  | 19 / A18 Migration/launch       | Unassigned | 7–12 days  | —             | Assessment/customer/operations gates                    |

For each completed step attach: implementation commit/PR, test commands/results, acceptance evidence, adversarial failure traces, migration/rollback notes and remaining accepted limitations. Do not put credentials, JWTs or private customer content in evidence.

## 5. First execution session

Start with Step 01 only. Preserve the two authorization planning documents and any other working-tree changes. Inspect the harness and route inventory, fix fixture environment leakage, run the focused baseline, and produce `BASELINE.md` plus `ROUTE_INVENTORY.md`. Then review that diff before beginning Step 02. No engine installation or customer configuration is required for the first session.

The original planning pass created documentation only. Implementation is now active in this branch; commands and evidence actually executed are recorded in [BASELINE.md](authorization/BASELINE.md). Unchecked future commands remain proposed work. Validate estimates against actuals at every milestone; measure the system before promising enterprise guarantees.
