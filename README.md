# Truex agent platform

A TypeScript platform around a **project-local, source-pinned Codex app-server**. Next.js frontend, NestJS platform, Express adapter, MongoDB persistence and SSE streaming. No authentication or multi-tenancy is implemented; use an internal development environment.

## Truex runtime

Truex retains thinking, plans, response timings, streaming, stop/steer, fork,
compact, goals, model settings, collaboration and HTTP MCP tools. The access
policy blocks local shell/file tools and host configuration overrides. Public
responses retain useful agent activity while excluding raw commands, repository
paths, internal configuration and runtime diagnostics. HTTP connectors can be
managed in the Connected tools panel; local stdio launch remains disabled.
Pre-policy conversations are retained but cannot be reopened or resumed.
See [runtime policy, migration and verification](docs/TRUEX_RUNTIME.md).

## Local Codex pin

`codex.lock.json` pins OpenAI Codex revision `4a942885c8b4745757a9f86ad2075e16c42483c5`.

```sh
npm run codex:setup
npm run protocol:gen
```

Setup fetches source into `vendor/codex`, checks its revision and tracked-file cleanliness, and builds `vendor/codex/codex-rs/target/debug/codex` with Cargo's lockfile. Rust and native compiler prerequisites are needed. `.runtime/codex-build.json` records the local binary checksum and build revision. The source directory and build products are ignored by this application's Git configuration and reproduced by setup.

**Neither a global `codex`, `CODEX_BIN`, nor a sibling checkout is used.** The runtime reads its binary location from `codex.lock.json`. The lock and generated protocol inventory are kept alongside the application source. To upgrade, intentionally change the pin, fetch/check out that revision, rebuild, regenerate and run the tests; changing the lock alone is rejected by setup if the checkout differs.

## Install and run

Node 24 and npm are required. Each service has its own lockfile and builds independently. Root commands coordinate them without npm workspaces.

```sh
npm ci
npm run install:all
cp agent-core/.env.example agent-core/.env
cp platform/.env.example platform/.env
cp frontend/.env.example frontend/.env
cp model-gateway/.env.example model-gateway/.env   # optional, see Model gateway
```

Set `MONGO_URI` in `platform/.env`. The database is `truex` (`MONGO_DB=truex`). Configuration is read directly from your existing collections:

| Collection | Configuration |
|---|---|
| `truex_agents` | Agent name, instructions, model reference and MCP references |
| `truex_models` | Provider endpoint, model name and **API key stored in MongoDB** |
| `truex_mcp` | MCP endpoint/command and authentication configuration |

There is no production seed command and no provider API-key or model configuration in `.env`. Manage agents and model profiles in MongoDB. HTTP MCP profiles and agent attachments can also be managed through the Connected tools panel; local command connectors are blocked. The service rereads them per request; ObjectId and string IDs are supported, including string references to ObjectIds. Both `apiKey` and `apikey` credential fields are accepted (the camel-case field takes precedence if both exist). See [MongoDB document examples](docs/mongodb.md).

```sh
npm run dev
```

Open `http://localhost:3000`. The runner refuses occupied service ports and prints the listening process. Each service loads its own `.env`. Session/message state is stored separately in `truex.sessions` and `truex.messages`; the existing `truex_runs` and `truex_conversations` collections are left alone.

## Model gateway

The pinned runtime speaks only the OpenAI Responses API. Providers that don't (Chat Completions-only endpoints such as NVIDIA, Anthropic, Gemini) go through `model-gateway`, a separate service that translates Responses requests to the provider's API and streams the reply back as Responses events. `vendor/codex` is not modified.

| `wireApi` on the `truex_models` profile | Route |
|---|---|
| missing or `responses` | Direct: Codex calls `baseUrl/responses` with the profile key (unchanged behavior) |
| `chat` | Gateway: Chat Completions (`baseUrl/chat/completions`) |
| `anthropic` | Gateway: Anthropic Messages API |
| `gemini` | Gateway: Gemini `streamGenerateContent` |

Optional profile fields: `route` (`gateway` forces a Responses profile through the gateway), `contextWindow`, `autoCompactTokenLimit`, `maxOutputTokens`, `thinking`, and `apiKeySecretArn` (read the key from AWS Secrets Manager instead of `apiKey`).

For gateway profiles the platform never sends the provider key to agent-core. Codex receives the gateway URL `MODEL_GATEWAY_URL/p/<profileId>/v1` and a token signed with `MODEL_GATEWAY_SECRET` that is valid only for that profile. The gateway checks the token, loads the profile and key from `truex_models`, and calls the provider. Tokens do not expire, because Codex keeps a thread's provider config for the life of the thread. Revoke access by disabling the profile (`enabled: false`) or rotating the secret.

Setup: set `MODEL_GATEWAY_URL` and `MODEL_GATEWAY_SECRET` in `platform/.env`, and the same `MODEL_GATEWAY_SECRET` plus `MONGO_URI`/`MONGO_DB` in `model-gateway/.env`. `npm run dev` starts the gateway when `model-gateway/.env` exists and warns if the two secrets differ. Without the gateway configured, gateway profiles fail with a 422 `GATEWAY_NOT_CONFIGURED` error and direct profiles are unaffected. Provider-hosted web search is disabled for non-Responses providers; optional [SearXNG WebSearch](docs/WEBSEARCH.md) and [Crawl4AI WebRead](docs/WEBREAD.md) work through ordinary function tools across supported provider routes.

The platform does not silently change a provider or rewrite database records. Missing sandbox/approval settings default to read-only/never.

Local MongoDB can be started separately with `docker compose -f deploy/compose.yaml up -d mongo` when Docker is running. The repository does not alter unrelated MongoDB data or borrow credentials from other projects.

## Credential-free demo

```sh
npm run demo
```

The demo downloads/starts an isolated MongoDB test process, seeds a **local fixture** profile, starts a simulated Responses API provider and runs all three applications. Codex still runs from this repository's pinned binary. Output is canned; this mode validates integration and UI behavior, not a real model's reasoning or provider performance. Demo data is removed when the runner exits.

If the default ports are occupied:

```sh
DEMO_FRONTEND_PORT=3100 DEMO_PLATFORM_PORT=4200 DEMO_CORE_PORT=4300 npm run demo
```

## Features

- Capabilities, documents & visuals panel for explanations/planning, clarification questions, web research, documents, Visualize, goal tracking and helper-agent collaboration. Project/Git/command execution is excluded.
- [Visualize](docs/VISUALIZE.md): interactive charts, diagrams, simulations and explainers inside replies, with saved source, an expandable viewer, remembered controls, follow-up drafts and sandboxed HTML exports.
- Upload and read PDF, DOCX, XLSX, PPTX and text documents; create downloadable PDF, Word, Excel and PowerPoint files through model-callable tools. Revisions preserve the original and create a new version. See [assistant capabilities](docs/ASSISTANT_CAPABILITIES.md) for limits and provider configuration.
- Mongo-backed agent picker and session list.
- One active turn per thread; overlapping messages serialize into start or steer.
- Stop/steer, streaming, expandable thinking, plans, response timings and business activity; host execution details remain private.
- Bounded event replay, generation-aware cursors, snapshots and slow-subscriber eviction at both SSE layers.
- Business clarification questions, typed response validation and deadlines. Other runtime approval requests are denied automatically.
- Final messages, decisions and completed-turn metrics are written to a small adapter record spool on the Codex volume. Platform consumes and acknowledges these records independently of browser streams. This is a local persistence handoff, not a turn scheduling queue or broker.
- Mongo writes deduplicate records. Message submission requires `clientId`; ambiguous failures are not blindly retried.
- HTTP MCP tools and connector configuration are available; local stdio connectors are rejected.
- Opt-in [Crawl4AI WebRead](docs/WEBREAD.md): read one public page into bounded Markdown with direct citations, retrieval metadata and cancellation. Start a new conversation after enabling; WebCrawl remains planned.
- Opt-in [SearXNG WebSearch](docs/WEBSEARCH.md): provider-independent source discovery with bounded snippets, direct citations, partial-engine warnings and cancellation. Start a new conversation after enabling.
- Per-thread provider and MCP configuration. Concurrent provider-key isolation is tested against the real runtime with local fixtures.
- Lazy same-owner resume with retained runtime/workspace storage and cold-open transcript reconciliation.
- Conversation tools expose fork, compact, goals, model/reasoning settings and archive through a restricted API. Raw schema/configuration and host execution methods remain private.

## Repository

| Path | Purpose |
|---|---|
| `agent-core/` | Child process transport, protocol validation, thread coordination, requests, SSE, persistence handoff |
| `web-service/` | Private Search/Read API, SearXNG adapter and isolated Crawl4AI browser egress |
| `platform/` | MongoDB, profiles, sessions, owner routing, HTTP API and SSE relay |
| `frontend/` | Chat, picker, session list, approvals, events, plans, diffs, timings and capability inspection |
| `shared/` | Contracts plus generated protocol types, schemas and inventory |
| `vendor/codex/` | Independently pinned local Codex source and compiled binary |
| `deploy/` | Compose and Kubernetes deployment templates |
| `docs/protocol.md` | Source-generated protocol inventory and verified limitations |
| `docs/capability-coverage.md` | Per-method implementation surface; runtime coverage remains explicit |
| `docs/VALIDATION.md` | Checks run, evidence and outstanding verification |
| `IMPLEMENTATION_PLAN.md` | Phase checklist with completed work marked |

## Validation

```sh
npm run codex:verify
npm run protocol:gen
npm run build
npm test
npm run format:check
```

The tests include protocol/schema checks, concurrency, request expiry, disk-spool recovery, Mongo idempotency, real Codex streaming and provider-key isolation, and HTTP-level restart recovery. Test provider responses are simulated. A live OpenRouter greeting has also been verified with the user-managed MongoDB profile. Full capability and deployment acceptance are still open; see `docs/VALIDATION.md`.

## Deployment and operations

Build each image with the repository root as its context. The agent-core Dockerfile compiles the vendored Rust source inside the image build; it does not download a global Codex package.

```sh
docker build -f agent-core/Dockerfile -t truex-agent-core:local .
docker build -f platform/Dockerfile -t truex-platform:local .
docker build -f frontend/Dockerfile -t truex-frontend:local .
docker build -f model-gateway/Dockerfile -t truex-model-gateway:local .
```

The model gateway is stateless and scales horizontally. Run it privately next to the platform, reachable from the agent-core runtime but not from the internet (for AWS AgentCore: VPC mode, an internal ALB, and a security group that admits only the runtime subnets). Model calls are long-lived streams, so keep load-balancer idle timeouts at 300 seconds or more and give deployments enough deregistration delay for in-flight streams to finish. Health: `GET /health` (liveness) and `GET /ready` (readiness, fails while draining or when MongoDB is unreachable).

`deploy/kubernetes.yaml` provides stable per-pod DNS and per-pod `/data` PVCs. `/data/codex` and `/data/workspace` must both survive restarts. Configure the `platform-config` Secret's `MONGO_URI`, image registry/tags, storage class and browser-facing platform URL before deployment. The frontend URL is a build-time `NEXT_PUBLIC_PLATFORM_URL` value. No deployment has been applied.

`AGENT_CORE_URLS` enumerates owners eligible for new sessions and existing-session routing. Keep old owner addresses configured while their sessions exist. Adding replicas also requires updating this list. Readiness stops new admission while draining; shutdown waits up to `DRAIN_TIMEOUT_MS` (default 30 seconds) for active turns. The memory/thread resource defaults are provisional, not production sizing evidence.

SSE routes require buffering and compression disabled in any added ingress/reverse proxy, with idle timeouts longer than the 15-second heartbeat. The supplied services expose no public ingress. Apply an appropriate network policy in a cluster with policy enforcement.

Before runtime upgrades, stop admission, drain turns, back up each runtime/workspace volume and MongoDB, and retain the previous images and pin. Validate new storage compatibility against restored copies before rolling out. Do not downgrade a volume whose runtime schema changed without restoring a compatible snapshot. Backups, restores, Kubernetes behavior and container builds have not been exercised in this environment.

### WebCrawl

Native `web_crawl` runs bounded background Crawlee jobs using the isolated Crawl4AI reader. Set `WEB_CRAWL=on` in the service and agent-core environments, rebuild the existing Docker stack, and create a new conversation. Jobs and saved Markdown survive restarts in a private Docker volume. See [WebCrawl setup, limits and testing](docs/WEBCRAWL.md); run `npm run webcrawl:smoke` for a real three-page crawl.
