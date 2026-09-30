# Token Optimization Plan: Tools and Skills at Scale

Status: proposed (2026-09-30), not started. All phases are flag-gated. No changes to `vendor/codex`.

## Problem

An agent can have many MCP servers attached, and each server can expose many tools. Users should not have to pick tools by hand. Skills have the same problem: every attached skill costs tokens on every request.

Rough scale: 1,000 tools at 200-400 tokens each is 200-400K tokens per request. That doesn't fit in most context windows, and tool-selection accuracy drops once a model sees more than about 100 tools.

## How it works today

### MCP tools
- MCP profiles live in the tenant DB `truex_mcp` (`platform/src/store.ts:206`). Agents link to them through `Agent.mcpProfileIds` (`shared/contracts.ts:15`), with a cap of 50 per agent (`platform/src/service.ts:578-617`).
- The session build turns each profile into `config["mcp_servers.<name>"]` (`platform/src/service.ts:390`). Server names are also listed in the base instructions through `attachedMcpInstructions` (`platform/src/mcp.ts:7`).
- Every tool from every attached server is sent in full on every request.
- Codex has native deferred tools behind a BM25 `tool_search` (`core/src/mcp_tool_exposure.rs:89-93`). It only turns on when `model_info.supports_search_tool && provider.namespace_tools` (`core/src/tools/spec_plan.rs:582-595`), which is false for non-OpenAI models. The gateway adapters also drop `tool_search` (`model-gateway/src/adapters/anthropic.ts:39`, `chat.ts:27`, `gemini.ts:78`).
- Codex supports per-server `enabled_tools` / `disabled_tools` (`codex-mcp/src/tools.rs:63-95`). The platform never sets them. agent-core passes `mcp_servers.*` overrides through unchanged (`agent-core/src/business-runtime.ts:270-289`).
- Only gateway-routed profiles pass through code we control, where `AdapterContext.input.tools` holds the full tools array. Direct routes (`platform/src/model-route.ts:13-45`) go from Codex straight to the provider, so trimming in the gateway alone can't solve this.

### Skills
- The catalog DB `truex_skills` stores `{name, description, body, version, enabled}` (`platform/src/store.ts:70-79`). Agents reference skills by `skillIds`, filtered by the tenant's `allowedSkillIds` (`store.ts:231-241`).
- The full body of every attached skill is inlined into `baseInstructions` (`agent-core/src/tenancy.ts:89-99`, appended at `business-runtime.ts:337`). Limits are 50 skills, 64 KB per body and 256 KB total (`tenancy.ts:8-14`), roughly 64K tokens in the worst case.
- Codex's own on-demand skill catalog (name + description + path, body read on use) is disabled (`business-runtime.ts:311-318`), because Codex can't limit a thread to a chosen set of skills.

### Caching and measurement
- The Anthropic adapter sets `cache_control` on tools + system (`model-gateway/src/adapters/anthropic.ts:43-56`), but `cachedInputTokens` is 0 on every turn (backlog.txt:58). One suspected cause is the proxy dropping `cache_control`, not yet confirmed.
- A one-word "Hi" costs about 10.4K input tokens.
- Token usage is traced (`agent-core/src/trace.ts:165-175`, `platform/src/traces.ts:16-41`), but nothing measures tool-definition size, tool count or per-server cost.

## Approach

The model sees a short index up front, and full definitions load only when needed. Anthropic and OpenAI both provide this natively now. Published results:
- Anthropic tool search: tool-definition tokens dropped from about 72K to 8.7K, and MCP eval accuracy rose (Opus 4.5 went from 79.5% to 88.1%).
- Picking a server first, then a tool (MCP-Zero, 2,797 tools): about 98% fewer tokens.

## Phase 0: Measure and fix caching

1. Per request, record the tool count, tool-definition tokens and per-server cost in the gateway and traces.
2. Split the token bar into "Setup (instructions + tools)" and "Conversation".
3. Fix prompt caching: confirm the proxy forwards `cache_control` and returns `cache_read_input_tokens` / `cache_creation_input_tokens`. Cached input is billed at about 10% of the normal rate, and every model call in a task resends the same starting prompt.
4. Quick wins from backlog.txt:56-66:
   - `include_permissions_instructions=false` (~970 tokens)
   - shorten the 8 workspace tool descriptions (~700-900 tokens)
   - send workspace tools only to agents that use them (~1,500 tokens)
   - find the ~4,100 unlogged tokens
   - (`skills.include_instructions=false` is already done at `business-runtime.ts:316`)
5. Forward `tool_output_token_limit` (and per-tool `output_token_limit` where needed) so large tool results get capped.

Expected: about 3-3.4K tokens saved on "Hi" (~30%), plus the caching discount on every call.

## Phase 1: Load skills on demand

1. Replace the inlined bodies in `skillInstructions()` with an index of name, version and a one-line description. Budget it at about 2% of the context window, the same default as Codex `skills.max_context_tokens`.
2. Add a Truex dynamic tool `read_skill(name)` that returns the body from the thread's saved skill set (thread marker, `business-runtime.ts:378-386`). This keeps tenant allow-list control, which is why the Codex version stays off.
3. Relax the 256 KB total limit, since only the index goes into the prompt. Keep a per-body limit.
4. Later, when skill counts grow: add `find_skills(query)`, and let skills reference extra files loaded through the same tool.

Expected: the worst case drops from about 64K tokens to about 5K for 50 skills.

## Phase 2: Truex MCP broker

Truex runs one HTTP MCP server per session that connects to all of the agent's attached servers. Codex is configured with this one server instead of N.

Tools it exposes:
- `find_tools(query, server?)`: returns the top-k matches with full input schemas.
- `call_tool(name, args)`: runs the real tool on the right server and returns its result.
- A few always-loaded tools, pinned per agent (later chosen from usage data).

Instructions: list the connected servers with one line each (extending `attachedMcpInstructions`), so the model picks a server before searching its tools.

Details:
- Search starts with BM25 over tool names, descriptions and argument names and descriptions. Embeddings come later, behind the same interface.
- It switches on automatically once an agent's tool definitions pass a threshold (around 30 tools or about 8K tokens). Below that, tools go out in full as they do today.
- It works for every provider and both routes, because Codex only sees a normal MCP server.
- The tool list stays fixed for the thread, so the prompt cache survives. `find_tools` results arrive as tool output, not as new tool definitions.
- Cache each server's `tools/list` keyed by the `mcpFingerprint` from `docs/USER_SCOPED_MCP_PLAN.md`, and refresh it on `listChanged`.
- Keep tool names as `server__tool`, the same scheme as `model-gateway/src/tool-names.ts`.

Expected: tool overhead stays at a fixed 2-5K tokens no matter how many servers are attached.

### Risks to handle
- **Approvals.** Codex only sees `call_tool`, so the broker must enforce approval for each real tool itself. It uses MCP tool annotations (`destructiveHint`, `readOnlyHint`) plus the agent's approval mode (see the approval-modes plan). Unannotated tools default to requiring approval.
- **Traces and UI.** The broker must record which real server and tool ran, so traces, receipts and the activity UI show the real tool and not `call_tool`.
- **Security.** The broker holds decrypted user MCP credentials. It must be scoped to one session, authenticated with a per-session token, and never an open network endpoint.
- **Search misses.** Tools with poor descriptions won't be found. Mitigations: an eval set, a server filter on `find_tools`, and falling back to listing a server's tool names when a search returns nothing.
- **Latency.** The first use of a tool adds one model turn for the search.

## Phase 3: Optional tuning

- For Anthropic gateway traffic, use native `defer_loading` + tool search (`advanced-tool-use-2025-11-20`) in the adapter instead of the broker.
- For OpenAI direct traffic, consider Responses API `tool_search` in client mode with namespaces.
- Choose always-loaded tools from usage data (tool usage is heavily skewed toward a few tools).
- Embedding-based retrieval, then reranking of the top candidates.
- Add `input_examples` only on tools with tricky schemas.
- An eval set that tracks search hit rate, task accuracy and tokens per turn for each phase.

## Open decisions

1. Where the broker runs: inside the platform process, as a separate service, or started per session by agent-core.
2. The auto-enable threshold: tool count or definition tokens.
3. Whether embedding search may send tool descriptions to an outside embeddings provider, or must stay in-house.
4. What the approval default is for unannotated MCP tools going through `call_tool`.

## References

- Anthropic, advanced tool use: https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic, tool search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Anthropic, code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- Agent Skills spec: https://agentskills.io
- OpenAI, tool search: https://developers.openai.com/api/docs/guides/tools-tool-search/
- MCP spec changelog 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- RAG-MCP: https://arxiv.org/abs/2505.03275
- MCP-Zero: https://arxiv.org/abs/2506.01056
- ScaleMCP: https://arxiv.org/abs/2505.06416
- StackOne, MCP token optimization compared: https://www.stackone.com/blog/mcp-token-optimization/
