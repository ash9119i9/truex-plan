# Trust Boundaries in the New Stack

For each boundary: the controls that exist today, the tests that already prove them (quoted by name, so search for them before proposing a duplicate), and the attacks still worth trying when a change touches it. Controls drift; confirm each `file` still does what is written here before relying on it.

## Test patterns used by every boundary

**Two principals.** `platform-next/test/integration/chats.test.ts` sets up `alice` and `bob` (same tenant) and `dave` (another tenant) with `member(subject, tenant)`, then calls the API as each one with `call(who, method, path, body)` and checks refusals with `fails(res, status, code)`. `"chats are private to their owner"` is the model abuse test: one resource, every route that reaches it (read, stream, message, patch), each refused with `404 NOT_FOUND`, and the attacker's own listing still empty. Copy that shape.

**Indistinguishable refusals.** Compare the foreign answer to the answer for an ID that never existed (`/chats/not-an-id`), not only to a fixed status. `"unknown, foreign, removed, disabled and pending tenants all get the same 403"` in `test/http/tenant-access.test.ts` does this for tenants.

**No side effect.** After a refused attempt, read the stored documents (the test's Mongo handle), the model calls (`FakeGateway.requests` and `FakeGateway.refused` in `platform-next/test/support/chat-stack.ts`), the files under the real adapter's `AdapterProcess.stateDir`, and the event stream, and assert none changed.

**Marker sweep (no leak).** Plant a unique marker as the secret (`leak-marker-<random>` as a connector token, provider key or header value). After the scenario, search for it in: every response body and header, every SSE event, captured stdout/stderr of each process, every stored document except the one encrypted field, and every file under the adapter's state directory (`find <stateDir> -type f` and read each). Existing examples: `"the real token is in no event, log line or file"` (runtime-adapter `test/codex/network.test.ts`), `"the header marker is in no adapter log nor any file under the state dir"` (`test/codex/mcp.test.ts`), `"the token never appears in any response, the row's plaintext, the audit, or the listing"` (platform-next `test/integration/connectors.test.ts`).

**Forged credentials.** Sign tokens with the test keys (`testKeyEnv()` in `platform-next/test/support/test-auth.ts`; `ADAPTER_TOKEN` and `GATEWAY_SECRET` in `test/support/chat-stack.ts`), then change one thing: a claim, the key, the algorithm, the profile, the tenant. A forged token must be refused for the same reason a garbage one is.

## B1 — Browser → frontend forwarders

**Controls:** `frontend/lib/forward.ts` — `safeSegment`, `safePath` (encoded traversal refused, `/admin` and `/v1/admin` blocked), a header allowlist that drops `Host`, forwarded headers and identity claims, `forwardedFor` (client `X-Forwarded-For` dropped unless a trusted proxy is configured), `limitBody` (2 MB; 20 MB for an attached file), `no-store` and `Vary: Cookie, Authorization`.

**Existing tests** (`frontend/test/forward.test.ts`): `"only safe, non-admin paths are forwarded"`, `"methods, bodies and headers: only what the platform needs is forwarded"`, `"client-supplied X-Forwarded-For is dropped unless a trusted proxy is configured"`, `"oversized requests are refused up front and cut off mid-stream"`, `"an attached file may be up to 20 MB; nothing else is"`.

**Attacks to try when a change adds a route or header:** double-encoded and mixed-case `/admin` paths; `%2e%2e`, `%2f`, backslash and NUL in a segment; a new header the platform trusts (does the allowlist pass it from the browser?); a chunked body that grows past the cap after the first check; a response header from the platform that should not reach the browser.

## B2 — Frontend → platform-next: tokens, sessions, tenant

**Controls:** Ed25519 access tokens with strict header shape and issuer/audience/purpose checks (`platform-next/src/modules/sessions/access-token.ts`); refresh rotation with reuse detection (`sessions.service.ts`); `__Host-` `HttpOnly` `SameSite=Strict` cookies, one value accepted (`src/common/http/cookies.ts`); Google OIDC with PKCE, state and nonce, `email_verified` required (`src/modules/auth/`); tenant from signed claims, never from request data (`src/common/access/tenant.guard.ts`).

**Known, accepted:** F-2 — tenant routes trust a token's `tid`/`role` for up to 5 minutes (`backlog/security/01-access-token-revocation.md` lists what is still checked fresh). A test that finds the 5-minute window is not a new finding; one that finds a path *not* in that list staying open longer is.

**Existing tests:** `test/unit/access-token.test.ts` (`"rejects other algorithms and extra header fields"`, `"rejects a tampered payload"`, `"a tampered tenant claim breaks the signature"`, `"rejects wrong issuer, audience or purpose"`); `test/http/tenant-access.test.ts` (`"role and tenant cannot be forged by headers or extra parameters"`, `"removal and disabling take effect on the next request"`, `"a removal or role change reaches tenant routes at the next refresh"`, `"interleaved requests to different tenants keep separate context"`); `test/integration/sessions.test.ts` (`"an access token naming another user's session is rejected"`, `"cookie endpoints refuse a missing or foreign origin"`, `"logout revokes, is repeatable, and kills the live access token"`); `test/integration/google-auth.test.ts` (`"ID tokens failing any check grant no access"`, `"a removed membership is not restored by signing in"`).

**Attacks to try:** a new route without the tenant guard; a route that reads `tenantId` from body or query and uses it for a database choice; an admin-only action reachable by a `user` role token; a role or membership change during an open SSE stream (`"a revoked session or removed membership closes a live stream; the reply is still saved"` covers chats — does the new stream do the same?); invitation or signup flows used to join a tenant uninvited.

## B3 — Member ↔ member, tenant ↔ tenant

**Controls:** every chat, run, message, upload and file query carries `ownerId` from the caller's context (`src/modules/chats/chats.service.ts`, `chat-store.ts`, `chat-files.ts`, `chat-uploads.ts`); file objects keyed `t/<tenant>/c/<chat>/f/<file>`; connector tokens AES-256-GCM with AAD binding tenant, owner, connector and key (`src/modules/connectors/token-crypto.ts`); one database per tenant chosen server-side.

**Existing tests:** `test/integration/chats.test.ts` (`"chats are private to their owner"`, `"answerApproval refuses bad input, another member's chat and a settled run"`, `"a live reply streams only to its owner, in its chat and tenant"`, `"removed access blocks new replies and reads; the saved chat is kept for its owner"`); `test/integration/chat-uploads.test.ts` (`"another member's staged upload can't be sent or removed"`); `test/integration/coding-chat.test.ts` (`"another member can't list or read a chat's files"`); `test/integration/chat-approvals-store.test.ts` (`"allowToolForChat only matches the owner's own chat"`); `test/integration/connectors.test.ts` (`"another member's connection never reaches the run's network"`, `"a ciphertext copied to another owner makes runSpecs mark token_unreadable"`); `test/unit/connectors-crypto.test.ts` (`"a ciphertext copied to another owner fails to decrypt"`).

**Attacks to try for any new resource:** the full route list from the two-principals pattern, including list endpoints (does the foreign item appear in a listing, a count or a search?), aggregate endpoints and reports, the history/recovery read, and caches (a `ttl-cache.ts` keyed without owner or tenant); a shared (tenant-scoped) agent used to reach its creator's connectors or skills; a resource ID from tenant A sent with tenant B's token (`dave`).

## B4 — platform-next → runtime-adapter

**Controls:** bearer `RUNTIME_ADAPTER_TOKEN` compared with `timingSafeEqual` over digests (`runtime-adapter/src/server.ts`); JSON only, 256 KiB cap; IDs match `ID = /^[A-Za-z0-9_-]{1,64}$/` (`src/contract.ts`); run lookups need both `tenantId` and `chatId` to match; each chat has its own workspace under the state directory (`chatWorkspace` in `src/runtime/files.ts`).

**Known, accepted:** F-5 — one static token for every tenant. F-9 — unauthenticated `/health` reports counts.

**Existing tests:** `test/http/http.test.ts` (`"every operation needs the exact bearer token"`, `"bodies must be JSON and at most 256 KiB"`, `"invalid requests are refused before any Codex process starts"`, `"unknown routes and runs"`, `"steering an unknown or another chat's run is RUN_NOT_FOUND"`); `test/codex/mcp.test.ts` (`"first answer wins; another chat cannot answer; unknown ids are 404"`).

**Attacks to try when the contract grows a field or route:** the new route without the token; another chat's `runId` or `approvalId` with this chat's IDs; IDs at the pattern's edges (64 and 65 chars, `.`, `/`, unicode look-alikes); a field the platform trusts the browser to set flowing through unchecked into Codex config (connector URL, header, skill digest, model name, network host).

## B5 — Codex → model-gateway

**Controls:** HMAC profile token (`signGatewayToken`, `verifyGatewayToken` in `shared/gateway-token.ts`, constant-time compare), bound to one profile and checked per request; profile and key loaded per request, disabled profile refused; provider keys never sent to the runtime; prompt cache key includes tenant, profile, model, tools and system messages (`model-gateway/src/prompt-cache.ts`); no request bodies logged.

**Known, accepted:** F-4 — tokens never expire; `exp` is ignored.

**Existing tests** (`model-gateway/test/server.test.ts`): `"gateway: token must be valid and bound to the requested profile"`, `"gateway: old tokens and tenant tokens both verify; profile still binds"`, `"gateway: upstream errors keep their status; context overflow becomes a failed stream"`. Prompt cache scoping: `model-gateway/test/prompt-cache.test.ts`.

**Attacks to try:** profile A's token on `/p/<B>/v1`; a token after the profile is disabled; a tenant's token reaching another tenant's prompt-cache entry (same prompt, different tenant: different key); a provider error body that carries the key or the upstream URL back to the runtime; a new adapter (provider) that logs request bodies.

## B6 — Codex → MCP connectors and network egress

**Controls:** connector specs validated in the adapter contract (`https` only, no credentials, query or fragment in the URL; header names and values bounded; `ADAPTER_ALLOW_LOOPBACK_MCP=1` test-only); write and unannotated tools raise `approval.requested`; critical tools ask every time; egress through a proxy with a per-run host policy, private and metadata addresses refused even through an allowed name (`runtime-adapter/src/codex/network.ts` lists `169.254.169.254`, `169.254.170.2`, `metadata.google.internal`); connector tokens injected by the proxy only to the connector's prefixes; platform-side policy and grants recomputed, never taken from the runtime (`platform-next/src/modules/network/`).

**Known, accepted:** F-3 — a tool the server annotates as read-only runs without a card, so a hostile connector can label a write as a read.

**Existing tests:** runtime-adapter `test/codex/network.test.ts` (`"private and metadata addresses are refused, even through an allowed name, and offer no allow"`, `"a command cannot skip the proxy"`, `"a command that prints a fake violation line raises no card"`, `"a read-only connection refuses every write and offers no allow"`, `"the real token is in no event, log line or file"`); `test/codex/mcp.test.ts` (`"deny: the server is never called and the call fails DENIED"`, `"a critical tool asks every time: no Allow for this chat, approvedTools ignored"`, `"stop while a card is open cancels it; a late answer is refused"`); platform-next `test/unit/network-policy.test.ts` (`"refuses addresses, wildcards, ports and private zones"`, `"a token may only go to prefixes on the connector's own hosts"`), `test/unit/network-grants.test.ts` (`"the widest answer is recomputed, whatever the runtime claims"`, `"a site grant adds a public host; a private or connection host is never added"`, `"critical comes from the catalog rules, not the runtime"`).

**How to drive it:** `McpFixture` (`test/support/mcp-fixture.ts`) is the hostile connector — give it tools with misleading annotations, oversized results, results containing instructions; `NetworkFixture` (`test/support/network-fixture.ts`, CA in `network-ca/`) plays both allowed and refused hosts; `startConnectorFixture()` (platform-next `test/support/connector-fixtures.ts`) plays the OAuth provider.

**Attacks to try:** DNS names that resolve to private addresses, IPv6 and IPv4-mapped forms, decimal and octal IP spellings, redirects from an allowed host to a private one; a connector token sent to a host or path outside its prefixes; a tool result that asks the model to call a write tool (must raise a card); an approval answered by another chat, twice, after stop or after the run ends.

## B7 — Coding sandbox, workspace files, uploads, skills

**Controls:** the `truex` permissions profile in `runtime-adapter/src/codex/coding.ts` (state directory and `/tmp` denied, workspace and per-chat scratch writable, no network, `inherit: "none"` environment, prompt rules for `git push`/`reset --hard`/`clean`); workspace reads refuse dot segments, absolute paths, backslashes, NUL and symlinks, with a size cap (`readWorkspaceFile` in `src/runtime/files.ts`); uploads one visible path segment, never through a symlinked folder (`src/runtime/uploads.ts`); skill archives checked by digest, size and decompression ratio, no links, modes stripped (`src/runtime/skills.ts`, `tar.ts`; packing in platform-next `src/modules/skills/skill-bundle.ts`); upload names and contents checked in platform-next `src/modules/chats/chat-uploads.ts`.

**Existing tests:** runtime-adapter `test/unit/files.test.ts` (the `refuses the path …` loop), `test/unit/uploads.test.ts` (`"names must be one visible path segment"`, `"an uploads folder replaced by a symlink is never followed"`), `test/unit/skills.test.ts` (`"archived setuid, setgid, sticky and world bits never reach disk"`, `"refuses a decompression bomb"`, `"refuses a digest mismatch and a malformed digest"`), `test/codex/coding.test.ts` (`"reads outside the workspace are refused by the sandbox, even for allowed commands"`); platform-next `test/unit/chat-uploads.test.ts` (`"refuses paths, hidden files, controls and unknown types"`, `"documents and images must start with their signature"`), `test/unit/skill-bundle.test.ts` (`"refuses links, so a bundle never reads outside its folder"`, `"refuses oversize bundles"`).

**Attacks to try:** a command (scripted from the model fixture) that reads another chat's workspace by relative path, the adapter's state directory, or environment variables; a symlink or hard link created by a command and then read through the files API; an archive entry named `../x`, an absolute path, a device file or a duplicate entry; a file name with bidi or control characters reaching a download header (`chat-files.ts` quotes it — `"a download name is quoted safely and kept exactly in filename*"`); a polyglot upload that passes the signature check.

## B8 — Model and tool output → model and UI

See [prompt-injection.md](prompt-injection.md).
