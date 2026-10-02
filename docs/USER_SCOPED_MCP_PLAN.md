# Sign-in, invites, tenants, and tenant/user MCP: plan

Status: planned, not implemented (updated 2026-09-30; first draft 2026-09-29). Tracks the backlog items "Adding Auth", "User invitation", "Allowing People to Connect with their Enterprise APP (MCP)" and "user can see only their own chats unless admin".

## Summary

- **Admin dashboard** (`admin/`, a separate app) is for the platform owner only. It uses a simple username and password login, and it is where tenants are created and users are invited. Nothing else creates tenants or invites people for now.
- **Invites go out by email** through Resend. The email holds a one-time link to an invite acceptance page in the main app.
- **Users sign in with Google only**, and only `@gmail.com` accounts are accepted. An invite can be accepted only by the Gmail address it was sent to.
- After joining, users come back through `/login` with Google. They stay signed in for 7 days of inactivity, and 30 days at most.
- One Gmail account can belong to many tenants, with a separate role (`admin` or `user`) in each. A login session is bound to one tenant.
- The dashboard account is not a tenant member. To use the main app, the owner invites their own Gmail like anyone else.
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
  - `mcpConfig()` (`platform/src/mcp.ts:27`) accepts a raw `config` passthrough (`:40`) and has no private-IP checks. Its name regex `^[\w-]{1,64}$` allows `__`.
- **Resume:** `agent-core/src/manager.ts:502` returns early for threads that are already loaded. A rebuilt MCP config therefore reaches Codex only on a cold resume. Codex also ignores config overrides for a thread that is running.
- **Chats:**
  - `Session` (`shared/contracts.ts:81`) and `Project` (`contracts.ts:371`) have no user field.
  - `GET /api/sessions` (`service.ts:683`) is unfiltered.
  - None of the `/api/sessions/:id/*` routes (`index.ts:146-479`) check ownership.
- **Local configuration:** the frontend uses `NEXT_PUBLIC_PLATFORM_URL` (default `http://localhost:4000`). The platform binds `HOST || 127.0.0.1` (`index.ts:621`).

## End-to-end flow

1. The owner signs in to the admin dashboard with username and password.
2. The owner creates a tenant (id, name, allowed models and skills, `chatVisibility`).
3. The owner invites a Gmail address to that tenant with a role, `admin` or `user`. Resend emails the invite link.
4. The invitee opens the link and lands on `/invite/<token>`. The page shows the tenant name, the role, the invited Gmail (locked) and when the invite expires.
5. The invitee clicks "Join" and signs in with Google. The Google account must be a verified `@gmail.com` address and must match the invited address.
6. The invitee lands in the tenant. From then on they sign in at `/login`.

## Admin dashboard login

- **One account, set in env:** `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. There is no admin users table.
- **Hash:** scrypt from `node:crypto`, stored as `scrypt$N$r$p$<salt>$<hash>`. `npm run admin -- hash-password` reads the password from stdin (never from argv, so it stays out of shell history) and prints the value to put in env.
- **Login:** `POST /auth/admin/login` with `{ username, password }`.
  - It compares both values in constant time, and runs the scrypt check even when the username is wrong.
  - It is rate-limited per IP (5 attempts a minute), with a growing delay after repeated failures.
  - Failures always return the same "Wrong username or password".
- **Session:** an `auth_sessions` row with `app: "admin"` and `userId: null`, in the `__Host-truex_admin` cookie. It lasts 8 hours with no sliding. `POST /auth/admin/logout` deletes it.
- Admin sessions can call only `/api/admin/*` and `/auth/admin/*`. Main app sessions can't call `/api/admin/*`.
- If `ADMIN_PASSWORD_HASH` is unset, the admin login is disabled and the platform logs why. It never falls back to a default password.

## Admin dashboard

- **App:** a new top-level Next app in `admin/`, port 3001, served on its own host (`admin.<domain>`). It forwards `/api/*` and `/auth/*` to the platform the same way the main app does.
- **Code sharing:** it imports `frontend/styles/v2/tokens.css`, `base.css`, `icon` and `popover` by relative path, like `shared/`. The Next, React and lucide versions must be identical to the frontend's.
- **Wiring:** added to `scripts/dev.mjs` and the root `install:all`/`build`/`format` scripts.
- **Screens:** the login page, the tenants list, create tenant, tenant settings, and each tenant's invites and members. It needs a design pass first; `docs/truex-design-spec.html` has no screens for it.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/admin/tenants` | All tenants with status, member count and pending invite count |
| POST | `/api/admin/tenants` | `{ id, name }`. Same id rules and index setup as `npm run tenant -- create` (shared code, so the unique `truex_agents.handle` index the CLI misses is created too) |
| PATCH | `/api/admin/tenants/:id` | `status`, `allowedModelIds`, `allowedSkillIds`, `chatVisibility` |
| GET | `/api/admin/tenants/:id/invites` | Invites with status: pending, accepted, expired, revoked, and whether the email was sent |
| POST | `/api/admin/tenants/:id/invites` | `{ email, role }`. Gmail only. 409 if already an active member or already invited. Sends the email |
| POST | `/api/admin/tenants/:id/invites/:inviteId/resend` | Issues a new token, resets the 7-day expiry and sends again. The old link stops working |
| DELETE | `/api/admin/tenants/:id/invites/:inviteId` | Revoke |
| GET | `/api/admin/tenants/:id/members` | Members with role and last sign-in |
| PATCH | `/api/admin/tenants/:id/members/:userId` | `{ role }` |
| DELETE | `/api/admin/tenants/:id/members/:userId` | Remove: marks the membership `removed`, deletes that user's sessions for this tenant and their user MCPs |

The dashboard can't read a tenant's chats, agents or MCPs.

## Invites

### Data (catalog DB)

```js
// invites
{ _id: "inv_<uuid>", tenantId, email, emailKey, role: "admin" | "user",
  tokenHash, status: "pending" | "accepted" | "revoked", createdAt, expiresAt,
  sentAt?, sendError?, acceptedAt?, acceptedBy?, revokedAt? }
// unique: tokenHash
// unique partial index: { tenantId, emailKey } where status is "pending"
```

- **`status`:** MongoDB partial indexes can't filter on `$exists: false`, so the one-pending-invite index keys on `status: "pending"`. Accepting sets `status: "accepted"` with `acceptedAt`, and revoking sets `status: "revoked"` with `revokedAt`, in the same update. `expiresAt` is a Date.

- **Token:** 32 random bytes, base64url, in the link `${APP_PUBLIC_URL}/invite/<token>`. Only its sha256 is stored, so the raw link exists only in the email.
- **Lifetime:** 7 days, single use. Resending issues a new token and invalidates the old one.
- **`emailKey`:** the canonical Gmail address, lowercased, with dots and any `+tag` removed from the local part. Gmail delivers all those spellings to the same inbox, so `A.Shok+x@gmail.com` and `ashok@gmail.com` are the same account.
- Invite creation rejects anything that isn't `@gmail.com`.

### Email (Resend)

- **Call:** a plain `fetch` to `POST https://api.resend.com/emails`, with no SDK dependency.
  - `Authorization: Bearer ${RESEND_API_KEY}`, `from: INVITE_FROM_EMAIL`
  - `Idempotency-Key: <inviteId>:<tokenHash prefix>`, so a retry never sends twice
- **Content:** subject "You're invited to <tenant> on Truex". HTML and plain text versions contain the tenant name, the role, the link and the expiry date. The tenant name is HTML-escaped.
- **Failure:** the invite is still created. `sendError` is stored, and the dashboard shows "Not sent" with a Resend button. A 429 from Resend is retried with backoff.
- **Free plan:** 3,000 emails a month, 100 a day.
- **Domain:** sending to other people needs a domain verified in Resend (DNS records), with `INVITE_FROM_EMAIL` on that domain, for example `Truex <invites@yourdomain.com>`. Until it's verified, Resend only delivers to the account owner's own address.
- **Dev:** with `RESEND_API_KEY` unset, the platform logs the invite link instead of sending it. It refuses to start that way under `NODE_ENV=production`.

### Acceptance page (`/invite/[token]`, main app)

- **Lookup:** `GET /auth/invites/:token` is public and rate-limited per IP. It returns `{ tenantName, email, role, expiresAt }`, or a status of `expired`, `used`, `revoked` or `not_found`.
- **Content:** the page shows only those fields. It shows no chats, agent names or member names, since anyone holding the link can open it before signing in.
- **Join:** the button goes to `GET /auth/google/start?invite=<token>`.
- **Errors:** "Wrong account" shows "You signed in as X, but this invite is for Y" and a "Use a different account" button, which restarts Google sign-in with the account chooser.
- **Design:** the screenshot from 2026-09-30 is a sample only, and the final design will change.

## Google sign-in (users)

### Catalog collections

These live in the catalog DB because sign-in has to find a user's tenants before any tenant DB is opened.

```js
// users
{ _id: "u_<uuid>", googleSub: "…", email, emailKey, name, picture,
  status: "active" | "disabled", createdAt, lastLoginAt }
// unique: googleSub, emailKey

// memberships
{ _id, userId, tenantId, role: "admin" | "user", status: "active" | "removed", inviteId, createdAt }
// unique: { userId, tenantId }; index: { tenantId, role }

// auth_sessions
{ _id: sha256(token), userId | null, tenantId | null, app: "main" | "admin",
  createdAt, lastSeenAt, idleExpiresAt, absoluteExpiresAt, userAgent }
// TTL index on absoluteExpiresAt

// auth_flows (in-progress Google sign-ins)
{ _id: sha256(flowId), state, nonce, codeVerifier, inviteId?, createdAt }
// TTL: 10 minutes
```

### Flow

1. **Start:** `GET /auth/google/start`, with `?invite=<token>` from the acceptance page.
   - It checks that the invite is still pending, then does the authorization code flow with PKCE, `state` and `nonce`, using `openid-client` at a pinned version (a new platform dependency). Scopes are `openid email profile`.
   - For an invite, it sends `login_hint=<invited email>` and `prompt=select_account`.
   - The flow is stored in `auth_flows`, and a short-lived `__Host-truex_flow` cookie holds its id.
2. **Callback:** `GET /auth/google/callback` loads the flow and deletes it, since each flow is used once. It then:
   - verifies the ID token: issuer, audience, expiry and nonce
   - requires `email_verified: true`, an email ending in `@gmail.com`, and no `hd` claim. Anything else ends with `gmail_only`.
3. **With an invite:**
   - The Google `emailKey` must equal the invite's `emailKey`. If it doesn't, it redirects back to the acceptance page with `wrong_account`, and the invite stays pending.
   - It claims the invite atomically: `findOneAndUpdate` on `{ _id, acceptedAt: unset, revokedAt: unset, expiresAt > now }`, setting `acceptedAt`. If that matches nothing, the invite was used, revoked or expired in the meantime.
   - It finds the user by `googleSub`, or creates one. A user whose `emailKey` matches but whose `googleSub` differs is refused with `account_conflict`.
   - It upserts the membership with the invite's role. A previously removed membership is reactivated.
   - The session is bound to the invite's tenant, which must not be disabled.
4. **Without an invite (`/login`):**
   - It finds the user by `googleSub`. If none is found, it ends with `not_invited`, so accounts are created only by accepting an invite. A disabled user ends with `account_disabled`.
   - Tenant selection: one active membership binds the session to it, several go to `/select-tenant`, and none ends with `no_tenant`. Disabled tenants are skipped, and if that leaves nothing, the result is `tenant_disabled`.
   - Signing in doesn't accept pending invites. Only the invite link does.
5. It sets the session cookie, updates `lastLoginAt` and redirects to the app.

The Google OAuth client must be set to **In production** in Google Cloud Console. In "Testing", only listed test users can sign in.

### Error codes

| Code | Shown on | Meaning |
|---|---|---|
| `gmail_only` | login, invite | Not a verified `@gmail.com` account |
| `wrong_account` | invite | Signed in with a different Gmail than the one invited |
| `invite_expired`, `invite_used`, `invite_revoked` | invite | The link can't be used; ask for a new invite |
| `not_invited` | login | No account yet; accounts are created from an invite link |
| `account_conflict` | login, invite | The Gmail is tied to a different Google account |
| `account_disabled` | login | The account is disabled |
| `no_tenant`, `tenant_disabled` | login | No usable membership |

### Sessions

Users don't sign in every time. After the first sign-in, the session cookie keeps them in.

- The cookie holds a random 32-byte token, and only its sha256 is stored. The cookie is `__Host-truex_session` for the main app and `__Host-truex_admin` for the admin dashboard. Both are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` outside localhost.
- **Main app:** 7 days idle, 30 days absolute. `lastSeenAt` is written at most once a minute. Signing in again is one click at `/login`.
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
export interface UserRef { id: string; email: string; role: "user" | "admin"; }
export const userContext = new AsyncLocalStorage<UserRef>();
export const currentUser = () => userContext.getStore();
```

- `authMiddleware` replaces `tenantMiddleware(devTenantResolver())` on `/api`. It reads the cookie, loads the `auth_sessions` row, checks that the user and membership are active, and resolves the tenant through `store.resolveTenant()`. It then sets `res.locals.tenant` and `res.locals.user`.
- `route()` runs handlers inside both `tenantContext` and `userContext`.
- `role` comes from the membership.
- **Dev mode:**
  - `AUTH_MODE=dev` keeps today's fixed tenant. It adds a fixed user: `DEV_USER_ID`, default `dev-user`, with `DEV_USER_ROLE`, default `admin`.
  - `DEV_USER_HEADER=on` lets `X-Truex-User` pick the user, for local two-user testing.
  - Dev mode refuses to start under `NODE_ENV=production`. Tests use it.
- Identity never comes from the request body, and it comes from headers only in dev mode.

### Endpoints

| Method | Path | Behavior |
|---|---|---|
| POST | `/auth/admin/login` | Dashboard username and password |
| POST | `/auth/admin/logout` | Delete the dashboard session |
| GET | `/auth/invites/:token` | Public invite details for the acceptance page |
| GET | `/auth/google/start` | Start Google sign-in, optionally with `?invite=<token>` |
| GET | `/auth/google/callback` | Finish sign-in, accept the invite if there is one, set cookie |
| POST | `/auth/logout` | Delete the session |
| GET | `/auth/tenants` | Active memberships of the signed-in user (for the picker) |
| POST | `/auth/switch-tenant` | `{ tenantId }`, checks membership and issues a new cookie |
| GET | `/api/me` | `{ user, tenant, role, tenants[] }` |

### Recovery CLI

- `npm run admin -- hash-password`
- `npm run tenant -- invite <tenant> <email> --role admin|user` creates an invite and prints the link, without sending an email.
- `npm run tenant -- members <tenant>`

## Main frontend

- **Same origin:** the main app forwards `/api/*` and `/auth/*` to the platform through a Route Handler (`app/api/[...path]/route.ts`, `app/auth/[...path]/route.ts`).
  - The handler reads `PLATFORM_INTERNAL_URL` at runtime and streams the body both ways, SSE included.
  - `base` in `lib/api.ts` becomes `""`, `api()` sends `credentials: "same-origin"`, and `EventSource` then sends the cookie automatically.
  - Next rewrites also stream, but they fix the destination at build time and add a 30s idle timeout.
- **Pages:**
  - `app/login/page.tsx`: "Sign in with Google", with error copy for the codes above
  - `app/invite/[token]/page.tsx`: the acceptance page
  - `app/select-tenant/page.tsx`: the tenant picker
  - `/invite` needs a design pass; the screenshot is a sample.
- **Guard:**
  - `proxy.ts`, the Next 16 name for middleware, sends requests without a cookie to `/login`. It never matches `/login` or `/invite/*`.
  - Its matcher covers page routes only, never `/api` or `/auth`, because Next buffers request bodies for routes that proxy.ts matches.
  - The real check is `/api/me`, and any 401 in `lib/api.ts` redirects to `/login`.
- **User menu** (`components/v2/user-menu.tsx`): real name, Gmail and avatar, "Switch tenant" when there is more than one, and a working Sign out.
- **Tenant MCP servers:** managed by tenant admins in MCP settings (see "MCP: tenant and user scope").

## Chat ownership and visibility

### Data

- `sessions.userId` is set once on `POST /api/sessions` from `currentUser()` and never changes. Add the index `{ userId: 1, createdAt: -1 }`.
- `projects.ownerId` is set on create. Under `"own"`, projects are per-user folders.
- `tenants.chatVisibility` is `"own" | "all"`. A missing value means `"all"`. `TenantRef` carries it. It is set in the admin dashboard, or with `npm run tenant -- chat-visibility <id> own|all`.
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
- `POST …/capabilities` is read for `thread/goal/get` and write for every other method, including commands.
- Projects follow the same table as chats, keyed on `ownerId`. Only the owner can rename or delete a project, or file a chat into it (on create or with `…/project`). Others get 404 where they can't see it and 403 where they can only read it.
- Requests with no user in context (ingestion, polling, cold resume, scripts) are not checked. Every `/api` request has a user, set by `userMiddleware`.

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

- `agentIds` replaces `agent.mcpProfileIds` for both scopes. It holds `String(agent._id)`. Migration moves existing attachments into it, and afterwards `agent.mcpProfileIds` is no longer read. The field stays on existing agent documents (and new agents still get `[]`), unread, until a later cleanup removes it.
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
| Delete for offboarding | — | Deleted automatically when the member is removed in the admin dashboard |

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

Tenant admins (`role: admin` in the current tenant). A `user` gets 403 `TENANT_ADMIN_REQUIRED` on every one of these:

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/tenant/mcp` | `{ profiles }`: every tenant MCP |
| POST | `/api/tenant/mcp` | Create a tenant MCP. The response carries `shadowedUserMcps` (user MCPs already using the name) and a warning |
| PATCH | `/api/tenant/mcp/:id` | Update or rotate the key; `shadowedUserMcps` as on create |
| DELETE | `/api/tenant/mcp/:id` | Delete a tenant MCP |
| GET | `/api/agents/:id/tenant-mcp` | `{ profiles, profileIds }`: tenant MCPs with `attached` for this agent |
| POST | `/api/agents/:id/tenant-mcp` | `{ profileIds }`: `$addToSet` / `$pull` on `agentIds` of tenant MCPs |

Response fields:

- `GET /api/mcp` returns `{ userProfiles, tenantProfiles }`. A user MCP a tenant MCP shadows has `shadowed: true` and a warning.
- Every profile carries `id`, `name`, `scope`, `enabled`, `transport`, `hasKey`, `urlHost` (host only, never the path or query), `agentIds` and `editable`. `GET /api/agents/:id/mcp` adds `attached`, and returns `{ profiles, profileIds, tenantProfiles }`; `tenantProfiles` are the tenant MCPs attached to the agent.
- No response contains a key, `apiKeyEnc` or header values.

Someone else's user MCP id returns 404 `MCP_NOT_FOUND` everywhere, for admins too.

Name clashes:

- A user MCP created or renamed to a tenant MCP's name returns 409 `MCP_NAME_RESERVED`. The same name twice in one scope returns 409 `MCP_NAME_TAKEN` (unique index).
- The cross-scope rule has no index, so after inserting or renaming a user MCP the platform checks again and, if a tenant MCP with that name appeared in between, deletes the insert or reverts the rename and returns 409.
- A tenant MCP created after a user one with the same name is not a race: the build skips the user copy.

**LEGACY(frontend-v1) shim.** The current MCP settings form (`frontend/components/mcp-settings.tsx`) has one list and uses only `GET/POST /api/agents/:id/mcp` and `POST /api/mcp`. Until the new MCP settings ship:

- For a tenant admin, `GET /api/agents/:id/mcp` also puts every tenant MCP in `profiles` (with `attached`) and `profileIds`. `POST /api/agents/:id/mcp` with `{ profileIds }` splits the ids by scope and replaces both sets: the admin's own user MCPs and the tenant MCPs. So an admin can keep attaching `qlik` and `btp` from the old form.
- For a `user` nothing changes: `profiles` and `profileIds` are their own user MCPs, and a tenant id in `profileIds` returns 404.
- `POST /api/mcp` from the old form now creates a user MCP owned by the caller.
- Dev mode's default user is `admin`, so a local UI without `X-Truex-User` keeps working.
- Remove the shim (marked `LEGACY(frontend-v1)` in `service.ts`) when the new MCP settings ship.

Offboarding: `PlatformService.deleteUserMcps(userId)` deletes that user's MCPs in the current tenant and returns `{ deleted }`. Member removal (Phase 5) calls it.

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
  - `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `APP_PUBLIC_URL`, `ADMIN_PUBLIC_URL`
  - `FRONTEND_ORIGIN`, `ADMIN_ORIGIN`
  - `RESEND_API_KEY`, `INVITE_FROM_EMAIL`
  - `MCP_ENCRYPTION_KEY`, `MCP_ENCRYPTION_KID`
  - `MCP_ALLOWED_PRIVATE_HOSTS`
- Google OAuth redirect URIs: `http://localhost:3000/auth/google/callback` and the production app host. The admin app doesn't use Google.
- Resend: verify the sending domain (DNS records) before inviting anyone other than the Resend account owner.

## Implementation phases

The work starts with a dev-mode identity. Chat ownership and MCP scopes need `currentUser()`, but they don't need Google, so they can be built and tested before real sign-in exists. Tracks in the same phase can run in parallel.

1. **Dev identity:** `user.ts`, `AUTH_MODE=dev`, `X-Truex-User`, `route()` wrapping `userContext`, `/api/me`, and fixtures for Ashok, Dharun and Admin in `t1` plus a second tenant `t2`.
2. **Standalone safety work:**
   - **MCP credential safety:** encryption, URL checks, field allow-lists, the new name rule, and removing raw config.
   - **Chat purge script:** dry run first. The real run happens only after the counts are reviewed.
   - **agent-core fingerprint resume.**
3. **Chat ownership:** `userId`/`ownerId`, `chatVisibility`, `sessionFor`, list filters and tests.
4. **MCP scopes:** `scope`/`ownerId`/`agentIds`, name rules, the `/api/mcp` and `/api/tenant/mcp` APIs, the session build and the migration.
5. **Auth backend:**
   - catalog collections and indexes
   - admin password login and `/api/admin/*`
   - invites with the Resend email
   - `/auth/invites/:token`
   - the Google flow with invite matching
   - sessions and `authMiddleware`
   - CSRF, rate limits and the recovery CLI
   - Google is faked in tests with a local issuer and JWKS, and Resend with a local stub.
6. **Admin dashboard app:** login, tenants list, create tenant, tenant settings, invites (send, resend, revoke) and members (role, remove). It needs a design pass first.
7. **Main app sign-in:** the forwarding Route Handlers, `/login`, `/invite/[token]`, `/select-tenant`, `proxy.ts`, 401 handling and the user menu. The invite page needs a design pass first.
8. **Frontend MCP settings:** "Your servers" (editable) and "Tenant servers" (editable for admins, read-only for users), the chat owner label, the admin "All users" toggle, and the read-only chat view.
9. **Deploy and docs:** Ingress, env, `HOST`, the Resend domain, and `docs/mongodb.md`, `README.md` and `docs/VALIDATION.md`.

Phases 1–4 need nothing external. Phase 5 needs a Google OAuth client, and a Resend API key with a verified domain.

## Tests

The platform tests use Ashok (`user`), Dharun (`user`) and Admin (`admin`) in tenant `t1`, plus a second tenant `t2`. Google is faked with a local issuer and JWKS, and Resend with a local stub.

Admin dashboard:

- [ ] The right username and password sign in. A wrong username or a wrong password gives the same error, and repeated failures are rate-limited.
- [ ] With `ADMIN_PASSWORD_HASH` unset, admin login is disabled.
- [ ] An admin session expires after 8 hours and gets 403 on tenant `/api/*`. A main app session gets 403 on `/api/admin/*`.
- [ ] Creating a tenant adds no members.

Invites:

- [ ] Creating an invite for a non-Gmail address is rejected. Inviting an active member or an already-invited address returns 409.
- [ ] Creating an invite calls Resend once with the link. A Resend failure keeps the invite and records `sendError`.
- [ ] Resend issues a new token, and the old link returns `used` or `not_found`.
- [ ] The public invite lookup returns only tenant name, email, role and expiry.
- [ ] Expired, revoked and used invites can't be accepted.
- [ ] Two parallel accepts of one invite create one membership.

Google sign-in:

- [ ] Accepting with the invited Gmail creates the user and membership with the invite's role and marks the invite accepted.
- [ ] Accepting with a different Gmail returns `wrong_account`, and the invite stays pending.
- [ ] An invite for `A.Shok+x@gmail.com` is accepted by `ashok@gmail.com`.
- [ ] Non-`@gmail.com`, a present `hd` claim, or `email_verified: false` is rejected.
- [ ] `/login` without an account returns `not_invited`. `/login` doesn't accept pending invites.
- [ ] A reused or expired `auth_flows` entry is rejected.
- [ ] A user with two memberships goes to the picker. `switch-tenant` to a tenant without membership returns 403. A switch issues a new token.
- [ ] Removing a membership or disabling a tenant ends the next request with 401 or 403.
- [ ] Tampered, expired, idle-expired and logged-out cookies return 401.
- [ ] A cross-origin POST is rejected.
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
- [ ] Removing a member in the admin dashboard deletes their user MCPs.
- [ ] No response or trace contains a key, `apiKeyEnc` or header values.
- [ ] Private and metadata URLs are rejected. An allow-listed private host is accepted.

Purge:

- [ ] The dry run writes nothing. A real run without `--confirm purge-chats` refuses. Agents, MCPs, models, skills and tenants remain after a run.

## Later

- A Members panel in the main app, so tenant admins can invite and manage people themselves.
- Google Workspace domains, and other identity providers.
- Per-user OAuth for MCP (Notion, GitHub, Atlassian): a platform-side authorization start and callback with PKCE and refresh, with tokens in `truex_mcp_credentials` keyed by `{ mcpId, userId }`. It stays outside Codex.
- A connector catalog in the catalog DB (`truex_connectors`), with `tenants.allowedConnectorIds`.
- Per-connector tool allow-lists linked to approval modes, and an audit log of tool calls per user.
