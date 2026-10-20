# Plan: directory connectors (MCP) for platform-next

Date: 2026-10-20. Status: **building** (go given 2026-10-20). See "Build contract" at the end.
Builds on chat v1 ([chat-v1-plan.md](chat-v1-plan.md)) and the runtime adapter
([runtime-adapter/README.md](../runtime-adapter/README.md)).

## Goal

A business user opens **Connected tools**, clicks **Connect GitHub**, approves
on GitHub's page and sees "Connected as @octocat". Chats with an agent that
attaches GitHub can then use GitHub's read-only tools. The user never sees a
URL, a token or the word "MCP".

The code is generic. GitHub is only the first catalog entry.

**Design rule:** adding a directory connector means adding one catalog
document, plus registering an OAuth client if the provider has no dynamic
registration. Code changes are needed only for a new auth type or a new
client-registration mode.

## Agreed decisions (user, 2026-10-20)

| Decision | v1 |
| --- | --- |
| Connector kinds | Directory connectors only, defined by the product team. Custom/SAP connectors are deferred. |
| First connector | GitHub hosted MCP server |
| Auth | `oauth_user`: each user signs in. No pasted tokens or URLs for business users. |
| Transport | Streamable HTTP only. stdio is never allowed. |
| Where tools appear | Only in chats whose agent attaches the connector. No per-chat toggle. |
| Read or write | Read-only. No approval UI in v1. |
| Tenant enable step | None. Every enabled catalog connector is visible in every workspace. |
| Connection scope | One per user per workspace (tenant DB) |
| Not connected | The chat opens; sending is blocked by a "This agent uses GitHub. Connect" card. |
| Token handling | Platform holds the tokens. Codex gets the access token in that thread's `http_headers` (no proxy in v1). |
| Token expiry | **Kept on** (GitHub App user tokens: 8 h access, 6 months refresh). The platform refreshes at run start; see "Token expiry" below (decided 2026-10-20). |

## Probe results (2026-10-20)

Probe sources: `.runtime/mcp-probe/` (the probe is gitignored; the run log is `run1.log`).

### 1. GitHub hosted server: auth discovery and licence

Tested unauthenticated against the live server, plus GitHub's docs.

- `POST https://api.githubcopilot.com/mcp/` and `/mcp/readonly` → `401`.
  The `WWW-Authenticate` header carries `resource_metadata=".../.well-known/oauth-protected-resource/mcp/readonly"`.
- Protected-resource metadata lists `authorization_servers: ["https://github.com/login/oauth"]`,
  `bearer_methods_supported: ["header"]` and OAuth-App scopes (`repo`, `read:org`, …).
- Authorization-server metadata lives at `https://github.com/.well-known/oauth-authorization-server/login/oauth`:
  - `authorization_code`, `refresh_token` and device grants
  - PKCE `S256`
  - `iss` returned on the redirect
  - **no `registration_endpoint`**, so there is no dynamic client registration and the product team must register an app
- A bogus bearer token returns `401 error="invalid_token"`. This status is what the verify step will look for.
- Licence, from GitHub's docs (`policies-and-governance.md`):
  - The remote server is available to all users "regardless of plan".
  - Only tools backed by paid features need that licence.
  - Third-party hosts are governed by OAuth App access policy, GitHub App installation and PAT policy, **not** by the Copilot MCP policy.
  - One third-party blog claims OAuth needs a Copilot licence. The docs contradict it.
- **Not verified:** an authenticated call with a token from *our* GitHub App,
  made by an account without Copilot. This needs a registered app (slice 0) and is the first gate.

### 2. Approval behaviour on the pin (real pinned Codex, fixture MCP server)

The probe used the adapter's own thread settings (`approvalPolicy: "never"`, text-only features):

| Tool annotations | Default `auto` mode | Result |
| --- | --- | --- |
| `readOnlyHint: true` | runs | reached the server, result returned to the model |
| none | refused | "MCP tool call requires approval, but approval policy is never" |
| `readOnlyHint: false` (write) | refused | same message |
| write, with `default_tools_approval_mode = "approve"` or `tools.<name>.approval_mode = "approve"` | runs without asking | reached the server |

- A refusal sends Codex no client request. The model receives the refusal text as the tool output, and the `mcpToolCall` item ends `failed`.
- GitHub's `/readonly` endpoint serves only tools whose `ReadOnlyHint` is true (upstream `pkg/inventory/server_tool.go:174`). So every tool it offers passes `auto`, and **v1 needs no approval path**.
- The adapter must **never** emit `approve` modes. A catalog or agent setting must not be able to switch write tools on silently.
- MCP tools reach the model as one `namespace` declaration, `mcp__<server>`.
- Whenever any MCP server is configured, Codex also adds three built-in tools: `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource` (`core/src/tools/spec_plan.rs:1268`).
- model-gateway already flattens namespace tools for the chat, anthropic and gemini adapters (`model-gateway/src/tool-names.ts`).

### 3. Where secrets land on disk

After three threads, two process restarts and a resume, the probe scanned all 97 files under `CODEX_HOME` for the header token, the rotated token and the gateway token. **None were found.** The MCP URL and the custom header name were not on disk either.

Positive control: the prompt text and the tool *result* text were found in `sessions/**/rollout-*.jsonl` and `thread_history_1.sqlite`. Tool output is therefore stored on `/mnt/state`, in the same way chat text already is.

Resume behaviour:

- **Resume without `mcp_servers` gives the model no MCP tools at all.** The config is not kept with the thread. The adapter must send it on every `thread/resume`.
- Resume with a rotated token uses the new token.
- A thread that is already loaded keeps its headers until its Codex process unloads.

### 4. Token cost per turn

Estimated from upstream toolsnaps (`github-mcp-server@e3809fe`, 2026-10-15), counting the declaration Codex sends and dividing characters by 4:

| Tool set | Tools | ≈ tokens per turn |
| --- | --- | --- |
| `/mcp/` default toolsets (context, repos, issues, pull_requests, users, copilot) | 78 | 19.5k |
| **`/mcp/readonly` (default toolsets, read-only)** | **29** | **7.9k** |
| all toolsets, read-only | 61 | 16k |
| all toolsets | 141 | 36k |

The largest read-only tools are `pull_request_read` (≈640 tokens), `list_issues` and `search_issues`. Narrowing with `X-MCP-Toolsets` or `X-MCP-Tools` can cut the 7.9k further. The real count is measured from `tools/list` when a user connects (slice 2), and stored on the catalog entry as an estimate.

## Records

```text
truex_mcp_connectors   catalog DB   product team   1 per connector, no user secrets
agents.connectors[]    tenant DB    agent creator  which connectors an agent uses
mcp_connections        tenant DB    one user       that user's encrypted tokens
chats.connectors[]     tenant DB    snapshot at chat creation
```

### Catalog: `truex_mcp_connectors` (catalog DB)

Written only by the operator CLI, like `truex_models`. Documents are disabled, never deleted.

```ts
interface McpConnectorDoc {
  _id: ObjectId;
  slug: string;              // "github"; ^[a-z][a-z0-9_]{1,30}$, unique, never changes (Codex server name)
  displayName: string;       // "GitHub"
  description: string;
  icon: string;              // design-spec icon key
  url: string;               // "https://api.githubcopilot.com/mcp/readonly"; https only
  fixedHeaders: Record<string, string>; // non-secret, e.g. X-MCP-Toolsets; never user-editable
  auth: {
    type: "oauth_user";      // v1 handler; later api_key, client_credentials, token_exchange
    registration: "preregistered"; // later "dcr" / "cimd"
    clientId: string;
    clientSecretArn: string; // Secrets Manager
    scopes: string[];        // GitHub App: [] (permissions live on the app)
    discovery: "protected_resource_metadata"; // endpoints found from the server, not hard-coded
    revoke?: "github_app_grant" | "rfc7009"; // revoke handler kind
    accountTool?: { name: string; field: string }; // { name: "get_me", field: "login" }
    adminHelp?: { text: string; url: string };      // shown for needs_admin_approval
  };
  allowedTools?: string[];   // → Codex enabled_tools (defence in depth)
  toolTimeoutSec: number;    // default 60
  startupTimeoutSec: number; // default 15
  toolTokenEstimate?: number; // measured on connect; shown when attaching
  sortOrder: number;
  enabled: boolean;
  revision: number;
  createdAt: Date; updatedAt: Date; updatedBy: string;
}
// index { slug: 1 } unique
```

### Connection: `mcp_connections` (tenant DB)

```ts
interface McpConnectionDoc {
  _id: ObjectId;
  connectorId: ObjectId;
  ownerId: ObjectId;
  status: "active" | "needs_reconnect" | "needs_admin_approval";
  secret: {                  // never projected by default, never returned by any API
    keyId: string; iv: Binary; tag: Binary; ciphertext: Binary; // AES-256-GCM of {accessToken, refreshToken?}
  };
  accessExpiresAt?: Date; refreshExpiresAt?: Date;
  account?: { login: string };
  toolCount: number;
  lastVerifiedAt: Date; lastUsedAt?: Date;
  lastError?: { code: string; at: Date };   // safe codes only, never provider text
  revision: number;
  createdAt: Date; updatedAt: Date;
}
// index { ownerId: 1, connectorId: 1 } unique — reconnect is an upsert
```

- **AAD** = `tenantId|ownerId|connectorId|keyId`. A ciphertext copied to another row fails to decrypt.
- **Keys:** `MCP_TOKEN_KEYS=<keyId>=<base64 32 bytes>[,…]` plus `MCP_TOKEN_ACTIVE_KEY`, loaded from Secrets Manager in production. This follows the `AUTH_SIGNING_KEY` rotation pattern. KMS envelope encryption is a later hardening step.
- A default projection excludes `secret`, like `SECRET_PROJECTION` for models. Only the run executor reads it.

### Agent and chat

- `AgentDoc.connectors: Array<{ connectorId: ObjectId }>`. At most 3 per agent in v1. Only enabled catalog entries can be added.
- At creation, the chat stores `connectors: [{ connectorId, slug }]` and a new prompt version. Agent edits affect only new chats, the same rule as prompts.

## Flows

### Connect

```text
Browser  POST /api/v1/connectors/github/connect?tenantId=…  (authenticated) → { authorizeUrl }, then navigates
Platform discover endpoints from the connector URL's 401 / protected-resource metadata (cached)
         set short-lived flow cookie {state, PKCE verifier, connectorId, tenantId, userId}
         302 → https://github.com/login/oauth/authorize?client_id&redirect_uri&state&code_challenge
GitHub   user approves → 302 /api/connectors/callback?code&state&iss
Platform check cookie state, iss and the session's user and tenant
         exchange the code (client secret from Secrets Manager) → tokens
         verify: MCP initialize + tools/list with the token (and accountTool, if set)
         encrypt and upsert the connection; audit "connector.connected"
         302 → frontend /connected-tools?connected=github
```

- This reuses `modules/auth/oauth-flow.ts` (flow cookie and PKCE), generalised with a connector-specific cookie name.
- Callback errors map to safe codes:
  - `access_denied` → the user cancelled
  - an org restriction → `needs_admin_approval`, with `adminHelp`
  - verify `401` → failure
  - anything else → retryable failure
- If verification fails, nothing is stored.

### Chat run

```text
send → load chat.connectors → one find() of the owner's connections ($in)
     → any missing / not active → 409 CONNECTION_REQUIRED {connectors:[slug…]}  (nothing started)
     → decrypt → StartRunRequest.mcp = [{ name: slug, url, headers, enabledTools, timeouts }]
adapter → thread/start or thread/resume with mcp_servers.<slug> (sent every time; probe 3)
Codex  → calls GitHub directly → mcpToolCall items → adapter tool events → platform → UI cards
```

The token travels in the AgentCore invocation payload and stays in adapter and Codex memory only. Probe 3 showed it is not written to `/mnt/state`.

### Disconnect

`DELETE /api/connectors/:slug/connection` revokes the grant at the provider using the catalog's `revoke` handler, then deletes the record and audits the change.

Revocation must happen first. A thread that is already loaded keeps its token in memory, so revoking is what actually stops access. If revocation fails, the record is still deleted. The user is shown a "Revoke on GitHub" link, and a warning is logged.

## Slices and acceptance criteria

### Slice 0: GitHub App and licence gate (manual, needs the user)

- The product team registers a GitHub App "Truex (dev)":
  - Permissions: Contents, Issues, Pull requests and Metadata, all read.
  - User-token expiry left **on** (decided 2026-10-20: handled by refresh at run start).
  - Callback `http://localhost:3000/api/connectors/callback`.
- The client secret is never pasted in chat. v1 keeps it in a platform env var (`clientSecret: { env }`); moving it and the token keys into Secrets Manager is backlog (`backlog/security/02-connector-secrets-in-aws.md`, decided 2026-10-20).
- **Acceptance:** with a user token from this app, made by an account without
  Copilot, `initialize` + `tools/list` on `/mcp/readonly` returns 200 and the
  tool list, and one `get_me` call succeeds.
- **If this fails, stop and re-plan.** The fallback is a self-hosted
  `github-mcp-server` behind HTTP, which we would own.

### Slice 1: catalog and operator CLI (platform-next)

- `truex_mcp_connectors` with the validator above. `operator mcp upsert --file`, `mcp list` and `mcp disable`.
- **Acceptance:**
  - Invalid documents are rejected with field errors. This covers non-https URLs, a bad slug, a slug change on update, an unknown `auth.type` or `registration`, and a secret value in `fixedHeaders`.
  - Upsert bumps `revision`. A disabled connector disappears from the API but existing records stay readable.
  - Adding a second connector is data only: a test inserts a fixture connector and it appears in the API with no code change.

### Slice 2: connections, OAuth and crypto (platform-next)

Routes:

| Route | Purpose |
| --- | --- |
| `GET /api/connectors` | Catalog merged with my status: `not_connected`, `active`, `needs_reconnect` or `needs_admin_approval`, plus `account` and `toolCount` |
| `POST /api/connectors/:slug/connect` | Start sign-in (returns the authorize URL; see Build contract) |
| `GET /api/connectors/callback` | Finish sign-in |
| `POST /api/connectors/:slug/connection/verify` | Re-check a saved connection |
| `DELETE /api/connectors/:slug/connection` | Disconnect |

Acceptance (tested against a local fixture authorization server and MCP server):

- A full connect stores one encrypted record. No API response, log or audit entry contains the token; tests check this with a marker token.
- Reconnecting upserts the same record (unique index), including when two callbacks race.
- State mismatch, a missing or expired cookie, an `iss` mismatch, a session user or tenant different from the flow, and code replay are all rejected with nothing stored.
- Verify `401` → nothing stored. Org-restricted → `needs_admin_approval` with the help link.
  - **Deviation (2026-10-20):** GitHub issues a normal user token when an org
    has not installed the app; the org's repositories are just absent. Nothing
    at sign-in can detect it, so no GitHub path sets `needs_admin_approval`.
    The status stays reserved for providers that report it, and the catalog's
    `adminHelp` is shown on connected cards as well.
- A ciphertext moved to another owner's row fails to decrypt. Rotating to a new active key still decrypts old rows.
- Discovery reads the endpoints from protected-resource metadata. No GitHub URL appears in code.

### Slice 3: runtime adapter MCP support

- `StartRunRequest.mcp?: McpServerSpec[]`, typed and validated:
  - at most 3 servers
  - `name` must match the slug pattern
  - `https` only, with loopback allowed only under a test flag
  - header names from a safe charset; values up to 8 KB; no `approval_mode` field exists at all
- The adapter builds `mcp_servers.<name>` with `default_tools_approval_mode` forced to `"auto"`. It sends the config on **both** start and resume.
- Events:
  - `tool.started` / `tool.completed {itemId, connector, tool, status, durationMs, errorCode?}` from `mcpToolCall` items. Arguments and results stay out of events and logs.
  - `connector.status {name, status, reason?}` from `mcpServer/startupStatus/updated`.
- The watchdog re-arms on any item or tool event, not only on agentMessage deltas.
- Tests, on the real pin with the fixture MCP server (promoted from the probe):
  - A read-only tool runs.
  - An unannotated or write tool is refused, and the refusal reaches `run.completed`.
  - A resume without `mcp` exposes no tools. A resume with `mcp` exposes them, and a rotated token is used.
  - The header marker never appears in adapter logs or on disk under the state directory.
  - A tool call that lasts longer than the watchdog (shortened via test limits) finishes without `MODEL_TIMEOUT`.
  - An MCP server that is down at startup → the chat still answers and `connector.status` reports `failed`.
  - A `401` at startup → check whether the pin reports `ReauthenticationRequired` for header auth, and map it to `reason: "auth"`.
  - Existing tests pass unchanged when `mcp` is absent; the text-only behaviour is identical.

### Slice 4: agents and chats (platform-next)

- Agents: `connectors` field in create and edit, validated against enabled catalog entries. At most 3. Built-in General Agent stays without connectors.
- Chats:
  - Snapshot `connectors` at creation.
  - New prompt version `v3`. Tool chats replace the "You have no tools" sentence with a generic paragraph listing connector display names and "read-only".
  - Text-only chats keep their current version.
- Run executor:
  - Loads connections with one query, sends `409 CONNECTION_REQUIRED` before starting anything, decrypts and passes `mcp`.
  - Updates `lastUsedAt` at most once an hour.
  - On `connector.status` with `reason: "auth"`, marks the connection `needs_reconnect`.
- Messages store a tool summary per call: connector, tool title, status and duration. Raw arguments and results are not stored in Mongo in v1.
- **Acceptance:**
  - An agent edit doesn't change existing chats.
  - A disconnected user gets 409 with the slugs, and no run, message or runtime call is created.
  - A tool chat's prompt contains no connector URLs or IDs.
  - The extra Mongo work is one connection read per run start, confirmed by counting round trips the way the chat latency work did.

### Slice 5: frontend

Design spec first. If a screen is not in `truex-design-spec.html`, it is mocked and approved before it is built.

- Connected tools screen: logo, name, description, status, Connect / Reconnect / Disconnect, "Ask your GitHub admin" state.
- In the agent dialog, a connector picker that shows the tool-token estimate.
- In chat:
  - the Connect card when sending is blocked
  - tool-call cards: "Searched GitHub issues · 1.2 s" and a failed state
  - a banner when a connector is unavailable
- **Acceptance:** driven in headless Chromium with a mocked API for every state above. Keyboard and screen-reader labels are covered.

### Slice 6: end to end on AgentCore

- Deploy the adapter image. Then connect a real GitHub account through the dev app. Then ask "What are the open PRs in <repo>?"
- **Acceptance:**
  - The answer cites real data.
  - The tool card shows.
  - The token is absent from `/mnt/state` (scan through the agentcore test script) and from CloudWatch logs.
  - After Disconnect, the next run is blocked and the grant is gone at GitHub.
  - p50 and p95 run-start latency is recorded with and without the connector.

## Risks

| Risk | Level | Mitigation |
| --- | --- | --- |
| Our app's token is refused, or a Copilot licence is required | High, unverified | Slice 0 gate before any build |
| A write tool runs without consent | Critical | `/readonly` URL; adapter forces `auto` and has no approve field; `allowedTools`; test that write tools are refused |
| Token leaks through logs, API or disk | Critical | Write-only API, default projection, marker-token tests at every layer, disk scan on AgentCore |
| Tool output (private repo content) stored on `/mnt/state` and in Codex history | Medium | Same as chat text today; listed in the data-handling notes; per-chat deletion keeps covering the Codex home |
| A loaded thread keeps a revoked token in memory | Medium | Revoke at the provider on disconnect |
| Org admins have not installed the app, so connect fails for org repos | Medium (UX) | `needs_admin_approval` state with an admin link; personal repos still work |
| Tool schemas cost about 8k tokens per turn | Medium (cost) | Cap of 3 connectors, token estimate shown, prompt cache, `X-MCP-Tools` narrowing; broker later (token optimization plan) |
| Gateway tool translation fails on a provider | Medium | One tool-call test per gateway adapter in slice 3/6 |
| A reply that runs longer than the refresh margin (15 min) meets an expired token | Low | Tool call fails; the next message refreshes. The proxy removes this if it matters |
| Two processes refresh one rotating refresh token | High → mitigated | Single-flight: in-process promise + Mongo lease; the write requires the lease |
| Crash after the provider rotated the refresh token, before it is stored | Low | The stored refresh token is dead; the next refresh is refused → `needs_reconnect`, the member signs in again |

## Deferred

- Write tools and the approval flow (Allow once / Always allow)
- Custom and SAP connectors
- `api_key`, `client_credentials` and `token_exchange` auth types
- DCR/CIMD registration
- The MCP proxy: Truex MCP gateway so provider tokens never reach Codex, with server-side policy (`backlog/security/05-truex-mcp-gateway.md`, added 2026-10-21)
- A tenant-admin enable step
- A per-chat toggle
- Tool search / broker

## Open items

1. Who registers the GitHub App (slice 0), and under which GitHub account or org?
2. Callback host for dev and production (`/api/connectors/callback` on the frontend origin, forwarded to the platform).
3. Narrow the tool set beyond `/readonly`, e.g. drop `users` and `context`, or keep all 29 tools for v1?

## Build contract (locked 2026-10-20, build started)

Fixed before the parallel build so runtime-adapter and platform-next can be
built at the same time. Changing anything here means updating both sides.

### Adapter request: `StartRunRequest.mcp`

Optional. Absent or `[]` = today's text-only behaviour, byte for byte.

```ts
interface McpServerSpec {
  name: string;          // /^[a-z][a-z0-9_]{1,30}$/, unique in the list; Codex server name
  url: string;           // https only; no credentials, query or fragment.
                         // http on loopback only when ADAPTER_ALLOW_LOOPBACK_MCP=1 (tests)
  headers: Record<string, string>; // ≤ 16; names /^[A-Za-z0-9-]{1,64}$/; values 1-8192 chars, no CR/LF/NUL
  enabledTools?: string[];         // ≤ 200; /^[A-Za-z0-9_.-]{1,64}$/ → Codex enabled_tools
  toolTimeoutSec: number;          // 1-300
  startupTimeoutSec: number;       // 1-60
}
// StartRunRequest.mcp?: McpServerSpec[]   (≤ 3 entries)
```

- There is no approval field. The adapter always writes
  `default_tools_approval_mode = "auto"` and nothing per tool.
- The config is sent on **every** `thread/start` and `thread/resume`.
- If a thread is already loaded with a different MCP fingerprint (hash of the
  specs including headers), the adapter reloads it so the new spec applies.
- Header values never appear in logs, errors, events or the request hash
  surface that is logged.

### Adapter events (SSE, additive)

| Event | Data |
| --- | --- |
| `tool.started` | `{ itemId, connector, tool }` |
| `tool.completed` | `{ itemId, connector, tool, status: "completed" \| "failed", durationMs, errorCode? }` |
| `connector.status` | `{ connector, status: "starting" \| "ready" \| "failed", reason?: "auth" \| "unreachable" \| "unknown" }` |

`errorCode` is one of `REFUSED` (Codex approval refusal), `TOOL_ERROR`
(server returned an error), `TIMEOUT`, `UNKNOWN`. Arguments, results and
provider error text are never in events or logs.

`RunItem` gains `{ type: "tool", itemId, connector, tool, status, durationMs, errorCode? }`,
placed in stream order, so `run.completed.items` and `run.snapshot` carry tool
calls. Platform's `itemsOf` ignores unknown item types, so this is backward
compatible.

Watchdog: while any tool call is in flight, the silence timer is replaced by
the call's own limit (`toolTimeoutSec` + 15 s grace); it re-arms with
`silenceMs` when the call completes.

### Platform routes (`/api/v1`, tenant routes use `?tenantId=`)

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /connectors` | Tenant | Enabled catalog merged with my connection status |
| `POST /connectors/:slug/connect` | Tenant | Returns `{ authorizeUrl }` and sets the sealed flow cookie; the browser then navigates |
| `GET /connectors/callback` | Flow cookie | Finishes sign-in, 302 to `${FRONTEND_ORIGIN}/connected-tools?connected=<slug>` or `?error=<code>&connector=<slug>` |
| `POST /connectors/:slug/connection/verify` | Tenant | Re-check a saved connection |
| `DELETE /connectors/:slug/connection` | Tenant | Revoke at the provider, then delete |

The API authenticates with bearer access tokens, so a plain navigation can't
start a sign-in; hence POST then navigate. The flow cookie is AES-GCM sealed
with the active connector token key (AAD `connector-oauth-flow`), holds
`{state, codeVerifier, connectorId, tenantId, userId, startedAt}`, lives 10
minutes, is path-scoped to the callback and cleared on use. At the callback the
platform re-checks that the user is still an active member of the tenant.

### Platform → executor

`ConnectorsService.runSpecs(dbName, userId, connectorIds)` returns either
`{ ok: true, specs: McpServerSpec[] }` or `{ ok: false, missing: slug[] }`,
using one `find` on `mcp_connections`. Slice 4 calls it from the run
executor.


## Token expiry (decided 2026-10-20)

The user kept GitHub's token expiry on. Codex cannot refresh a token it was
handed, so the platform makes sure every run starts with one that lasts.

```text
send → runSpecs → token valid ≥ 15 min?  yes → use it
                                          no  → refresh (single-flight)
refresh: in-process promise per connection
       → Mongo lease on the row (findOneAndUpdate, 30 s, revision-free)
       → POST token_endpoint grant_type=refresh_token
       → store new access + rotated refresh token, only while the lease is ours
waiters (other process): poll the row every 200 ms, up to 15 s, then use the new token
```

| Case | Result |
| --- | --- |
| Provider refuses the refresh token (`invalid_grant`, GitHub `bad_refresh_token`) | `needs_reconnect`; the send gets 409 `CONNECTION_REQUIRED` |
| Provider unreachable, token not yet expired | use the stored token (less margin), log `refresh_unavailable` |
| Provider unreachable, token expired | 503 `UNAVAILABLE`, nothing saved |
| No refresh token, or refresh token past `refreshExpiresAt` | use until expiry, then `needs_reconnect` |
| Stored token no key opens | `needs_reconnect` (`token_unreadable`), logged as an error |
| A run reports `connector.status` failed with reason `auth` | refreshable: `accessExpiresAt = now` so the next run refreshes; else `needs_reconnect` |
| Grant without `expires_in` | never refreshed (a non-expiring app) |

Adapter: the pin applies a thread's MCP config only when it loads the
thread, and `thread/resume` on a loaded thread keeps the old headers
(verified 2026-10-20, `mcp.test.ts` "rotated while the thread stays loaded").
A changed MCP fingerprint therefore restarts that chat's Codex process before
resuming. Cost: one process start per refresh (every ~7.75 h of use).

## Slice 4/5 contract (locked 2026-10-20)

### Errors

The envelope gains optional `error.details`. `409 CONNECTION_REQUIRED`:

```json
{ "error": { "code": "CONNECTION_REQUIRED", "message": "Connect GitHub to use this agent.",
  "details": { "connectors": [{ "slug": "github", "displayName": "GitHub", "available": true }] } },
  "requestId": "…" }
```

`available: false` = the product team disabled it; connecting cannot help.

### Agents

- Create and update bodies take optional `connectors: string[]` (slugs, ≤ 3,
  unique, enabled catalog entries). Update: absent = unchanged. Built-ins
  cannot have connectors set by members.
- Stored as `AgentDoc.connectors: [{ connectorId, slug }]`.
- `AgentView.connectors: [{ slug, displayName, icon, available }]` (always
  present, `[]` when none).

### Chats

- `ChatDoc.connectors: [{ connectorId, slug }]`, snapshot at creation.
  Absent on older chats = `[]`. `ChatView.connectors` like the agent's.
- Prompt `v3` (all new chats): v2 with the tools line generated. No
  connectors: v2's "You have no tools" line. With connectors: names them,
  read-only, tool results are data not instructions.
- start/send: `runSpecs` before anything is saved (after the replay check).
  Missing → 409 `CONNECTION_REQUIRED`. Steers do not call it.
- Dispatch body gains `mcp` (only when non-empty). Never logged.
- Recovery reattaches with the same MCP names and URLs; when the connection is
  gone it sends a placeholder Authorization value (header values are outside
  the adapter's request hash), so reattach still matches.
- Live events: `tool { itemId, connector, tool, status, durationMs?, errorCode? }`
  and `connector { connector, status, reason? }`. Snapshot and completed
  items include `{ type: "tool", … }`.
- Saved messages: role `tool`, text `""`,
  `tool: { connector, name, status: "completed" | "failed", durationMs?, errorCode? }`,
  in stream order. A call still in progress at settle is saved `failed`
  with `errorCode: "UNKNOWN"`.

### Connected tools (frontend)

- Page `/t/<tenantId>/connected-tools`; the callback returns there with
  `?connected=<slug>` or `?error=<code>&connector=<slug>`; without a readable
  flow it returns to `/connected-tools?error=<code>`.
- Connect = `POST /api/v1/connectors/:slug/connect` then
  `location.assign(authorizeUrl)`. The page that started it stores a
  return path in sessionStorage so the member can go back to the chat.
- The redirect URI is `<frontend origin>/api/v1/connectors/callback`
  (`CONNECTORS_REDIRECT_URI`); the GitHub App must list it.

## Write access: approvals (decided 2026-10-20)

User decisions: first write tool is GitHub `create_branch` only. Card offers
Allow once / Allow for this chat / Deny. Read tools keep running without a
card. The agent creator picks access per connector (read and write by
default, read only on request). Everything ships in one commit with the
read-only work.

### Probe on the pin (`.runtime/mcp-probe/approval-probe*.ts`, 2026-10-20)

| Question | Result |
| --- | --- |
| Request Codex sends | `mcpServer/elicitation/request` `{threadId, turnId, serverName, mode:"form", message, _meta:{codex_approval_kind:"mcp_tool_call", persist:["session","always"], tool_description, tool_params, tool_params_display}}`. No tool name field; the preceding `mcpToolCall` `item/started` has it. |
| Allow once | `{action:"accept", content:{}}` → tool runs; the next call asks again |
| Allow for session | `{action:"accept", content:{}, _meta:{persist:"session"}}` → later calls of that tool in the loaded thread run without asking. Lost when the process restarts (asked again after resume). |
| Deny / cancel | `decline` → item failed "user rejected MCP tool call"; `cancel` → "user cancelled MCP tool call". The model sees that text; the server is never called. |
| `persist:"always"` | Offered by Codex; would write config.toml in the runtime. Never sent. |
| No answer | Codex waits indefinitely (200 s observed). The adapter owns the timeout. |
| Interrupt while pending | Turn ends `interrupted`, Codex sends `serverRequest/resolved`; a late accept is ignored (tool never runs). |
| Read-only tool | Runs with no request, as before. Unannotated tool now asks. |
| Policy | `approvalPolicy: {granular:{sandbox_approval:false, rules:false, skill_approval:false, request_permissions:false, mcp_elicitations:true}}` behaves as above and offers the model exactly the same tools as `never`. Used whenever a run has MCP servers; text-only runs keep `never`. |

### Adapter contract (additive)

- `McpServerSpec.approvedTools?: string[]`: tools the member allowed for this
  chat. The adapter answers their requests itself with `persist:"session"`.
  Not part of the MCP fingerprint (no process restart when it grows).
- `StartRunRequest.limits.approvalMs?`: 10 s … adapter max (default 5 min).
- Events:
  - `approval.requested {approvalId, itemId, connector, tool, params, expiresAt}`
  - `approval.resolved {approvalId, itemId, connector, tool, decision, auto, params}`
    with `decision` one of `allow`, `allow_for_chat`, `deny`, `expired`,
    `cancelled`.
  - `params` = `[{name, value}]` from Codex's display params, at most 12,
    values stringified and cut to 500 chars. Shown on the card and audited;
    never logged.
- `run.snapshot.approvals`: pending approvals, so a reconnecting caller can
  show the card. Tool `RunItem`s gain `approval?: decision`. A denied, expired
  or cancelled call completes `failed` with `errorCode: "DENIED"`.
- `POST /v1/runs/:runId/approvals/:approvalId {tenantId, chatId, decision}`
  with decision `allow` | `allow_for_chat` | `deny`. 200 `{decision}`;
  409 `APPROVAL_RESOLVED` when already answered (first answer wins);
  404 `APPROVAL_NOT_FOUND`.
- While any approval is pending the silence watchdog is off; the approval
  timer replaces it and answers `decline` on expiry.
- Stop: pending approvals resolve `cancelled` at once. Steer: pending
  approvals are declined first (`deny`), then the steer is sent.
- A server's own elicitation (not `codex_approval_kind: mcp_tool_call`) and a
  request that matches no in-progress tool call are declined.

### Platform

- Catalog `writeTools?: string[]` (⊆ `allowedTools`). GitHub: URL `/mcp/`
  (not `/readonly`), `allowedTools` = the 28 read tools + `create_branch`,
  `writeTools: ["create_branch"]`.
- Agent `connectors: [{slug, access: "read_write" | "read_only"}]` on
  create/update (strings still accepted = `read_write`). `read_only` removes
  `writeTools` from `enabledTools`. Snapshotted on the chat with the
  connector.
- Prompt `v4` for new chats: says which tools change data and that each
  change waits for the member's approval.
- `ChatDoc.toolApprovals: [{connector, tool, at}]` grows when the member picks
  Allow for this chat; sent as `approvedTools`.
- `POST /api/v1/chats/:chatId/runs/:runId/approvals/:approvalId?tenantId=`
  `{decision}`: owner only, forwards to the adapter, records the chat allow
  after a 200.
- Live event `approval {approvalId, itemId, connector, tool, params,
  expiresAt?, decision?}`; `Snapshot.approvals` for pending ones.
- Audit: tenant collection `tool_approvals`, one document per
  `approval.resolved` the run reader sees: `{chatId, runId, userId,
  connector, tool, decision, auto, params, at}`.

### Write access contract (locked 2026-10-20, platform-next ↔ frontend)

Catalog (`ConnectorSpec`, operator CLI):
- `writeTools?: string[]`: tools that change data. Each must be in
  `allowedTools`; `writeTools` without `allowedTools` is refused (a read-only
  agent needs an explicit list to subtract from). ≤ 50.
- `ConnectorView` gains `writeTools: string[]` (always present, `[]`).

Agents:
- Create/update `connectors` entries are a slug string (= `read_write`) or
  `{ slug, access: "read_write" | "read_only" }`. Same caps as before.
- `AgentConnector` / `ChatConnector` gain `access?: "read_only"` (absent =
  `read_write`, so old documents keep their meaning). An edit that only
  changes access is a change. `requestHashOf` includes access.
- `AgentConnectorView` gains `access: "read_write" | "read_only"` and
  `writeTools: string[]` (the catalog's; `[]` when unavailable).
- The chat snapshots access with the connector at creation.

Runs:
- `runSpecs`: `enabledTools` = `allowedTools`, minus `writeTools` when the
  chat's connector is `read_only`. `approvedTools` = the chat's
  `toolApprovals` for that connector (only when non-empty).
- Dispatch `limits.approvalMs` = 5 min (adapter default; not sent).
- Prompt `v4` (new chats; v3 kept): v3's tools line, plus when the chat has
  any writable tool: "These tools change data: <tool names>. Each change waits
  for the member's approval; if they decline, do not retry it, ask what they
  want instead." Read-only chats keep v3's wording.

Approvals (platform):
- Adapter `approval.requested` → `LiveRun` pending map + live event
  `approval { approvalId, itemId, connector, tool, params, expiresAt,
  status: "pending" }` (`expiresAt` ISO string).
- Adapter `approval.resolved` → live event `approval { approvalId, itemId,
  connector, tool, params, status: <decision>, auto }`, removed from pending.
  The reader also (not awaited, logged on failure):
  - inserts an audit document into tenant `tool_approvals`
    `{ _id: approvalId, chatId, runId, userId, connector, tool, decision,
    auto, params, at }` (`_id` = approvalId string makes a reconnect replay
    idempotent: duplicate key is ignored);
  - when `decision === "allow_for_chat"` and `!auto`: `$addToSet` the chat's
    `toolApprovals: { connector, tool }` (bounded: ≤ 50 entries).
- `Snapshot.approvals`: pending approvals (same shape as the live event).
  Adapter `run.snapshot.approvals` is merged in on reconnect.
- `ToolSettleItem.approval?` and the saved tool message's `tool.approval?`
  carry the decision; `errorCode: "DENIED"` is kept (add to the allowed set).
- Route `POST /api/v1/chats/:id/runs/:runId/approvals/:approvalId?tenantId=`
  body `{ decision: "allow" | "allow_for_chat" | "deny" }` (unknown fields
  refused). Owner only, the run must be this chat's active run. Forwards to
  the adapter. Responses: 200 `{ decision }`; 409 `APPROVAL_RESOLVED`
  ("This request was already answered."); 404 `APPROVAL_NOT_FOUND` ("This
  request has expired or the reply has finished."); 503 when the adapter is
  unreachable (retryable). Never logs params.

Frontend:
- Agent dialog: each attached connector has an access choice
  ("Read and write" default, "Read only"), shown only when the connector has
  `writeTools`; the create/update body sends `{ slug, access }`.
- Chat: an `approval` event with `status: "pending"` shows an approval card
  inline at the tool row it belongs to (`itemId`): connector + tool in plain
  words (e.g. "GitHub wants to create a branch"), the params as a
  name/value list (plain text, wrapped, never HTML), and three buttons:
  Allow once / Allow for this chat / Deny. Keyboard: the card takes focus
  when it appears (without scrolling the user away if they scrolled up),
  buttons are real `<button>`s, Escape = Deny is NOT bound (too easy to hit).
  While the POST is in flight buttons are disabled; 409/404 replaces the card
  with "Already answered" / "Expired". A resolved event replaces the card
  with a one-line outcome: "Allowed", "Allowed for this chat", "Denied",
  "Expired — not run", "Cancelled". Auto answers show "Allowed for this
  chat" on the tool row, no card. A countdown is not required; show
  "Waiting for your approval" on the composer status.
- Saved transcript: a tool row with `approval` shows the same outcome label;
  `DENIED` shows "Not run".

## Gmail directory connector (built 2026-10-20)

Second directory connector, Google's official remote server
`https://gmailmcp.googleapis.com/mcp/v1` (Developer Preview). v1 tools: the six
read tools plus `create_draft` (write, approval card). Nothing sends, trashes,
spams or relabels mail. Catalog definition: `.runtime/mcp-e2e/gmail.json`
(placeholder client id; secret from env `GMAIL_OAUTH_CLIENT_SECRET`). Not yet
applied to the dev catalog.

Generic code changes (no Gmail-specific code; source still names no provider):

- **Discovery fallback.** Gmail answers `initialize` and `tools/list` with 200
  and no token, so there is no 401 to read. A non-401 probe now falls back to
  the RFC 9728 well-known URL; a 5xx probe is `unavailable`.
- **Issuer kept verbatim.** The PRM lists `https://accounts.google.com/` but
  the AS metadata issuer (and the callback `iss`) has no slash; URL
  normalisation would have refused every Google callback as an iss mismatch.
- **`auth.authorizeParams`.** Allowlist `access_type` (online|offline) and
  `prompt` (none|consent|select_account|login, space-separated set, `none`
  alone). Never replaces a core parameter. Gmail uses offline + consent so a
  refresh token is issued on every connect.
- **`auth.accountUserinfo: { field }`.** Exclusive with `accountTool`. Verify
  GETs the discovered `userinfo_endpoint` with the token; a 401 there is
  `verify_failed`. This is also Gmail's only proof the token works, because
  `tools/list` needs none.
- **Granted scopes.** Google has granular consent. If the token response's
  `scope` lacks a requested scope, nothing is stored and the callback returns
  `permissions_missing` ("Connect again and leave every permission selected").
- **rfc7009 revoke** sends the refresh token when there is one (ends the whole
  grant, works after the 1 h access token expired). Only 200 counts; Google's
  400 `invalid_token` is not treated as revoked.

Access tokens last 1 h, so the run-start refresh happens often and each one
restarts that chat's Codex process (a few seconds, about once an hour of use).

Open: Google Cloud setup (user), real connect test, Model Armor / prompt-injection
screening decision, retention of Gmail content in Codex history on `/mnt/state`,
Google verification + CASA before External production.
