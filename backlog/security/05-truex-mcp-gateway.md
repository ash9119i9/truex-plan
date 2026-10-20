# Connectors: Truex MCP gateway (provider tokens never reach Codex)

Status: open · Added 2026-10-21 · Depends on: MCP directory connectors (`tasks/mcp-plan.md`) · Revisit before the first enterprise tenant or any connector beyond the curated directory

## Goal

Put our own MCP gateway between Codex and every MCP server, and make it the single place where connector policy is enforced. Codex keeps being the MCP client, but it talks only to the gateway and holds only a short-lived Truex token. The real GitHub, Google or Notion token never leaves the platform side.

```text
today:   Codex ── Bearer ghu_… ──────────────────────────────► api.githubcopilot.com/mcp/
gateway: Codex ── Bearer <truex run token> ──► Truex MCP gateway ── Bearer ghu_… ──► api.githubcopilot.com/mcp/
```

No `vendor/codex` change: only the `mcp_servers.<name>.url` and `Authorization` header in the adapter config change.

## Current state (v1)

- The platform decrypts the user's access token per run and the adapter passes it to Codex as `http_headers.Authorization` (`runtime-adapter/src/codex/config.ts`).
- Policy lives in Codex config: `enabled_tools` drops write tools for read-only agents, and write tools ask through `mcpServer/elicitation/request`. Codex enforces both; nothing checks them again on the way to the provider.
- Local probe (2026-10-20, `tasks/mcp-plan.md` §3): no token found in any of the 97 files under `CODEX_HOME` after restarts and a resume. AgentCore `/mnt/state` and CloudWatch are not yet checked (slice 6).

## Why

The model can't read the token, but these paths remain while Codex holds it:

1. Codex state or logs on AgentCore that we haven't scanned.
2. An HTTP error text that includes request headers being returned to the model as a tool error.
3. A third-party MCP server echoing the token back in a result.
4. Anything that can read the Codex process or the adapter's stdin.

And all enforcement today depends on Codex behaving as the probe showed on this pin. A future pin change, a config bug or a missed `enabled_tools` entry would let a call through with nothing behind it.

## What "strict" means

The gateway refuses by default. Every rule below is checked on every call, independent of what Codex was told.

| Area | Rule |
| --- | --- |
| Caller token | Signed by the platform, bound to tenant, user, chat, connector and catalog revision, with a short expiry and a revocation check. Same signing pattern as the model-gateway token. Useless against any other chat or connector |
| Tools | `tools/list` returns only the tools the chat's access allows. `tools/call` for anything else is refused, even if Codex asks |
| Write tools | Refused unless the platform has a matching approval (Allow once, or Allow for this chat) for that chat and tool. Approvals stop depending only on the Codex elicitation |
| Arguments | Validated against the tool's input schema, with a size cap |
| Egress | Only the catalog record's MCP URL. Resolved addresses checked against private and link-local ranges (SSRF) |
| Results | Size cap, any known token value redacted, marked as untrusted content. The hook for prompt-injection screening |
| Rate limits | Per user and per connector, with a clear error the model can report |
| Audit | One record per call: tenant, user, chat, tool, outcome, duration, approval ID. No arguments or results, only their hashes |
| Network | On AgentCore, the runtime can reach the gateway but not provider MCP URLs directly (VPC egress rule) |
| Spec | Send the RFC 8707 `resource` parameter on authorize and token requests (MCP spec 2026-07-28), per connector |

Token refresh moves next to the gateway, so a run longer than the 15-minute refresh margin no longer meets an expired token mid-reply.

## Fits with

- The planned MCP broker for thousands of tools (`docs/TOKEN_OPTIMIZATION_PLAN.md`, phase 2: `find_tools` / `call_tool`). The gateway is where it would live; build them as one service.
- `backlog/security/02-connector-secrets-in-aws.md`: the gateway is the only service that needs the client secrets and token keys.

## Build or adopt

Evaluate before building. agentgateway (Linux Foundation) supports per-user upstream auth and token exchange and is the first candidate. IBM ContextForge had a cross-user token bug (issue #1078) and an SSRF bulletin, so treat it with caution. Building our own is likely to be small, since the platform already does OAuth, refresh, encryption and approvals; the gateway mostly moves the header and adds the checks above.

## Steps

1. Slice 6 first: scan AgentCore `/mnt/state` and CloudWatch for the token, and force a failing tool call to check the error text. This measures how urgent the gateway is.
2. Decide build vs adopt (one-day agentgateway spike against the GitHub connector).
3. Gateway service with the caller token, tool allowlist, egress check and audit. Adapter switches the URL and header behind a per-connector flag.
4. Server-side write approvals, result redaction and size caps.
5. Move refresh into the gateway path; add the `resource` parameter.
6. AgentCore VPC egress rule so only the gateway is reachable. Remove the direct path.

## Open decisions

1. Separate service, or a new route in model-gateway (shared deployment, signing and Mongo access).
2. Caller token lifetime: per run (strictest, but every run reloads the Codex thread because the header changes) or per chat with revocation.
3. Whether the gateway or the platform owns refresh and decryption.
4. What prompt-injection screening runs on results, and whether it blocks or only flags.
