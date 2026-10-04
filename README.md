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

Setup: set `MODEL_GATEWAY_URL` and `MODEL_GATEWAY_SECRET` in `platform/.env`, and the same `MODEL_GATEWAY_SECRET` plus `MONGO_URI`/`MONGO_DB` in `model-gateway/.env`. `npm run dev` starts the gateway when `model-gateway/.env` exists and warns if the two secrets differ. Without the gateway configured, gateway profiles fail with a 422 `GATEWAY_NOT_CONFIGURED` error and direct profiles are unaffected. Codex's built-in web search is disabled for non-Responses providers.

### Model gateway container

Build from the repository root. On the ARM64 EC2 instance:

```sh
docker buildx build --platform linux/arm64 --load \
  -f model-gateway/Dockerfile -t truex-model-gateway:local .

docker run -d --name truex-model-gateway --restart unless-stopped \
  --init --stop-timeout 45 \
  --env-file model-gateway/.env -e HOST=0.0.0.0 -e PORT=4200 \
  -p 127.0.0.1:4200:4200 truex-model-gateway:local

curl --fail http://127.0.0.1:4200/ready
```

The image compiles TypeScript and includes production dependencies and the shared token implementation. It runs as the `node` user and checks `/ready`, including MongoDB connectivity. The Dockerfile-specific build context excludes credentials, local dependencies and Codex artifacts; supply settings with `--env-file` at startup. Set `MONGO_URI` to a database reachable from the container; `127.0.0.1` inside the container refers to the container itself.

The command binds port 4200 to the EC2 host's loopback address for an HTTPS reverse proxy on that host. Configure the proxy to forward to `http://127.0.0.1:4200`, preserve streaming (disable response buffering) and allow long model responses. Set `MODEL_GATEWAY_URL` in `platform/.env` to the reachable HTTPS base URL, restart the platform and create a new conversation. Its signing secret must match the gateway's. For an internal load balancer, publish the port on the appropriate interface and restrict its security group to the load balancer.

The platform does not silently change a provider or rewrite database records. Missing sandbox/approval settings default to read-only/never.

Run MongoDB separately or use an existing MongoDB instance, and point `MONGO_URI` at it. The repository does not alter unrelated MongoDB data or borrow credentials from other projects.

## Platform container

Build the platform backend from the repository root on EC2. The build uses the instance's native architecture (AMD64 or ARM64):

```sh
docker buildx build --load \
  -f platform/Dockerfile -t truex-platform:local .

docker run -d --name truex-platform --restart unless-stopped \
  --init --stop-timeout 15 \
  --env-file platform/.env -e HOST=0.0.0.0 -e PORT=4000 \
  -p 127.0.0.1:4000:4000 truex-platform:local

curl --fail http://127.0.0.1:4000/livez
```

The image compiles the backend and shared code, includes production dependencies, and runs as the `node` user. Supply configuration at startup; `.env` files and local build artifacts are excluded from the build context.

For this AgentCore deployment, set `AGENTCORE_RUNTIME_ARN`, a reachable `MONGO_URI`, `MONGO_DB`, `MODEL_GATEWAY_URL`, the matching `MODEL_GATEWAY_SECRET`, and your deployed `FRONTEND_ORIGIN` in `platform/.env`. Set `AUTH_MODE=poc` for this POC. The image defaults to that mode and keeps `NODE_ENV=production`. Google sign-in, invitation lookup, admin login and the admin API are disabled; Google and Resend keys can be removed from the environment.

POC mode uses one shared user (`DEV_USER_ID=dev-user`, `DEV_USER_ROLE=admin` by default) and one tenant (`DEV_TENANT_ID=default` by default), preserving the existing POC conversation ownership. It ignores client user, role and tenant override headers. All five testers share this identity and its conversations. Existing environments with `AUTH_MODE=dev` or `google` must be changed to `poc` for this deployment.

The Google/invitation implementation remains available through `AUTH_MODE=google` for a later authenticated deployment. That mode still requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FRONTEND_ORIGIN`, and a `RESEND_API_KEY` when `NODE_ENV=production`.

Attach an EC2 instance role with `bedrock-agentcore:InvokeAgentRuntime` permission for the configured runtime. The AWS SDK reads that role's credentials at runtime; set the [EC2 metadata response hop limit](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html) to 2 for Docker access. The image contains no AWS credentials. Configure an HTTPS reverse proxy to `http://127.0.0.1:4000`, disable response buffering for SSE, and allow at least 180 seconds for cold AgentCore requests. The frontend runs separately.

The container health check uses `/livez` to check the platform process without repeatedly invoking AgentCore. Use `/healthz` separately to verify MongoDB and AgentCore connectivity.

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
- Per-thread provider and MCP configuration. Concurrent provider-key isolation is tested against the real runtime with local fixtures.
- Lazy same-owner resume with retained runtime/workspace storage and cold-open transcript reconciliation.
- Conversation tools expose fork, compact, goals, model/reasoning settings and archive through a restricted API. Raw schema/configuration and host execution methods remain private.

## Repository

| Path | Purpose |
|---|---|
| `agent-core/` | Child process transport, protocol validation, thread coordination, requests, SSE, persistence handoff |
| `platform/` | MongoDB, profiles, sessions, owner routing, HTTP API and SSE relay |
| `frontend/` | Chat, picker, session list, approvals, events, plans, diffs, timings and capability inspection |
| `shared/` | Contracts plus generated protocol types, schemas and inventory |
| `vendor/codex/` | Independently pinned local Codex source and compiled binary |
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

The tests include protocol/schema checks, concurrency, request expiry, disk-spool recovery, Mongo idempotency, real Codex streaming and provider-key isolation, and HTTP-level restart recovery. Test provider responses are simulated. A live OpenRouter greeting has also been verified with the user-managed MongoDB profile. Full capability acceptance is still open; see `docs/VALIDATION.md`.

## Local runtime state

`npm run dev` starts the services as local Node processes. `CODEX_HOME` and `AGENT_WORKSPACE` retain runtime history and conversation files across restarts; keep these directories and MongoDB data when stopping the app.

`AGENT_CORE_URLS` lists the local runtime addresses used for session ownership. Existing sessions stay attached to their recorded owner. Readiness stops new admission while draining; shutdown waits up to `DRAIN_TIMEOUT_MS` (default 30 seconds) for active turns.

## Bedrock AgentCore image

The root `Dockerfile` builds the pinned Codex executable for Linux ARM64, then packages Codex, agent-core and the AgentCore HTTP entrypoint. The separate `model-gateway/Dockerfile` packages the gateway for EC2 or another container host. Frontend, platform and MongoDB run separately. The runtime image does not include model-gateway source or dependencies.

Build the reusable binary first, then the runtime image:

```sh
npm run codex:artifact
node scripts/codex-artifact.mjs verify .runtime/agentcore/codex .runtime/agentcore/codex.json codex.lock.json
npm run agentcore:build
```

The artifact target cross-compiles on the builder's native architecture and exports `.runtime/agentcore/codex` plus a manifest containing its source revision, architecture and SHA-256. It fetches the exact source in `codex.lock.json`; it does not reuse the host's x86-64 debug binary. Application image builds verify that artifact and do not rebuild Rust. Keep the artifact and rebuild it when the Codex pin changes. Cargo caches persist on the same Docker builder. Use `--build-arg CODEX_BUILD_JOBS=1` if the builder has limited memory. Image builds require an ARM64 builder or ARM64 emulation support.

To reuse a binary built natively on an ARM64 Linux host with `node scripts/codex.mjs --build`, package it before building the image:

```sh
install -D -m 0755 vendor/codex/codex-rs/target/debug/codex .runtime/agentcore/codex
node scripts/codex-artifact.mjs create .runtime/agentcore/codex .runtime/agentcore/codex.json codex.lock.json vendor/codex
npm run agentcore:build
```

The runtime uses Debian Trixie with glibc 2.41 to support binaries built on Ubuntu 24.04 with glibc 2.39. Architecture and checksum verification run before packaging; the image build also executes `codex --version` to check shared-library compatibility.

On an x86-64 Linux host whose default builder cannot run ARM64 processes, use an isolated BuildKit builder for the image:

```sh
docker buildx create --name truex-agentcore-builder --driver docker-container --bootstrap
BUILDX_BUILDER=truex-agentcore-builder npm run agentcore:build
```

The container exposes `0.0.0.0:8080` with `GET /ping` and `POST /invocations`, as required by the [AgentCore HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html). It starts internal services on the first valid invocation because [AgentCore filesystem mounts are available at invocation time](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html), rather than during container initialization.

For a direct Responses provider, no gateway configuration is needed. For gateway-backed profiles, deploy model-gateway as a shared private service reachable from AgentCore. Configure the platform with that service's `MODEL_GATEWAY_URL` and a matching `MODEL_GATEWAY_SECRET` (at least 32 characters). Use a reachable hostname, not `127.0.0.1`; a private endpoint requires appropriate AgentCore VPC connectivity. The platform passes the gateway URL and a scoped access token in each thread's model configuration.

Configure `MODEL_GATEWAY_SECRET`, `MONGO_URI`, `MONGO_DB` and optionally `CATALOG_MONGO_DB` on the separate gateway service. Set its `HOST=0.0.0.0` and `PORT=4200` when serving requests through a private network endpoint. Do not put the gateway signing secret or database credentials in the AgentCore runtime environment. Provider keys remain in MongoDB or Secrets Manager. Secrets and local `.env` files are excluded from the image build context.

The runtime starts only agent-core and checks only local core health. A gateway outage surfaces when a model request uses the gateway; it does not prevent the runtime from starting or handling other local operations.

Invocation payloads wrap local runtime operations:

```json
{"method":"POST","path":"/threads","body":{"model":"your-model","modelProvider":"your-provider","config":{}}}
```

JSON responses preserve the local HTTP status inside `{ "status": 201, "body": { ... } }`. To subscribe to a thread, invoke `{ "method": "GET", "path": "/threads/<id>/events", "cursor": "<last-event-id>" }`; the response streams SSE frames and closes after 55 minutes for reconnection. Unsupported paths are rejected.

Reuse the same AgentCore `runtimeSessionId` for all operations in a conversation. Configure persistent storage at `/mnt/state`; `CODEX_HOME` and `AGENT_WORKSPACE` point there. The image alone does not persist data across session termination. Managed session storage also resets on runtime version changes; choose storage and backups to match the required retention.

To run the frontend, platform and model-gateway locally while invoking Codex on Bedrock, configure `platform/.env`:

```env
AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:502055890667:runtime/truex_codex-Z4fv9HDC8F
MODEL_GATEWAY_URL=https://your-reachable-gateway.example.com
```

Keep the existing shared `MODEL_GATEWAY_SECRET` and MongoDB settings. The gateway URL must be reachable from AgentCore; a gateway on the developer laptop's `127.0.0.1` cannot receive requests from AWS. Private gateway endpoints require AgentCore VPC connectivity. Gateway-backed profiles with a loopback gateway URL are rejected before starting a conversation.

Authenticate with AWS (`aws login` for local console credentials, or configure a role/profile), then run `npm run dev`. When `AGENTCORE_RUNTIME_ARN` is configured, the launcher starts platform, frontend and model-gateway (when its `.env` exists), and the platform invokes the remote runtime using the AWS SDK. Each new conversation stores an `agentCoreSessionId` in MongoDB; creation, resume, messages, event streams and background ingestion reuse it. Streaming reconnects forward the event cursor. JSON envelopes preserve agent-core's original status and errors. AWS credentials stay in the platform process.

Existing conversations keep their original runtime owner. Start a new conversation after switching from local HTTP to Bedrock; old local conversations are not moved into the remote runtime. The direct HTTP transport remains available when `AGENTCORE_RUNTIME_ARN` is unset. Building the image does not publish anything to AWS.

After deploying the image, test the runtime using AWS CLI v2 and Node:

```sh
npm run agentcore:test -- arn:aws:bedrock-agentcore:us-east-1:502055890667:runtime/truex_codex-Z4fv9HDC8F
```

The script calls `InvokeAgentRuntime` with JSON operation envelopes, starts Codex through `/healthz`, verifies the deployed revision against `codex.lock.json` and writable storage, checks `/capabilities`, then repeats health in the same runtime session. It exits nonzero on a failed check and saves requests, responses and a summary under `.runtime/agentcore-tests/<session-id>/`. Pass a session ID as a second argument to reuse a session. AWS CLI uses your configured credentials (or `AWS_PROFILE`); the caller needs `bedrock-agentcore:InvokeAgentRuntime` permission on the runtime. This smoke test does not call a model or test model-gateway connectivity.
