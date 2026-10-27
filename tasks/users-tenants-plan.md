# Plan: New platform backend — users, tenants and admin features

Status: detailed proposal, revised after review on 2026-10-15; implementation has not started.
Date: 2026-10-15.
Task checklist: [users-tenants-todo.md](users-tenants-todo.md).

## 1. Confirmed direction

Build a new, independent backend in `platform-next/`, alongside the existing
`platform/`. Use fresh databases. Replace the old backend only after the new
backend has been verified against the capabilities needed for that release.

This is new implementation: a new application root, domain modules, data access,
contracts, tests and deployment configuration. Do not import business logic,
Store/PlatformService facades or middleware from the old platform. Existing
source and tests are reference material for lessons and failure cases, not the
new application's architecture.

Confirmed requirements:

- Google identifies the account. Every new direct signup joins a shared default tenant.
- Invitations grant access to specific tenants with their own databases.
- Every customer (enterprise) tenant has its own database. This is a hard requirement for enterprise isolation and later enterprise SSO.
- Invitations are on hold for this build. This plan keeps only their high-level DB and code design; a separate invitation plan covers the details before implementation.
- Only the platform operator grants admin. All tenant-admin invitations create users.
- All user identities live in a shared catalog; memberships connect users to tenants.
- MongoDB ObjectIds identify new records and their internal references; API/JWT identifiers serialize those IDs as 24-character hex strings.
- User identity comes from a verified application JWT. A tenant-scoped request selects its tenant through a single `tenantId` query parameter.
- Roles are exactly `"user" | "admin"`, scoped to each tenant membership. The default role is `"user"`.
- A person can be an admin in tenant A and a user in tenant B.
- One usable tenant opens directly after login. Multiple usable tenants require a chooser after each normal login. In this build every user has only the default tenant, so the chooser screen is on hold.
- Analytics is on hold; only its high-level design stays (section 8). When it ships it shows tenant-wide aggregates and usage, without individual-user drilldowns or chat content.
- Admins have no extra screens in this build. The role is stored now so analytics and invitations can use it later.
- Chats remain private to their owner, including when another tenant member is an admin.

Immediate implementation scope is users, the shared default tenant, memberships
and per-tenant authorization. Invitations and analytics are on hold: sections
marked "on hold" keep their high-level design only. The full conversation/runtime
implementation and full chat UI are later work.

In this build users join only through Google signup, so everyone belongs to the
default tenant and goes straight to it. Customer tenants, the chooser and adding
users to customer tenants return with invitations. The data model and tenant
authorization still support many tenants from day one.

## 2. Admin authority and proposed technical defaults

Confirmed admin-grant policy: only the platform operator assigns the admin role.
Tenant-admin invitations always create `"user"` memberships. Tenant admins cannot
invite/promote another admin, and no public signup path creates an admin.

Technical defaults proposed for this plan:

- Stack: TypeScript with NestJS feature modules, MongoDB native driver and REST/OpenAPI.
- JWT access lifetime: 10 minutes. Refresh session: 7-day absolute lifetime and 24-hour idle lifetime.
- Access JWTs in browser memory; opaque rotating refresh credentials in secure HttpOnly SameSite cookies. No access JWTs in URLs or localStorage.
- Confirmed join flow: Google signup enters the default tenant immediately; invitation acceptance (on hold) enters the invited tenant immediately. Neither needs a second login.
- Operator-managed tenant provisioning initially. Customer tenant creation, billing, arbitrary role editors and per-user analytics are outside this phase.
- User/tenant removal initially means disabled/removed status. Historical erasure and retention need a separate explicit policy before public production operation.

Open decisions:

- Re-inviting a removed member (invitation plan). Proposed default: only a new admin invitation can reactivate a removed membership, always as `"user"`; signup never does.
- Enterprise SSO protocol (OIDC or SAML) and how a tenant maps to its identity provider (later SSO plan). The user schema below already allows extra providers.

## 3. New folder and module ownership

Proposed layout; create files when implementing their capability, rather than
generating empty modules in advance:

```text
platform-next/
  package.json
  package-lock.json
  tsconfig.json
  .env.example
  README.md
  Dockerfile
  src/
    main.ts
    app.module.ts
    config/                  validated startup settings
    database/                one Mongo client, catalog access, tenant DB resolver, indexes
    common/
      http/                  validation, response/error mapping, request IDs
      access/                guard composition, route policies, immutable request context
    modules/
      users/                 global account identity and profile
      tenants/               registry, default tenant and provisioning
      memberships/           per-tenant role, membership lifecycle and access lookup
      sessions/              JWT verification/issuance, refresh, revocation
      auth/                  Google/OIDC and signup/entry orchestration
      invitations/           on hold; added with the separate invitation plan
      analytics/             on hold; bounded tenant aggregate queries and usage contracts
      audit/                 structured security events
    contracts/               public request/response schemas; no runtime internals
  scripts/                   operator setup, controlled admin assignment, index setup
  test/
    unit/
    integration/
    http/
    fixtures/
  docs/
    api/
    decisions/
    runbooks/
```

Use controllers for HTTP parsing/response semantics, services for business rules
and small Mongo-specific repositories for persistence. Add a repository only
where it owns meaningful queries or transactions. No generic base repository,
universal service or single cross-domain facade.

Logical provider dependencies:

- Users and tenants depend on database/configuration.
- Memberships depend on users and tenants.
- Sessions depend on users and their own session storage.
- Invitations (on hold) will depend on users, tenants, memberships and a mail boundary.
- Auth orchestrates Google verification, sessions and direct enrollment; invited enrollment arrives with invitations.
- Analytics (on hold) will depend on authorized tenant context and explicit event/read models.
- HTTP guard composition consumes these services; domain services do not import controllers or guards.

Keep public-provider boundaries small. Resolve cross-domain enrollment in one
orchestrator rather than making modules import each other cyclically.

## 4. Fresh database layout and schemas

Use an explicit new namespace, for example `truex_next_catalog`,
`truex_next_t_default`, and server-generated names for other new tenant DBs.
Names are proposals finalized in environment setup. Do not point the new app at
old databases, auto-adopt existing data, copy accounts or run destructive resets.
The existing app and its data remain available independently.

One catalog database holds the following collections.

### ObjectId storage and API contract

Use MongoDB `ObjectId` values for user, tenant, membership, invitation and session
`_id` fields. Store `userId`, `tenantId`, `inviteId`, `invitedBy` and other record
references as ObjectIds as well. Do not mix string and ObjectId references in Mongo queries.

Serialize those IDs as canonical 24-character hexadecimal strings in JSON, URLs
and JWT claims. `sub` is the string form of the user's `_id`; `sid` is the string
form of the session `_id`; query `tenantId` is the string form of the tenant `_id`.
The backend validates the exact wire format and converts to ObjectId at the boundary.
The browser treats IDs as opaque strings and never manufactures identity values.

Google subjects, OAuth state, invitation secrets, refresh credentials, external
event IDs and idempotency keys keep their appropriate string/random formats;
ObjectIds are identifiers, not authentication secrets. References remain logical
relationships enforced by the application rather than Mongo foreign keys.

Default-tenant configuration stores its new tenant ObjectId in string form. The
registry maps this ID to a server-controlled DB name; the ID is not a client-selected DB name.

### users

- `_id`: server-generated MongoDB ObjectId, stable for this account.
- `identities`: array of `{ provider, subject }`, for example `{ provider: "google", subject: "<Google sub>" }`.
  Only Google is used now. `provider` names the exact identity provider, so enterprise SSO providers can attach later without a data migration.
- `email`, `emailKey`, `name`, optional `picture`: validated profile.
- `status: "active" | "disabled"`.
- `createdAt`, `updatedAt`, `lastLoginAt`: Mongo Date values.
- No global tenant role. An email change must not create/merge accounts automatically.

Unique index on `(identities.provider, identities.subject)`; define and test normalized-email collision handling explicitly.
If email uniqueness is enforced, reject collisions rather than linking identities.

### tenants

- `_id` as ObjectId, `name`, backend-controlled `dbName`.
- `kind: "default" | "organization"`.
- `status: "active" | "disabled"`.
- `provisioningStatus: "pending" | "ready" | "failed"`.
- `createdAt`, `updatedAt`.

Unique `dbName`. Default-tenant identity is explicit configuration plus a validated
registry record; a missing/misconfigured default refuses signup rather than
opening another database. Provisioning is repeatable and checks ownership before
creating or adopting storage. Default signup never creates another DB per user.

Every customer tenant gets its own database. Before onboarding many tenants,
check the MongoDB host's database/collection limits for the chosen tier against
the expected tenant count, and record the result.

### memberships

- `_id`, `userId`, `tenantId`, all stored as ObjectIds.
- `role: "user" | "admin"`, assigned server-side, default `"user"`.
- `status: "active" | "removed"`.
- `joinedVia: "signup" | "invitation" | "operator"`.
- Optional `inviteId`; `createdAt`, `updatedAt`.

Unique `(userId, tenantId)`. Add indexed access paths for active memberships
by user and by tenant. A removed membership is not restored by ordinary signup.
Check references in the application: MongoDB does not enforce these foreign keys.

### invitations (on hold)

High-level design only; the separate invitation plan finalizes fields, states and indexes.

- `_id`, `tenantId` as ObjectIds, normalized invited `emailKey`, delivery email.
- `role`, default `"user"`; invitations cannot grant the admin role.
- `tokenHash`, `expiresAt`.
- `status: "pending" | "accepted" | "revoked"`; expired is derived from deadline.
- `invitedBy`, optional `acceptedBy`, `acceptedAt`, `revokedAt`.
- `createdAt`, `updatedAt`; delivery state tracked separately from acceptance.

Unique token hash and partial unique `(tenantId, emailKey)` for pending invites.
Explicitly retire an expired pending record before allowing a replacement;
do not rely on TTL timing to enforce validity. Index invitation listing by tenant/time.

### auth_sessions and oauth_flows

- Session ID, `userId`, hashed refresh credential/generation, creation, idle/absolute
  expiry and revocation state. No selected tenant or authoritative tenant role.
- OAuth state/nonce/PKCE and short-lived enrollment intent, including invitation
  binding when applicable.
- Unique refresh hashes/session IDs and expiry/lookup indexes.

Access JWT claims: `sub` (user ID), `sid`, `iss`, `aud`, `iat`, `exp`
and explicit access-token purpose/type. Keep private data and membership lists out.

### security_audit, analytics_events and delivery_outbox

- Audit records: actor ID, tenant ID, action, result, timestamp and request ID.
  No message content, credentials, raw invitation links or raw email in logs.
- Catalog analytics events (on hold with analytics): successful sign-ins and membership/invitation lifecycle
  events with stable IDs and UTC timestamps; define each metric's event source.
- Durable invitation delivery jobs (on hold with invitations): deduplication key,
  attempt/next-attempt state, lease and bounded retry metadata. The worker creates
  the invite token at send time and stores only its hash, so no raw link is ever
  queued; resend issues a new token.
- Set and enforce field retention before public production release.

Each tenant has its own database. In this phase it can contain tenant metadata
and the later `usage_events` read model. Chats/messages/agents are not fabricated
or provisioned with fake data. Default-tenant users share a DB but never gain
access to one another's conversations.

## 5. Authentication, tenant authorization and permissions

Tenant request contract:

```http
GET /api/v1/tenant?tenantId=507f1f77bcf86cd799439011
Authorization: Bearer <application-access-jwt>
```

Every tenant-scoped request must:

1. Verify signature with configured trusted keys/algorithm, issuer, audience,
   access-token purpose, expiry and required claims.
2. Resolve the active user and live server-side session.
3. Require exactly one scalar `tenantId`; reject repeated, malformed, missing,
   object, array or empty values.
4. Check the active membership and active/ready tenant using current catalog state.
5. Derive the role from that membership, apply route permission, and resolve DB
   from the registry only if the operation needs tenant storage.
6. Pass an immutable `{ userId, tenantId, role }` context to the operation.

No global selected-tenant mutation, client role headers, body-supplied ownership,
silent default tenant or JWT-error fallback. User-only endpoints do not require
a tenant. Public OAuth/invitation entry endpoints have separate narrowly defined policies.

Role permissions:

- `user`: own profile, own memberships, access to an authorized tenant and later own chats.
- `admin`: the same user features; tenant analytics and invitation management are added when they ship.
- An admin role grants no access to another tenant, global accounts, individual usage breakdowns or another user's chat content.
- Platform operator provisioning is a separate trusted CLI/control-plane permission, not a third customer role.
- UI capabilities are returned from current permissions. Hiding a page is not authorization.
- Direct signup and omitted invitation roles always produce `"user"`; reject invalid roles and unauthorized requests for `"admin"`.
- Bootstrap an admin through an explicit operator command bound to an existing verified user and exact tenant. Never promote the first arbitrary signup.

New requests observe committed membership/account/tenant changes. An operation
already authorized and executing may finish; stricter mutation checks belong in
the relevant transaction. Later long-lived chat streams need explicit revocation
handling before they are added.

## 6. Complete user journeys

### Direct registration and future login

Google start → verify callback/state/nonce/PKCE → identify by Google subject →
atomically create user/default membership as user when new → issue app session →
return account and usable memberships.

Returning accounts reuse the same identity. Disabled accounts and removed memberships
do not regain access through signup. Ordinary login never consumes pending invitations.

Entry result is typed as `enterTenant`, `chooseTenant` or `noTenant`.
One usable tenant enters it; multiple require choice even after a remembered choice.
No usable tenant shows a recovery/access-required state.

### Invitation journey (on hold)

High-level flow kept for the invitation plan:

Admin submits invitation → backend authorizes tenant admin → records invite and
delivery job → email link → explicit acceptance with matching Google account →
transactionally create/reuse global identity and activate membership → issue/retain
the authenticated session and enter the invited tenant.

A logged-in matching user can accept without creating another account. Expired,
revoked, wrong-account and disabled-tenant cases grant no access. Concurrent/repeated
acceptance creates one membership. Do not silently upgrade an existing active
membership through a new invitation.

### Tenant switching

The chooser/tab stores presentation state and sends that tenant ID with each
request. Switching does not rewrite the login session or mint a tenant-specific
identity token. Independent tabs may use different authorized tenants.

### Admin pages

Invite users (on hold): list invitations, create, resend and revoke; show queued/sent/failed,
pending/accepted/expired/revoked states accurately. Invitations always create users; there is no admin-role selector. Disable duplicate submission and provide actionable errors.

Analytics (on hold): date range, tenant summary, membership activity (invitation activity once invitations ship), and usage
metrics when their real source is integrated. Only authorized tenant admins enter.
No individual-user leaderboard, private prompt text or chat-history drilldown.

## 7. Proposed new API surface

All paths are newly designed `/api/v1` contracts, not claims about existing APIs.

Public/auth-flow:

- `GET /auth/google`: begin direct/invited flow, binding intent server-side.
- `GET /auth/google/callback`: verify Google response and complete enrollment.
- On hold: `POST /auth/invitations/inspect`: accept opaque invite token in body; return minimal safe preview.
- On hold: `POST /auth/invitations/accept`: accept under verified identity or establish the bound Google acceptance flow; exact response states are specified before implementation.

Session/user-only:

- `POST /auth/refresh`: rotate refresh credential and issue access JWT.
- `POST /auth/logout`: revoke session; repeat safely.
- `GET /me`: caller profile.
- `GET /me/tenants`: only caller's usable memberships, entry result and per-tenant capabilities.

Tenant user:

- `GET /tenant?tenantId=...`: public tenant metadata and caller membership/capabilities.

Tenant admin, on hold until the invitation plan:

- `GET /invitations?tenantId=...`: cursor-paginated list.
- `POST /invitations?tenantId=...`: create invitation.
- `POST /invitations/:id/resend?tenantId=...`: resend/replace generation safely.
- `DELETE /invitations/:id?tenantId=...`: revoke.

Tenant admin, on hold with analytics:

- `GET /analytics/summary?tenantId=...&from=...&to=...`.
- `GET /analytics/usage?tenantId=...&from=...&to=...&interval=day`.

Typed schemas/OpenAPI specify required fields, bounds, response/error shapes,
pagination, request IDs and permission metadata. An invitation ID is looked up
with its authorized tenant, not globally then trusted. Tenant-admin role edits, user directory
and tenant deletion endpoints are not silently added.

Use one error envelope: `{ error: { code, message }, requestId }`.
400 invalid request; 401 invalid/missing login; 403 forbidden tenant/action;
404 missing resource within authorized scope; 409 conflicting state;
429 throttled; 503 unavailable dependency. Refuse unauthorized tenant selection
without disclosing registry/database details.

Stable intent/idempotency keys protect invitation creation/resend; duplicates
with a different payload fail, and in-flight duplicates have a bounded explicit outcome.

## 8. Analytics contract and honest scope (on hold)

High-level design kept for when analytics resumes.

Confirmed visibility: tenant-wide aggregates and usage. Phase A supports metrics
whose sources exist with users/tenants: current active members, joins in a UTC
time range and sign-in activity. Invitation metrics stay unavailable (not zero)
until invitations ship.
Define snapshots versus events clearly; a successful sign-in is not a chat interaction.

Phase B, after real conversation/runtime integration, adds conversation/turn
counts, input/cached-input/output token usage, failures and estimated cost.
The analytics page exposes availability/coverage and `asOf` for every metric.
Unavailable data is `null` with a reason, not a fabricated zero. A real zero is
returned only for a known-complete empty interval.

Per-tenant usage records use a stable producer/source ID, event time, model ID,
token counts and status. Deduplicate retries and update cumulative records rather
than summing repeated usage snapshots. Avoid double counting main/helper usage
and overlapping token categories. No message bodies or titles are required.

Estimated cost requires a versioned price source, currency, token-category rules
and a visible estimate label. Unknown pricing produces unavailable cost.
No claim of provider-billed accuracy or imported legacy usage.

Start with indexed bounded aggregations. Proposed limit: 90-day daily ranges,
UTC inclusive start/exclusive end; reject unbounded/invalid ranges. Add rollups
only if measurements show a need, and specify late-arriving-event correction.
Ordinary client requests cannot submit trusted usage events.

## 8b. Frontend strategy — change the existing frontend in place

Confirmed 2026-10-15: keep `frontend/` and move it to `platform-next/` step by
step. Users and tenants come first; chat moves later, together with its backend.
There is no `frontend-next/`.

Keep:

- UI components and the design-spec look (`docs/truex-design-spec.html`).
- The `api()` request function in `lib/api.ts`, which almost every call goes through.
- The same-origin forwarder (`app/api/[...path]`, `app/auth/[...path]`, `lib/forward.ts`).
- Per-user/per-tenant browser data scoping in `lib/identity.ts`.
- Existing tests, updated where behavior changes.

Replace:

- The session-cookie login layer (`lib/session.ts`, `lib/login.ts`, `lib/workspaces.ts`)
  with an in-memory access JWT plus a refresh cookie.
- Server-remembered tenant selection with a tenant taken from the route and sent
  as `?tenantId=` by `api()`.
- Session and tenant loading inside `app/page.tsx` (2,888 lines): extract it into
  the tenant layout so a tenant switch resets state. A focused extraction, not a rewrite.
- Nothing on the login screen's look. Reuse the existing login (`components/auth/login-card.tsx`,
  `google-button.tsx`) and change only what it calls. The tenant chooser and analytics
  screens are on hold, so no new screens are designed in this build.

Backend pairing during the migration: fresh databases make old and new accounts
separate realms, so one browser session cannot log in through `platform-next/`
and use chat on the old platform. Do the migration on the `truex_planv2` branch, where the
forwarder targets `platform-next/` (`PLATFORM_INTERNAL_URL`); `main` keeps the
current frontend/backend pairing. Chat shows only its shell on the branch until
chat moves. Rebase the branch on `main` often and merge it only at cutover.

Later chat migration: `lib/transport.ts` opens live streams with `EventSource`,
which cannot send an `Authorization` header. The chat plan chooses between a
`fetch`-based stream reader and the forwarder attaching the token server-side.

### Page and layout boundaries

- `/login` (existing route): Google entry, authentication errors and recovery.
- `/auth/complete`: complete the authenticated callback handoff/refresh without JWTs in the URL; route by the backend entry outcome.
- On hold: `/select-tenant` (existing route): chooser for multiple memberships and recovery for no usable tenants.
- On hold: `/invite/[token]`: invitation preview, explicit acceptance and wrong-account/expired/revoked states.
- `/t/[tenantId]/chat`: tenant shell, sidebar and later private conversation interface.
- On hold: `/t/[tenantId]/admin/invitations`: admin-only invitation management; no admin-role selector.
- On hold: `/t/[tenantId]/admin/analytics`: admin-only tenant aggregates and usage availability.

The tenant ID in the UI route provides refreshable, tab-local navigation state.
The shared API adapter derives the required `?tenantId=...` for backend requests
from that route. UI routing and API query addressing are separate contracts.
With only the default tenant, login goes straight to `/t/[tenantId]/chat`. Once users can have several tenants, normal login shows the chooser; an already
authenticated page refresh restores its authorized route rather than forcing
another login/chooser. Invitation acceptance (on hold) will enter its invited tenant.

Keep the tenant layout focused on tenant name, switcher, sidebar, account/logout
and capability-dependent navigation. The later chat page adds the central chat
and collapsible activity panel. Admin pages use that same layout without loading
chat state, subscriptions or conversation data.

### Frontend code placement

New code goes into the existing folders: routes and layouts in `app/`, auth,
tenant and API code in `lib/`, screens in `components/`. Follow the existing
patterns there. Do not introduce a global store unless actual state sharing requires it.

### Authentication and tenant state

Use one user/session provider and a route-scoped tenant provider. The shared API
adapter attaches the access JWT, adds exactly one tenant query value when needed,
and maps typed errors. It must not attach tenant parameters to global discovery
or use a stale globally selected tenant instead of the calling page's context.

The same-origin Next forwarder passes `Authorization`, preserves the query and
forwards refresh cookies/Set-Cookie only to the configured new backend. It never
uses a browser-supplied backend URL. Protected reads remain backend-authorized;
presentation layouts alone do not grant access.

Keep access JWTs in memory and refresh credentials HttpOnly. Coordinate refresh
requests across tabs so rotation does not produce races; broadcast account/logout
events, not a global tenant selection. Retry after authentication refresh only
when the request's outcome is known safe; do not repeat uncertain mutations.
On final 401 clear identity; on tenant 403 clear that tenant's private state and
offer another authorized tenant. A dependency outage is an unavailable state,
not a fake logout.

Until an explicit server-authenticated rendering contract is introduced, server
components render public structure and private data loads through the verified
client API boundary. Do not cache private responses publicly or serialize the
browser access JWT into rendered page markup.

### State isolation and page behavior

Key any private cached data by user ID, tenant ID and resource. On account/tenant
changes abort obsolete requests, remove old private content and ignore late
responses. Tenant switching stays local to its tab; logout clears all tabs.
Role changes revalidate capabilities; an admin in A who enters B as user loses
admin navigation, and the backend refuses direct admin requests independently.

Invitation actions show queued/sent/failed delivery and actual acceptance states,
prevent duplicate submission and preserve useful recovery. Analytics (on hold) show bounded
date ranges, loading/error/empty states, and unavailable-versus-zero usage clearly.
Follow the design spec, with accessible keyboard/focus behavior and responsive layouts.

Build in working slices: app/API/auth foundation; Google login and entry routing;
tenant layout; chooser, analytics and invitation pages after they come off hold;
chat/activity implementation only after its backend is ready. Verify each against
the real new API and isolated fixtures before broadening scope.

## 9. Implementation phases and exit criteria

### Phase 0 — Contracts and security model

Record the confirmed operator-only admin policy, schemas, event definitions, API states,
privacy boundaries and test fixtures. Record accepted decisions before coding.

Exit: signup and role scenarios are observable, and each route is
classified as public, user-only, tenant-user or tenant-admin.

### Phase 1 — Independent runnable foundation

Create `platform-next/` with strict TypeScript, Nest module composition, validated
configuration, explicit fresh catalog/default DB names, one Mongo client,
readiness/liveness, errors, request IDs and isolated test fixtures. Add independent
dev/build/typecheck/test/format commands and a separate local port.

Exit: new app starts/stops independently; readiness fails on unavailable storage;
invalid configuration fails startup; no old platform imports or database writes.

### Phase 2 — Provisioning and roles

Implement fresh tenant provisioning, indexes, users/memberships and operator
command to bootstrap an admin. A command to add a user to a customer tenant waits
until customer tenants are needed; tests create multi-tenant fixtures directly. Default all new membership paths to user. Tenant provisioning transitions
pending → ready/failed safely and is repeatable after interruption.

Exit: default and organization tenants have distinct DBs; same user can have
different tenant roles; clients cannot set role or DB mapping.

### Phase 3 — Google login and JWT sessions

Deliver direct signup/login, refresh, logout and tenant discovery as working HTTP
slices. Use Google identity verification, transactions and unique constraints.
Test refresh races, replay, expiry and disabled users.

Exit: new/repeated/concurrent signup creates one account/membership; JWT identity
is verified; refresh/revocation works; one/many/none entry behavior is correct.

### Phase 4 — Tenant authorization

Implement query tenant guards and admin route permissions. The invitation
lifecycle is on hold and moves to the separate invitation plan.

Exit: admin A cannot use admin routes in tenant B; a user cannot reach admin
routes; forged roles and foreign tenant IDs are refused; no accidental role elevation.

### Phase 5 — Aggregate analytics foundation (on hold)

Deferred with analytics; kept for reference.

Implement real membership/sign-in event metrics and bounded admin-only
queries. Define and test the usage producer contract and unavailable-data states.
Do not connect legacy tenant DBs to supply missing usage.

Exit: fixtures reconcile with reported counts; no cross-tenant or per-user leakage;
unknown metrics differ from zero; repeated events do not inflate totals.

### Phase 6 — Frontend integration and verification

On the migration branch (8b), connect the existing `frontend/` to `platform-next/`
in separate slices: JWT login layer, the existing Google login wired to the new API,
then the tenant layout with capability navigation. Read `frontend/AGENTS.md`
and the installed Next documentation before UI work. `main` keeps the current
frontend/backend pairing until cutover.

Exit: browser tests prove role-dependent navigation plus direct API permission
checks; tabs use independent tenants; refresh/relogin recovers cleanly.
Chat entry can show its shell, but real chat stays outside this milestone.

### Phase 7 — Replacement readiness

Exercise real Google integration in staging with test accounts, verify
deployment/security configuration, restore procedures and observed lookup/query
performance. Produce explicit API parity/remaining-capability inventory.

Exit: identity/tenant/admin foundation is independently usable in staging.
Replacing the entire old platform still requires the later conversation/runtime/
connector capabilities needed by the product to be implemented and verified.
The first milestone is not permission to route old chat traffic to an incomplete backend.

## 10. Verification, failure review and release safety

Core acceptance fixtures: two users, default plus two organization tenants;
one person admin in A/user in B, another user only in A. Use isolated MongoDB
replica-set fixtures to test transactions. Do not read production data to build fixtures.

Attempt: forged/wrong-purpose/expired JWTs, stale sessions, forged roles, query
arrays/duplicates, unauthorized tenant IDs, concurrent signup/refresh, revocation
during requests, Mongo outage, interrupted provisioning and reused usage events.
Invitation attacks (ID swapping, email mismatch, accept/resend races, mail timeout)
move to the invitation plan.

Check authorization in HTTP tests, not only service unit tests. Measure query
counts and latency on synthetic representative sizes; do not claim scale without
a measured target. One application process, connection pooling, indexed lookups
and bounded aggregations are the initial design; avoid unnecessary new services.

New package command contract (to be implemented during scaffolding):
`dev`, `build`, `start`, `typecheck`, `test`, `test:unit`,
`test:integration`, `test:http`, `format:check`.
Proposed verification commands, not currently executable:

```sh
npm --prefix platform-next run typecheck
npm --prefix platform-next test
npm --prefix platform-next run build
npm --prefix platform-next run format:check
npm --prefix platform-next audit --omit=dev
```

Frontend checks use the existing `frontend/` commands on the migration branch:
`npm --prefix frontend test`, `npm --prefix frontend run typecheck`,
`npm --prefix frontend run build`, plus real browser verification.
Add root runner/build/container wiring only in its explicit integration task.

Keys and OAuth secrets come from deployment secrets; fixed signing algorithms,
trusted keys, issuer/audience and refresh/session settings are validated at startup.
Review JWT/email dependencies and lockfiles before installation; never port old
development shared-admin identity defaults into the new backend.
Use shared rate-limit enforcement for multi-instance auth/invite operations;
choose its Mongo-backed implementation and limits during the security contract task.

Fresh databases mean no account or chat migration is required. They do not
authorize deletion of old storage. Use separate app/database credentials, signing
keys, cookies/audiences and OAuth callback configuration during coexistence.
If infrastructure is shared, enforce an allowlist of the new database namespace.

Before replacement: complete required capabilities, verify backups/restores,
build images, document environment/port/proxy changes and token invalidation,
then schedule a controlled switch. Do not rename folders or change root scripts
as an implicit side effect of scaffolding. Keep the old image/configuration/data
for a defined recovery window. Old and new fresh account/data realms cannot be
merged by rollback; make any switch back explicit and preserve new writes.

## 11. Definition of done for this foundation

- New independent backend with fresh catalog and per-tenant DBs.
- Google registration/login, application JWTs, refresh/logout and tenant discovery.
- Exactly user/admin roles, user by default, enforced per membership.
- Existing login screen working against `platform-next/` on `truex_planv2`, entering the default tenant.
- Invitation and analytics high-level designs recorded for their separate plans.
- Identity/role/tenant isolation, failure and concurrency tests with recorded results.
- Staging deployment/runbook and explicit later work before full platform replacement.
- Owner-only chat requirement retained for the later chat implementation.

## Implementation references

- [NestJS modules](https://docs.nestjs.com/modules): explicit feature-module boundaries and exported provider interfaces.
- [JWT Best Current Practices, RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html): algorithm, issuer/audience and token-purpose verification.
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect): Google subject and identity verification.
- [MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/): transactional writes and deployment requirements.

Folder/schema/API names and token lifetimes above are application design proposals;
the references do not prescribe them.
