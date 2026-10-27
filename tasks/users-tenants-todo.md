# New platform: users, tenants and admin features

Plan: [users-tenants-plan.md](users-tenants-plan.md).
Status: in progress; 2a, 2b, 3a, 3b, 4a, 4b, 4c (2026-10-15) and 5a, 7a, 7b (2026-10-16) done; 4b's real-Google staging check is still open.
Invitations (5b, 7c), analytics (6a, 6b, 7d) and the tenant chooser are on hold; only their high-level design stays in the plan.
Migration branch for `frontend/`: `truex_planv2`.

All implementation paths below refer to the future `platform-next/` unless
prefixed otherwise. Commands for that package are planned and become executable
after task 2. Keep each implementation batch around 3-5 files; split scaffolding
and cross-cutting tasks into smaller reviewable batches rather than creating
one large patch. No tasks modify or import old platform business logic.

## 1. Freeze contracts and permissions

- [ ] Record confirmed operator-only admin grants and the confirmed join flow (signup enters the default tenant immediately) and session lifetimes. Invitation and analytics definitions wait for their plans.
- [ ] Specify typed public/user/tenant/admin API schemas, role matrix, enrollment transitions and exact error states; store record references as MongoDB ObjectIds and serialize wire/JWT IDs as validated 24-character hex strings.
- [ ] Record database namespace allowlist, security boundaries and synthetic fixture cases.

**Dependencies:** none. **Scope:** M.
**Files:** planning documents; new contract/security decision notes.
**Verify:** review every entry path for default user role and every tenant operation for membership authorization. No application/data writes.

## 2a. Scaffold the new application

- [x] Create independent package/lockfile, strict TS configuration, `main.ts` and Nest app module with no imports from `platform/`.
- [x] Implement independent dev/build/start/typecheck/test/format commands with recursive test discovery.
- [x] Validate explicit config/port, graceful shutdown and a startup smoke test.

**Dependencies:** 1. **Scope:** M per package/config and app/startup batches.
**Files:** `package.json`, lockfile, TS config; `src/main.ts`, `src/app.module.ts`, config/test setup in separate batches.
**Verify:** new package typecheck/build and smoke test; scan imports for old backend references.

## 2b. Add Mongo lifecycle and HTTP boundaries

- [x] One Mongo client, explicit catalog/tenant access, readiness/liveness and request IDs.
- [x] Configuration refuses old/unowned namespaces; no default database fallback from an untrusted request.
- [x] Consistent validation/errors and isolated Mongo replica-set fixtures; dependency outage has bounded errors.

**Dependencies:** 2a. **Scope:** M per DB and HTTP batch.
**Files:** `src/database/`, `src/config/`, `src/common/http/`, matching focused tests.
**Verify:** typecheck/build plus HTTP startup/invalid-config/outage tests; confirm fixtures touch only new isolated DBs.

### Checkpoint A

- [x] Independent app starts/tests without old backend imports, old credentials or old database access.
- [x] Startup/cleanup/error behavior and test discovery are verified.

## 3a. Provision tenants and enforce membership roles

- [x] Implement fresh tenants, memberships and indexes: role exactly user/admin, user by default, unique user/tenant relation.
- [x] Idempotent default/organization provisioning marks ready only after required indexes; interrupted setup is safely resumable.
- [x] Same identity has different roles per tenant; request data cannot assign roles or DB names.

**Dependencies:** 2b. **Scope:** M per tenant/provisioning and membership batches.
**Files:** `src/modules/tenants/`, `src/modules/memberships/`, database indexes, focused integration tests.
**Verify:** synthetic multi-tenant schema/provisioning/role tests, duplicate membership and partial-provisioning failure; package typecheck/build.

## 3b. Implement users and controlled admin bootstrap

- [x] Unique verified identity via `identities[{ provider, subject }]` (Google now, enterprise SSO later) and explicit account status; do not store a global tenant role.
- [x] Operator bootstrap is bound to a verified account and exact tenant, repeatable and audited.
- [x] No arbitrary first-user admin promotion; role input/invalid values cannot escalate a membership.

**Dependencies:** 3a. **Scope:** M.
**Files:** `src/modules/users/`, an operator command, audit boundary and tests.
**Verify:** user uniqueness, collision, role/bootstrap permission and retry tests; no actual user/admin accounts created during fixture verification.

## 4a. Implement JWT and revocable sessions

- [x] Issue/verify app access JWTs with required claims, fixed algorithms, issuer/audience/purpose and trusted key rotation.
- [x] Implement hashed rotating refresh credentials, bounded expiry and logout/revocation; preserve origin/CSRF protections.
- [x] Concurrent refresh/replay/logout policy is tested; invalid JWTs cannot fall back to another auth mode.

**Dependencies:** 3b. **Scope:** M per verification and session lifecycle batches.
**Files:** `src/modules/sessions/`, session indexes, configuration and tests.
**Verify:** JWT forgery/substitution/expiry tests; session replay/race/outage integration tests; package build.

## 4b. Deliver direct Google signup/login

- [x] Verify OAuth state/nonce/PKCE and Google identity, then transactionally create/reuse global user and default membership as user.
- [x] Duplicate callbacks/concurrent signup produce one account/membership; unavailable default or disabled account grants no access.
- [x] Return application credentials through a secure handoff, never an access JWT in redirect URLs.

**Dependencies:** 4a. **Scope:** M per OAuth and enrollment batches.
**Files:** `src/modules/auth/`, user/membership persistence, HTTP/integration tests.
**Verify:** real-handler Google fixtures, rollback/race/account-collision tests; separate later real-Google staging check.

## 4c. Deliver account/tenant discovery

- [x] User-only me/tenant-list endpoints work without selecting/opening a tenant.
- [x] One/many/none usable memberships return typed entry outcomes; remembered choices cannot skip the multi-tenant chooser.
- [x] Only caller memberships/public metadata are exposed; disabled/pending tenants and removed memberships are excluded.

**Dependencies:** 4b. **Scope:** M.
**Files:** auth entry orchestration, me controller/contracts, membership queries and focused HTTP tests.
**Verify:** login matrix across synthetic accounts/tenants and missing-tenant discovery; package typecheck/build.

### Checkpoint B

- [x] Fresh direct signup/returning login, JWT lifecycle and one/many/none tenant routing pass through production handlers.
- [x] All new membership paths default to user; per-tenant roles and disabled-account handling are verified.

## 5a. Authorize tenant query requests

- [x] Require one scalar query tenantId and validate JWT/session/user plus active membership/tenant.
- [x] Resolve role from membership and DB mapping from registry; implement tenant metadata endpoint (`GET /tenant`). Capabilities are deferred until the first role-gated feature (invitations/analytics): nothing differs by role yet.
- [x] Reject forged roles and missing/duplicate/object/foreign tenants; simultaneous requests/tabs retain separate context.

**Dependencies:** 4c. **Scope:** M.
**Files:** `src/common/access/`, tenant controller/contracts, authorization tests.
**Verify:** real HTTP request-policy tests, cross-tenant context races, disable/removal cases and DB-resolution assertions.

## 5b. Invitations — on hold

- [ ] Write the separate invitation plan (email provider, Google-account requirement for invitees, email matching rules, re-inviting removed members, create/deliver/accept/resend/revoke, admin page) before any invitation code.

**Dependencies:** decision to resume invitations. Not part of this build.

### Checkpoint C

- [x] Tenant admin A/user B is enforced at the API using multi-tenant test fixtures.
- [x] Tenant URLs authorize independently per tab without session-wide tenant changes; chooser UI remains on hold.

## 6a. Deliver real aggregate identity analytics — on hold

- [ ] Define and persist membership/sign-in event semantics with stable deduplication IDs; invitation metrics return unavailable until invitations ship.
- [ ] Admin-only summary queries are tenant-bound, bounded by UTC ranges and reconcile to synthetic source data.
- [ ] No individual-user usage breakdowns, global user directory or chat content appear in analytics responses.

**Dependencies:** 5a. **Scope:** M per event capture/query batches.
**Files:** `src/modules/analytics/`, audit/event persistence and analytics integration tests.
**Verify:** aggregate reconciliation, duplicate-event and empty-range cases, pagination/range rejection and cross-tenant permission probes.

## 6b. Specify usage integration and availability — on hold

- [ ] Version a trusted usage producer/read-model contract for later chat integration; clients cannot forge trusted usage.
- [ ] Test cumulative main/helper token deduplication, late updates and versioned estimated-cost rules using fixtures.
- [ ] Return availability/asOf/coverage; missing producers or unknown prices produce unavailable metrics rather than false zeroes.

**Dependencies:** 6a. **Scope:** M.
**Files:** usage contracts, aggregate reader and focused tests; producer wiring deferred to the conversation phase.
**Verify:** source-to-total fixtures, retries, late updates and unavailable-vs-zero/cost cases. Do not claim live usage ingestion is complete.

## 7a. Move the existing frontend's API/auth layer to platform-next

- [x] Create the `truex_planv2` branch; point the forwarder at `platform-next/` there and keep `main` on the current backend.
- [x] Replace the session-cookie login layer (`lib/session.ts`, `lib/login.ts`, `lib/workspaces.ts`) with an in-memory access JWT, a refresh cookie, coordinated refresh and cross-tab logout. No JWTs in URLs/localStorage.
- [x] `api()` in `lib/api.ts` attaches the JWT and exactly one `?tenantId=` taken from the route; global discovery calls carry no tenant.

**Dependencies:** 4c and 5a. **Scope:** M per forwarder, auth and request batch.
**Files:** `frontend/lib/` auth/api/forward modules, matching tests in `frontend/test/`.
**Verify:** `npm --prefix frontend test`, `run typecheck`, `run build`; proxy/auth integration checks against `platform-next/`.

## 7b. Wire the existing login and the tenant layout

- [x] Keep the existing login screen (`components/auth/login-card.tsx`, `google-button.tsx`); point it at the new Google start/complete flow. No new screen design.
- [x] After signup or login, go straight to `/t/[tenantId]/chat` for the default tenant; refresh keeps the route's tenant. The chooser (`/select-tenant`) stays on hold.
- [x] Add the `/t/[tenantId]/...` tenant layout; extract session/tenant loading out of `app/page.tsx` so a tenant change resets state. Chat shows its shell only.
- [x] User/tenant-keyed caches reject stale responses; removed membership and unavailable backend have explicit recovery states.

**Dependencies:** 7a. **Scope:** M per login wiring and layout slice.
**Files:** `frontend/components/auth/`, `frontend/app/` routes/layout, `app/page.tsx` extraction, matching tests.
**Verify:** real-browser new signup, returning login, refresh, multi-tab, stale-response and direct-route access cases plus package checks.

## 7c. Invitation pages — on hold

Deferred with task 5b. The existing `components/invite/` code is reworked when the invitation plan resumes.

## 7d. Deliver tenant analytics page — on hold

- [ ] Design the analytics screen from the spec's foundations and get it approved first.
- [ ] Only the selected tenant's admin sees aggregate analytics with valid bounded dates and loading/error/empty states.
- [ ] Real counts reconcile with the backend; unavailable usage/price data differs from known zero and estimated cost is labeled.
- [ ] No private chat content or individual usage drilldown; changing tenant/role immediately removes inappropriate content.

**Dependencies:** 7b and 6a-6b. **Scope:** M.
**Files:** `frontend/app/t/[tenantId]/admin/analytics`, analytics components and focused tests.
**Verify:** browser user/admin/multi-tenant, known-empty/unavailable/partial/error data, keyboard/mobile and frontend package checks. Chat implementation remains later work.

### Checkpoint D

- [ ] Google signup/login into the default tenant works in staging with a fresh identity/data realm.

## 8. Prepare deployment and eventual replacement

- [ ] Separate new credentials/DB namespace/keys/audience/cookies/port/callback configuration; independently build/run the new image.
- [ ] Verify the real Google flow, auth throttling, restore/recovery and measured query/latency behavior in staging.
- [ ] Record remaining old-platform capabilities, replacement prerequisites and rollback behavior preserving fresh writes; update root scripts/proxy only in a reviewed cutover task.

**Dependencies:** 7a and 7b plus later conversation/runtime work before full replacement. **Scope:** M per packaging, rehearsal and cutover batch.
**Files:** new Dockerfile/runbook/README; root runners/deployment config only at integration; validation report.
**Verify:** new package tests/typecheck/build/format/audit, container startup/health/shutdown and live staging smoke checks. Record actual results and limitations.

### Final gates

- [ ] All role/user/tenant acceptance cases and meaningful failure/concurrency tests pass.
- [ ] No imports from legacy platform implementation; no old database adoption/deletion; final diff reviewed.
- [ ] Identity/tenant foundation completion is distinguished from full backend replacement.
- [ ] Full replacement occurs only after every product-required conversation/runtime/connector capability has its own implementation and verification evidence.


## Frontend integration verification — 2026-10-16

Tasks 7a/7b now route the existing login flow through platform-next, complete
sign-in at `/auth/complete`, and open an authorized `/t/[tenantId]/chat` shell.
Legacy chat code is retained in `frontend/legacy/chat.tsx` outside the route tree.
Retired invitation links redirect to login while invitations are on hold.

Evidence and reproduction: [frontend integration report](../verification-reports/platform-next-frontend-2026-10-16.md).
Real Google staging, production cutover and chat execution remain open.
