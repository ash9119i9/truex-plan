# Local Docker cache setup

Requested action: start Docker and set up the application's local cache.
Result: **PASS — local cache running and healthy**, left running for development.
This is a follow-up to the earlier native-cache verification, not an AWS or
production deployment certification.

- Started the installed Docker Desktop. Engine: **29.8.0**, ARM64; Compose **5.5.1**.
- Pulled the [official Valkey image](https://hub.docker.com/r/valkey/valkey),
  **9.1.2 Alpine**, and pinned its release digest in
  [compose.cache.yaml](../compose.cache.yaml):
  `sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11`.
- Running service: `truex-plan-cache-valkey-1`, healthy; host endpoint
  `redis://127.0.0.1:6379`, published only on loopback.
- Runs as the image's `valkey` user, with a read-only root filesystem,
  dropped capabilities and no-new-privileges. Container limits: 256 MiB, one CPU,
  64 PIDs. Cache: 64 MiB, `allkeys-lru`, 128 clients; AOF/snapshots disabled;
  data directory is tmpfs. Protected mode is off for Docker bridge forwarding;
  local loopback publishing is the development access boundary.
- Updated only the five cache entries in ignored `platform/.env`: L1/L2 on,
  standalone mode, namespace `truex-plan-local-cache-v1`, and the local endpoint.
  Other environment values were preserved and are not included in this report.
- No platform process was listening on port 4000 during setup. The cache settings
  take effect when that local platform process starts. No application/provider
  or AWS service was invoked. No other container configuration was changed;
  Docker Desktop may resume existing containers with their own restart policies.

## Verification

| Check | Result |
| --- | --- |
| `docker compose -f compose.cache.yaml config --quiet` | PASS |
| `docker compose -f compose.cache.yaml up -d --wait` | PASS, healthy |
| CLI `PING` and server `--version` | PASS, `PONG`, version 9.1.2 |
| Server memory/eviction/persistence config | PASS, matches stated limits |
| Host connectivity through application adapter, Node 24.21.0 | PASS |
| Two independent application cache clients | PASS, second reused L2; source loaded once |
| TTL and remote Pub/Sub invalidation | PASS |
| Compose formatting and `git diff --check` | PASS |

The first host connectivity check correctly caught protected-mode rejection:
Docker's forwarded source is outside the container's loopback. The configuration
was corrected and host adapter checks rerun successfully. Health-only success
was not treated as application connectivity proof. Verification used unique
synthetic keys/channels and deleted only its own key; no `FLUSHALL` occurred.

The earlier application report and candidate manifest remain historical records;
this follow-up changes the operations guide and adds the Compose configuration.
Production TLS/ACL/failover, full application container builds, dependency release
gates, and live model-provider experiments remain outside this local setup.

Manage this cache using the commands in
[APPLICATION_CACHE_OPERATIONS.md](../docs/APPLICATION_CACHE_OPERATIONS.md).
`docker compose -f compose.cache.yaml down` stops this project; losing its entries
requires no database migration or recovery.
