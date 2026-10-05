# Application cache implementation and verification

Date: 2026-10-06, Asia/Kolkata. Baseline: `application-caching`, commit `e44b79e`.
Requested stage: local implementation and verification; no push or deployment.
Release verdict: **BLOCKED for release certification**; application caching is implemented and locally verified. Required checklist, dependency and deployed-environment gates below remain outstanding. This verdict applies to the recorded uncommitted snapshot, not merely the baseline commit.

Candidate identity and file digests: [snapshot manifest](2026-10-06-application-cache-evidence/candidate-manifest.json). The unrelated pre-existing `docs/SAP_OPPORTUNITY_PRIORITIES.md` is excluded and untouched. No vendor/Codex changes or destructive database migration were made.

## Result and architecture

Three GPT-6.1-Sol agents implemented and independently cross-reviewed the frontend, model gateway and AgentCore slices; the root agent implemented platform L1/L2, HTTP policy, ingestion coalescing and real cache integrations. The [AGENTS.md](../AGENTS.md) workflow was applied: inspect, define behavior, simplify, implement, break, measure, repair and review the final diff.

- Platform caches only public picker projections, scoped by environment, catalog/database, tenant, current principal/role and policy lists. Agents use L1; models can use optional Valkey. Permissions and assembled runtime configuration remain authoritative.
- Same-session ingestion shares active work while preserving Mongo persistence before acknowledgement. No retained ingestion result, lease or durable cursor lives in the cache.
- Frontend metadata reuse is memory bounded. `/api/me` is verified on each eligible read, sharing concurrent active work only. Identity generations fence late responses, streams, widgets, logout, background-focus changes and account cycles. Private content is not persisted by the new cache.
- Gateway profiles and secrets have bounded retention, strict expiry, independent source reservations, caller admission, deadlines and invalidation fences. Expired authority/credentials cannot be dispatched after a refresh failure. Provider controls require an operator flag and supported profile capability.
- AgentCore verifies authoritative filesystem state before using derived marker/list/text results. Quota admission bypasses cached lists. Event serialization is reused without changing durable-write ordering.

New optional caches default **off**. Provider prompt caching is distinct from Valkey. Operations, controls, actual bounds and rollback are in [APPLICATION_CACHE_OPERATIONS.md](../docs/APPLICATION_CACHE_OPERATIONS.md); future conditional scope remains in [APPLICATION_CACHING_PLAN.md](../docs/APPLICATION_CACHING_PLAN.md).

## Verification matrix

Tests ran against Node **24.21.0**, macOS ARM64, MongoMemoryServer's real MongoDB process and native **Valkey 9.1.2** built from the official release. The selected client is pinned `@redis/client` **6.3.0**. Dependency scans used npm **11.19.0**. Native Valkey was built without TLS; TLS and managed failover are not validated by these tests.

| Gate | Result | Command / evidence |
| --- | --- | --- |
| AgentCore build | PASS | Explicit Node24 `node_modules/typescript/bin/tsc`, in `agent-core`; exit 0 |
| AgentCore default tests | PASS | Explicit Node24 `node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 test/*.test.ts`; **182/182**, no skips |
| AgentCore cache-enabled tests | PASS | Same command with `CACHE_RUNTIME_METADATA=on`; **182/182**, no skips |
| Model gateway build/tests | PASS | Explicit Node24 tsc and tsx test commands in `model-gateway`; **74/74**, exit 0, no skips |
| Platform build | PASS | Explicit Node24 tsc in `platform`; exit 0 |
| Platform default tests | PASS | `CACHE_L1=off`, explicit Node24 tsx with Node24 PATH, `--test-concurrency=2`; **164/164**, exit 0, no skips |
| Platform cache-enabled full suite | PASS | `CACHE_L1=on`, explicit Node24 tsx, `--test-concurrency=1`; **163/163**, no skips; followed by the final monotonic-clock regression and full cache integration suite |
| Final cache integrations | PASS | Explicit Node24 `tsx --test platform/test/cache*.test.ts`; **17/17**, no skips, includes standalone, three-primary cluster, timeout recovery and Pub/Sub |
| Frontend tests/typecheck | PASS | Explicit Node24 test runner and `tsc --noEmit` in `frontend`; **209/209**, exit 0 |
| Frontend builds | PASS | Explicit Node24 Next build, default and `NEXT_PUBLIC_CLIENT_CACHE=on`; routes compiled, exit 0; generated tracked file restored |
| Independent frontend lifecycle review | PASS | **28/28** focused tests and separate bootstrap/account-cycle/focus race harness |
| Codex pin verification | PASS | `npm run codex:verify`; pinned revision `4a942885c8b4745757a9f86ad2075e16c42483c5`; exit 0 |
| Changed cache code formatting/diff | PASS | Targeted Prettier checks and `git diff --check`; no new formatting warning |
| Whole-repository formatting | FAIL, pre-existing | `npm run format:check` exits 1 on **59** baseline files; comparing those exact files against HEAD reproduced the warnings. Existing unformatted ownership test received only the explicit index-wait correction |
| Literal credential scan/manual review | PASS within scope | Changed/new candidate files scanned for provider/GitHub/AWS token and private-key literals; no findings. Manual review of cache values, logs, error handling and probe output. No approved comprehensive secret scanner supplied |
| Dependency audit | FAIL, pre-existing | `npm audit --omit=dev --json` in all four components; platform **2 high**, frontend **1 critical**, core/gateway **0**. Exact affected versions already exist at HEAD; no cache-client advisory was reported |
| Required release checklist | UNVERIFIED | `PRE_PUSH_CHECKLIST.md` absent from repository and searched ancestors. No substitute checklist used |
| Docker/ARM64 image and real Bedrock runtime | UNVERIFIED | Docker daemon unavailable; native runtime integration is not a deployed AgentCore container test |
| AWS TLS/ACL/HA, failover, cold-start and fallback sizing | UNVERIFIED | No infrastructure provisioned, live AWS traffic or failover exercised |
| Live provider cache-hit/cost/TTFT experiment | UNVERIFIED | Probe dry run reports **0 network calls**; no billable provider experiment performed |
| Remote CI, push, PR, deployment | N/A | Not requested or performed |

Passing detailed local logs remain in `/tmp/truex-final-*`; sanitized benchmark/audit artifacts are preserved beside this report. Tests intentionally log injected failures and terminated runtime children; those messages are not hidden. Early simultaneous Node24 runtime suites hit initialization timeouts; both full serial reruns passed without changing code, assertions or timeouts. A simultaneous Mongo fixture/benchmark run also collided on an ephemeral port; the final run removes that contention. A first cache-enabled suite failed two immediate-display assertions after direct DB writes; tests now explicitly assert bounded display TTL **and immediate authority rejection**, then original unknown-profile behavior at expiry. An ownership index assertion now awaits the existing background index build instead of relying on network delay.

Completed command records (working directory, completion timestamp, exit code and log digest): [gate records](2026-10-06-application-cache-evidence/gate-records.json). The explicit `test:cache` command fails if its real Valkey binary is absent, rather than passing with skipped integrations. Default tests retain optional-fixture behavior for development without Valkey.

## Measured evidence

Measurements below are local fixtures, not production latency, cloud savings or universal scalability claims. Final benchmarks were run sequentially under explicit Node24. Latency comparison includes each benchmark's stated work/assertion costs. JSON artifacts preserve p50/p95/p99 where the harness reports them.

| Workload | Disabled p95 | Cached p95 | Source effect |
| --- | --- | --- | --- |
| Real Mongo catalog service, warm L1 | 12.704 ms | 0.663 ms | **512 → 0** Mongo commands per 128 catalog pairs, concurrency 8 |
| Same service, cold L1 batches | 12.704 ms | 3.187 ms | **512 → 64** commands through active miss coalescing |
| Same service, warm L2 with cleared L1 per batch | 12.704 ms | 2.180 ms | 48 Mongo commands; shared models reused 16 times, agents remain L1-only |
| Same service, Valkey outage with cleared L1 | 12.704 ms | 2.801 ms | 64 Mongo commands; identical results and authoritative disabled-model rejection |
| Filesystem marker parsing | 0.086 ms | 0.005 ms | Fresh file stat still performed |
| 50-file metadata list | 0.857 ms | 0.292 ms | Metadata JSON reuse; authoritative manifest checks retained |
| DOCX extraction | 0.962 ms | 0.129 ms | Authoritative bytes/hash still checked |
| XLSX extraction | 15.338 ms | 0.129 ms | Authoritative bytes/hash still checked |
| Synthetic gateway profile authority, warm | 2.756 ms | 0.059 ms | 112 → 0 synthetic authority calls; **400/400** expired-cache outage requests rejected |
| Synthetic browser helper, warm burst | 10.670 ms | 3.170 ms | 60 → 1 metadata origin calls; 20 fresh identity checks retained |

Artifacts: [platform](2026-10-06-application-cache-evidence/platform-benchmark.json), [runtime](2026-10-06-application-cache-evidence/runtime-benchmark.json), [gateway](2026-10-06-application-cache-evidence/gateway-benchmark.json), [frontend](2026-10-06-application-cache-evidence/frontend-benchmark.json).

The local catalog hypothesis (>50% source reduction and >20% p95 improvement) is met. L1/coalescing supply most of this gain; keep deployed POC L2 disabled until cross-replica reuse and private TLS justify its operating cost. Cold browser reads incur identity-check overhead (13.33 ms in the synthetic cold fixture versus 10.67 ms disabled); the security/freshness check is intentionally retained. No user send/open TTFT, AWS invocation reduction, production peak, event-loop lag, CPU profile or regional monthly-cost claim is established.

A T3 collaborative-browser smoke used an isolated real POC platform/Mongo fixture and cache-enabled Next development build: application rendered, agent/model pickers loaded, current identity requests occurred, and browser local/session storage remained empty during the fixture. Snapshot capture intermittently failed; DOM evaluation and focused clicks worked. This is not Google-account switching or deployed authentication E2E.

## Break Mode findings and repairs

| Failure reproduced | Protection verified |
| --- | --- |
| Expired profile dispatched from an hour-long stale fallback | Strict expiry; safe retryable source failure; no expired dispatch |
| Thousands of hot-key callers behind one pending loader | Independent waiter limits, retained running-work accounting after invalidation, retryable capacity errors |
| Loader completes after mutation/clear/shutdown | Generation/token fences prevent local and shared refill |
| Written Redis command never returns a reply | Real end-to-end deadline destroys both connections and falls back; recovery re-subscribes |
| Pub/Sub reconnect adds duplicate callbacks | Stable callback; real recovery test failed before repair and passes after |
| Initial stream has no verified identity; delayed `/me` and Alice→Bob→Alice private response | Unified active identity verification, epoch fences, bootstrap/cancel guards and checks before every stream callback |
| Account changes while backgrounded without BroadcastChannel | Focus clears private views synchronously, verifies authority and restores streams only for the same identity |
| Missing/corrupt/deleted file metadata, changed parser source and simultaneous quota admission | Source verification on cache hits; authoritative quota reads inside existing serialized writes |
| Failed ingestion persistence, duplicate events and simultaneous ingestion | Persist-before-ack unchanged; singleflight never retains success across calls |
| Wall clock moves backward after L1 admission | Monotonic deadline additionally bounds local lifetime; L2 wall expiry still checked |

## Remaining risks and release actions

1. Resolve existing dependency findings before release: Next **16.3.5** critical advisory for `next/og ImageResponse`, and platform Nest **11.2.5**/Multer **2.2.0** high advisories. These versions were not introduced here; no unrelated upgrades were applied. Exact reachability/exploitability is not established. Sanitized [frontend audit](2026-10-06-application-cache-evidence/frontend-audit.json) and [platform audit](2026-10-06-application-cache-evidence/platform-audit.json) preserve scanner results.
2. Supply the authoritative checklist and rerun applicable release gates. The [verify-before-push skill](</Users/ashok/.codex/skills/verify-before-push/SKILL.md>) says: “If it cannot be found, report the missing requirement and continue independent inspection without declaring readiness.” Its absence does not prevent this authorized local implementation.
3. Validate private AWS TLS/ACL/networking, managed failover, cache loss, source capacity under cold/10× expected peak, and regional cost before enabling L2. Production plaintext cache URLs are rejected, including a POC container with `NODE_ENV=production`.
4. Confirm live provider capability/retention and measure eligible repeated requests, read/write counters, TTFT and costs. Newer direct Responses controls, Gemini explicit cached-content management, semantic/output caching and MCP discovery remain the plan's conditional future scope.
5. Cross-replica invalidation is best effort display freshness, bounded by TTL. Gateway revocation/rotation uses documented per-process freshness windows or explicit process invalidation; no transactional writer/outbox integration exists. Already dispatched provider requests can complete.
6. Connect bounded cache logs/timing/provider counters to dashboards and alerts. Runtime/browser retained-byte bounds are estimates rather than a process RSS guarantee. A source outage can still fail a legitimate request; caches do not manufacture authoritative availability.

Temporary native cache fixtures and browser smoke services were stopped. Test binaries/build outputs remain ignored local artifacts; no production services were changed. Rollback needs no cache-data recovery: disable the relevant flags, rebuild frontend for its public flag, restart services as documented, and return to authoritative reads.
