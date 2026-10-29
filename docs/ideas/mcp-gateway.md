# MCP gateway, connector onboarding and enterprise SSO

Status: idea, agreed in discussion 2026-10-29 · Replaces the plans in `backlog/security/05-truex-mcp-gateway.md` and `backlog/features/05-connector-catalog-at-scale.md` · Driver: first enterprise tenant

## Problem Statement

How might we let enterprise tenants use any approved MCP connector so that provider tokens never leave our platform, every tool call is checked on our side, adding a vendor takes a review instead of a week of setup, and IT grants and revokes app access from their own login system?

## Today

- Codex holds the real provider token: the adapter writes it into `mcp_servers.<name>.http_headers.Authorization` (`runtime-adapter/src/codex/config.ts:90`). State files, logs, error text or a misbehaving MCP server could expose it.
- Policy is enforced only by Codex: `enabled_tools` for read-only agents, elicitation for writes. Nothing checks either again before the provider.
- The token is fixed when the run starts, so a reply past the 15-minute refresh margin can hit an expired token partway through.
- Two connectors: GitHub works, Gmail has a placeholder `clientId`. Each new vendor needs a hand-registered OAuth app and hand-typed tool lists.
- Sign-in is Google only (`platform-next/src/modules/auth/google-oidc.ts`). No Okta or Entra.

## Recommended Direction

**A separate Truex MCP gateway service.** Codex stays the MCP client, so `vendor/codex` doesn't change, but every `mcp_servers` entry points at the gateway with a per-chat Truex token. The gateway decrypts and refreshes the real token, enforces policy on every call whatever Codex was told, and is the only thing on AgentCore that can reach provider MCP URLs. It's a separate service, not a model-gateway route: otherwise one breach would expose both the LLM keys and every user's provider tokens. It reuses the signing code in `shared/gateway-token`.

**Connector onboarding.** Registration goes CIMD first, then DCR, with pre-registered apps only where a vendor requires one (GitHub, Google). A probe CLI reads a server's discovery metadata and `tools/list`, reusing `mcp-verify.ts`, and drafts the connector JSON. A human classifies write and critical tools in a PR. The probe never trusts `readOnlyHint`. Each reviewed tool definition is stored as a hash, and the gateway hides any tool whose live definition no longer matches until it's reviewed again. This defends against tool poisoning.

**Enterprise SSO.** A tenant admin connects the company's Okta or Entra, and employees sign in to Truex through it. For connectors that support MCP Enterprise-Managed Authorization (XAA / ID-JAG), the platform exchanges the employee's company identity for access, with no consent screen. When IT disables the employee, no new access is issued and their Truex session ends. Connectors without support keep the normal one-time "Connect".

Everything ships as one release, end to end. The direct Codex-to-provider path is deleted, with no fallback flag.

## Gateway rules (checked on every call, refuse by default)

| Area | Rule |
| --- | --- |
| Caller token | Signed, bound to tenant, user, chat, connector and catalog revision. Per chat, with a revocation check on every call |
| Real token | Decrypted and refreshed at call time. RFC 8707 `resource` sent on authorize and token requests |
| Tools | `tools/list` and `tools/call` limited to the chat's allowlist. A tool whose definition hash changed is hidden |
| Write tools | Refused without a server-side approval record (Allow once / Allow for this chat) for that chat and tool. The platform writes the record before it forwards Allow to the adapter. The gateway never holds a call waiting for a person, because Codex's tool timeout would fail it |
| Arguments | Validated against the reviewed input schema, size-capped |
| Egress | Catalog URL only. Resolved address checked against private and link-local ranges |
| Results | Size cap, known token values redacted, marked untrusted, prompt-injection flag (no blocking) |
| Rate limits | Per user and per connector, with an error the model can report |
| Audit | One record per call: tenant, user, chat, tool, outcome, duration, approval ID, argument and result hashes. No content |
| Network | AgentCore VPC egress: the runtime reaches the gateway, not provider URLs |

## Scope

Layers touched: new `mcp-gateway` service, runtime-adapter (MCP config), platform-next (auth, connectors, approvals, token storage), frontend (approval card, SSO admin setup, connector screens), deploy (AgentCore VPC). Everything stays tenant-scoped: tokens, approvals, audit records and SSO settings belong to one tenant, and nothing is shared across tenants.

Connectors: GitHub moved onto the gateway, plus Notion, Jira/Confluence, Gmail and Slack.

Build order. The release is the whole list; the order exists because each step needs the one before it.

1. Slice 6 scan: AgentCore `/mnt/state`, CloudWatch, and the error text of a forced failing tool call. This gives the baseline.
2. Inventory the runtime's other outbound traffic on AgentCore (web search, git, packages) so the egress rule doesn't break it.
3. Gateway service: caller token, token swap and refresh, `resource`, allowlist and definition hashes, argument checks, egress and SSRF, result handling, rate limits, audit.
4. Server-side write approvals.
5. Adapter points every connector at the gateway, GitHub migrates, and the direct path is deleted.
6. CIMD, DCR and the probe CLI, then onboard Notion, Jira/Confluence, Gmail and Slack.
7. Company login: Okta and Entra over OIDC, configured per tenant, with the session ending on offboarding.
8. Enterprise-Managed Authorization for the connectors that support it (Atlassian confirmed).
9. AgentCore VPC egress rule, plus a test that the runtime can't reach a provider directly.

## Key Assumptions to Validate

Probed on the real pin with a stub gateway, 2026-10-29 (`runtime-adapter/test/codex/gateway-probe.test.ts`):

- [x] ~~The gateway can hold a write call while a person decides.~~ **False.** Codex's per-call `tool_timeout_sec` is the ceiling: a call held 6 s failed `TIMEOUT` at 3 s and completed at 10 s, and the contract caps the timeout at 300 s. **Design change:** the approval stays in Codex's elicitation. The platform writes the approval record before it forwards Allow to the adapter, and the gateway checks that record when the call arrives. A write Codex approved but the gateway refused failed cleanly (`TOOL_ERROR`), the model saw the gateway's reason, and the provider was never called.
- [x] A per-chat token doesn't reload the thread. **True.** The same token across runs gave no `mcp_reload` and `resumed: false`. A new token restarted the Codex process and resumed the thread. So a per-run token would cost a process restart on every run, and the caller token should last the life of the chat. Revocation is checked on every call, so it doesn't need a short expiry.
- [x] Codex treats the gateway like any streamable-HTTP MCP server, elicitation included. **True.** A read call and an approved write both went through. Codex only ever sent the Truex token, the server only saw the provider token, and no model request contained the provider token. A tool filtered from `tools/list` wasn't offered to the model, and when the model called it anyway, Codex refused it before it reached the gateway (`unsupported call`). The gateway's own refusal on `tools/call` is the backstop.
- [ ] The gateway streams SSE responses and keeps `mcp-session-id` correct with real servers. The stub only forwarded JSON. Test: GitHub through a real gateway build.
- [ ] Notion, Atlassian and Slack accept CIMD or DCR, and Google has a hosted Gmail MCP server. Test: the probe CLI against each.
- [ ] Enterprise-Managed Authorization works for Atlassian with Okta as documented, and Entra support exists. Test: an Okta developer org against Atlassian Rovo MCP. Notion, Slack and Google are unconfirmed.
- [ ] The runtime's other outbound needs can be allowlisted next to the gateway. Test: the step 2 inventory.
- [ ] The extra hop is small. Test: p50/p95 of `tools/call` direct versus through the gateway, inside AWS.
- [ ] Existing GitHub chats keep working. Test: a chat started before the switch and continued after it.

## Not Doing (and Why)

- **MCP Registry sync:** with five connectors, the probe plus PR review covers onboarding. Revisit at about 20.
- **One aggregated "truex" MCP server / `find_tools`:** the fix doesn't need it. It changes the tool names Codex sees and couples every connector to one code path. It's a separate decision alongside `docs/TOKEN_OPTIMIZATION_PLAN.md`.
- **Blocking prompt injection:** results are flagged and marked untrusted. Blocking needs a screening model we haven't chosen.
- **MCP startup and connection delay:** deferred by decision.
- **Tenant-registered private MCP servers:** they conflict with the SSRF rule and need a per-tenant egress design. Wait until a tenant asks.
- **Platform as the MCP client (dynamic tools):** it would rebuild Codex's MCP client.
- **Adopting agentgateway or ContextForge:** agentgateway's per-user token storage is enterprise-only, and ContextForge had a cross-user token bug and an SSRF CVE. The gateway mostly moves a header we already manage.
- **Nango:** our own broker already handles encryption binding and refresh.
- **SAML login:** Okta and Entra both support OIDC, and one protocol is enough.

## Open Questions

1. Is there an Okta or Entra test org? The Okta free developer org is enough. This is needed before step 7.
2. Which IdP does the first enterprise tenant use, and roughly how many users?
3. ~~How does a write approval reach the gateway without trusting Codex's answer?~~ Settled by the probe: the platform records it, and the gateway checks the record (see Key Assumptions). Still open: should Allow once be used up by the first matching call, and how is "matching" defined (tool name only, or a hash of the arguments)?
4. Offboarding: is SCIM required, or are short Truex sessions refreshed against the IdP enough? Access tokens already issued live until they expire either way.
5. Who decrypts and refreshes tokens, the gateway (lean) or the platform? Settle this together with `backlog/security/02-connector-secrets-in-aws.md`.
