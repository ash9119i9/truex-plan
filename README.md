# Truex agent platform

A TypeScript platform around a **project-local, source-pinned Codex app-server**. Next.js frontend, NestJS platform, Express adapter, MongoDB persistence and SSE streaming. No authentication or multi-tenancy is implemented; use an internal development environment.

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
```

Set `MONGO_URI` in `platform/.env`. The database is `truex` (`MONGO_DB=truex`). Configuration is read directly from your existing collections:

| Collection | Configuration |
|---|---|
| `truex_agents` | Agent name, instructions, model reference and MCP references |
| `truex_models` | Provider endpoint, model name and **API key stored in MongoDB** |
| `truex_mcp` | MCP endpoint/command and authentication configuration |

There is no production seed command and no provider API-key or model configuration in `.env`. Add or update these documents yourself. The service rereads them per request; ObjectId and string IDs are supported, including string references to ObjectIds. Both `apiKey` and `apikey` credential fields are accepted (the camel-case field takes precedence if both exist). See [MongoDB document examples](docs/mongodb.md).

```sh
npm run dev
```

Open `http://localhost:3000`. The runner refuses occupied service ports and prints the listening process. Each service loads its own `.env`. Session/message state is stored separately in `truex.sessions` and `truex.messages`; the existing `truex_runs` and `truex_conversations` collections are left alone.

The pinned runtime accepts only `wireApi: "responses"`; profiles declaring `chat` receive a clear 422 configuration error. The platform does not silently change a provider or rewrite database records. A missing `wireApi` defaults to `responses`; missing sandbox/approval settings default to read-only/never.

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

- Mongo-backed agent picker and session list.
- One active turn per thread; overlapping messages serialize into start or steer.
- Stop control, token streaming, reasoning, plan/diff panels and runtime event inspection.
- Bounded event replay, generation-aware cursors, snapshots and slow-subscriber eviction at both SSE layers.
- Runtime-request cards, typed response validation, deadlines, automatic denial and audit records. Non-approval request variants accept their schema-specific responses.
- Final messages, decisions and completed-turn metrics are written to a small adapter record spool on the Codex volume. Platform consumes and acknowledges these records independently of browser streams. This is a local persistence handoff, not a turn scheduling queue or broker.
- Mongo writes deduplicate records. Message submission requires `clientId`; ambiguous failures are not blindly retried.
- Per-thread provider and MCP configuration. Concurrent provider-key isolation is tested against the real runtime with local fixtures.
- Lazy same-owner resume with retained runtime/workspace storage and cold-open transcript reconciliation.
- Per-turn timing panel and a schema-driven capabilities console. All 152 inventoried client requests are represented; lifecycle methods use dedicated endpoints. Backend-gated methods may return explicit unsupported errors. The console is not a completed bespoke UI for every capability.

## Repository

| Path | Purpose |
|---|---|
| `agent-core/` | Child process transport, protocol validation, thread coordination, requests, SSE, persistence handoff |
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
```

`deploy/kubernetes.yaml` provides stable per-pod DNS and per-pod `/data` PVCs. `/data/codex` and `/data/workspace` must both survive restarts. Configure the `platform-config` Secret's `MONGO_URI`, image registry/tags, storage class and browser-facing platform URL before deployment. The frontend URL is a build-time `NEXT_PUBLIC_PLATFORM_URL` value. No deployment has been applied.

`AGENT_CORE_URLS` enumerates owners eligible for new sessions and existing-session routing. Keep old owner addresses configured while their sessions exist. Adding replicas also requires updating this list. Readiness stops new admission while draining; shutdown waits up to `DRAIN_TIMEOUT_MS` (default 30 seconds) for active turns. The memory/thread resource defaults are provisional, not production sizing evidence.

SSE routes require buffering and compression disabled in any added ingress/reverse proxy, with idle timeouts longer than the 15-second heartbeat. The supplied services expose no public ingress. Apply an appropriate network policy in a cluster with policy enforcement.

Before runtime upgrades, stop admission, drain turns, back up each runtime/workspace volume and MongoDB, and retain the previous images and pin. Validate new storage compatibility against restored copies before rolling out. Do not downgrade a volume whose runtime schema changed without restoring a compatible snapshot. Backups, restores, Kubernetes behavior and container builds have not been exercised in this environment.
