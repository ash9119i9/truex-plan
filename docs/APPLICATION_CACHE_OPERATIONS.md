# Application cache operations

This guide describes the implemented cache controls and repeatable local checks.
It is not a deployment record or production certification. Architecture and future
work remain in [the implementation plan](APPLICATION_CACHING_PLAN.md); gateway
details are in [model-gateway/CACHING.md](../model-gateway/CACHING.md).

## Controls and current scope

New optional caches start disabled. Set these variables in the owning service's
environment; each local service loads its own `.env`.

| Service       | Variable                   | Default   | Implemented behavior                                                                                                 |
| ------------- | -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| Platform      | `CACHE_L1`                 | `off`     | Bounded local agent/model picker projections; Mongo remains the authority                                            |
| Platform      | `CACHE_L2`                 | `off`     | Optional Valkey reuse of the safe model-picker projection only; requires L1, URL and namespace                       |
| Platform      | `CACHE_METRICS_LOG`        | `on`      | Set `off` to suppress periodic cache counter logs; caching and failure logs remain enabled                           |
| Platform      | `CACHE_NAMESPACE`          | Empty     | Required for L2; use a unique environment/deployment value, never a credential                                       |
| Platform      | `CACHE_URL`                | Empty     | `redis://` locally; `rediss://` mandatory when `NODE_ENV=production`                                                 |
| Platform      | `CACHE_CLUSTER`            | `off`     | Cluster-aware client when `on`; required for ElastiCache Serverless and cluster-enabled deployments                  |
| AgentCore     | `CACHE_RUNTIME_METADATA`   | `off`     | Marker/document metadata and extracted-text caches with authoritative filesystem verification                        |
| Frontend      | `NEXT_PUBLIC_CLIENT_CACHE` | Unset/off | Short-lived metadata query reuse and active-request sharing; current identity is verified through uncached `/api/me` |
| Model gateway | `CACHE_PROVIDER_CONTROLS`  | `off`     | Optional provider fields only when the profile declares supported `promptCache` capabilities                         |

Use `on`/`off`. Platform and frontend trim and compare case-insensitively; runtime
metadata requires exactly `on`. Gateway provider controls additionally accept
`1`/`true`. A cache URL alone does not enable caching. Frontend `NEXT_PUBLIC_*`
values are embedded at build time: rebuild and release the frontend to change
this flag; restarting its existing build does not change it.

Gateway profile/secret caches existed before this work and remain enabled by
default. They now have hard freshness and capacity limits. Positive profiles
default to 30 seconds, missing/keyless profiles to 5 seconds, and resolved secrets
to 5 minutes. Source failure after expiry returns a retryable failure rather than
using expired credentials. `PROFILE_CACHE_TTL_MS=0` and
`SECRET_CACHE_TTL_MS=0` remove positive/secret retention;
`PROFILE_CACHE_MAX_ENTRIES=0` removes all retained profile/secret entries.
Singleflight, lookup deadlines and caller limits still apply. There is no shared
credential cache. See the gateway guide for all tuning variables.

Current bounds are code-owned defaults, not promised process RSS limits:

| Cache                     | Entry/byte limits                                                                                     | Freshness                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Platform L1               | 256 entries, 4 MiB serialized keys/values, 256 KiB per entry; 32 active loads and 256 waiting callers | Agents up to 15s; models up to 30s, with downward jitter                                       |
| Platform L2               | Writes at most 256 KiB per payload; server memory bounded separately                                  | Envelope expiry and Valkey TTL both enforced; L1 cannot extend L2 freshness                    |
| Runtime markers           | 128 entries, 8 MiB retained key/value estimate                                                        | 60s maximum, with fresh file stamps before reuse                                               |
| Runtime document metadata | 64 entries, 4 MiB estimate                                                                            | 30s maximum; directory and metadata-file stamps checked; quota admission bypasses cached lists |
| Runtime extracted text    | 64 entries, 8 MiB estimate                                                                            | 30s maximum; authoritative bytes/editable source are read and hashed before reuse              |
| Browser metadata          | 64 entries, 512 KiB serialized keys/values, 64 KiB values; 16 active cache loads and 256 callers      | General metadata 30s; agents/MCP lists 5s                                                      |

Sessions, transcripts, live context, documents, tool results, approvals, assembled
thread configuration, decrypted connectors, budgets and writer ownership are not
shared-cache values. Browser `/api/sessions/*` GETs remain uncached, with identity checks
and late-result rejection when the client cache flag is enabled. Streams wait for
identity bootstrap and close on identity invalidation; their cursors are scoped.
Widget state stays in memory with this flag enabled. These safeguards add an
identity roundtrip to cold reads/streams; active concurrent checks coalesce.

Platform mutation invalidation clears local values and publishes a best-effort
remote-clear signal. It does **not** delete every L2 value or guarantee immediate
cross-replica freshness; an older display value may survive until its TTL.
Authorization/configuration loads remain authoritative, independent of Pub/Sub.
Enabled platform caches emit bounded numeric `cache.metrics` logs every 30 seconds
unless `CACHE_METRICS_LOG=off`. Restart the platform after changing this setting.
Safe HTTP responses expose `Server-Timing`; operators must connect these to
their log/metrics dashboards and alerts. No cache keys, values or credentials are
included in the periodic record.
Gateway profile writers currently have no cross-process invalidation link;
respect their freshness windows or restart every gateway process after an urgent
credential/model change. Already dispatched provider requests can still finish.

## Local POC setup

First try L1 alone: set `CACHE_L1=on` in `platform/.env`, retain `CACHE_L2=off`, and
restart the platform. Enable runtime/browser caches separately after their checks.
No new cache service is needed for this step.

### Docker cache

The local cache is defined in [compose.cache.yaml](../compose.cache.yaml), using
the official [Valkey image](https://hub.docker.com/r/valkey/valkey), version
**9.1.2 Alpine**, pinned to a release digest. Start Docker Desktop, then run from
the repository root:

```sh
docker compose -f compose.cache.yaml up -d --wait
docker compose -f compose.cache.yaml ps
docker compose -f compose.cache.yaml exec -T valkey valkey-cli ping
```

The endpoint is `redis://127.0.0.1:6379`. The service publishes only on host
loopback, runs as the `valkey` user with a read-only root filesystem and dropped
capabilities, and has a 64 MiB cache budget inside a 256 MiB / one-CPU container.
Persistence is disabled; `/data` uses tmpfs. Health checks expect `PONG`.
`restart: unless-stopped` keeps the cache running across Docker restarts.
Container protected mode is disabled because Docker forwards host connections
from a bridge address. The published host port is explicitly loopback-only;
there is no authentication on this development endpoint. Keep it local.

For a platform process running directly on this development machine, configure
only these entries in `platform/.env` and restart that platform process:

```dotenv
CACHE_L1=on
CACHE_L2=on
CACHE_NAMESPACE=truex-plan-local-cache-v1
CACHE_URL=redis://127.0.0.1:6379
CACHE_CLUSTER=off
```

Stop only this cache project with:

```sh
docker compose -f compose.cache.yaml down
```

This is a local development service. Production application containers require
private TLS connectivity and a container-network address rather than this host
loopback URL. Do not weaken the application's production TLS requirement.

### Native alternative and test fixtures

The native helper uses the repository's `scripts/*.mjs` pattern and requires installed Valkey
**9.1.2** server and CLI binaries, matching the local integration-test engine.
Acquire binaries through the [official release/install sources](https://valkey.io/download/)
and your normal trusted package verification process. The helper performs a
version check; it neither downloads nor cryptographically verifies artifacts.
The local test pin is not an ElastiCache engine-version requirement.

If binaries are outside the existing ignored
`.runtime/cache-tools/valkey/src/` build location, set absolute paths:

```sh
export VALKEY_SERVER_BIN=/absolute/path/to/valkey-server
export VALKEY_CLI_BIN=/absolute/path/to/valkey-cli
node scripts/cache-local.mjs --check
node scripts/cache-local.mjs --port 6379
```

The helper also discovers installed binaries on `PATH` when the local build is
absent. The test fixture uses explicit environment paths or that local build,
so export the paths printed by `--check` before running integration tests.
`--check` exits nonzero if either binary is missing or the version differs.
Do not treat skipped native tests as a successful Valkey validation.

The server binds only `127.0.0.1`, enables protected mode, uses a 64 MiB
`maxmemory` limit with `allkeys-lru`, and disables snapshots/AOF. It runs in a
temporary directory and exits/cleans up on Ctrl-C or SIGTERM. Valkey's memory
limit is not a hard process RSS cap. Every application cache write has a TTL.
Only disposable display data belongs in this instance. Use a separate terminal
for the application, and add these settings to `platform/.env`:

```dotenv
CACHE_L1=on
CACHE_L2=on
CACHE_NAMESPACE=truex-local-poc-cache-v1
CACHE_URL=redis://127.0.0.1:6379
CACHE_CLUSTER=off
```

Use `AUTH_MODE=poc` for the existing deliberate shared POC identity. This is not
an isolation test. Use the existing dev/auth test fixtures to test multiple users.
Start the application using the normal [local setup](../README.md).

The deployed platform POC container uses `NODE_ENV=production`; it rejects this
plaintext cache URL even on loopback. Keep deployed POC L2 off until private TLS
connectivity is provisioned, or configure a properly operated TLS Valkey service.
Do not change `NODE_ENV` to bypass the production TLS check. A host loopback URL
also does not reach a service from another container; provision its actual network
and certificate identity before enabling L2 there.

Stopping this cache loses all entries and should cause authoritative reads. No
Mongo/runtime migration, backup restoration or cache data recovery is necessary.

## Repeatable checks and experiments

Run from the repository root after installing locked dependencies. Native tests
start isolated bounded servers on temporary ports; they do not attach to or flush
your running POC cache. Mongo integration tests use MongoMemoryServer fixtures.

```sh
node scripts/cache-local.mjs --check
npm --prefix platform run test:cache
npm --prefix platform run bench:cache
npm --prefix model-gateway run bench:cache
npm --prefix frontend run cache:benchmark
npm --prefix agent-core run bench:cache
```

| Check                 | What it measures/proves                                                                                                                    | What it does not prove                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Platform native tests | Real GET/SET-with-TTL, Pub/Sub, corruption fallback, paused/blackholed replies, server loss, and local three-primary cluster command paths | AWS TLS, managed failover, real production auth/load                  |
| Platform benchmark    | Real local Mongo fixture and Valkey service reads in disabled/cold/warm L1, empty-L1 warm-L2, and outage modes                             | Production network, AWS cost, full UI/runtime latency                 |
| Gateway benchmark     | Offline synthetic authority timings and origin counts in disabled/cold/warm/outage modes                                                   | Production Mongo/Secrets Manager, live provider TTFT or savings       |
| Frontend benchmark    | Simulated identity/metadata origins with three consumers; origin-call reduction and burst latency                                          | Browser rendering, real authentication/network timings                |
| Runtime benchmark     | Real local marker/filesystem and DOCX/XLSX parser work, off versus warmed cache                                                            | Distributed filesystem behavior, cloud cold starts, model performance |

Record engine/client versions, architecture, dataset, concurrency, p50/p95/p99
where reported, origin count and memory with results. Do not infer end-to-end
speedup from a helper benchmark. Repeat an identical approved workload with flags
off, cold, warm and unavailable. During a local manual outage, stop only the
disposable cache and read the same catalog again; check fallback latency/error
rate and Mongo load, then restore the helper and check recovery. There is no
automatic safe-to-run outage against an existing remote environment.

Run regression/build checks for changed paths before release:

```sh
npm --prefix platform test
npm --prefix platform run build
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix model-gateway test
npm --prefix model-gateway run build
npm --prefix agent-core test
CACHE_RUNTIME_METADATA=on npm --prefix agent-core test
npm --prefix agent-core run build
```

The provider probe is a separate gate. Its default is an offline dry run:

```sh
npm --prefix model-gateway run probe:cache
```

An explicitly authorized `-- --live` run makes two billable synthetic requests
with `PROBE_GATEWAY_URL`, `PROBE_PROFILE_ID` and `PROBE_GATEWAY_TOKEN`. Supply
approved non-production credentials privately; do not commit or echo them.
Verify endpoint/model capability and retention before turning on profile controls.
Read/write token counters and stable prefix reuse are evidence; headers latency
alone is not necessarily time to first token. Missing counters remain unknown.

## Production AWS requirements and release gates

Use managed ElastiCache for Valkey when measured cross-process reuse justifies
L2. Choose Serverless for uncertain traffic or node-based primary/replica capacity
for predictable usage and configuration control. Serverless requires a TLS,
cluster-capable client; its managed topology spans Availability Zones. For
node-based use a replica in another AZ and configure automatic failover/Multi-AZ.
Choose region-specific pricing from measured storage/request/connection volume;
no fixed monthly cost or fastest-engine claim is established here.
[AWS deployment choices](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.deployment.html).

Serverless uses fixed `volatile-lru`, so keep TTLs on all entries. It does not
support keyspace notifications. Use its primary port 6379 initially; port 6380
supports eventual replica reads. Pub/Sub clearing remains a latency aid rather
than correctness. Node-based configuration depends on the selected parameter
group. [AWS engine configuration](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/RedisConfiguration.html).

Use private endpoints, TLS verification, encryption at rest, deployment-specific
namespaces, and a dedicated least-privilege cache user. Provision subnet/security
group routes from the platform and allow the actual selected-client handshake,
cluster topology, GET, SET-with-expiry and Pub/Sub commands/channels. Test ACLs
against the pinned `@redis/client` 6.3.0 adapter; do not guess a command allowlist.
Keep URLs/credentials out of logs and browser environment variables. Serverless
may offer public endpoints on newer engines, but this application plan requires
private access.

Only the platform currently connects to L2. AgentCore and gateway caches are
process-local. If a later runtime feature needs private cache access, configure
AgentCore VPC subnets/security groups and required egress explicitly; a cache URL
or public subnet does not provide connectivity.
[AgentCore VPC requirements](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html).

The following remain release gates until measured in the target environment:

- Private DNS, TLS/certificate/ACL behavior, two platform replicas and the selected
  ElastiCache cluster mode on the real endpoint.
- Managed failover, rolling replacement, missed invalidation, eviction/memory
  pressure and reconnect behavior with bounded source traffic.
- Cold/warm/outage API p95/p99, Mongo reads/load, event-loop lag/RSS and concurrent
  authenticated user/tenant isolation. Verify runtime admission/quota checks and
  persist-before-stream delivery independently.
- Live model eligibility, cache read/write accounting, stable prefixes, provider
  retention and cost. Direct Responses routes bypass optional gateway controls.
- Instance/runtime/container release, frontend rebuild, canary observation and
  flag-disabled rollback. Local mocks and native cluster tests do not close these
  AWS/provider gates.

## Rollout, monitoring and rollback

Roll out one flag/resource at a time: disabled baseline, local/non-production,
small canary, then broader release. Enable L1 before L2. Use a unique namespace
for incompatible display schemas or separate environments; there is no cache
schema migration. Preserve Mongo and native runtime state through rollback.

Observe API `Server-Timing` (`app`, `mongo`, `cache`) and retryable source/capacity
errors, bounded cache connection/command warnings, cache hit/miss/eviction and
entry/byte counts where available, Valkey memory/evictions/connections, and Mongo
read pressure. Gateway access lines carry provider cache read/write token counts.
Some counters currently exist only in process objects/tests; there is no deployed
Prometheus dashboard or complete alert/export pipeline supplied by this change.
Do not put raw keys, user IDs, prompts, credential URLs or tenant-specific data in
high-cardinality metric labels.

If latency/errors or source load regress, set `CACHE_L2=off` first and restart all
platform replicas. Set `CACHE_L1=off` to disable both read/write retention locally;
also set L2 off, because L2-on with L1-off is a startup error. Disable
`CACHE_RUNTIME_METADATA` and restart runtime processes to discard derived values.
Turn provider controls off and restart gateways; existing provider entries may
remain until provider expiry. Rebuild/release the frontend with
`NEXT_PUBLIC_CLIENT_CACHE=off`. Hard refresh affected browser tabs after release.

Flag changes do not undo all code changes: privacy headers, gateway strict
freshness and frame serialization/snapshot improvements remain. Roll back the
application artifact if those behaviors themselves regress. Avoid restoring the
old gateway's long expired-credential fallback as an incident shortcut.
No `FLUSHALL` is required. Stop/remove only a dedicated disposable local instance
after disabling users of it; never clear unrelated data on a shared service.

After any release/rollback, check a catalog read, authenticated session open,
stream delivery/reconnection and an approved ordinary document read. Compare
latency/errors and Mongo/runtime/provider calls to the same baseline window.
A successful deployment alone is not evidence of improved performance.
