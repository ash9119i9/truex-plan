# platform-next

The rebuilt Truex backend: users, tenants and memberships. It runs alongside
`platform/` on its own port with its own databases, and imports nothing from it.

Plan: [`tasks/users-tenants-plan.md`](../tasks/users-tenants-plan.md).

## Run locally

Needs Node 24 and a MongoDB 8.0+ replica set (transactions require a replica
set; starting a chat and sending a message use client `bulkWrite`, new in 8.0).
Tests download MongoDB 8.0.14 for their in-memory replica set.

```sh
cp .env.example .env
npm install
npm run dev
```

To run the whole chat stack (model-gateway, runtime-adapter, platform-next and
the frontend), run `npm run dev:next` from the repository root. It refuses to
start when a port is taken, a `.env` or `node_modules` is missing, or
`RUNTIME_ADAPTER_TOKEN` / `MODEL_GATEWAY_SECRET` differ between the services'
files. Output is labelled by service and also written to
`.runtime/dev-next/<service>.log`; Ctrl+C stops all four. The root `npm run dev`
still starts the old stack.

- `GET /health/live`: the process is running.
- `GET /health/ready`: the app can reach MongoDB (503 when it cannot).
- `GET /api/v1/auth/google`: starts Google sign-in (redirects to Google).
- `GET /api/v1/auth/google/callback`: finishes it, sets the refresh cookie and
  redirects to `/auth/complete`, or to `/login?error=<code>` with one of
  `cancelled`, `expired`, `rejected`, `unavailable`, `account_disabled`,
  `email_in_use`, `signup_unavailable`. No token is ever put in a URL.
- `POST /api/v1/auth/refresh[?tenantId=<id>]`: rotates the refresh cookie and
  returns a new 5-minute access token (409 when another tab refreshed first;
  retry). With `tenantId`, the token also carries that tenant and the caller's
  role there when they are an active member of a usable tenant; the response's
  `tenantId` says which tenant it carries, or `null`. A malformed `tenantId`
  is a 400.
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
  When the access token carries that tenant, tenant routes trust it with no
  MongoDB read, so a removal, role change, disabled tenant or logout reaches
  them within the 5-minute token lifetime. Otherwise they read the membership
  and tenant. `GET /me`, `GET /me/tenants` and `GET /tenant` always read
  current state, archiving another member's agent re-reads the admin role, and
  open streams re-check session and membership every 15 s.
- `GET /api/v1/models?tenantId=`: enabled models (`id, displayName,
shortLabel, family` only).
- `GET /api/v1/agents?tenantId=`: enabled built-ins, the caller's personal
  agents and the tenant's shared agents, each with `source`, `available` and
  the caller's `canEdit/canArchive/canPromote`.
- `POST /api/v1/agents`: `{clientRequestId, scope: "personal"|"tenant", name,
description, modelId, look?, tint?}`. 201 when created, 200 when a retry
  returns the same agent, 409 when the ID was used for different content,
  409 `LIMIT_REACHED` (50 per person, 200 shared per tenant), 422
  `MODEL_UNAVAILABLE`.
- `PATCH /api/v1/agents/:id`: `{revision, ...changes}`, creator only; 409
  `STALE_REVISION` when the agent changed since it was read.
- `POST /api/v1/agents/:id/promote` (creator; personal → tenant, one way) and
  `POST /api/v1/agents/:id/archive` (creator, or a tenant admin for shared
  agents). Both are safe to repeat. Another member's personal agent, another
  tenant's agent and a malformed ID all get the same 404.
- Chats (private to the member who started them; admins included). Each
  needs the runtime adapter and gateway settings below, otherwise 503:
  - `POST /api/v1/chats`: `{agentId, clientMessageId, text}`. The first message
    creates the chat. 202 when saved and handed to the assistant, 200 when a
    retry returns the same chat, message and run; 409 when the ID was used for
    different text.
  - `POST /api/v1/chats/:id/messages`: `{clientMessageId, text}`. 409
    `CHAT_BUSY` while a reply runs, 409 `CHAT_READ_ONLY` when the chat's
    history, model or built-in agent is gone, or the chat is archived; 429
    over about 20 messages a minute. Text is 1–32 000 characters.
  - `GET /api/v1/chats/:id/runs/:runId/stream`: server-sent events for one
    reply: `snapshot` (text so far), `status`, `delta` (batched every 50 ms),
    `item`, `usage`, `completed` (outcome known) and `saved` (outcome stored;
    show the saved tick only now), or `save_failed`. `: hb` every 15 s; the
    stream closes with `end` if the session or membership is revoked.
    Reconnecting is always safe: the snapshot replaces what the browser has.
  - `POST /api/v1/chats/:id/runs/:runId/stop`: 202; safe to repeat. Partial
    text is saved as `stopped`.
  - `GET /api/v1/chats` (newest first, `cursor`, `status=archived`),
    `GET /api/v1/chats/:id` (latest 50 messages with their runs),
    `GET /api/v1/chats/:id/messages?before=<seq>`, `PATCH /api/v1/chats/:id`
    `{title}`, `POST /api/v1/chats/:id/archive`.
  - Closing a stream never stops a reply. A reply whose platform process died
    is recovered on the chat's next access once its 30 s lease lapses: the
    platform reattaches to the runtime's run, or settles it from the runtime's
    history. A message the runtime may have seen is never resent; one it has
    no trace of is marked `NOT_SENT` for the member to resend.
- Authenticated responses are `Cache-Control: no-store`; a bad or expired
  token is a 401 with `WWW-Authenticate: Bearer`, a database outage a 503.
- API routes live under `/api/v1`. Errors always use
  `{ "error": { "code", "message" }, "requestId" }`.

## Models and built-in agents (product team)

Both live in the catalog database and are changed only with the operator CLI;
every command is audited. Definitions are JSON files (see
`test/support/catalog-fixtures.ts` for complete examples).

```sh
npm run operator -- model-put --operator <you> --file claude.json
npm run operator -- model-disable --operator <you> --slug claude-sonnet
npm run operator -- builtin-agent-put --operator <you> --file general.json
npm run operator -- model-list --operator <you>
```

- Models go through the model gateway (`wireApi` `anthropic`, `gemini` or
  `chat`) and need `contextWindow` and `autoCompactTokenLimit`. Keys are
  Secrets Manager references (`apiKeySecretArn`); a plaintext `apiKey` needs
  `--allow-dev-credentials`. Nothing printed includes a credential.
- A model's `wireApi`, `baseUrl` and `modelName` cannot change, because chats
  pin its ID: add a new slug and disable the old one. Models are never deleted.
- Re-running a put with the same file changes nothing. Members see changes
  within 60 seconds (in-memory cache per server). That includes new chats and
  messages: a disabled model or built-in can still start a turn for up to 60
  seconds. A model or built-in added since the cache loaded is read directly.
  Creating or editing an agent reads its model fresh.
- The gateway must read this catalog: set its `CATALOG_MONGO_DB` to
  `CATALOG_DB_NAME`.

## Tenant indexes

Provisioning builds every index a tenant database needs before marking the
tenant ready; requests never check or build indexes. The unique ones are what
make retried sends idempotent, so a tenant without them can duplicate chats.

```sh
npm run operator -- ensure-tenant-indexes --operator <you> --all
npm run operator -- ensure-tenant-indexes --operator <you> --tenant <id>
```

- Run `--all` once for tenants provisioned before this, and as a deploy step
  whenever `TENANT_INDEX_VERSION` (`src/modules/tenants/tenant-indexes.ts`)
  goes up, before the new code serves traffic. It only touches ready tenants
  behind the current version; it is safe to repeat and audited per tenant.
- At startup the server logs an error when any ready tenant is behind, or when
  MongoDB is older than 8.0.

## Configuration

| Variable                                       | Meaning                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `PORT`                                         | HTTP port (4100 locally; the old platform uses 4000).                          |
| `MONGODB_URI`                                  | MongoDB connection string.                                                     |
| `CATALOG_DB_NAME`                              | Shared catalog database; must start with `truex_next_`.                        |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`                 | Fixed strings checked on every access token; differ per environment.           |
| `AUTH_SIGNING_KEY_ID`, `AUTH_SIGNING_KEY`      | Ed25519 signing key from `npm run auth:generate-key`. Secret.                  |
| `AUTH_VERIFY_KEYS`                             | Previous public keys still accepted during a rotation (`id=key,...`).          |
| `AUTH_ALLOWED_ORIGINS`                         | Exact browser origins allowed to use the refresh cookie.                       |
| `RUNTIME_ADAPTER_URL`, `RUNTIME_ADAPTER_TOKEN` | The runtime adapter and its shared bearer token (32+ characters). Secret.      |
| `MODEL_GATEWAY_URL`, `MODEL_GATEWAY_SECRET`    | The model gateway Codex calls, and the token-signing secret it shares. Secret. |

Chat needs all four chat variables or none; with none, chat endpoints answer 503
and everything else works. v1 runs one platform process: live replies are held
in that process's memory.

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
Tenant URLs are authorized independently in each tab. The chat page lists the
member's chats, starts new ones with an agent and streams replies; invitations
and the tenant chooser are deferred.

For a disposable browser fixture without Google credentials or an existing DB:

```sh
# From platform-next/ (terminal 1):
npx tsx test/support/browser-fixture.ts
# From the repository root (terminal 2):
PLATFORM_INTERNAL_URL=http://127.0.0.1:4101 npm --prefix frontend run dev -- --port 3100
```

Open `http://localhost:3100` and use “Continue with Google”. The fixture uses a
local OAuth stand-in, throwaway signing keys and a fresh MongoDB replica set.
Chat runs on the real runtime adapter and pinned Codex (build it first with
`npm run codex:setup` at the repository root) behind a loopback stand-in for
the model gateway, so replies are canned. A control server scripts them:
`POST /script` queues behaviours (`reply`, `held`, `failed`), `POST /release`
finishes held replies, `POST /reset` clears both and `GET /requests` lists what
the model was sent. It binds ports 4101–4103 to loopback. Stop both processes
after testing (Ctrl-C stops the adapter and Codex too). This fixture is outside
the production build.

See [integration verification](../verification-reports/platform-next-frontend-2026-10-16.md)
for checks and remaining release blockers.
