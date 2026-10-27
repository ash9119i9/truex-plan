---
name: backend-performance
description: Measures and fixes backend performance - API latency, throughput, database queries and indexes, N+1, caching, connection pools, event-loop blocking, memory growth, payload size, queues and background jobs, timeouts and retries, and load testing. Use when an endpoint, job or service is slow, when p95/p99 latency or error rate rises under load, when CPU, memory or DB load grows, when asked "will this scale", "what breaks at 10x", for a backend performance audit or review, or before shipping a change on a hot path. Not for browser rendering or Core Web Vitals (use truex-frontend).
---

# Backend Performance

## Core rule

No measurement, no change. Every claim in the output is either a number you
measured, a number you derived by labelled arithmetic, or marked as unverified.
A fix that does not move the measured number is reverted, even if it "should"
help.

## When NOT to use

- No symptom, no SLO, no hot path: do not optimize. Say so and stop.
- Frontend rendering, bundle size, Core Web Vitals: use `truex-frontend`.
- The real problem is correctness or a crash: use `debugging-and-error-recovery`.

## Truex New Stack

In this repo, work in the new stack. Each package has its own `node_modules`, scripts and tests (no npm workspaces):

```text
frontend (3000) → platform-next (4100) → runtime-adapter (4400) → pinned Codex app-server → model-gateway (4200)
```

`agent-core/` and `platform/` are the old stack: leave them alone unless the user names them. `vendor/codex/` is never modified. Root `npm test` and `npm run build` skip runtime-adapter and platform-next, so they are not evidence for the new stack.

- Hot paths: sending a message and streaming its reply (platform-next chats → runtime-adapter → Codex → model-gateway), SSE fan-out, MongoDB round trips per message, and Codex process start.
- Baselines: `npm --prefix platform-next run bench:perf`; earlier results in `docs/PERFORMANCE_AUDIT_PLATFORM_NEXT_2026-10-23.md`, `docs/PERFORMANCE_AUDIT_PLATFORM_NEXT_2026-10-24.md` and `platform-next/bench/results-2026-10-24.txt`. Gateway prompt cache: `npm --prefix model-gateway run benchmark:cache`.
- runtime-adapter limits: `RUNTIME_MAX_PROCESSES` (default 20, about 150 MB each) and `RUNTIME_IDLE_MS`. Memory questions start there.
- Tests use mongodb-memory-server 8.0.14. Timings there are not production numbers; work counts (DB calls, keys examined) are.

## Workflow

```text
1. FRAME     what is slow, for whom, how slow, what target
2. BASELINE  reproducible harness + numbers (p50/p95/p99, throughput, calls/request)
3. LOCATE    find where time/resources go (profile, plan, trace) - not where you guess
4. HYPOTHESIZE one cause, one predicted effect
5. CHANGE    the smallest fix for that cause
6. VERIFY    same harness, same data; keep or revert; log both
7. GUARD     regression test, budget, metric or alert
```

### 1. Frame

Answer before touching code. If unknown, find out or state the assumption.

- Which operation (endpoint, job, query, consumer)? Which percentile hurts?
- Current number vs target (SLO, budget, or "same as before change X").
- Data shape at the size that matters: rows per tenant, largest tenant,
  payload size, fan-out. Performance bugs live in the largest account, not
  the average one.
- Traffic shape: steady, bursty, per-tenant hot spots, cron spikes.

### 2. Baseline

Build or reuse a harness that runs the real code path against a realistic,
fixed dataset. Prefer the project's existing bench tooling (for this repo:
`platform-next/bench/perf-audit.ts`, run with `npm run bench:perf`).

Record at minimum: p50, p95, p99, max, throughput, error rate, and **work per
request** (DB calls, rows/keys examined, bytes in and out, external calls).
Work-per-request counts are deterministic and catch regressions that
loopback latency hides. Details: [measurement.md](references/measurement.md).

### 3. Locate

Use the triage table, then the matching reference. Confirm with a profile,
query plan or trace before you fix anything.

| Symptom | Likely area | Reference |
|---|---|---|
| Latency grows with data size | Missing/wrong index, unbounded query, in-memory sort, offset pagination | [database.md](references/database.md) |
| Latency grows with request count per page | N+1 queries, chatty service calls | [database.md](references/database.md), [network-and-payloads.md](references/network-and-payloads.md) |
| All endpoints slow at once, CPU low | Pool exhaustion, lock contention, slow dependency, missing timeouts | [concurrency-and-io.md](references/concurrency-and-io.md) |
| All endpoints slow at once, CPU high | Event-loop blocking, sync work, large JSON, regex, crypto on main thread | [concurrency-and-io.md](references/concurrency-and-io.md) |
| p99 far above p50 | GC pauses, cold cache, lock waits, retries, one large tenant, queueing | [measurement.md](references/measurement.md), [memory.md](references/memory.md) |
| Memory climbs until restart | Leak, unbounded cache/map, buffered uploads, listener growth | [memory.md](references/memory.md) |
| Same data computed or fetched repeatedly | Missing cache or request coalescing | [caching.md](references/caching.md) |
| Big responses, slow on real networks | Payload size, no compression, over-fetching, no streaming | [network-and-payloads.md](references/network-and-payloads.md) |
| Background work lags or piles up | Queue throughput, sweeps that scale with total data, no batching | [async-work.md](references/async-work.md) |
| Outage spreads from one dependency | Missing timeouts, retry storms, no backpressure or load shedding | [concurrency-and-io.md](references/concurrency-and-io.md) |

### 4-5. Hypothesize and change

- One hypothesis per change: "Index X turns COLLSCAN of 100k docs into
  IXSCAN of ~20 keys; p95 drops from ~40 ms to under 5 ms."
- Fix the cause at the lowest layer that owns it (query before cache, cache
  before more hardware).
- Prefer removing work over speeding it up: fewer calls, fewer rows, fewer
  bytes, less frequent.
- Every optimization has a cost. Name it: write amplification for indexes,
  staleness and leakage for caches, complexity for concurrency, memory for
  buffers.

### 6. Verify

- Same harness, same dataset, same machine, warm-up included, enough runs to
  see past noise (compare distributions, not single runs).
- If the change is inside run-to-run noise, it is not a win. Revert it.
- Re-check correctness: tests pass, results identical, tenant isolation intact.
- Log every attempt, kept or reverted, in the attempts ledger so nobody
  re-tries a disproven idea.

### 7. Guard

Pick at least one, closest to the cause:

- Test asserting work per request (e.g. "list chats issues 2 DB calls",
  "query uses index X", "response under N KB").
- Bench result checked into the repo with date and environment.
- Production metric + alert (latency percentile, pool wait time, queue age,
  event-loop delay, heap after GC).

## Break Mode checklist

Before declaring done, ask what happens with:

- 10x traffic, 100x data, the single largest tenant, a burst after an outage.
- A dependency that becomes slow (not down): do requests pile up?
- Cold start, cold cache, cache flush, failover.
- Retries from clients and from our own code at the same time.
- Many concurrent writers to the same document/row/key.

If the answer is "unbounded" anywhere (memory, queue, fan-out, retries,
result size), that is a finding even without a measured incident.

## Output

For reviews and audits, use [report-template.md](references/report-template.md):
findings ranked by `probability x impact x difficulty of detection`, each with
evidence, a fix, and its cost; plus the attempts ledger and limitations.

For a single fix, report: baseline -> result (same harness), the change,
its cost, and the guard you added.

## Rules

- Never claim "faster", "scales" or "negligible" without a number or a labelled
  estimate.
- Loopback/local milliseconds are for relative comparison. Say so.
- Do not add a dependency, cache layer, queue or service to fix something an
  index, a projection or a batch call can fix.
- Do not change timeouts, pool sizes or retries without stating the failure mode
  they protect against and what happens when the limit is hit.
- Read the installed library version's defaults from the package source, not from
  memory or blog posts.
