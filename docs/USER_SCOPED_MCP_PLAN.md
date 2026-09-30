# Sign-in, tenants, and tenant/user MCP: plan

Status: planned, not implemented (updated 2026-09-30; first draft 2026-09-29). Tracks the backlog items "Adding Auth", "User invitation", "Allowing People to Connect with their Enterprise APP (MCP)" and "user can see only their own chats unless admin".

## Summary

- People sign in with Google, and only `@gmail.com` accounts are accepted. A first sign-in works only if an invite for that email exists.
- One Gmail account can belong to many tenants, with a separate role in each. A login session is bound to one tenant.
- There are two levels of administration:
  - **Admin dashboard** (`admin/`, a separate app), for platform operators only: create tenants, set tenant settings, and invite each tenant's first admin.
  - **Tenant admins**, working inside the main app: invite the rest of the tenant's users, manage members, and manage tenant MCP servers.
- Platform operators come from `PLATFORM_OPERATOR_EMAILS`, which defaults to `ashokjoe2001@gmail.com`. Being an operator gives access to the dashboard only. It does not make anyone a tenant member, so an operator sees a tenant's data only after being invited into it like anyone else.
- First run: sign in to the dashboard as `ashokjoe2001@gmail.com`, create a tenant, and invite `ashokjoe2001@gmail.com` as its admin. Then sign in to the main app and invite everyone else from inside the tenant.
- MCP servers have two scopes:
  - **tenant**: created by a tenant admin, usable by every user of the attached agents, with one shared credential
  - **user**: created by one user, loaded only in that user's own chats
- A tenant setting, `chatVisibility`, decides whether users see only their own chats (`"own"`) or all chats (`"all"`). Only a chat's owner can write to it.
- Existing chats and projects are purged from local dev data. Nothing is backfilled.
- None of this touches `vendor/codex`. MCP config reaches Codex per thread through agent-core (`thread/start` and `thread/resume` `config`).

## Current state

Checked on 2026-09-30:

- **Identity:** no users, roles, invites, sessions or cookies. The tenant comes from `devTenantResolver` (`platform/src/tenant.ts:58`). `route()` in `platform/src/http.ts:49` runs handlers inside `tenantContext`.
- **Frontend requests:** the browser calls the platform cross-origin (`frontend/lib/api.ts:1`, `NEXT_PUBLIC_PLATFORM_URL`) without credentials. SSE uses `EventSource` (`frontend/lib/transport.ts:77`). CORS has no `credentials` (`platform/src/index.ts:40`).
- **MCP:**
  - Every profile in `truex_mcp` is effectively tenant-shared. There is no owner or scope field, and there are no indexes.
  - Attachment is `agent.mcpProfileIds`, written by `setAgentMcp` (`platform/src/service.ts:585`). Nothing checks roles.
  - Session build loads the MCPs at `service.ts:365-391`.
  - `mcpConfig()` (`platform/src/mcp.ts:27`) accepts a raw `config` passthrough (`:40`) and has no private-IP checks.
- **Resume:** `agent-core/src/manager.ts:502` returns early for threads that are already loaded. A rebuilt MCP config therefore reaches Codex only on a cold resume. Codex also ignores config overrides for a thread that is running.
- **Chats:**
  - `Session` (`shared/contracts.ts:81`) and `Project` (`contracts.ts:371`) have no user field.
  - `GET /api/sessions` (`service.ts:683`) is unfiltered.
  - None of the `/api/sessions/:id/*` routes (`index.ts:146-479`) check ownership.
- **Deploy:** `deploy/kubernetes.yaml` has no Ingress. The frontend image bakes in `http://localhost:4000`. The platform binds `HOST || 127.0.0.1` (`index.ts:621`).

## Identity and sign-in

### Catalog collections

These live in the catalog DB because sign-in has to find a user's tenants before any tenant DB is opened.

```js
// users
{ _id: "u_<uuid>", googleSub: "…", email: "ashokjoe2001@gmail.com", emailKey: "ashokjoe2001@gmail.com",
  name, picture, platformRole: "operator" | null, status: "active" | "disabled", createdAt, lastLoginAt }
// unique: googleSub, emailKey

// memberships
{ _id, userId, tenantId, role: "admin" | "user", status: "active" | "removed", invitedBy, createdAt }
// unique: { userId, tenantId }; index: { tenantId, role }

// invites
{ _id, tenantId, email, emailKey, role, invitedBy, createdAt, expiresAt, acceptedAt?, revokedAt? }
// unique partial index: { tenantId, emailKey } where acceptedAt and revokedAt are unset

// auth_sessions
{ _id: sha256(token), userId, tenantId | null, app: "main" | "admin",
  createdAt, lastSeenAt, idleExpiresAt, absoluteExpiresAt, userAgent }
// TTL index on absoluteExpiresAt
```

`emailKey` is the canonical Gmail address: lowercased, with dots and any `+tag` removed from the local part. Invite matching uses `emailKey`, so an invite for `A.Shok+x@gmail.com` matches `ashok@gmail.com`.

### Google flow

1. `GET /auth/google/start?app=main|admin` does the authorization code flow with PKCE, `state` and `nonce`. It uses `openid-client` at a pinned version, with scopes `openid email profile`.
2. `GET /auth/google/callback` does the following:
   - Verifies the ID token: issuer, audience, expiry and nonce.
   - Requires `email_verified: true`, an email ending in `@gmail.com`, and no `hd` claim. Anything else redirects to `/login?error=gmail_only`.
3. For `app=admin`, it follows the "Operator" rules below and skips invite matching and tenant selection. For `app=main`, it finds the user by `googleSub`. On a first sign-in it looks up pending invites by `emailKey`:
   - If none are found, it redirects to `/login?error=not_invited`.
   - Otherwise it creates the user and, in one transaction, one membership per pending invite. Each accepted invite gets `acceptedAt`.
   - Later sign-ins also accept new pending invites for that `emailKey`.
4. Tenant selection:
   - With one active membership, the session is bound to that tenant.
   - With several, the user goes to `/select-tenant`.
   - With none, `/login?error=no_tenant`.
   - Disabled tenants are skipped.
5. It sets the session cookie and redirects to the app.

The Google OAuth client must be set to **In production** in Google Cloud Console. In "Testing", only listed test users can sign in.

### Sessions

- The cookie holds a random 32-byte token, and only its sha256 is stored. The cookie is `__Host-truex_session` for the main app and `__Host-truex_admin` for the admin dashboard. Both are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` outside localhost.
- **Main app:** 7 days idle, 30 days absolute. `lastSeenAt` is written at most once a minute.
- **Admin dashboard:** 8 hours absolute, with no sliding.
- A new token is issued on sign-in and on tenant switch, and the old one is deleted.
- `POST /auth/logout` deletes the session.
- **Access ends immediately when:**
  - the user is disabled
  - a membership is removed, which deletes that user's sessions for that tenant
  - a tenant is disabled, which the resolver checks, with the existing 5s tenant cache
- **CSRF:** `SameSite=Lax`, plus a check that state-changing requests carry an `Origin` from `FRONTEND_ORIGIN` or `ADMIN_ORIGIN` and `Content-Type: application/json`. Uploads keep their current multipart route and get the same Origin check.
- The `/auth/*` routes are rate-limited per IP.

### Resolver

`platform/src/user.ts`:

```ts
export interface UserRef { id: string; email: string; role: "user" | "admin"; operator: boolean; }
export const userContext = new AsyncLocalStorage<UserRef>();
export const currentUser = () => userContext.getStore();
```

- `authMiddleware` replaces `tenantMiddleware(devTenantResolver())` on `/api`. It reads the cookie, loads the `auth_sessions` row, checks that the user and membership are active, and resolves the tenant through `store.resolveTenant()`. It then sets `res.locals.tenant` and `res.locals.user`.
- `route()` runs handlers inside both `tenantContext` and `userContext`.
- `role` comes from the membership. `operator` comes from `users.platformRole` and only opens `/api/admin/*`. It gives no role inside a tenant.
- Admin dashboard sessions (`app: "admin"`) have `tenantId: null` and can call only `/api/admin/*` and `/auth/*`. Main app sessions can't call `/api/admin/*`.
- **Dev mode:**
  - `AUTH_MODE=dev` keeps today's fixed tenant. It adds a fixed user: `DEV_USER_ID`, default `dev-user`, with `DEV_USER_ROLE`, default `admin`.
  - `DEV_USER_HEADER=on` lets `X-Truex-User` pick the user, for local two-user testing.
  - Dev mode refuses to start under `NODE_ENV=production`. Tests use it.
- Identity never comes from the request body, and it comes from headers only in dev mode.

### Endpoints

| Method | Path | Behavior |
|---|---|---|
| GET | `/auth/google/start` | Start sign-in (`app=main\|admin`) |
| GET | `/auth/google/callback` | Finish sign-in, accept invites, set cookie |
| POST | `/auth/logout` | Delete the session |
| GET | `/auth/tenants` | Active memberships of the signed-in user (for the picker) |
| POST | `/auth/switch-tenant` | `{ tenantId }`, checks membership and issues a new cookie |
| GET | `/api/me` | `{ user, tenant, role, operator, tenants[] }` |

### Operator

- `PLATFORM_OPERATOR_EMAILS` defaults to `ashokjoe2001@gmail.com` in `.env.example` and the k8s config. It is not hard-coded in source.
- On a dashboard sign-in (`app=admin`), a matching `emailKey` sets `platformRole: "operator"`. That sign-in needs no invite, since nothing exists yet to invite from.
- Other emails can't sign in to the dashboard at all (`/login?error=not_operator`).
- Creating a tenant adds no members. The operator invites the first admin from the dashboard.
- The CLI gets `invite <tenant> <email> --role admin|user`, `members <tenant>` and `operator add|remove <email>`, for recovery only. The normal path is the dashboard.

## Main frontend

- **Same origin:** the main app forwards `/api/*` and `/auth/*` to the platform through a Route Handler (`app/api/[...path]/route.ts`, `app/auth/[...path]/route.ts`).
  - The handler reads `PLATFORM_INTERNAL_URL` at runtime and streams the body both ways, SSE included.
  - `base` in `lib/api.ts` becomes `""`, `api()` sends `credentials: "same-origin"`, and `EventSource` then sends the cookie automatically.
  - Next rewrites also stream, but they fix the destination at build time and add a 30s idle timeout.
- **Pages:** `app/login/page.tsx` has "Sign in with Google" and error copy for `not_invited`, `gmail_only`, `no_tenant` and `tenant_disabled`. `app/select-tenant/page.tsx` is the tenant picker.
- **Guard:**
  - `proxy.ts`, the Next 16 name for middleware, sends requests without a cookie to `/login`. Its matcher covers page routes only, never `/api` or `/auth`, because Next buffers request bodies for routes that proxy.ts matches.
  - The real check is `/api/me`, and any 401 in `lib/api.ts` redirects to `/login`.
- **User menu** (`components/v2/user-menu.tsx`): real name, email and avatar, "Switch tenant" when there is more than one, and a working Sign out. Tenant admins also get "Members".
- **Members panel** (tenant admins only, built like `mcp-settings.tsx`):
  - invite a Gmail address with a role (`admin` or `user`), with "Copy sign-in link"
  - see pending invites and revoke them
  - change a member's role
  - remove a member, which ends their sessions and deletes their user MCPs
- **Tenant MCP servers:** managed by tenant admins in MCP settings (see "MCP: tenant and user scope").
- Neither the Members panel nor the admin dashboard has screens in `docs/truex-design-spec.html` yet, so both need a design pass.

### Tenant admin API (`/api/tenant/*`, `role: admin` in the current tenant)

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/tenant/members` | Members with role and last sign-in |
| PATCH | `/api/tenant/members/:userId` | `{ role }`. An admin can't demote themselves if they are the last admin |
| DELETE | `/api/tenant/members/:userId` | Remove: marks the membership `removed`, deletes that user's sessions for this tenant and their user MCPs. The last admin can't be removed |
| GET | `/api/tenant/invites` | Pending invites |
| POST | `/api/tenant/invites` | `{ email, role }`. Gmail only; 409 if already a member or already invited; expires in 7 days |
| DELETE | `/api/tenant/invites/:id` | Revoke |

Invites are always scoped to the caller's current tenant, which comes from the session, never from the body.

## Admin dashboard

- **App:** a new top-level Next app in `admin/`, port 3001, served on its own host (`admin.<domain>`). It uses the same Route Handler forwarding and the `app=admin` sign-in.
- **Code sharing:** it imports `frontend/styles/v2/tokens.css`, `base.css`, `icon` and `popover` by relative path, like `shared/`. The Next, React and lucide versions must be identical to the frontend's.
- **Wiring:** added to `scripts/dev.mjs`, the root `install:all`/`build`/`format` scripts, `deploy/compose.yaml` and `deploy/kubernetes.yaml`.
- **Who can use it:** operators only. The server checks `operator` on every `/api/admin/*` call.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/admin/tenants` | All tenants with status, member count and admin count |
| POST | `/api/admin/tenants` | `{ id, name }`. Same id rules and index setup as `npm run tenant -- create` (shared code, so the unique `truex_agents.handle` index the CLI misses is created too) |
| PATCH | `/api/admin/tenants/:id` | `status`, `allowedModelIds`, `allowedSkillIds`, `chatVisibility` |
| GET | `/api/admin/tenants/:id/invites` | Pending admin invites |
| POST | `/api/admin/tenants/:id/invites` | `{ email }`. Always `role: admin` |
| DELETE | `/api/admin/tenants/:id/invites/:inviteId` | Revoke |

- The dashboard can't read a tenant's chats, agents or MCPs, and it can't manage ordinary members. Those stay with tenant admins.
- Invites send no email for now. Both the dashboard and the Members panel show "Copy sign-in link" to share by hand.

End-to-end flow:

1. The operator signs in to the dashboard, creates a tenant, and invites its first admin (for now, `ashokjoe2001@gmail.com`).
2. That admin signs in to the main app with the invited Gmail and lands in the tenant.
3. From Members, the admin invites the rest with `user` or `admin` roles.
4. Each invited user signs in with their Gmail and lands in the tenant, or picks it if they belong to several.

## Chat ownership and visibility

### Data

- `sessions.userId` is set once on `POST /api/sessions` from `currentUser()` and never changes. Add the index `{ userId: 1, createdAt: -1 }`.
- `projects.ownerId` is set on create. Under `"own"`, projects are per-user folders.
- `tenants.chatVisibility` is `"own" | "all"`. A missing value means `"all"`. `TenantRef` carries it. Operators set it from the admin dashboard, or with `npm run tenant -- chat-visibility <id> own|all`.
- `Session` and `Project` in `shared/contracts.ts` get `userId` and `ownerId`.

### Rules

| Caller | `"all"` | `"own"` |
|---|---|---|
| Owner | read and write | read and write |
| Admin (not owner) | read only | read only |
| Other user | read only | 404 |

- Only the owner can write, because a turn runs with the owner's user MCP credentials.
- Hidden chats return 404, not 403.
- Chats with no `userId` can't exist after the purge. If one shows up anyway, only admins can see it.

### Enforcement

- `PlatformService.sessionFor(id, "read" | "write")` loads the session and applies the table above. Every `/api/sessions/:id/*` route calls it first.

| Mode | Routes |
|---|---|
| read | `GET /api/sessions/:id`, `…/events` (SSE), `…/traces`, `…/timings`, `…/turns/:turnId/context`, `…/goal/history`, `…/documents` (GET), `…/documents/:fileId`, `…/visualizations/:fileId`, `…/capabilities`, `…/agents` (GET) |
| write | `…/messages`, `…/interrupt`, `…/agents/:agentId/interrupt`, `…/approvals/:requestId`, `…/approval-mode`, `…/project`, `…/documents` (POST/DELETE), `…/goal/review`, `…/agents/:agentId` (POST) |

- `GET /api/sessions` and `GET /api/projects` filter inside the query (`{ userId }` or `{ ownerId }` under `"own"` for non-admins).
- A test asserts that every `/api/sessions/:id` route in `index.ts` calls `sessionFor`.

### Agents

Anyone in a tenant can create agents. There is no role check, as today.

## MCP: tenant and user scope

### Data model (tenant DB, `truex_mcp`)

```js
{
  _id: "mcp_<uuid>",
  name: "notion",
  scope: "tenant" | "user",
  ownerId: "u_…",                  // user scope only
  agentIds: ["<agentId>"],         // agents this MCP loads for
  enabled: true,
  transport: "http",
  url: "https://…",
  auth: { kind: "bearer" },        // none | bearer | header (+ headerName)
  apiKeyEnc: { v: 1, kid: "k1", iv: "…", tag: "…", data: "…" },
  capabilities: { connectTimeoutMs, requestTimeoutMs },
  createdBy, createdAt, updatedAt
}
```

- `agentIds` replaces `agent.mcpProfileIds` for both scopes. Migration moves existing attachments into it, and afterwards `agent.mcpProfileIds` is no longer read.
- **Indexes:**
  - unique `{ scope: 1, name: 1 }` with `partialFilterExpression: { scope: "tenant" }`
  - unique `{ ownerId: 1, name: 1 }` with `partialFilterExpression: { scope: "user" }`
  - `{ agentIds: 1, scope: 1 }`
- User MCPs live in the tenant DB, so they don't follow a user into other tenants.

### Name rules

Codex keys MCP servers only by name (`mcp_servers.<name>`). Approvals, "allow for this chat" grants, traces and the UI tool chips all use that name. So:

- **Pattern:** names match `^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$`, up to 64 characters. That forbids `__`, because `mcp__<server>__<tool>` is split with a lazy regex (`agent-core/src/approval-modes.ts:54`, `platform/src/public.ts:257`).
- **Tenant names are reserved tenant-wide.** Creating or renaming a user MCP to a tenant MCP's name returns 409.
- **When an admin creates a tenant MCP whose name user MCPs already have**, the admin sees the affected count. When a chat is built, the tenant server wins, the user's copy is skipped, and the user sees a warning in MCP settings. The chat doesn't fail.

### Who can do what

| Action | Tenant MCP | User MCP |
|---|---|---|
| See it exists (name, url host, attached agents) | Everyone in the tenant | Owner only |
| Create, edit, rotate key, delete | Tenant admin (main app, MCP settings) | Owner (main app, MCP settings) |
| Attach to agents | Tenant admin | Owner, for their own chats |
| Loaded in a chat | Every chat of an attached agent | Only chats owned by the owner, with an attached agent |
| Delete for offboarding | — | Tenant admin, without reading it (when removing a member) |

No API ever returns a key or `apiKeyEnc`. Responses carry `hasKey: true | false`.

### API

Main app (`/api`, filtered by `currentUser()`):

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/mcp` | The caller's user MCPs, plus tenant MCPs (read-only fields) |
| POST | `/api/mcp` | Create a user MCP (`scope: "user"`, `ownerId` = caller). 409 on a name clash |
| PATCH | `/api/mcp/:id` | Update or rotate the key on the caller's own user MCP |
| DELETE | `/api/mcp/:id` | Delete the caller's own user MCP |
| GET | `/api/agents/:id/mcp` | Tenant MCPs attached to this agent (read-only) plus the caller's user MCPs with `attached` |
| POST | `/api/agents/:id/mcp` | `{ profileIds }`: `$addToSet` / `$pull` on `agentIds` of the caller's own user MCPs only |

Tenant admins (`/api/tenant/mcp*`, `role: admin` in the current tenant): the same create, edit, delete and attach operations for `scope: "tenant"`. Removing a member (`DELETE /api/tenant/members/:userId`) also deletes that member's user MCPs.

Someone else's user MCP id returns 404 everywhere.

### Session build

`service.configuration()` (`service.ts:329`) takes the session owner:

1. **Owner:** `session.userId` for an existing chat, or `currentUser().id` for a new one. It never uses the caller of a resume or a background request. Cold resume and background ingestion (`service.ts:1088`, `store.ts:184`) read it from the stored session.
2. **Tenant MCPs:** `find({ scope: "tenant", agentIds: agentId, enabled: { $ne: false } })`.
3. **User MCPs:** `find({ scope: "user", ownerId, agentIds: agentId, enabled: { $ne: false } })`. Any user MCP whose name matches a tenant MCP is skipped and logged.
4. **Checks:** the URL is re-checked for DNS rebinding and `stdio` is rejected, as today.
5. **Config:** `apiKeyEnc` is decrypted only here. `mcpConfig()` builds `http_headers`, and the result goes into this thread's `config["mcp_servers.<name>"]`.
6. **Fingerprint:** the result is hashed (names, urls, key versions) into `session.mcpFingerprint`.

### Applying MCP changes to live chats (agent-core)

Because of `manager.ts:502`, attaching, detaching or rotating an MCP doesn't reach a chat that agent-core already has loaded. Fix it in agent-core, with no Codex change:

- `POST /threads/:id/resume` accepts `mcpFingerprint`. If the thread is loaded and the fingerprint differs:
  - When idle, it sends `thread/unsubscribe`, then a cold `thread/resume` with the new config.
  - When a turn is running, it keeps the old config and applies the new one before the next turn.
- The platform sends the fingerprint on every `resume()` (`service.ts:858`, `:898`).
- Test: detach a user MCP and send the next message; that turn's config no longer contains it.

### Credential safety

This must land before anyone stores a real key.

- **Encryption:** AES-256-GCM, with `MCP_ENCRYPTION_KEY` (32 bytes, base64) held in env only. Rotation uses `MCP_ENCRYPTION_KEYS` (kid → key) and `MCP_ENCRYPTION_KID`.
- **Redaction:** `agent-core/src/redact.ts` already covers `apikey`, `http_headers` and `*_key`. A test confirms it also covers `apiKeyEnc` and decrypted header values in traces.
- **URL checks on create and update:**
  - Reject loopback, link-local (including `169.254.169.254`), private and CGNAT ranges, unless the host is in `MCP_ALLOWED_PRIVATE_HOSTS`.
  - Warn on `http://`. `MCP_REQUIRE_HTTPS=on` makes it an error.
- **Stored fields:** `auth` and `capabilities` are saved with known fields only, instead of whatever the caller sent (`mcp.ts:137`).
- **Raw config:** the passthrough (`mcp.ts:40`) is removed from the API path. Only scripts can set it.

### Existing profiles (`qlik`, `btp`)

The migration marks every ownerless profile `scope: "tenant"`, moves its `agent.mcpProfileIds` attachments into `agentIds`, and encrypts any plain `apiKey`/`apikey`. After that, tenant admins manage them in MCP settings in the main app. They can be deleted and re-added there.

## Chat purge (`scripts/purge-chats.mjs`)

Local dev data only. It matches the style of `scripts/tenant.mjs`: the platform's `mongodb` and `dotenv`, `CliError`, and hand-parsed arguments.

**Default mode:** dry run. It prints counts per tenant and per directory and writes nothing.

**Real run:** needs `--confirm purge-chats`. Stop agent-core first; the script refuses if agent-core's `/healthz` answers.

**Tenants covered:** every registered tenant, disabled ones included, plus the implicit `default` DB.

**MongoDB, per tenant:**
- `deleteMany({})` on `sessions`, `messages`, `traces` and `projects`, plus the old copies `truex_runs`, `truex_conversations` and `truex_live_sessions` if they exist.
- Never `dropDatabase`, because the catalog can share the default DB.

**Disk, under `${CODEX_HOME:-.runtime/codex}`:**
- In `business-v1/`: `sessions/`, `archived_sessions/`, `state_5.sqlite*`, `goals_1.sqlite*`, `logs_2.sqlite*`, `queue_1.sqlite*`, `thread-writer-locks/`, `business-threads/`, `business-workspaces/`, `adapter-records/` and `shell_snapshots/`.
- The same chat folders in the legacy top level.

**Kept:** agents, MCP profiles, models, skills, tenants, `skills/` and `installation_id`.

**Afterwards:** restart agent-core. The printed summary lists what was removed.

## Deploy

- Add an Ingress. Only `frontend` (app host) and `admin` (admin host) are public. The platform, agent-core and the model gateway stay internal.
- Set `HOST=0.0.0.0` on the platform and set `PLATFORM_INTERNAL_URL` on both web apps.
- New env keys, with secrets coming from `platform-config`:
  - `AUTH_MODE`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `AUTH_PUBLIC_URL`, `ADMIN_PUBLIC_URL`
  - `FRONTEND_ORIGIN`, `ADMIN_ORIGIN`
  - `PLATFORM_OPERATOR_EMAILS`
  - `MCP_ENCRYPTION_KEY`, `MCP_ENCRYPTION_KID`
  - `MCP_ALLOWED_PRIVATE_HOSTS`
- Google OAuth redirect URIs:
  - `http://localhost:3000/auth/google/callback`
  - `http://localhost:3001/auth/google/callback`
  - the production app and admin hosts

## Implementation order

Tracks in the same step can run in parallel.

1. **Start now:**
   - **A. Auth backend:** catalog collections, the Google flow, sessions, `authMiddleware`, `userContext`, `/auth/*`, `/api/me`, operator sign-in, `/api/admin/*` (tenants and first-admin invites), `/api/tenant/*` (members and invites), and the recovery CLI commands.
   - **B. Main app sign-in:** the forwarding Route Handlers, `/login`, `/select-tenant`, `proxy.ts`, 401 handling and the user menu. It builds against the `/api/me` and `/auth/*` contract above.
   - **C. MCP credential safety:** encryption, URL checks, field allow-lists, and removing raw config.
   - **D. Chat purge script** (dry run first).
   - **E. agent-core fingerprint resume.**
2. **After A merges:**
   - **F. Chat ownership:** `userId`/`ownerId`, `chatVisibility`, `sessionFor`, list filters and tests.
   - **G. MCP scopes:** `scope`/`ownerId`/`agentIds`, name rules, the `/api/mcp` and `/api/tenant/mcp` APIs, the session build and the migration.
   - **H. Admin dashboard (operators):** sign-in, the tenants list, create tenant, tenant settings, and invite the first admin. Needs a design pass first.
   - **H2. Members panel (tenant admins, main app):** invite, revoke, change role, remove. Needs a design pass first.
3. **Last:**
   - **I. Frontend MCP settings:** "Your servers" (editable) and "Tenant servers" (editable for admins, read-only for users), the chat owner label, the admin "All users" toggle, and the read-only chat view.
   - **J. Deploy:** Ingress, env and `HOST`.
   - **K. Docs:** `docs/mongodb.md`, `README.md` and `docs/VALIDATION.md`.

## Tests

The platform tests use Ashok (`user`), Dharun (`user`) and Admin (`admin`) in tenant `t1`, plus a second tenant `t2`. Google is faked with a local issuer and JWKS.

Sign-in:

- [ ] A first sign-in without an invite is rejected. With an invite, it creates the user and membership, and the invite is marked accepted.
- [ ] Non-`@gmail.com`, a present `hd` claim, or `email_verified: false` is rejected.
- [ ] An invite for `A.Shok+x@gmail.com` matches `ashok@gmail.com`.
- [ ] A user with two memberships goes to the picker. `switch-tenant` to a tenant without membership returns 403. A switch issues a new token.
- [ ] Removing a membership or disabling a tenant ends the next request with 401 or 403.
- [ ] Tampered, expired, idle-expired and logged-out cookies return 401.
- [ ] A cross-origin POST is rejected.
- [ ] An operator email signs in to the dashboard without an invite. Any other email is refused there.
- [ ] Operator status gives no access to a tenant's `/api/*`. Creating a tenant adds no members.
- [ ] An operator's first-admin invite, once accepted, gives `role: admin` in that tenant only.
- [ ] A tenant admin can invite, revoke, change roles and remove members in their own tenant only. A `user` gets 403 on `/api/tenant/*`.
- [ ] The last admin can't be demoted or removed.
- [ ] A main app session gets 403 on `/api/admin/*`, and a dashboard session gets 403 on tenant `/api/*`.
- [ ] `AUTH_MODE=dev` refuses to start in production. `X-Truex-User` is ignored outside dev mode.

Chats:

- [ ] Under `"own"`, Dharun doesn't see Ashok's chat in the list and gets 404 on every read and write route, SSE included.
- [ ] Under `"own"`, Admin can read Ashok's chat and gets 403 on writes. Under `"all"`, Dharun can read it and gets 403 on writes.
- [ ] Every `/api/sessions/:id` route goes through `sessionFor`.
- [ ] Chats and projects in `t1` never appear in `t2`.

MCP:

- [ ] A tenant MCP attached to agent X loads in both Ashok's and Dharun's chats with X. Non-admins can't create, edit or attach one, and never see its key.
- [ ] Ashok's user MCP loads only in Ashok's chats. Dharun gets 404 on it everywhere.
- [ ] A user MCP named like a tenant MCP returns 409. An existing clash skips the user copy with a warning and doesn't fail the chat.
- [ ] Names with `__` are rejected.
- [ ] A detached or rotated MCP is gone or changed on the next turn of a loaded chat (fingerprint resume).
- [ ] Removing a member deletes their user MCPs.
- [ ] No response or trace contains a key, `apiKeyEnc` or header values.
- [ ] Private and metadata URLs are rejected. An allow-listed private host is accepted.

Purge:

- [ ] The dry run writes nothing. A real run without `--confirm purge-chats` refuses. Agents, MCPs, models, skills and tenants remain after a run.

## Later

- Invite emails (SMTP or SES).
- Google Workspace domains, and other identity providers.
- Per-user OAuth for MCP (Notion, GitHub, Atlassian): a platform-side authorization start and callback with PKCE and refresh, with tokens in `truex_mcp_credentials` keyed by `{ mcpId, userId }`. It stays outside Codex.
- A connector catalog in the catalog DB (`truex_connectors`), with `tenants.allowedConnectorIds`.
- Per-connector tool allow-lists linked to approval modes, and an audit log of tool calls per user.
