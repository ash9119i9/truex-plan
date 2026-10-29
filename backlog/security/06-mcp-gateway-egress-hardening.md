# MCP gateway: egress hardening follow-ups

Status: open · Added 2026-10-29 · Split out of Task 10 in `tasks/mcp-gateway-todo.md` · Revisit before the AgentCore egress rule (Task 32)

## Why this is separate

Task 10 shipped the core egress guard. The deeper review below was moved here so the gateway work could continue. Writing it out in detail kept getting AI-assisted sessions stopped partway, so a person should own this review, or work on it in small, separate sessions.

## What Task 10 already does (`mcp-gateway/src/egress.ts`)

- Every provider request goes through one function: MCP forwarding, OAuth discovery and token refresh.
- The gateway resolves the host itself and refuses any address that isn't public. The list uses Node's `net.BlockList`, which also catches IPv4-mapped IPv6 addresses.
- The connection goes to the exact address that was checked, with the original host kept for TLS. A DNS answer that changes later can't redirect it.
- Redirects are never followed. URLs with credentials are refused. Plain http is allowed only for loopback fixtures.
- `CONNECTORS_ALLOW_LOOPBACK` is refused with `NODE_ENV=production` or a non-loopback `HOST`.
- Tests: `mcp-gateway/test/egress.test.ts`, plus one server test and one refresh test. Breaking the address check, the pinned lookup, or the server's use of the guard each fails a test.

## Follow-ups

1. **Range review:** compare the blocked list against the IANA special-purpose address registries (IPv4 and IPv6) and record the outcome for each entry.
2. **Multiple addresses:** today the first checked address is used. Decide whether to try the others when the first one fails.
3. **Proxy settings:** confirm that no `HTTP(S)_PROXY` setting in the gateway's environment can route requests around the guard.
4. **Independent review:** have a person outside this work review `egress.ts` against OWASP's SSRF guidance before the first enterprise tenant.
5. **Network rule:** keep the AgentCore VPC egress rule (Task 32) as the second layer, so a gap in code isn't the only protection.

## Done when

- Each follow-up has a recorded decision, and a test where one applies.
- The review in item 4 is done, and its findings are fixed or accepted by the owner.
