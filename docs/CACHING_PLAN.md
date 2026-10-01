# Caching in every layer: plan

Status: planned, not implemented (drafted 2026-10-01). Built from seven read-only code audits of the frontend, platform, agent-core, model-gateway, deploy config, the document path, and a general optimization sweep. Line references were checked on 2026-09-30 and may have drifted since.

## Summary

- Caching goes in at eight layers: browser HTTP cache, frontend app cache, platform in-process cache, Redis, Mongo, agent-core, model-gateway, and the LLM provider's prompt cache. A CDN comes later, once there is a public ingress.
- **Redis is optional.** With `REDIS_URL` unset, every service falls back to its in-process cache, so local dev works as it does today.
- **Redis is never the source of truth.** Mongo and agent-core stay authoritative. Every Redis key tolerates loss, so Redis runs with `allkeys-lru` and no persistence.
- **Every cache key includes the tenant.** Authorization runs before any cache read, and HTTP caching is always `private`.
- **Turn context (the masked prompt) is never cached** in any layer.
- **Each layer has its own flag**, following the `on()` pattern in `platform/src/features.ts`.
- **Measure first.** `Server-Timing` headers and frontend timing marks go in before any cache, so each phase has a before and after.
- None of this touches `vendor/codex`.

## Current state

- **Deploy:**
  - platform runs 2 replicas, model-gateway 2, agent-core a 2-pod StatefulSet, frontend 1 (`deploy/kubernetes.yaml:18,52,90,117`).
  - Mongo 8 is the only datastore. There is no Redis, CDN or ingress.
- **Existing caches:** all are in-process and per replica, and nothing invalidates them across replicas.
  - platform tenant registry: 5s TTL (`platform/src/store.ts:80-87,170-183`).
  - gateway profiles: 30s TTL, stale up to 1h, 5s negative cache. Secrets are cached 5 min. The gateway has a `clear()` (`model-gateway/src/profiles.ts:47-146`), but nothing calls it.
- **Frontend:**
  - `api()` is a bare `fetch` with no cache, no dedupe and no ETags (`frontend/lib/api.ts:98`).
  - `localStorage` holds only preferences, and `sessionStorage` holds only the SSE cursor (`frontend/lib/transport.ts:40`).
- **HTTP:**
  - Documents, visualizations and turn context are sent `no-store` (`platform/src/index.ts:191,198,469`).
  - List endpoints set no cache headers, and there is no compression.
- **LLM:**
  - The Anthropic adapter sets cache control (`model-gateway/src/adapters/anthropic.ts:48-55`), but `cachedInputTokens` is 0 on every turn (`backlog.txt:58`). A duckdns proxy is the suspected cause.
  - The chat adapter drops `prompt_cache_key`, and Gemini doesn't use `cachedContent`.

## Hot paths today

| User action | What happens | Reference |
|---|---|---|
| Open a conversation | 4 browser calls. On the server, 3 run a full agent-core ingest, `history()` reads the session 5 times, and `reconcile()` looks items up one by one | `platform/src/service.ts:1040-1118`, `platform/src/index.ts:413-463` |
| Send a message | `configuration()` does 4+N serial Mongo reads, the whole message history is loaded, and `/resume` and `/capabilities` are called even when the thread is already loaded | `service.ts:329-416,857-885,1216` |
| App start | Blocked on "Loading agents…" until `/api/agents` returns | `frontend/app/page.tsx:1352` |
| Tab or sheet switch | Refetches goal history (with a 400ms delay), model context, documents and the MCP list. The MCP list is fetched by 3 components | `components/connected-tools.tsx:26,121`, `components/mcp-settings.tsx:28` |
| Stream reconnect | Resends a full snapshot even when replay succeeded, and builds it twice | `agent-core/src/manager.ts:1062-1086` |
| Background | Both platform replicas poll every session every 2s | `service.ts:1119-1155` |

## Layer 1: browser HTTP cache

| Route | Header | Validator |
|---|---|---|
| Document content, visualization JSON | `private, max-age=31536000, immutable` | `sha256` ETag |
| `/models`, `/capabilities`, `/schemas/*`, `/features` | `private, no-cache` | ETag from `catalog:ver` |
| `/agents`, `/agents/:id/mcp` | `private, no-cache` | ETag from `cfg:{tenant}:ver` |
| `/sessions` | `private, no-cache` | ETag from the newest `updatedAt` |
| `/sessions/:id/documents` (list) | `private, no-cache` | ETag from file count + newest `createdAt` |
| `/turns/:t/context` | `no-store` (unchanged) | none |
| SSE `/events` | `no-cache, no-transform` (unchanged) | none |

- Every cacheable response sends `Vary` on the tenant header, and on the session cookie once auth lands.
- A cheap 304 replaces the full body when data hasn't changed.

## Layer 2: frontend app cache

Flag: `NEXT_PUBLIC_CLIENT_CACHE`.

- **One stale-while-revalidate layer in `lib/api.ts`.** It shows the cached copy immediately and refreshes it in the background. It is keyed by tenant and URL, shares in-flight requests, clears keys after writes, and sends `If-None-Match` for any ETag it has.
- **For the whole page load:** models, capabilities, schemas and features.
- **Shared per agent:** one MCP list for all 3 components, invalidated when `mcpVersion` changes.
- **In-memory LRU of the last 20 conversations:** detail, traces and timings. A reopened conversation shows immediately, and SSE brings it up to date.
- **localStorage on boot:** agents, sessions and projects render immediately, then revalidate. Clear them on tenant switch, and on logout once auth exists.
- **Kept across tab and sheet switches:** goal history, model context and the documents list. Remove the 400ms goal-tab delay.
- **Visualizations** are kept in memory by `session:id`, so a remount doesn't refetch up to 180 KB of HTML.

## Layer 3: platform in-process cache (L1)

This is a small LRU in each replica. It sits in front of Redis when Redis is on, and stands alone when Redis is off.

| Data | TTL | Invalidated by |
|---|---|---|
| Catalog models and skills | 60s | `catalog:ver` change |
| Tenant agents and MCP profiles | 300s | `cfg:{tenant}:ver` change, pub/sub |
| Tenant registry | 5s (as today) | pub/sub tenant eviction |
| Active-tenant list for the poller | 10s | pub/sub tenant eviction |

- With Redis off, the version stamps live in Mongo. Each replica checks them at most every 5s.
- `configuration()` reads its inputs (agent, model, MCP, skills) from this cache, which takes 4+N Mongo reads off every message send.

## Layer 4: Redis (shared, L2)

Flag: `REDIS_URL`. The client is `ioredis` at a pinned version, in a shared module in `shared/` exposing `getJSON`, `setJSON`, `lease`, `publish` and `subscribe`. It needs:
- a command timeout of about 50ms
- a circuit breaker that falls back to L1
- metrics for hits, misses and errors

### Uses

- **Poller lease:** only one replica polls each tenant. This halves the load on agent-core and removes the race where both replicas persist the same records before either one sends `/records/ack`.
- **Cross-replica invalidation:** a pub/sub message evicts cached gateway profiles and secrets, the tenant registry and tenant config on every replica. Key rotation and profile disable then take effect everywhere at once.
- **Shared read cache:** catalog, tenant config, completed traces and transcripts, documents.
- **Stream write dedupe:** the last persisted cursor per session, so extra tabs and replicas stop repeating goal and plan writes (`platform/src/index.ts:537-600`).
- **Idempotency pre-check:** for `command()` and title setting. The Mongo unique index stays the guarantee.

Redis is not needed for SSE fan-out or session ownership. Each session's events already come from its owning agent-core pod, and Mongo records the owner (`session.agentCoreHost`).

### Keys

| Key / channel | Purpose | TTL | If lost |
|---|---|---|---|
| `lease:poll:{tenant}` | One replica polls each tenant | 5s | Both replicas poll, as today |
| `truex:inv` (pub/sub) | Evict profiles, secrets, tenants and config on every replica | n/a | Data stays until its TTL expires |
| `catalog:ver`, `cfg:{tenant}:ver` | Version stamps for keys and ETags | none | Rebuilt from Mongo, causing one miss |
| `c:catalog:{ver}:models`, `c:catalog:{ver}:skills` | Catalog | 60s | Read from Mongo |
| `c:{tenant}:{ver}:agents`, `c:{tenant}:{ver}:mcp:{agentId}` | Tenant config | 300s | Read from Mongo |
| `c:{tenant}:done:{sessionId}:{kind}:{id}` | Completed traces, transcripts, goal history | 24h | Read from Mongo or agent-core |
| `doc:{tenant}:{sessionId}:{fileId}` | Document bytes ≤ 1 MB, visualization HTML | 24h | Fetched from agent-core |
| `doclist:{tenant}:{sessionId}` | Document list + ETag | 60s, cleared on save | Fetched from agent-core |
| `sse:persisted:{sessionId}` | Last persisted stream cursor | 1h | Repeated writes (harmless) |
| `idem:{tenant}:cmd:{clientId}` | Fast duplicate check | 10 min | Mongo unique index catches it |

### Deploy

- Add a `redis` (or `valkey/valkey`) service to `deploy/compose.yaml`.
- On AWS, use ElastiCache for Valkey or Redis OSS.
- Add `REDIS_URL` to platform (`deploy/kubernetes.yaml:62-76`) and gateway (`deploy/kubernetes.yaml:132-135`).
- Expose `redis: boolean` from `/api/features`.

## Layer 5: Mongo

These changes aren't caches, but they cut the cost of every cache miss.

- **Sessions list:** add `{runtimePolicyVersion:1, createdAt:-1}` for its filter and sort. The only candidate index today, `{projectId:1, createdAt:-1}` (`store.ts:136`), can't serve it.
- **Sessions list projection:** switch to an inclusion projection with the 8 fields `publicSession` needs (`platform/src/public.ts:23-37`).
- **Titles:** save `title` when the first user message is written, then remove the untitled `$group` aggregate from the list (`service.ts:697-702`).
- **Message reads:** paginate the session GET to the latest N messages, served by the existing `{sessionId, at}` index. On send, load only the fields `orderConversation` needs.
- **Poller query:** add a projection (`service.ts:1139`).
- **Batching:** replace the per-item lookups in `configuration()`, `setAgentMcp` and `reconcile()` with `$in` batches.
- **Commands:** add a unique index for command idempotency (`service.ts:1196-1210`).

## Layer 6: agent-core

- **Marker records:** cache them in a Map, invalidated at their 2 writes. They're read synchronously 6+ times per request (`agent-core/src/business-runtime.ts:118-250`).
- **Event serialization:** serialize each event once for all subscribers (`manager.ts:1282`), and make durable event writes async (`manager.ts:1260-1266`).
- **Snapshots:** skip the snapshot when replay succeeded, build it once, and send only what the client is missing. This also avoids the 4 MB frame limit that cuts off live updates in long sessions (`platform/src/public.ts:754`).
- **Document list:** cache it per workspace in memory and invalidate it in `save()`. Today it re-reads every metadata file on each call (`agent-core/src/file-tools.ts:202-217`).
- **Content hash:** compute `sha256` in `save()` and store it in metadata.
- **Binary downloads:** stream document bytes with the right `Content-Type`, replacing base64 JSON (`agent-core/src/index.ts:111`).

## Layer 7: document and visualization cache

Files are never overwritten. `save()` always uses a new UUID, and a revision gets a new id with `sourceId` (`agent-core/src/file-tools.ts:270,285`). That makes `(tenant, sessionId, fileId)` a safe permanent key.

| Tier | What it holds | Lifetime |
|---|---|---|
| Browser | Content with `immutable`; visualization JSON in memory | 1 year / page load |
| Platform Redis | Bytes ≤ 1 MB, visualization HTML | 24h |
| agent-core disk | The source today; an LRU cache in front of S3 once the storage plan ships | Workspace TTL |
| S3 (later) | Source of truth, served by 302 to a presigned GET, with `sha256` as the content address | Per retention policy |

- **The document list is marked stale by an SSE event** on save. The UI stops refetching on every sheet open and every `timings.length` change (`frontend/app/page.tsx:1748`).
- **HTML and SVG stay attachments** with `nosniff`. Visualizations keep rendering in the sandboxed iframe.
- **Authorization runs before a cached copy is served**: tenant plus session ownership.
- **Forks** copy files under the same fileId (`file-tools.ts:316-318`). The content is identical, so this is safe because `sessionId` is in the key.

## Layer 8: model-gateway and LLM prompt cache

"Hi" costs about 10,400 input tokens (`backlog.txt:55`) and none of it is cached. Fixing the cache comes first; the rest of this layer stacks on top. Provider numbers below were checked on 2026-10-01 (sources at the end of this section).

### 8.1 Provider prompt caching

| Provider | How it works | Price | Minimum | Truex today |
|---|---|---|---|---|
| Anthropic | Explicit `cache_control` breakpoints (max 4) or top-level auto. Prefix order is tools → system → messages | Write 1.25x (5m TTL) or 2x (1h TTL), read 0.1x | Varies by model (about 1–4K tokens) | Top-level + system breakpoint sent (`adapters/anthropic.ts:48-55`), but 0 cached tokens |
| OpenAI | Automatic exact-prefix match, 128-token steps. `prompt_cache_key` steers routing. Extended retention up to 24h on newer models | Up to 90% off cached input | 1,024 tokens | `prompt_cache_key` dropped (`adapters/chat.ts:32-40`) |
| Gemini | Implicit (automatic) plus explicit `cachedContent` with a TTL | 90% off cached tokens on 2.5+, plus storage per token-hour for explicit | 1,024 (Flash) / 4,096 (Pro) for explicit; implicit hit rates are lower in practice | Reads `cachedContentTokenCount` only (`adapters/gemini.ts:432`) |

- **Zero cached tokens (do first):** the adapter code looks right, so the duckdns proxy is the suspect. Send the same request twice direct to `api.anthropic.com` and twice through the proxy, and compare `cache_read_input_tokens` / `cache_creation_input_tokens`. Fix or bypass the proxy.
- **TTL choice:** use the 1h TTL on the tools + system breakpoint when users typically pause more than 5 minutes between messages. The 2x write pays off after 2 reads. Keep the conversation breakpoint on 5m.
- **Breakpoint layout (Anthropic):** 1 on the last tool, 1 on the stable system block, 1 on the last history message (rolling). Keep the 4th spare. A breakpoint only hits if every byte before it is identical.
- **OpenAI:** forward `prompt_cache_key = hash(tenant, agent, toolsetHash)` so requests sharing a prefix land on the same cache. Don't use the session id; agents with the same setup should share.
- **Gemini:** evaluate explicit `cachedContent` for agents whose stable prefix is above the minimum, keyed by the same prefix hash and reused until it changes. Gemini 2.5 shuts down in October 2026, so test on the replacement model.
- **Bedrock:** if Bedrock is added, it uses the same `cachePoint` / breakpoint model; reuse the 8.2 contract.

### 8.2 Prefix-stability contract

The cache is only as good as the prefix is stable. Make it a rule enforced by tests, not a convention.

- **Fixed order:** platform guardrails → agent persona and role → tools → skills index → conversation history → volatile tail. The system prompt, skills (sorted by name) and dynamic tools are already in a fixed order (`agent-core/src/tenancy.ts:39-41`, `business-runtime.ts:125-129`).
- **Volatile tail only:** the current date, user name, turn context, approval mode and anything per turn goes after the last breakpoint, never inside the system block. Replace any of these in the prefix with a placeholder and put the real value in the tail.
- **Byte-identical serialization:** tools sorted by name, JSON schemas with stable key order, no UUIDs, timestamps, local paths or random ids above the tail. `ToolNames` must map the same tool to the same provider name every turn.
- **Append-only history:** never rewrite earlier messages mid-conversation, except through 8.4 in planned batches.
- **Segment hashes:** the gateway logs a hash per segment (tools, system, skills, history) per request. If `cache_creation` appears mid-conversation, log which segment changed.
- **Mid-thread changes break the cache:** attaching an MCP server, loading a skill, or switching model invalidates everything after that point. Batch them, and prefer appending (a new message) over editing the prefix.

### 8.3 Fewer tool and skill tokens

- **Quick trims** (`backlog.txt:61-65`): `include_permissions_instructions=false` (~970), `skills.include_instructions=false` (~725), shorter workspace tool descriptions (~700–900), workspace tools only for agents that use them (~1,500). Then measure the unlogged ~4,100 tokens.
- **Per-agent tool allow-lists:** an agent gets only the MCP tools it is configured for, not every tool from every attached server.
- **Lazy skills:** an index in the prompt, full bodies fetched with a `read_skill` tool.
- **Lazy tools:** Anthropic tool search with `defer_loading` (only names load up front), or the Truex MCP broker (`find_tools` / `call_tool` plus a few pinned hot tools) for providers without it. Anthropic reports tool definitions can reach 50K+ tokens before the first user message.
- **Code execution with MCP:** the agent writes code that calls tools, so large intermediate results stay out of context. Anthropic's example went from about 150K to about 2K tokens. Longer term, depends on a sandbox.
- **Cache `tools/list`** by MCP server fingerprint, so tool definitions are identical across turns (see the token optimization plan).

### 8.4 Context growth

- **Large tool outputs:** write them to a workspace file and return a reference plus a short preview, with a hard per-result token cap.
- **Context editing:** Anthropic `clear_tool_uses` clears stale tool results above a threshold. Use `clear_at_least` so it clears in large batches; each clear invalidates the cache from that point.
- **Compaction:** summarize old turns on a cheap model once history passes a threshold. Keep `tool_use` / `tool_result` pairs intact.
- **Measure before tuning:** record history tokens per turn so thresholds are based on real conversations.

### 8.5 Response caching (narrow)

- **Exact-match cache** for deterministic side calls (titles, classification, summaries of immutable files), keyed by tenant + model + prompt hash, in Redis.
- **No semantic caching for agent turns.** Turns that call tools or depend on user data can return wrong or another user's answers. If added later, every key includes the tenant and any turn that ran a tool is skipped.

### 8.6 Model routing and batch

- Side tasks (titles, compaction, summaries) go to a small model such as Haiku.
- Offline jobs (evaluations, bulk summaries) use the provider Batch API, about 50% cheaper.

### 8.7 Observability and budgets

- **Per-turn usage:** uncached input, cache read, cache write and output. The Anthropic adapter reads `cacheWrite` (`adapters/anthropic.ts:392,474`) but folds it into input (`:496`), and `cacheWriteInputTokens` in `TokenUsageBreakdown` isn't filled. Pass it through.
- **Hit rate** per agent, tenant and model: `cache_read / (input + cache_read + cache_write)`. Alert when it drops below the baseline mid-conversation.
- **Receipt split:** "Setup (instructions + tools)" vs "Conversation", so "Hi" doesn't look like 10K.
- **Per-tenant token budgets** with soft warnings and hard limits.

### 8.8 Gateway housekeeping

- **Invalidation:** wire the unused `clear()` in `profiles.ts` to Redis pub/sub, with per-id eviction.
- **Client reuse:** reuse one Anthropic client per profile and key (`adapters/anthropic.ts:543`). This is a small gain.

### 8.9 Only if models are self-hosted later

vLLM automatic prefix caching, SGLang RadixAttention, KV cache offloading (LMCache), and prefix-aware load balancing. Not relevant while Truex uses hosted APIs.

### 8.10 Order

1. Fix the proxy and add cache-read / cache-write metrics (8.1, 8.7).
2. Prefix contract and the prefix-stability test (8.2).
3. `prompt_cache_key`, 1h TTL, Gemini explicit cache (8.1).
4. Quick tool and skill trims, per-agent allow-lists (8.3).
5. Lazy skills, tool search / broker (8.3).
6. Large-output offload, context editing, compaction (8.4).
7. Side-call cache and model routing (8.5, 8.6).

### Sources

- [Anthropic prompt caching guide (skills repo)](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md)
- [Claude context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Anthropic: code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [Anthropic: advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [Prompt caching cost multipliers](https://monteiro.hashnode.dev/prompt-caching-anthropic-cut-costs)
- [Volatile fields in system prompts (lean-ctx)](https://gist.github.com/alecchen/7dfbd511193968c38f037a52fb26c2aa)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching/)
- [OpenAI Prompt Caching 201](https://cookbook.openai.com/examples/prompt_caching_201)
- [Azure OpenAI extended retention](https://learn.microsoft.com/en-sg/azure/ai-services/openai/how-to/prompt-caching)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching?authuser=002&lang=python)
- [Vertex AI context cache overview](https://cloud.google.com/vertex-ai/docs/generative-ai/context-cache/context-cache-overview)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini 2.5 shutdown notice](https://firebase.google.com/docs/ai-logic/context-caching)

## Later: CDN and edge

- Put a CDN in front of Next static assets (`/_next/static/*` is already content-hashed) once a public ingress exists. Any proxy must disable buffering and compression for SSE (`README.md:154`).
- Trim the Caveat and Newsreader font weights, or self-host them, to cut the render-blocking Google Fonts CSS (`frontend/app/layout.tsx:9-27`).

## Related (not caching, same goal)

- **Streaming re-renders:** stop each streamed token from re-rendering the whole page.
  - Memoize message blocks by id and text, and hoist `remarkPlugins` (`frontend/components/chat-messages.tsx:379`).
  - Batch `message.delta` updates once per animation frame.
  - Move chat state out of `frontend/app/page.tsx`.
- **Lazy loading:** use `next/dynamic` for SessionActivity, AgentsPanel, McpSettings, AgentDialog and SearchPalette.
- **Compression:** add `compression` middleware to JSON routes on platform and agent-core. Leave it off for SSE.
- **SSE relay:** pass `message.delta` frames straight through the platform relay, and scan the buffer with an index instead of re-slicing it (`platform/src/public.ts:752-790`).

## Invalidation

| Data | Written by | Invalidation |
|---|---|---|
| Agents, agent MCP | `POST /api/agents`, `POST /api/agents/:id/mcp` | Bump `cfg:{tenant}:ver`, publish, clear the frontend key |
| MCP profiles | `POST /api/mcp` | Same as above |
| Models, skills, allow-lists | `scripts/tenant.mjs`, `scripts/demo.mjs`, migrations, direct Mongo writes | Scripts bump `catalog:ver`; 60s TTL as a safety net |
| Tenant status | `scripts/tenant.mjs` | Publish a tenant eviction; 5s TTL as a safety net |
| Gateway profiles, secrets | Profile writes, key rotation | Publish; each gateway pod calls `clear(id)` |
| Documents | `save()` (new id each time) | Content: none needed. List: SSE stale event plus clearing `doclist:*` |
| Sessions list | Create, title, archive | ETag from the newest `updatedAt`; frontend revalidates |
| Completed traces and transcripts | Written once, when the turn or agent finishes | None needed; anything still running isn't cached |

## Flags

| Flag | Layer | Default |
|---|---|---|
| `NEXT_PUBLIC_CLIENT_CACHE` | Frontend app cache | off |
| `REDIS_URL` | Redis (unset = in-process only) | unset |
| `SERVER_CACHE` | Platform L1/L2 read caches and ETags | off |
| `DOCUMENT_CACHE` | Document headers, Redis doc cache, binary streaming | off |
| `POLL_LEASE` | Poller lease (needs `REDIS_URL`) | off |

## Rollout

0. **Measure, then remove repeated work.**
   - Add `Server-Timing` headers and frontend marks, and record a baseline.
   - Apply the Mongo fixes, remove the ingest calls on GET, and stop the duplicate session fetch.
   - Skip `/resume` when the thread is already loaded, and batch the lookups.
1. **Frontend app cache** (Layer 2).
2. **Redis setup:** the shared module, compose and k8s changes, poller lease, pub/sub invalidation, stream write dedupe.
3. **Server read caches and ETags** (Layers 1 and 3, plus the Redis keys).
4. **Document cache** (Layer 7) and the agent-core changes that go with it.
5. **Streaming and render work, and the LLM prompt cache** (Layer 8, in its own order in 8.10), in parallel once Phase 0 numbers are in. The proxy fix in 8.1 can start right away; it doesn't depend on the other phases.
6. **CDN and gateway rate limits**, once a public ingress exists.

## Testing

- **Unit tests** for the cache module:
  - TTL expiry, version-stamp misses, in-flight dedupe
  - circuit-breaker fallback when Redis is down
  - pub/sub eviction
- **Tenant isolation:** the same URL under two tenants must never return the other tenant's data, from L1, from Redis or through an ETag 304.
- **Multi-replica:** run 2 platform replicas in compose. A write on one must be visible on the other within one request with Redis on, and within 5s with it off. Only one replica holds the poll lease.
- **Redis failure:** kill Redis mid-run. Requests must still succeed, just slower.
- **Frontend:** drive the real app in headless Chromium with a mocked API. Checks:
  - a reopened conversation renders with no network wait
  - the MCP list is fetched once across all 3 components
  - a cold start renders from localStorage
- **Prompt prefix stability:** build turn N and turn N+1 of the same conversation and assert the bytes up to the last stable breakpoint are identical, for each adapter. Run it in CI.
- **Prompt cache hit:** the second identical request reports `cache_read > 0` (live check against each provider, not in CI).
- **Before and after:** compare `Server-Timing` and frontend marks for conversation open, time to first token and cold start against the Phase 0 baseline.

## Open decisions

1. **Redis host:** ElastiCache for Valkey or Redis OSS.
2. **Frontend cache:** build a small one ourselves (about 150 lines, no new dependency), or adopt TanStack Query at a pinned version.
3. **localStorage before auth:** agents, sessions and projects would stay readable on a shared machine until login and logout exist.
4. **Year-long document caching:** a browser keeps a file for a year, even after the workspace cleanup job deletes the conversation.
5. **File delete or rename:** the audit found no delete or rename endpoint, but didn't fully confirm it. If one is added, it must clear `doc:*` and drop `immutable` for that route.
