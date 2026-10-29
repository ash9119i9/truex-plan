# MCP gateway: tasks

Plan: [mcp-gateway-plan.md](mcp-gateway-plan.md). One release; build in this order. Each task is tested first and stops for approval (`truex-build`). `mcp-gateway/` is a new package laid out like `model-gateway/`, with its own `node_modules`, scripts and tests. Never use root `npm test`.

## Phase 0: Baseline (AWS, needs an explicit go)

## Task 1: AgentCore token scan and error-text check

**Description:** Do slice 6 of `tasks/mcp-plan.md` before the gateway exists, so we know how the current path behaves. Scan AgentCore `/mnt/state` and CloudWatch for a marker provider token. Then force a failing tool call (a 401 and a 500 from the provider) and record exactly what text reaches the model.

**Acceptance criteria:**
- [ ] The scan result is recorded in `tasks/mcp-plan.md`: the marker was found or not found in `/mnt/state` and in CloudWatch.
- [ ] The tool error text for a 401 and a 500 is recorded, including whether any request header appears in it.

**Verification:**
- [ ] Manual check: `node scripts/agentcore-smoke.mjs` run with the marker token, and the scan output attached.

**Dependencies:** None

**Files likely touched:**
- `scripts/agentcore-smoke.mjs`
- `tasks/mcp-plan.md`

**Estimated scope:** Small

## Task 2: Runtime outbound traffic inventory on AgentCore

**Description:** List every host the runtime reaches on AgentCore (model gateway, web search, git, package registries, AWS endpoints), so the egress rule in Task 32 allows exactly those plus the MCP gateway.

**Acceptance criteria:**
- [ ] A table of host, port, purpose and the feature that needs it, taken from VPC flow logs or the network proxy log over one chat run, one coding run and one web-search run.
- [ ] Each entry is marked keep or drop after the cutover.

**Verification:**
- [ ] Manual check: the inventory is reviewed with a human and saved to `tasks/mcp-gateway-plan.md`.

**Dependencies:** None

**Files likely touched:**
- `tasks/mcp-gateway-plan.md`

**Estimated scope:** Small

## Phase 1: Gateway core

## Task 3: Caller token in `shared/`

**Description:** Add `shared/mcp-caller-token.ts`: an HMAC-signed token carrying tenant, user, chat, connector slug and catalog revision, with its own secret. It follows `shared/gateway-token.ts` but stays separate from it. The token has no expiry, because revocation is checked on every call (Task 4). The probe showed that a per-run token would restart Codex on every run.

**Acceptance criteria:**
- [x] Sign then verify returns the same claims. A token with a bad signature, wrong segment count, missing claim or wrong secret returns null.
- [x] A model-gateway token never verifies as a caller token, and a caller token never verifies as a model-gateway token.
- [x] The comparison is constant-time and the token is limited to 2 KB.

**Verification:**
- [x] Tests pass: `npm --prefix mcp-gateway test` (unit tests for the shared module live there)
- [x] Typecheck: `npm --prefix mcp-gateway run build`

**Dependencies:** None

**Files likely touched:**
- `shared/mcp-caller-token.ts` (new)
- `mcp-gateway/package.json`, `mcp-gateway/tsconfig.json` (new)
- `mcp-gateway/test/caller-token.test.ts` (new)

**Estimated scope:** Small

## Task 4: Gateway skeleton: verify, revocation check, transparent forwarding

**Description:** Create the `mcp-gateway` HTTP server at `POST|GET|DELETE /mcp/:connector`. For each request it verifies the caller token, checks that the path connector matches the token's connector, and checks revocation in one Mongo query: the chat exists and isn't deleted, the member is still in the tenant, the connection is active, and the connector is enabled. It then forwards JSON-RPC to the catalog URL with no other changes: streaming SSE without buffering, passing `mcp-session-id` both ways, and never following redirects. Unknown JSON-RPC methods are refused.

**Acceptance criteria:**
- [x] A missing, bad or revoked token returns 401 with `WWW-Authenticate`. A connector mismatch returns 403. Neither request reaches the upstream.
- [x] `initialize`, `tools/list` and `tools/call` reach the fixture, with SSE responses streamed and the session ID kept.
- [x] An upstream redirect is returned as an error, not followed. An upstream timeout returns a JSON-RPC error the model can read.

**Verification:**
- [x] Tests pass: `npm --prefix mcp-gateway test` (a smaller gateway-specific fixture with JSON, held-SSE, redirect and hang modes, plus an in-memory Mongo)
- [x] Build succeeds: `npm --prefix mcp-gateway run build`

**Dependencies:** Task 3

**Files likely touched:**
- `mcp-gateway/src/server.ts`, `mcp-gateway/src/index.ts` (new)
- `mcp-gateway/src/revocation.ts` (new)
- `mcp-gateway/test/forward.test.ts`, `mcp-gateway/test/support/mcp-fixture.ts` (new)

**Estimated scope:** Medium

## Task 5: Gateway token crypto and leased refresh, compatible with platform-next

**Description:** The gateway gets its own implementation of platform-next's sealed token format and of the leased, single-flight refresh. platform-next can't import `shared/`, and the gateway is meant to end up the only key holder (plan, Architecture Decisions). The format is AES-256-GCM, with the AAD binding tenant, owner, connector and key, and key rotation supported. The lease protocol is the `refreshLease` field and its claim conditions. Calling the provider's token endpoint is injected here, and Task 6 wires the real one. platform-next's code isn't changed.

**Acceptance criteria:**
- [x] The gateway opens a token sealed by platform-next's `sealTokens` (a fixed vector, including an old rotated key), and platform-next's `openTokens` opens one the gateway sealed. A wrong owner, connector, tenant, key or tag can't be opened.
- [x] A token near expiry is refreshed once, both for concurrent calls in one process and across two gateway instances. A live lease held in platform-next's shape is waited for, never overridden.
- [x] A refused refresh marks the connection `needs_reconnect`. When the provider is unreachable, a still-valid token is used, and an expired one is reported as unavailable. A holder that lost its lease doesn't overwrite the newer tokens.

**Verification:**
- [x] Tests pass: `npm --prefix mcp-gateway test`, `npm --prefix platform-next test`
  - mcp-gateway 33/33. platform-next 615 pass, 0 fail of 637. The 6 earlier `coding-chat` failures came from the worktree's `vendor/codex` being a symlink, not from this task (fixed 2026-10-29, see the plan's local setup note).
- [x] Typecheck: `npm --prefix mcp-gateway run typecheck`, `npm --prefix platform-next run typecheck`

**Dependencies:** None

**Files likely touched:**
- `mcp-gateway/src/token-crypto.ts`, `mcp-gateway/src/credentials.ts` (new)
- `mcp-gateway/test/token-crypto.test.ts`, `mcp-gateway/test/credentials.test.ts` (new)
- `platform-next/test/unit/connectors-crypto.test.ts` (one vector test added)

**Estimated scope:** Medium

## Task 6: Token injection and refresh at call time

**Description:** The gateway decrypts the connection's token, refreshes it through its leased refresh (Task 5) when it is near expiry, building the refresh call to the connector's token endpoint (discovery, client secret), and sends `Authorization: Bearer <provider token>` upstream. The caller's `Authorization` header is never forwarded. When the provider answers 401, the gateway refreshes once and retries once, but only when the method is safe to repeat: `initialize` or `tools/list`, never `tools/call`.

**Acceptance criteria:**
- [x] The upstream sees only the provider token, and the Truex token never leaves the gateway.
- [x] A token past its refresh margin is refreshed before the call, which fixes the mid-reply expiry. Two calls at once trigger one refresh.
- [x] A 401 on `tools/call` is not retried; it returns a "reconnect" error and marks the connection as needing a new sign-in, the same way the platform does today.
  - As built, following platform-next's `tokenRejected`: with no refresh token, the connection becomes `needs_reconnect` and the model is told to reconnect. With a refresh token, the token is marked expired, the model is told to try the call again, and the next call renews it. A second 401 right after a renewal always means `needs_reconnect`.

**Verification:**
- [x] Tests pass: `npm --prefix mcp-gateway test`

**Dependencies:** Tasks 4, 5

**Files likely touched:**
- `mcp-gateway/src/credentials.ts`, `src/server.ts`, `src/revocation.ts`, `src/index.ts`
- `mcp-gateway/src/refresh-grant.ts`, `src/config.ts` (new)
- `mcp-gateway/test/inject.test.ts`, `test/refresh-grant.test.ts`, `test/support/auth-fixture.ts` (new); `test/forward.test.ts`, `test/support/mcp-fixture.ts`

**Estimated scope:** Medium

## Task 7: RFC 8707 `resource` on authorize, token and refresh

**Description:** Send the connector's resource (the MCP URL, from protected-resource metadata) as `resource` on the authorize, token exchange and refresh requests.

**Acceptance criteria:**
- [x] Authorize URL, code exchange and refresh each carry `resource`, checked by tests against a fake authorization server.
- [x] A provider that rejects an unknown `resource` is handled per connector by a `sendResource: false` catalog field, defaulting to true.
  - Built 2026-10-29: `auth.sendResource` (only `false` is stored), honoured by platform-next and the gateway refresh. Not yet checked against live GitHub or Google; the first real connect in Task 17 (or the probe in Task 9) tells us whether either needs `false`.
  - The discovered `resource` must now be a safe absolute URL with no fragment; a server that names a malformed one fails discovery.

**Verification:**
- [x] Tests pass: `npm --prefix platform-next test`
- [x] Typecheck: `npm --prefix platform-next run typecheck`

**Dependencies:** Task 5

**Files likely touched:**
- `platform-next/src/modules/connectors/connector-oauth-flow.ts`
- `platform-next/src/modules/connectors/oauth-exchange.ts`
- `mcp-gateway/src/refresh-grant.ts`
- `platform-next/src/modules/connectors/connector.ts`

**Estimated scope:** Small

## Task 8: Tool allowlist and definition hashes

**Description:** Add `toolHashes: { [tool]: sha256 }` to the catalog record: the hash of each reviewed tool's canonical definition (name, description, input schema, annotations). The gateway filters `tools/list` to tools that are in the chat's allowed set (read-only access removes write tools) and whose live hash matches. `tools/call` for anything else is refused with a readable error.

**Acceptance criteria:**
- [x] A tool outside the allowlist is neither listed nor callable. The probe showed Codex refuses it as `unsupported call`; the gateway refuses it too.
- [x] A tool whose live description or schema changed is hidden and logged as `tool_definition_changed`.
- [x] A catalog record without `toolHashes` exposes no tools (strict default).

**Verification:**
- [x] Tests pass: `npm --prefix mcp-gateway test`, `npm --prefix platform-next test`

**Dependencies:** Task 4

**Files touched:**
- `platform-next/src/modules/connectors/connector.ts`, `connectors-catalog.service.ts` (parse and store `toolHashes`; a put that drops them unsets them)
- `mcp-gateway/src/tool-hash.ts` (new; in the gateway, not `shared/`, because platform-next can't import `shared/`. Task 9's probe needs a platform-next copy pinned by the same vector)
- `mcp-gateway/src/policy.ts` (new), `src/revocation.ts`, `src/server.ts`
- `mcp-gateway/test/policy.test.ts` (new), `test/support/mcp-fixture.ts`

**Estimated scope:** Medium

## Task 9: Probe CLI: discovery report, tool draft, tool hashes

**Description:** Add `operator connector-probe <url> [--token <file>]`. It reports protected-resource and authorization-server metadata: the registration modes supported (CIMD, DCR or pre-registered) and whether `resource` is accepted. With a test token, it runs `verifyConnection`, lists the tools and writes a draft catalog JSON: `allowedTools`, suggested `writeTools`, and `toolHashes`. A tool is suggested as a write unless it is marked read-only, and `readOnlyHint` is never trusted on its own. Re-run it on GitHub to add hashes to `catalog/connectors/github.json`.

**Acceptance criteria:**
- [x] The report against a fixture server lists each discovery fact and each registration mode it detected.
- [x] The draft marks every tool without `readOnlyHint: true` as a write candidate, and prints a reminder that a human must classify the tools.
- [ ] `github.json` has `toolHashes` that match the live server.
  Not done: listing GitHub's tools needs a test account's access token, which this session doesn't have. Run `connector-probe --url https://api.githubcopilot.com/mcp/ --token <file> --file catalog/connectors/github.json` and copy the drafted `toolHashes` in after review. Needed before Task 16.

**Verification:**
- [x] Tests pass: `npm --prefix platform-next test`
- [x] Manual check: `npm --prefix platform-next run operator:dev -- connector-probe --operator <name> --url https://api.githubcopilot.com/mcp/` (discovery only, no token). GitHub reports issuer `https://github.com/login/oauth`, PKCE S256, `iss` supported, no CIMD and no DCR, so it stays pre-registered. Its `resource` matches the catalog URL, trailing slash included.

**Dependencies:** Task 8

**Files likely touched:**
- `platform-next/src/cli/operator.ts`
- `platform-next/src/modules/connectors/connector-probe.ts` (new)
- `platform-next/catalog/connectors/github.json`
- `platform-next/test/unit/connector-probe.test.ts` (new)

**Estimated scope:** Medium

## Task 10: Egress allowlist and SSRF guard

**Description:** The gateway connects only to the catalog record's MCP URL (https, exact host). It resolves DNS itself, refuses private, loopback, link-local, CGNAT and metadata addresses (IPv4 and IPv6, mapped forms included), and connects to the address it checked while keeping the original host for TLS and SNI. This blocks DNS rebinding. Response size and time are capped.

**Acceptance criteria:**
- [x] A catalog URL that resolves to 127.0.0.1, 10/8, 169.254.169.254, ::1, fc00::/7 or ::ffff:10.0.0.1 is refused before connecting.
- [x] A host that resolves to a public address on the check but a private one on a second lookup still reaches only the checked address.
- [x] A test-only flag allows loopback for the fixture, and it can't be set in production config.

**Verification:**
- [x] Tests pass: `npm --prefix mcp-gateway test`

**Follow-ups moved to backlog:** `backlog/security/06-mcp-gateway-egress-hardening.md` (range review, multiple addresses, proxy settings, independent review).

**Dependencies:** Task 4

**Files likely touched:**
- `mcp-gateway/src/egress.ts` (new)
- `mcp-gateway/test/egress.test.ts` (new)

**Estimated scope:** Medium

## Task 11: Argument validation, result caps, redaction, untrusted marking

**Description:** Validate `tools/call` arguments against the reviewed input schema (the one whose hash matched) with a 64 KB size cap. Cap result size. Redact any known token value (the current and previous access token and the refresh token) from results and error text. Add a `_meta` untrusted marker, plus a prompt-injection flag that is logged and doesn't block.

**Acceptance criteria:**
- [x] Invalid or oversized arguments are refused with a readable JSON-RPC error, and the provider is never called.
- [x] A result or error that contains the provider token reaches Codex with the token replaced by `[redacted]`.
- [x] An oversized result is cut to the cap with a visible truncation note.

**Verification:**
- [x] Tests pass: `npm --prefix mcp-gateway test`

**Not done here:** the prompt-injection flag in the description. Which screening to run, and whether it blocks or only flags, is still open (`docs/ideas/mcp-gateway.md`, open questions). Results are already marked untrusted (`_meta["ai.truex/untrusted"]`), which is where a screen would hook in.

**Dependencies:** Tasks 6, 8. Open question 1 settled 2026-10-29: `ajv` 8.20.0, pinned exactly.

**Files likely touched:**
- `mcp-gateway/src/arguments.ts`, `mcp-gateway/src/results.ts` (new)
- `mcp-gateway/test/arguments.test.ts`, `mcp-gateway/test/results.test.ts` (new)

**Estimated scope:** Medium

## Checkpoint A: after Tasks 3–11
- [ ] `npm --prefix mcp-gateway test` and build pass; `npm --prefix platform-next test` and typecheck pass
- [ ] Gateway forwards to the fixture with token swap, refresh, allowlist, hashes, SSRF, argument checks and result handling
- [ ] Review with human before proceeding

## Task 12: Contract: `argsHash` on `approval.requested`

**Description:** The adapter adds `argsHash` to `approval.requested` and `approval.resolved`: the sha256 of the canonical tool arguments Codex will send. On the pin, this checks that the elicitation's `tool_params` equal the `tools/call` arguments. If they don't, stop and use the fallback in the plan's risks table. This is the only contract change, and it is additive.

**Acceptance criteria:**
- [x] On the real pin, `argsHash` equals the hash of the arguments the fixture receives, for at least three argument shapes (nested, unicode, empty).
- [x] `runtime-adapter/README.md` documents the field. platform-next accepts it on the live event.

**Verification:**
- [x] Tests pass: `npm --prefix runtime-adapter test`, `npm --prefix platform-next test` (4 toolchain tests cancelled: they need `.runtime` toolchain dirs this worktree lacks)
- [x] Typecheck: both packages

**Found while testing, fixed 2026-10-29:** a tool argument or reply containing U+2028 or U+2029 crashed the run. The adapter read Codex's stdout with `readline`, which treats those characters as line breaks and cut the JSON-RPC message in two; `handleLine` couldn't parse the halves and killed Codex (`codex_exit_mid_run`). `src/codex/rpc.ts` now splits stdout on `\n` only. Regression test: "a tool argument and a reply with U+2028 and U+2029 complete intact" (`test/codex/mcp.test.ts`), and the argsHash test includes both characters again.

**Dependencies:** None (can start any time)

**Files likely touched:**
- `runtime-adapter/src/runtime/chat.ts`
- `runtime-adapter/README.md`
- `runtime-adapter/test/codex/mcp.test.ts`
- `platform-next/src/modules/chats/runtime-client.ts`

**Estimated scope:** Medium

## Task 13: Server-side approval grants

**Description:** When the member answers a card, the platform writes a grant before it forwards Allow to the adapter. An Allow once grant is `{chat, connector, tool, argsHash, used: false, expiresAt}`; Allow for this chat stays as `chat.toolApprovals`. The gateway refuses any write tool call unless it consumes a matching unused grant in one atomic `findOneAndUpdate`, or the chat allows that tool. Critical tools always need an Allow once grant.

**Acceptance criteria:**
- [ ] A write with a matching grant runs once, and a second identical call is refused. The probe showed a refusal fails cleanly as `TOOL_ERROR`, with the reason shown to the model.
- [ ] A write that Codex approved but the platform has no grant for is refused, and the provider is never called.
- [ ] Two simultaneous calls on one grant: exactly one runs.

**Verification:**
- [ ] Tests pass: `npm --prefix platform-next test`, `npm --prefix mcp-gateway test`
- [ ] Index: `npm --prefix platform-next run operator -- ensure-tenant-indexes` creates the grant TTL index

**Dependencies:** Tasks 8, 12

**Files likely touched:**
- `platform-next/src/modules/chats/chats.service.ts` (approval endpoint)
- `platform-next/src/modules/connectors/approval-grants.ts` (new)
- `mcp-gateway/src/approvals.ts` (new)
- `mcp-gateway/test/approvals.test.ts` (new)

**Estimated scope:** Medium

## Task 14: Rate limits

**Description:** Fixed-window limits per user and per connector (calls per minute), set in the catalog with defaults, stored as atomic Mongo counters so every gateway instance shares them. When a limit is hit, the model gets an error saying when to retry.

**Acceptance criteria:**
- [ ] Call number N+1 in the window is refused, and the provider isn't called.
- [ ] Two gateway instances share the count.
- [ ] The error text includes the retry time and the connector name.

**Verification:**
- [ ] Tests pass: `npm --prefix mcp-gateway test`

**Dependencies:** Task 4

**Files likely touched:**
- `mcp-gateway/src/rate-limit.ts` (new)
- `mcp-gateway/test/rate-limit.test.ts` (new)

**Estimated scope:** Small

## Task 15: Audit records

**Description:** Write one tenant-scoped record per `tools/call`: tenant, user, chat, connector, tool, outcome (ok, refused and why, error, timeout), duration, approval grant ID, and hashes of the arguments and result. Never store argument or result content. The write never blocks the response; if it fails, the gateway logs it and increments a metric.

**Acceptance criteria:**
- [ ] Every call outcome writes exactly one record with the fields above.
- [ ] A test asserts that no argument or result text appears in the record.
- [ ] An audit write failure doesn't fail the call and raises `audit_write_failed`.

**Verification:**
- [ ] Tests pass: `npm --prefix mcp-gateway test`
- [ ] Index: `ensure-tenant-indexes` creates the audit indexes

**Dependencies:** Tasks 4, 13

**Files likely touched:**
- `mcp-gateway/src/audit.ts` (new)
- `platform-next/src/modules/audit/` (collection and indexes)
- `mcp-gateway/test/audit.test.ts` (new)

**Estimated scope:** Small

## Phase 2: Cutover

## Task 16: Platform emits gateway specs; delete the direct path

**Description:** `runSpecs` now emits `url = <gateway>/mcp/<slug>` and `Authorization: Bearer <caller token>`, and no longer decrypts or refreshes provider tokens for runs. Delete the old provider-token header path, with no flag. Add the gateway URL and caller-token secret to the platform config, failing closed if either is missing.

**Acceptance criteria:**
- [ ] No `McpServerSpec` contains a provider token. A test searches every emitted spec for the connection's token.
- [ ] The same chat gets the same caller token on every run, so the fingerprint is stable and nothing reloads.
- [ ] The platform refuses to start without `MCP_GATEWAY_URL` and the caller-token secret.

**Verification:**
- [ ] Tests pass: `npm --prefix platform-next test`
- [ ] Typecheck: `npm --prefix platform-next run typecheck`

**Dependencies:** Tasks 6, 8, 9, 13

**Files likely touched:**
- `platform-next/src/modules/connectors/connectors.service.ts`
- `platform-next/src/config/app-config.ts`
- `platform-next/test/integration/connectors.test.ts`

**Estimated scope:** Medium

## Task 17: Local end-to-end through the real gateway; latency measured

**Description:** Run the dev stack with the gateway: frontend, platform-next, runtime-adapter, the pinned Codex, mcp-gateway and GitHub. Ask a read question, approve a write and refuse a write. Continue a chat that started before the switch. Measure `tools/call` p50/p95 direct versus through the gateway. Add the gateway to `scripts/dev-next.mjs`.

**Acceptance criteria:**
- [ ] Read, approved write and refused write all behave as in Task 13, against GitHub's SSE responses.
- [ ] A chat started before the cutover continues after one reload.
- [ ] Latency numbers recorded in the plan, with any cache added only if they call for it.

**Verification:**
- [ ] Manual check: dev stack run through the browser, with screenshots
- [ ] Tests pass: all four packages' `test` commands

**Dependencies:** Tasks 14, 15, 16

**Files likely touched:**
- `scripts/dev-next.mjs`
- `tasks/mcp-gateway-plan.md`

**Estimated scope:** Small

## Task 35: Coding sandbox credentials no longer reach Codex (design decision first)

**Description:** Coding runs hand Codex the member's real token. `runSpecs` builds the run's network policy with it (`networkConnectorOf` in `connectors.service.ts`), and the adapter passes it to Codex's network proxy credential broker as `TRUEX_TOKEN_<NAME>` (`runtime-adapter/src/codex/network.ts`: "Holds real tokens; only ever passed to Codex in thread params"). Commands see a stand-in, but Codex holds the real token. That's the exposure the gateway removes for MCP. A human picks one of three options (plan, open question 6): (a) a Truex egress proxy injects the token, if the pinned proxy can forward credentialed hosts upstream (unverified); (b) the sandbox gets only short-lived, narrowly scoped tokens, such as GitHub App installation tokens for one repository; (c) the remaining exposure is accepted and documented.

**Acceptance criteria:**
- [ ] The decision is recorded in the plan, with what was verified on the pin.
- [ ] For (a) or (b): no thread params and no network policy sent to the adapter contain a long-lived provider token, tested by searching every emitted request for the stored token.
- [ ] Git clone and push and the GitHub API still work from the sandbox (existing coding tests).

**Verification:**
- [ ] Tests pass: `npm --prefix runtime-adapter test`, `npm --prefix platform-next test`

**Dependencies:** Task 16

**Files likely touched:**
- `platform-next/src/modules/connectors/connectors.service.ts`
- `runtime-adapter/src/codex/network.ts`
- `tasks/mcp-gateway-plan.md`

**Estimated scope:** Medium (after the decision)

## Task 34: Gateway seals tokens at connect; platform-next drops the token key

**Description:** At connect and reconnect, platform-next sends the new grant to an internal gateway endpoint, authenticated with a service credential separate from caller tokens. The gateway seals and stores the grant and runs the `initialize → tools/list` check that `verifyConnection` does today. platform-next then deletes `token-crypto.ts` and its refresh code, and `MCP_TOKEN_KEYS` leaves its configuration. The OAuth flow cookie gets a key of its own. After this, only the gateway can decrypt provider tokens.

**Acceptance criteria:**
- [ ] Connect, reconnect and verify work end to end with platform-next holding no token key. Its config no longer reads `MCP_TOKEN_KEYS`, and no source file imports `token-crypto`.
- [ ] The internal endpoint refuses a missing or wrong service credential and a caller token. A grant is bound to the tenant, owner and connector named by the platform.
- [ ] Connections sealed before the change still open in the gateway.

**Verification:**
- [ ] Tests pass: `npm --prefix mcp-gateway test`, `npm --prefix platform-next test`
- [ ] Typecheck: both packages

**Dependencies:** Tasks 16, 35

**Files likely touched:**
- `mcp-gateway/src/connections.ts` (new), `mcp-gateway/src/server.ts`
- `platform-next/src/modules/connectors/connectors.service.ts`, `token-crypto.ts` (deleted)
- `platform-next/src/config/connectors-config.ts`

**Estimated scope:** Large: split into "gateway endpoint" and "platform switch" when it's built

## Checkpoint B: after Task 17
- [ ] GitHub works only through the gateway, locally
- [ ] Review with human before proceeding

## Phase 3: Connector onboarding

## Task 18: `registration: "cimd"`

**Description:** Publish a Client ID Metadata Document at a stable platform URL, and add `registration: "cimd"` to the catalog. Authorize uses that URL as `client_id`, with no client secret. Every metadata URL we fetch goes through the SSRF guard (shared with Task 10).

**Acceptance criteria:**
- [ ] The metadata document is served with the redirect URIs and the client name, and matches the spec's required fields.
- [ ] Connect against a fake CIMD authorization server succeeds with no stored client secret.
- [ ] A metadata fetch to a private address is refused.

**Verification:**
- [ ] Tests pass: `npm --prefix platform-next test`

**Dependencies:** Tasks 7, 10

**Files likely touched:**
- `platform-next/src/modules/connectors/connector.ts`
- `platform-next/src/modules/connectors/connector-oauth-flow.ts`
- `platform-next/src/modules/connectors/connectors.controller.ts`

**Estimated scope:** Medium

## Task 19: `registration: "dcr"`

**Description:** Add `registration: "dcr"`. On the first connect, register at the server's `registration_endpoint` and store the issued client per connector, encrypted like tokens. Re-register when the server rejects the stored client.

**Acceptance criteria:**
- [ ] The first connect registers once. Ten users connecting at the same time still cause one registration (lease).
- [ ] A refused registration shows the member a readable error, and an operator alert is logged.
- [ ] A server whose metadata changed (a new registration endpoint) is re-probed, not trusted automatically.

**Verification:**
- [ ] Tests pass: `npm --prefix platform-next test`

**Dependencies:** Task 18

**Files likely touched:**
- `platform-next/src/modules/connectors/dcr.ts` (new)
- `platform-next/src/modules/connectors/connector-oauth-flow.ts`
- `platform-next/src/modules/connectors/client-secret.resolver.ts`

**Estimated scope:** Medium

## Tasks 20–23: Onboard Notion, Jira / Confluence, Gmail, Slack

One task per connector, same shape:

**Description:** Run `connector-probe` on the vendor's hosted MCP URL. Pick the registration mode it reports (CIMD, then DCR, then a pre-registered app). A human classifies the write and critical tools in the PR. Commit `catalog/connectors/<vendor>.json` with `toolHashes`, then `connector-put` and `connector-enable` in dev.

**Acceptance criteria (each):**
- [ ] A test account connects, runs one read and one approved write through the gateway, and has a refused write audited.
- [ ] The PR lists every tool with its classification and the reason for it.
- [ ] Gmail: the placeholder `clientId` is replaced. If Google has no hosted Gmail MCP server, stop and raise it, rather than writing our own server.

**Verification:**
- [ ] Manual check: dev stack in the browser, per connector
- [ ] Tests pass: `npm --prefix platform-next test` (catalog validation)

**Dependencies:** Tasks 17, 19 (and Task 18 for CIMD vendors)

**Files likely touched:** `platform-next/catalog/connectors/{notion,atlassian,gmail,slack}.json`

**Estimated scope:** Small each

## Checkpoint C: after Tasks 18–23
- [ ] Five connectors connect, read and write through the gateway
- [ ] Review with human before proceeding

## Phase 4: Enterprise SSO

## Task 24: Tenant identity provider settings

**Description:** Store a per-tenant IdP record: provider (`okta` or `entra`), issuer, client ID, the client secret encrypted, allowed email domains and `enforced`. Add operator commands to set and show it. Admin UI is out of scope unless open question 5 says otherwise.

**Acceptance criteria:**
- [ ] One record per tenant. The issuer must be https and pass discovery.
- [ ] The secret is never returned by any read path.

**Verification:**
- [ ] Tests pass: `npm --prefix platform-next test`

**Dependencies:** None

**Files likely touched:**
- `platform-next/src/modules/tenants/tenant-idp.ts` (new)
- `platform-next/src/cli/operator.ts`

**Estimated scope:** Small

## Task 25: OIDC sign-in for Okta and Entra (backend)

**Description:** Generalize `google-oidc.ts` into an issuer-driven OIDC verifier, keeping key caching, refetch on an unknown `kid`, the clock skew allowance and size caps. Add `/auth/sso/start?tenant=` and the callback. The user is matched to the tenant by issuer and subject, with the email domain checked. When the tenant enforces SSO, Google sign-in is refused for its members.

**Acceptance criteria:**
- [ ] Sign-in works against an Okta developer org and a fake issuer in tests.
- [ ] A token from another tenant's issuer, a wrong audience, an expired token or a reused nonce is refused.
- [ ] Google sign-in still works unchanged for tenants without an IdP.

**Verification:**
- [ ] Tests pass: `npm --prefix platform-next test`

**Dependencies:** Task 24. Open question 4 (test org) must be settled first.

**Files likely touched:**
- `platform-next/src/modules/auth/oidc-verifier.ts` (new, from `google-oidc.ts`)
- `platform-next/src/modules/auth/sso.controller.ts` (new)
- `platform-next/src/modules/auth/auth.service.ts`

**Estimated scope:** Medium

## Task 26: Company sign-in screen (frontend)

**Description:** Add a "Sign in with your company" option. The user enters a work email, the frontend looks up the tenant's IdP by email domain, and redirects to it. Errors (no IdP for the domain, refused) are shown in plain language.

**Acceptance criteria:**
- [ ] A known domain redirects to the right IdP, and an unknown domain gets a clear message.
- [ ] The screen works by keyboard and labels its fields properly.

**Verification:**
- [ ] Tests pass: `npm --prefix frontend test`
- [ ] Build succeeds: `npm --prefix frontend run build`

**Dependencies:** Task 25

**Files likely touched:**
- `frontend/app/login/`
- `frontend/lib/auth.ts`
- `frontend/test/auth.test.ts`

**Estimated scope:** Small

## Task 27: Offboarding ends the Truex session

**Description:** For SSO tenants, Truex sessions are short and renewed against the IdP. If the user is disabled at renewal, the session ends and the user's caller tokens fail the revocation check. If open question 3 requires SCIM, add a deprovision endpoint as a follow-up task.

**Acceptance criteria:**
- [ ] After the IdP disables the user, the next session renewal signs them out.
- [ ] Their next gateway call is refused, even inside a running chat.

**Verification:**
- [ ] Tests pass: `npm --prefix platform-next test`, `npm --prefix mcp-gateway test`

**Dependencies:** Tasks 4, 25

**Files likely touched:**
- `platform-next/src/modules/sessions/`
- `mcp-gateway/src/revocation.ts`

**Estimated scope:** Small

## Task 28: ID-JAG exchange library

**Description:** Implement Enterprise-Managed Authorization in `shared/`. Exchange the user's IdP ID token at the IdP for an ID-JAG (RFC 8693 token exchange), then trade the ID-JAG at the resource's authorization server for an access token (JWT bearer grant).

**Acceptance criteria:**
- [ ] Both exchanges work against fakes, with the audience, resource and expiry checked.
- [ ] An IdP refusal (app not approved by IT) gives a readable "ask your IT admin" error.

**Verification:**
- [ ] Tests pass: `npm --prefix mcp-gateway test`

**Dependencies:** Task 25

**Files likely touched:**
- `mcp-gateway/src/id-jag.ts` (new)
- `mcp-gateway/test/id-jag.test.ts` (new)

**Estimated scope:** Medium

## Task 29: Enterprise-managed connectors (Atlassian)

**Description:** Add `auth.enterpriseManaged: true` to the catalog. For SSO tenants, the gateway gets the token with ID-JAG at call time instead of the member's stored connection, so there's no connect screen. The UI shows the connector as "managed by your company".

**Acceptance criteria:**
- [ ] An Okta test user uses Jira with no consent screen.
- [ ] When the IdP stops issuing the pass, the next call is refused after the current short-lived token expires.
- [ ] Non-SSO tenants still use the normal connect flow for Atlassian.

**Verification:**
- [ ] Manual check: Okta developer org with Atlassian Rovo MCP
- [ ] Tests pass: `npm --prefix mcp-gateway test`, `npm --prefix platform-next test`

**Dependencies:** Tasks 21, 27, 28

**Files likely touched:**
- `mcp-gateway/src/credentials.ts`
- `platform-next/src/modules/connectors/connector.ts`
- `frontend/` connector card

**Estimated scope:** Medium

## Task 30: Admin setup guide

**Description:** A short guide for a tenant's IT admin: register Truex in Okta or Entra, approve apps for Cross App Access, and what offboarding does.

**Acceptance criteria:**
- [ ] A person new to Truex can follow it on an Okta developer org from start to finish.

**Verification:**
- [ ] Manual check: walked through once by someone who didn't write it

**Dependencies:** Task 29

**Files likely touched:**
- `docs/enterprise-sso.md` (new)

**Estimated scope:** Small

## Checkpoint D: after Tasks 24–30
- [ ] An Okta user signs in and uses Jira with no consent screen; disabling them stops both
- [ ] Review with human before proceeding

## Phase 5: Deploy and lock down (AWS, needs an explicit go)

## Task 31: Deploy the gateway with health checks, metrics and alerts

**Description:** Add a `mcp-gateway/Dockerfile`, at least two instances, a least-privilege Mongo user (see the plan's risks table) and secrets from Secrets Manager. Add `/health`, metrics (calls, refusals by reason, latency, refresh failures, audit write failures) and alerts on error rate and p95.

**Acceptance criteria:**
- [ ] The gateway runs in AWS with two instances, and killing one causes no failed calls.
- [ ] The Mongo user can't read a collection outside its list (tested).
- [ ] Alerts fire on a forced error spike.

**Verification:**
- [ ] Manual check: AWS console or IaC plan reviewed with a human. Open question 2 (where IaC lives) must be settled first.

**Dependencies:** Checkpoint B

**Files likely touched:**
- `mcp-gateway/Dockerfile` (new)
- IaC location per open question 2

**Estimated scope:** Medium

## Task 32: AgentCore VPC egress rule

**Description:** Using Task 2's inventory, AgentCore's egress allows the gateway and the kept hosts only. Provider MCP hosts are blocked.

**Acceptance criteria:**
- [ ] From the runtime, a direct request to `api.githubcopilot.com` fails, while the gateway, model gateway and kept hosts work.

**Verification:**
- [ ] Manual check: a request from inside the runtime, recorded

**Dependencies:** Tasks 2, 31

**Files likely touched:**
- IaC location per open question 2

**Estimated scope:** Small

## Task 33: Release gate on AgentCore

**Description:** Run everything on AgentCore: Task 1's scan again (now the token can't be there at all), five connectors, the SSO flow, coding and web search under the egress rule, and latency.

**Acceptance criteria:**
- [ ] The provider token marker is absent from `/mnt/state`, CloudWatch and every model request.
- [ ] Every connector and the SSO flow pass. Coding and search still work.

**Verification:**
- [ ] Manual check: `scripts/agentcore-smoke.mjs` with the new checks, with results recorded in the plan

**Dependencies:** Tasks 30, 32

**Files likely touched:**
- `scripts/agentcore-smoke.mjs`
- `tasks/mcp-gateway-plan.md`

**Estimated scope:** Small

## Checkpoint E: release
- [ ] All acceptance criteria met; Definition of Done in `AGENTS.md`
- [ ] Remaining risks stated; human approves the release
