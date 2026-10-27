# Connectors: grow the catalog without hand-maintaining every app

Status: open · Added 2026-10-27 · Depends on: MCP directory connectors (`tasks/mcp-plan.md`) · Related: `backlog/security/05-truex-mcp-gateway.md` (token injection), `backlog/security/02-connector-secrets-in-aws.md` (secrets) · Revisit before onboarding more than a handful of connectors

## Goal

Let us add enterprise MCP connectors (Jira, Confluence, Notion, Slack, Salesforce, SAP…) at the rate customers ask for them, without hand-writing a JSON record and registering an OAuth app per vendor, and without weakening the curated safety fields that make a connector safe.

Codex stays the MCP client. Vendors own their MCP servers. We own the catalog of servers, the connect flow, credential storage, and injecting the credential on every call.

```text
User clicks "Connect Jira" → our OAuth flow → token in mcp_connections (per user, encrypted)
Agent run: Codex (MCP client) ── token ──► vendor MCP server   (gateway in between: security/05)
Catalog (truex_mcp_connectors) says which servers exist and which tools are safe
```

## Current state (v1)

- Catalog: one document per connector in `truex_mcp_connectors` (`platform-next/src/modules/connectors/connector.ts:17`), loaded from `platform-next/catalog/connectors/*.json` with `operator connector-put` / `connector-enable`. Two exist: GitHub (usable) and Gmail (`clientId` is still a placeholder).
- Auth: only `oauth_user` with `registration: "preregistered"` (`connector.ts:21,26`). Every connector needs an OAuth app we register by hand, with its client secret. No dynamic client registration (DCR), no Client ID Metadata Documents (CIMD), no static API-key connectors, no tenant-shared credentials.
- Discovery is already spec-style (`protected_resource_metadata`, `oauth-discovery.ts`), PKCE S256 is in place, and tokens are AES-256-GCM with AAD bound to tenant, owner, connector and key (`token-crypto.ts`).
- No RFC 8707 `resource` parameter on authorize or token requests (grep of `connector-oauth-flow.ts`, `oauth-exchange.ts`).
- `allowedTools`, `writeTools`, `criticalTools` and `egress` are typed by hand. `verifyConnection` (`mcp-verify.ts`) already runs `initialize → tools/list` with the user's token, so a tool probe can reuse it.

## Why

Hand-maintaining the catalog doesn't scale: each new vendor today means an OAuth app, a client secret, a URL, and a typed tool list. Most of that can be discovered or registered automatically. The part that can't, classifying write and critical tools and egress rules, is the security boundary and must stay a human review.

## What we decided in discussion (2026-10-27)

1. **The official MCP Registry is a source of candidates, not the catalog.** `registry.modelcontextprotocol.io/v0/servers` gives name, description, remote URL, transport, version, status and required headers. It does not give OAuth apps, tool safety, egress rules or any trust guarantee (a search for "github" returns Smithery-hosted third-party wrappers, not GitHub's server). Sync it into a separate collection; never write into `truex_mcp_connectors` automatically.
2. **CIMD first, DCR second, pre-registered last.** The MCP spec revision of 2026-07-28 prefers CIMD: we publish one client metadata URL and any spec-following server accepts it, which removes most per-vendor OAuth app setup. Keep pre-registered apps for vendors that need them (GitHub, Google).
3. **Keep our own credential broker for now.** It already handles encryption binding and safe refresh better than most open-source options. Revisit Nango when we need many non-MCP APIs.
4. **Token injection belongs in the gateway** (`security/05`), not in this item.

## Open-source options considered

Licences and activity are from web research on 2026-10-27 and were not checked against the repos (GitHub API rate limit). Verify before adopting.

| Role | Option | Licence | Note |
| --- | --- | --- | --- |
| Catalog | Official MCP Registry (`modelcontextprotocol/registry`) | Open source | Public read API meant for aggregators; can run as our own sub-registry for private entries |
| Credential broker | Nango | Elastic License 2.0 (source-available, not OSI) | Most complete (1,000+ APIs, MCP OAuth with CIMD/DCR, refresh). Production RBAC self-hosted is paid; legal review of ELv2 for a multi-tenant SaaS |
| Credential broker | OpenConnector (oomol-lab) | Unverified | New; maturity unknown |
| Gateway | agentgateway (Linux Foundation) | Apache-2.0 (unverified) | First candidate in `security/05`; per-user SaaS token storage is enterprise-only |
| Gateway | Pomerium MCP | Core Apache-2.0; MCP feature unverified | Closest to "connect once, gateway injects" |
| All-in-one | IBM ContextForge | Apache-2.0 (unverified) | Gateway, catalog, per-team OAuth; SSRF CVE (Aug 2026) and a cross-user token bug, so harden first |
| Authorization server | Keycloak, Ory Hydra | Apache-2.0 | For our own platform tokens; Keycloak CIMD is experimental |
| Secrets | OpenBao (Vault fork), Infisical | MPL-2.0, MIT core (unverified) | Storage only; refresh stays with us. HashiCorp Vault is BSL |
| Not a fit | Composio, Pipedream, Merge, Paragon | Closed / SaaS | Customer tokens would sit with a third party |
| Not a fit | Docker MCP Gateway, MetaMCP, Obot | Open source | Local/dev use or employee IT governance, not embedding in a product |

## Plan

```text
Hourly: GET /v0/servers (cursor paging), keep remote servers from trusted publishers
   ▼
truex_mcp_registry_candidates      ← new, never reaches agents
   ▼ operator picks one → probe:
   │   protected-resource metadata → OAuth? CIMD? DCR?
   │   test account → verifyConnection → tools/list → draft allowedTools
   │   annotations suggest writeTools (human confirms; audit F-3: never trust readOnlyHint)
   ▼ operator fills curated fields → connector-put → connector-enable
truex_mcp_connectors               ← unchanged
```

Later syncs only flag changes for promoted connectors: a new version re-runs the probe for review, `deprecated`/`deleted` warns, and a changed URL is never applied automatically (it would send user tokens to a new host).

## Steps

1. Add the RFC 8707 `resource` parameter on authorize and token requests, per connector.
2. `registration: "cimd"`: publish the client metadata document at a stable platform URL; SSRF checks on every metadata URL we fetch.
3. `registration: "dcr"` as the fallback, storing the issued client per connector (and per tenant if the server requires it).
4. Probe command in the operator CLI: given a URL, report discovery and registration support and draft `allowedTools` from `tools/list`, reusing `verifyConnection`.
5. Registry sync into `truex_mcp_registry_candidates`, plus a "promote" path that pre-fills a connector draft. Do this once we're onboarding about 20 or more connectors; steps 1–4 come first.
6. Static API-key connectors (`auth.type: "api_key_user"`) for servers whose registry entry declares a secret header, stored the same way as OAuth tokens.
7. Later: Enterprise-Managed Authorization (ID-JAG / cross-app access) so a tenant's Okta or Entra grants access without a consent screen per app (Atlassian and Notion support it).

## Done when

- A new spec-following OAuth MCP server can be added with no OAuth app registered by hand: probe, review the tool classification, `connector-put`, enable.
- Authorize and token requests carry `resource`, with a test.
- Registry sync never changes `truex_mcp_connectors`; a test proves a changed upstream URL is only flagged.
- Each new registration mode has tests for refused registration, metadata fetch to a private address, and a server that changes its metadata.

## Open decisions

1. Which publishers the sync trusts (vendor namespaces only, or an allowlist we keep).
2. Whether tenant admins may promote candidates for their own tenant, or only the product team.
3. Nango versus our broker, once non-MCP APIs are on the roadmap.
4. Whether DCR clients are per connector or per tenant.
