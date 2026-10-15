# platform-next

The rebuilt Truex backend: users, tenants and memberships. It runs alongside
`platform/` on its own port with its own databases, and imports nothing from it.

Plan: [`tasks/users-tenants-plan.md`](../tasks/users-tenants-plan.md).

## Run locally

Needs Node 24 and a MongoDB replica set (transactions require one).

```sh
cp .env.example .env
npm install
npm run dev
```

- `GET /health/live`: the process is running.
- `GET /health/ready`: the app can reach MongoDB (503 when it cannot).
- `GET /api/v1/auth/google`: starts Google sign-in (redirects to Google).
- `GET /api/v1/auth/google/callback`: finishes it, sets the refresh cookie and
  redirects to `/auth/complete`, or to `/login?error=<code>` with one of
  `cancelled`, `expired`, `rejected`, `unavailable`, `account_disabled`,
  `email_in_use`, `signup_unavailable`. No token is ever put in a URL.
- `POST /api/v1/auth/refresh`: rotates the refresh cookie and returns a new
  10-minute access token (409 when another tab refreshed first; retry).
- `POST /api/v1/auth/logout`: ends the session; safe to repeat.
- `GET /api/v1/me`: the caller's profile (`Authorization: Bearer <access token>`).
- `GET /api/v1/me/tenants`: the caller's usable tenants with their role, plus
  where to go after sign-in: `enterTenant` (exactly one), `chooseTenant`
  (several; always show the chooser) or `noTenant`. Takes no `tenantId`.
- `GET /api/v1/tenant?tenantId=<id>`: the tenant and the caller's role there.
  Every tenant-scoped route needs exactly one canonical `tenantId` query
  parameter (400 otherwise) and an active membership in an active, provisioned
  tenant. Anything else, including a tenant that does not exist, gets the
  same 403. The role always comes from the membership, never the request.
- Authenticated responses are `Cache-Control: no-store`; a bad or expired
  token is a 401 with `WWW-Authenticate: Bearer`, a database outage a 503.
- API routes live under `/api/v1`. Errors always use
  `{ "error": { "code", "message" }, "requestId" }`.

## Configuration

| Variable                                  | Meaning                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `PORT`                                    | HTTP port (4100 locally; the old platform uses 4000).                 |
| `MONGODB_URI`                             | MongoDB connection string.                                            |
| `CATALOG_DB_NAME`                         | Shared catalog database; must start with `truex_next_`.               |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`            | Fixed strings checked on every access token; differ per environment.  |
| `AUTH_SIGNING_KEY_ID`, `AUTH_SIGNING_KEY` | Ed25519 signing key from `npm run auth:generate-key`. Secret.         |
| `AUTH_VERIFY_KEYS`                        | Previous public keys still accepted during a rotation (`id=key,...`). |
| `AUTH_ALLOWED_ORIGINS`                    | Exact browser origins allowed to use the refresh cookie.              |

Invalid configuration stops startup and lists every problem.

## Checks

```sh
npm run typecheck
npm test            # unit + HTTP tests on an in-memory MongoDB replica set
npm run build
npm run format:check
```

## Frontend integration

On `truex_planv2`, run the existing frontend with
`PLATFORM_INTERNAL_URL=http://localhost:4100`. Configure this backend's
`AUTH_ALLOWED_ORIGINS` to include the frontend's exact origin, and Google's
callback to `<frontend-origin>/api/v1/auth/google/callback`.
The refresh cookie is set on that frontend origin by its same-origin proxy.
`/auth/complete` discovers the account's tenant and opens `/t/<tenantId>/chat`.
Tenant URLs are authorized independently in each tab. The chat page currently
shows its shell; chat execution, invitations and the tenant chooser are deferred.

For a disposable browser fixture without Google credentials or an existing DB:

```sh
# From platform-next/ (terminal 1):
npx tsx test/support/browser-fixture.ts
# From the repository root (terminal 2):
PLATFORM_INTERNAL_URL=http://127.0.0.1:4101 npm --prefix frontend run dev -- --port 3100
```

Open `http://localhost:3100` and use “Continue with Google”. The fixture uses a
local OAuth stand-in, throwaway signing keys and a fresh MongoDB replica set.
It binds backend/authorization ports 4101/4102 to loopback. Stop both processes
after testing. This fixture is outside the production build.

See [integration verification](../verification-reports/platform-next-frontend-2026-10-16.md)
for checks and remaining release blockers.
