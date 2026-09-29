# User-owned MCP and chat visibility: plan

Status: planned, not implemented (2026-09-29). Tracks the backlog items "Allowing People to Connect with their Enterprise APP (MCP)" and "user can see only their own chats unless admin".

## Summary

- A tenant setting, `chatVisibility`, decides whether users see only their own chats (`"own"`) or every chat in the tenant (`"all"`). Admins always see every chat.
- Each MCP a user adds belongs to that user (`ownerId`). It loads only in sessions that user owns. Nobody else can list it, read it, attach it or have it load in their chat.
- Tenant-shared connectors, OAuth and the connector catalog (GitHub, Notion, Atlassian) are out of scope for now. See "Later".

The model depends on a trusted user id. Authentication is still in the backlog, so until it lands this runs on a development user resolver, and it organises data rather than protecting it. See "Identity".

## Current state

Checked in MongoDB on 2026-09-29:

| Database | Relevant contents |
|---|---|
| `truex_catalog` | `tenants` (only `default`, `dbName: "truex"`), `truex_models` (4), `truex_skills` (0) |
| `truex` (default tenant) | `truex_mcp` (2), `truex_agents` (1), `sessions` (1), `messages`, `projects`, `traces`; old copies: `truex_models`, `truex_runs`, `truex_conversations`, `truex_live_sessions` |

Existing MCP profiles:

- `qlik`: HTTPS, `auth.kind: "header"` (`x-api-qlik-key`). `apiKey` is stored in plain text.
- `btp`: plain `http://` to a public IP, `auth.kind: "none"`.

Neither has an owner, and the existing session has no `userId`.

How the code works today:

- `platform/src/service.ts:356`: session build loads every id in `agent.mcpProfileIds`. Every user of the agent gets the same MCPs.
- `agentMcp` / `setAgentMcp` (`service.ts:490`): lists all profiles in the tenant and writes attachments onto the shared agent.
- `platform/src/http.ts:29`: `tenantMiddleware` resolves the tenant per request through `TenantResolver`. `platform/src/tenant.ts` holds the dev resolver.
- `shared/contracts.ts:49`: `Session` has no user field. `Project` (`contracts.ts:339`) has no owner.

## Data model

### Tenant setting (catalog DB, `tenants`)

```js
{
  _id: "default",
  dbName: "truex",
  status: "active",
  chatVisibility: "own"   // "own" | "all"; missing means "all" (today's behavior)
}
```

The setting lives beside `allowedModelIds` and `allowedSkillIds` because the tenant database has no settings collection. `TenantRef` carries it, so handlers read it from `currentTenant()` without an extra query. Manage it with a new command: `npm run tenant -- chat-visibility <id> own|all`.

### Session (tenant DB, `sessions`)

```js
{ _id, agentId, threadId, ..., userId: "u_ashok" }
```

- `userId` is set once on `POST /api/sessions` from the resolved user and never changes.
- Add the index `{ userId: 1, createdAt: -1 }`.
- `Session` in `shared/contracts.ts` gets `userId?: string`.

### Project (tenant DB, `projects`)

```js
{ _id, name, ownerId: "u_ashok", createdAt, updatedAt }
```

Under `"own"`, a project folder follows the same visibility as chats. Otherwise Ashok's folder names show up for Dharun. Open question 2 covers this.

### MCP profile (tenant DB, `truex_mcp`)

```js
{
  _id: "mcp_<uuid>",
  name: "notion",
  ownerId: "u_ashok",              // required for new profiles
  agentIds: ["<agentId>"],         // agents the owner uses this MCP with
  enabled: true,
  transport: "http",
  url: "https://…",
  auth: { kind: "bearer" },        // none | bearer | header (+ headerName)
  apiKeyEnc: { v: 1, kid: "k1", iv: "…", tag: "…", data: "…" },
  capabilities: { connectTimeoutMs, requestTimeoutMs },
  createdAt, updatedAt
}
```

- `ownerId` and `agentIds` replace the shared `agent.mcpProfileIds` for user MCPs. A user MCP never goes into `agent.mcpProfileIds`.
- The unique index `{ ownerId: 1, name: 1 }` is needed because Codex keys servers by name (`mcp_servers.<name>`).
- Add the index `{ ownerId: 1, agentIds: 1 }` for the session-build lookup.
- `apiKey`/`apikey` in plain text are read only for legacy documents, and the migration encrypts them.
- Profiles with no `ownerId` are legacy shared profiles. See "Legacy profiles".

## Identity

A new `platform/src/user.ts` mirrors the tenant resolver:

```ts
export interface UserRef { id: string; role: "user" | "admin"; }
export interface UserResolver { resolve(req: Request): UserRef; }
export const userContext = new AsyncLocalStorage<UserRef>();
export const currentUser = () => userContext.getStore();
```

Development resolver:

- `DEV_USER_ID` (default `dev-user`) and `DEV_USER_ROLE` (default `admin`, so a local single-user setup keeps seeing everything).
- `DEV_USER_HEADER=on` lets `X-Truex-User` and `X-Truex-Role` pick the user. Use it locally only, to test Ashok and Dharun side by side.
- Like `devTenantResolver`, it refuses to start with `NODE_ENV=production` unless `ALLOW_DEV_USER=on`.
- User ids are validated with `/^[\w.@-]{1,128}$/`.

A `userMiddleware` next to `tenantMiddleware` in `http.ts` stores the result in `res.locals.user`. The `route()` wrapper then runs the handler inside `userContext`, the same way it does for the tenant.

When auth lands, the real resolver takes the user and role from the verified token or session cookie. User identity must never come from the request body.

## Chat visibility

### Rules

| Caller | `chatVisibility: "all"` | `chatVisibility: "own"` |
|---|---|---|
| Session owner | read and write | read and write |
| Admin (not owner) | read and write* | read only |
| Other user | read only | 404 |

\* Under `"all"`, non-owners can still only read. See the write rule below.

- **Write rule, both modes:** only the owner can act on a session: send a message, interrupt, answer an approval, change approval mode, upload documents, move it to a project, review a goal. A turn runs with the owner's MCP credentials, so letting anyone else drive it would use the owner's accounts.
- Hidden sessions return 404 rather than 403, so the response doesn't confirm the id exists.
- Legacy sessions with no `userId` are visible to admins only under `"own"`, until they are backfilled.

### Enforcement

Add one guard to `PlatformService`:

```ts
async sessionFor(id: string, mode: "read" | "write"): Promise<SessionDocument>
// loads the session, applies the table above, throws 404 or 403
```

Every `/api/sessions/:id/*` route calls it before doing anything, with the mode shown below. Routes are registered in `platform/src/index.ts`.

| Mode | Routes |
|---|---|
| read | `GET /api/sessions/:id`, `…/events` (SSE), `…/traces`, `…/timings`, `…/turns/:turnId/context`, `…/goal/history`, `…/documents` (GET), `…/documents/:fileId`, `…/visualizations/:fileId`, `…/capabilities`, `…/agents` (GET) |
| write | `…/messages`, `…/interrupt`, `…/agents/:agentId/interrupt`, `…/approvals/:requestId`, `…/approval-mode`, `…/project`, `…/documents` (POST/DELETE), `…/goal/review`, `…/agents/:agentId` (POST) |

- `GET /api/sessions` filters inside the query: `{ userId: user.id }` under `"own"` for non-admins, no filter otherwise. The UI must not do the filtering.
- `GET /api/projects` and the project routes follow the same rule on `ownerId`, if open question 2 is accepted.
- A test asserts that every `/api/sessions/:id` route in `index.ts` calls `sessionFor`, so a new route can't skip the check.

## User-owned MCP

### API

All endpoints filter by `ownerId: currentUser().id`. Admins get no special access to other users' MCPs, because they carry personal credentials.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/mcp` | The caller's MCPs, without secrets. Returns `hasKey: true/false` instead of the key. |
| `POST` | `/api/mcp` | Create with `ownerId` = the caller. `newMcpProfile` stays the field allow-list. Duplicate names per owner return 409. |
| `PATCH` | `/api/mcp/:id` | Update the owner's MCP. Rotate the key by sending a new one. |
| `DELETE` | `/api/mcp/:id` | Delete the owner's MCP. Its `agentIds` go with it. |
| `GET` | `/api/agents/:id/mcp` | The caller's MCPs, each with `attached` for this agent, plus legacy shared profiles marked read-only. |
| `POST` | `/api/agents/:id/mcp` | `{ profileIds }` sets `agentIds` on the caller's own MCPs only: `$addToSet` for listed ids, `$pull` for the caller's others. |

- Someone else's MCP id returns 404 on every endpoint.
- Changing legacy shared attachments (`agent.mcpProfileIds`) becomes an admin-only action.

### Session build

Change the loop at `service.ts:356` to:

1. Resolve the session's owner: `session.userId` for an existing session, the caller for a new one. Never use the caller of a resume or background request.
2. Load the legacy shared profiles from `agent.mcpProfileIds`, keeping only profiles without `ownerId`. A user MCP id that ended up there is skipped and logged.
3. Load the owner's profiles: `mcp.find({ ownerId, agentIds: agentId, enabled: { $ne: false } })`.
4. Reject name clashes between the two sets with `CONNECTOR_CONFIGURATION`, as the loop does today.
5. Decrypt `apiKeyEnc` only here, build `http_headers` through `mcpConfig()`, and put them into this thread's config only.

Cold resume and background ingestion (`store.ts:179`) take the owner from the stored session, so a resume after Ashok detaches or deletes an MCP no longer loads it.

### Credential encryption

- AES-256-GCM, with the key from `MCP_ENCRYPTION_KEY` (32 bytes, base64). It is never stored in MongoDB.
- The stored format is `{ v, kid, iv, tag, data }`. `kid` allows key rotation: `MCP_ENCRYPTION_KEYS` maps `kid` to key, and `MCP_ENCRYPTION_KID` picks the current one for writes.
- Decrypt at session build only. No API returns the plaintext or the ciphertext.
- Existing redaction of `apiKey`/`apikey` in diagnostics and traces also covers `apiKeyEnc` and `http_headers` values.

### URL checks

These apply to new and updated profiles:

- Reject hosts that resolve to loopback, link-local (including `169.254.169.254`), or private ranges, unless the host is in `MCP_ALLOWED_PRIVATE_HOSTS`. Check again at session build to catch DNS rebinding.
- Warn in the UI on `http://`. `MCP_REQUIRE_HTTPS=on` makes it an error.
- `stdio` stays blocked, as today.

## Legacy profiles (`qlik`, `btp`)

They have no `ownerId`, so they keep working as shared profiles through `agent.mcpProfileIds`. Nobody can edit them from the user UI. The migration offers two choices for each:

- `--assign <mcpId>=<userId>`: becomes that user's MCP. `agentIds` is copied from every agent that references it, and it is removed from `agent.mcpProfileIds`.
- Leave shared until tenant scope exists (default).

## Migration (`scripts/migrate-user-scope.mjs`)

Runs per tenant. `--dry-run` prints the changes and writes nothing. The script is safe to rerun.

1. Encrypt plain `apiKey`/`apikey` into `apiKeyEnc` and unset the plain fields. Stop if `MCP_ENCRYPTION_KEY` is missing.
2. Apply any `--assign` mappings.
3. `--backfill-sessions <userId>` sets `userId` on sessions without one (and `ownerId` on projects).
4. Create the new indexes.
5. Print a summary with counts.

Back up `truex_mcp` first. After step 1 the plain keys are gone, and only the encryption key can recover them.

## Frontend

- `frontend/components/mcp-settings.tsx`:
  - Show "Your MCP servers" (editable) and "Shared" (legacy, read-only).
  - Show key status as "set / not set", never the value.
  - Add edit, delete and key-rotation actions.
- Session list: under `"own"`, show only the user's chats. Admins get an "All users" toggle and see the owner on each chat.
- Read-only sessions (admin, or another user under `"all"`) hide the composer and the approval, interrupt and upload controls, with a short note saying why. The server still enforces these.
- Dev only: a user switcher that sends `X-Truex-User` when `DEV_USER_HEADER=on`.

## Tests

Platform tests, with Ashok (`user`), Dharun (`user`) and Admin (`admin`) in one tenant.

Chats:

- [ ] Under `"own"`, Dharun's `GET /api/sessions` doesn't include Ashok's session.
- [ ] Under `"own"`, Dharun gets 404 on every read and write route for Ashok's session, including SSE `events`.
- [ ] Under `"own"`, Admin can read Ashok's session and gets 403 on every write route.
- [ ] Under `"all"`, Dharun can read Ashok's session and gets 403 on write routes.
- [ ] Every `/api/sessions/:id` route registered in `index.ts` goes through `sessionFor`.
- [ ] A legacy session without `userId` is visible to Admin only under `"own"`.

MCP:

- [ ] Dharun's `GET /api/mcp` and `GET /api/agents/:id/mcp` don't include Ashok's MCP.
- [ ] Dharun gets 404 from `PATCH`/`DELETE /api/mcp/<ashok mcp>`, and from `POST /api/agents/:id/mcp` with Ashok's id.
- [ ] Dharun's new chat with the same agent doesn't have Ashok's MCP in its config.
- [ ] Ashok's chat has it, with the decrypted header.
- [ ] A cold resume of Ashok's chat after Ashok detaches the MCP doesn't load it.
- [ ] A user MCP id placed by hand in `agent.mcpProfileIds` is skipped for everyone except its owner's own attachment.
- [ ] A name clash between shared and user MCPs is rejected.
- [ ] No API response or trace contains the key, `apiKeyEnc`, or header values.
- [ ] Private or metadata URLs are rejected. An allow-listed private host is accepted.

Resolver:

- [ ] The dev user resolver refuses to start in production without `ALLOW_DEV_USER=on`.
- [ ] With `DEV_USER_HEADER` off, `X-Truex-User` is ignored.

## Implementation order

1. **Identity:** `user.ts`, `userMiddleware`, `userContext` in `route()`, and `userId` on new sessions and projects.
2. **Chat visibility:** `chatVisibility` on `TenantRef`, `sessionFor`, the list filter, the route guards, the tenant command, and the tests.
3. **MCP ownership:** the `ownerId`/`agentIds` fields, the owner-filtered APIs, the session-build change, and the tests.
4. **Credential safety:** encryption, redaction, URL checks, and the migration script.
5. **Frontend:** MCP panel sections, chat list filter, read-only session view, dev user switcher.
6. **Docs:** update `docs/mongodb.md` (new fields, indexes, commands, env vars).

Steps 1 to 3 can ship together. Step 4 must be done before any real user key is stored.

## Later

- **Tenant-shared connectors:** add `scope: "tenant"` to `truex_mcp`, made by admins, with `agent.mcpProfileIds` holding shared profiles only.
- **Per-user OAuth** (Notion, GitHub, Atlassian): platform-side authorization start and callback with PKCE and refresh. Tokens go in `truex_mcp_credentials`, keyed by `{ mcpId, userId }`. This stays outside Codex, per the no-Codex-changes rule, and the user MCPs above don't change.
- **Connector catalog:** templates in the catalog DB (`truex_connectors`), with `tenants.allowedConnectorIds` like the model and skill allow-lists.
- **Controls:** per-connector tool allow-lists linked to approval modes (read-only via `readOnlyHint`), and an audit log of tool calls per user.

## Open questions

1. Which role should the dev resolver default to: `admin` (current behavior, sees everything) or `user`?
2. Should projects follow `chatVisibility` (per-user folders), or stay shared across the tenant?
3. For `qlik` and `btp`: assign each to a user, or keep them shared until tenant scope exists?
4. Can admins delete other users' MCPs (for offboarding) without being able to read or use them?
