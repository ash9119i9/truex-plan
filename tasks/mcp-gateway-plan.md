# Implementation Plan: MCP gateway, connector onboarding and enterprise SSO

Tasks: [mcp-gateway-todo.md](mcp-gateway-todo.md). Idea and decisions: [docs/ideas/mcp-gateway.md](../docs/ideas/mcp-gateway.md). Probe on the pin: `runtime-adapter/test/codex/gateway-probe.test.ts` (2026-10-29). Replaces the step lists in `backlog/security/05-truex-mcp-gateway.md` and `backlog/features/05-connector-catalog-at-scale.md`.

## Overview

A new `mcp-gateway/` service sits between Codex and every provider MCP server. Codex holds only a per-chat Truex token. The gateway swaps in the user's real token, refreshing it when the call is made, and checks every call against policy. The direct Codex-to-provider path is deleted. Connector onboarding gains CIMD, DCR and a probe CLI, and four connectors are added. Tenants can sign in with Okta or Entra, and connectors that support Enterprise-Managed Authorization (XAA / ID-JAG) connect without a consent screen. An AgentCore VPC egress rule makes the gateway the only route to providers. Everything ships as one release; the order below is build order only.

```text
frontend → platform-next ── StartRunRequest.mcp: url = gateway, Authorization = Bearer <truex chat token>
                 │                         ▼
                 │        runtime-adapter → Codex ──► mcp-gateway ── Bearer <provider token> ──► provider MCP
                 │                                        │  verify token, revocation, allowlist + hashes,
                 └── Mongo: connections, catalog, ────────┘  approval grants, args/result caps, SSRF,
                     approval grants, audit                  rate limits, audit, refresh
```

## Architecture Decisions

- **Separate service** `mcp-gateway/`, its own package, image and secrets, laid out like `model-gateway/`. If it lived in model-gateway, one breach would expose both the LLM keys and every provider token.
- **No runtime-adapter contract change for the cutover.** The platform already builds `McpServerSpec` (`platform-next/src/modules/connectors/connectors.service.ts:650`). The cutover changes the `url` and `Authorization` it emits. The only contract change is additive: `argsHash` on `approval.requested` (Task 12).
- **Caller token per chat, never per run.** The probe showed that a new header value restarts the Codex process. Revocation is checked on every call: the chat exists, the member is still in the tenant, the connection is active, and the connector is enabled. The signing follows `shared/gateway-token.ts` but uses its own secret and its own claims.
- **Approvals stay in Codex's elicitation.** The probe showed the gateway can't hold a call for a human, because `tool_timeout_sec` (default 60 s, max 300 s) fails it. Instead, the platform writes a grant before it forwards Allow to the adapter, and the gateway consumes the grant atomically when the call arrives. An Allow once grant is bound to the tool plus a hash of the arguments, and is single-use.
- **The gateway owns decryption and refresh, and ends up the only holder of the token key.** platform-next builds only from its own sources, so it can't import `shared/`. The gateway therefore gets its own implementation of the same sealed format and refresh lease (Task 5). Compatibility is proven by fixed test vectors in both directions and a cross-service lease test. After the cutover, platform-next hands new tokens to the gateway at connect time and deletes its copy and the key (Task 34). The two copies only overlap until then. Later the key moves to AWS KMS, so IAM enforces that only the gateway can decrypt (`backlog/security/02`).
- **Coding runs are a second token path** (found 2026-10-29). `runSpecs` puts the member's real token into the run's network policy (`networkConnectorOf`), and the adapter hands it to Codex's network proxy as `TRUEX_TOKEN_<NAME>` (`runtime-adapter/src/codex/network.ts`). Commands see a stand-in, but Codex holds the real token. "Provider tokens never reach Codex" holds only after Task 35, and Task 34 can't remove platform-next's key until Task 35 is done.
- **Strict by default.** If a tool has no reviewed definition hash, or the hash doesn't match, the tool is hidden. Unknown JSON-RPC methods are refused. Redirects are never followed.
- **The probe CLI comes before the cutover**, because GitHub needs reviewed tool hashes before the gateway will offer any of its tools.
- **Company login is OIDC only** (Okta, Entra), generalized from `platform-next/src/modules/auth/google-oidc.ts`. No SAML.

## Task List

### Phase 0: Baseline (AWS, needs an explicit go)
- [ ] Task 1: AgentCore token scan and error-text check (slice 6)
- [ ] Task 2: Runtime outbound traffic inventory on AgentCore

### Phase 1: Gateway core
- [ ] Task 3: Caller token in `shared/`
- [ ] Task 4: Gateway skeleton: verify, revocation check, transparent forwarding
- [ ] Task 5: Gateway token crypto and leased refresh, compatible with platform-next
- [ ] Task 6: Token injection and refresh at call time
- [ ] Task 7: RFC 8707 `resource` on authorize, token and refresh
- [ ] Task 8: Tool allowlist and definition hashes
- [ ] Task 9: Probe CLI: discovery report, tool draft, tool hashes
- [ ] Task 10: Egress allowlist and SSRF guard
- [ ] Task 11: Argument validation, result caps, redaction, untrusted marking

### Checkpoint A: gateway passes its own tests against the MCP fixture; review with human

- [ ] Task 12: Contract: `argsHash` on `approval.requested`
- [ ] Task 13: Server-side approval grants
- [ ] Task 14: Rate limits
- [ ] Task 15: Audit records

### Phase 2: Cutover
- [ ] Task 16: Platform emits gateway specs; delete the direct path
- [ ] Task 17: Local end-to-end through the real gateway; latency measured
- [ ] Task 35: Coding sandbox credentials no longer reach Codex (design decision first)
- [ ] Task 34: Gateway seals tokens at connect; platform-next drops the token key

(Tasks 34 and 35 were added after the original list and keep their numbers. Task 35 comes before Task 34.)

### Checkpoint B: GitHub works end to end only through the gateway, locally; review with human

### Phase 3: Connector onboarding
- [ ] Task 18: `registration: "cimd"`
- [ ] Task 19: `registration: "dcr"`
- [ ] Task 20: Onboard Notion
- [ ] Task 21: Onboard Jira / Confluence
- [ ] Task 22: Onboard Gmail
- [ ] Task 23: Onboard Slack

### Checkpoint C: five connectors connect, read and write through the gateway; review with human

### Phase 4: Enterprise SSO
- [ ] Task 24: Tenant identity provider settings
- [ ] Task 25: OIDC sign-in for Okta and Entra (backend)
- [ ] Task 26: Company sign-in screen (frontend)
- [ ] Task 27: Offboarding ends the Truex session
- [ ] Task 28: ID-JAG exchange library
- [ ] Task 29: Enterprise-managed connectors (Atlassian)
- [ ] Task 30: Admin setup guide

### Checkpoint D: an Okta test user signs in and uses Jira with no consent screen; disabling them stops both

### Phase 5: Deploy and lock down (AWS, needs an explicit go)
- [ ] Task 31: Deploy the gateway with health checks, metrics and alerts
- [ ] Task 32: AgentCore VPC egress rule
- [ ] Task 33: Release gate on AgentCore

### Checkpoint E: release

## Parallelization

- After Task 4: Tasks 5, 7, 10 and 11 touch different files and can run in parallel.
- Task 12 (contract) goes first in its group; Tasks 13 and 14 can then run in parallel.
- Phase 3 and Phase 4 are independent of each other once Checkpoint B passes. Task 29 needs Tasks 21 and 28.
- Tasks 1 and 2 can run any time before Task 32, and should be done early because they size the risk.

## Local setup in a worktree

A worktree has no `vendor/codex`. Don't symlink it to the main checkout. Codex grants its sandbox helper access to the binary's path as spawned, but macOS `sandbox-exec` resolves the symlink, so the helper is denied (`execvp() ... Operation not permitted`) and every `apply_patch` fails. Shell commands still work, which hides it. Copy the binary to `vendor/codex/codex-rs/target/debug/codex` instead (`cp -c` on APFS is instant), check its sha256 against `.runtime/codex-build.json`, and point `RUNTIME_TEST_TOOLCHAIN_DIRS` at the main checkout's `.runtime/toolchain/python` for the toolchain tests.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Codex's `tool_params` in the elicitation don't equal the `tools/call` arguments, so `argsHash` never matches | High: every Allow once is refused | Task 12 asserts equality on the pin before Task 13 starts. Fallback: bind Allow once to the tool plus a short TTL, and say so |
| Revocation and grant checks add Mongo round trips per call | Medium: latency | One query per check, indexed. Task 17 measures p50/p95 direct versus through the gateway, and a cache of at most a few seconds is used only if measured to be needed |
| Gateway outage stops every connector | High | Health checks, multiple instances, alerts on error rate and latency (Task 31). The model receives a clear "connector unavailable" error |
| SSE streaming or `mcp-session-id` handling breaks with real servers | High | Task 4 forwards streams without buffering; Task 17 runs against GitHub, which uses SSE |
| A vendor doesn't support CIMD or DCR | Low | Pre-registered apps stay supported. The probe reports which modes work before a connector task starts |
| Entra's XAA support isn't documented | Medium | Atlassian + Okta is the gate (Checkpoint D). Entra ships with OIDC login and the normal connect flow until it is verified |
| Egress rule breaks web search, git or package installs | High | Task 2 inventory before Task 32; Task 33 runs the coding and search tests on AgentCore |
| DNS rebinding between the SSRF check and the connection | High | Connect to the resolved, checked address with the original host for TLS (Task 10) |
| Existing GitHub chats break at the cutover | Medium | The fingerprint changes once, causing one reload. Task 17 continues a chat started before the switch |
| Gateway and platform-next refresh the same connection with different rules during the overlap | High: GitHub invalidates a used refresh token, leaving the member signed out | Same lease field and claim conditions; Task 5 tests a lease held in platform-next's shape blocking the gateway |
| Coding runs keep handing Codex the real token | High: the gateway's main goal is unmet for coding runs | Task 35, decided with a human before Task 34 |
| Gateway's Mongo user can read every tenant | High | Least-privilege user: read on the catalog, chats, memberships and connections; write only on connections (refresh), grants and audit (Task 31) |

## Open Questions

1. JSON Schema validation for tool arguments (Task 11): add `ajv` at an exact version, or write a small validator for the subset of JSON Schema providers use? This is a new dependency in a security service.
2. Where does AWS infrastructure live? `deploy/` holds only `websearch.env`. Tasks 31 and 32 need an IaC home, or a documented console runbook.
3. Offboarding (Task 27): is SCIM required, or are short Truex sessions renewed against the IdP enough?
4. Is there an Okta or Entra test org? It's needed before Task 25. The Okta developer org is free.
5. Do tenant admins configure their own IdP in the UI, or does the product team do it with the operator CLI for the first tenant?
6. Coding sandbox credentials (Task 35): route credentialed sandbox traffic through a Truex egress proxy, give the sandbox only short-lived narrowly scoped tokens, or accept and document the remaining exposure?
