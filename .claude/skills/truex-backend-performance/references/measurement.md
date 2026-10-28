# Measurement

## What to measure

| Metric | Why |
|---|---|
| p50 / p95 / p99 / max latency | Averages hide the tail; users and timeouts live in the tail |
| Throughput at a fixed latency target | "Requests/s while p99 < X" is a capacity number; raw max RPS is not |
| Error and timeout rate | A faster endpoint that fails more is not faster |
| Work per request | DB calls, keys/docs examined, external calls, bytes in/out. Deterministic, so diffs are trustworthy |
| Resource use | CPU %, RSS, heap after GC, event-loop delay, pool in-use/wait, open sockets |
| Saturation signals | Queue depth/age, pool wait time, DB connections, lock waits |

## Harness rules

- Run the real code path (real app, real modules, real driver), not a
  re-implementation of the query.
- Fixed, synthetic, realistic dataset. Size it to the largest tenant you
  expect, not the median. Seed deterministically so runs are comparable.
- Warm up (JIT, connection pools, caches) before timing; report cold-start
  separately if it matters.
- Repeat: >= 30 iterations for micro paths; compare distributions.
- Change one thing at a time. Record environment: runtime version, DB version,
  driver version, hardware, dataset size.
- Local loopback numbers are relative. Production estimates are arithmetic and
  must be labelled as such ("at 2,000 tenants this is ~2,000 queries per sweep").

## Load testing

- Open-model load (fixed arrival rate) reveals queueing; closed-model load
  (fixed concurrency) hides it. Tools that wait for each response before
  sending the next suffer **coordinated omission** and under-report the tail.
- Use a constant-arrival-rate executor (k6 `constant-arrival-rate`, wrk2,
  Vegeta) for latency-vs-load curves. autocannon is fine for quick
  closed-model comparisons.
- Ramp until p99 breaks the target; that knee is the capacity. Note what
  saturated first (CPU, pool, DB, dependency).
- Run long enough to see GC, cache expiry, and pool churn (minutes, not seconds).
- Never load-test shared or production systems without explicit approval.

## Locating time (Node.js)

| Question | Tool |
|---|---|
| Where is CPU spent? | `node --cpu-prof` (open `.cpuprofile` in Chrome DevTools), `0x`, `perf` with `--perf-basic-prof` |
| Is the event loop blocked? | `perf_hooks.monitorEventLoopDelay()`; report p99 delay. `--trace-sync-io` flags sync I/O after startup |
| Where does memory go? | `--heapsnapshot-signal=SIGUSR2`, `v8.writeHeapSnapshot()`, `--heap-prof`; compare two snapshots |
| Which DB calls per request? | Driver command monitoring (MongoDB `monitorCommands: true` + `commandStarted`/`commandSucceeded`), SQL query logging; emit as `Server-Timing` or span attributes |
| Where in a distributed request? | OpenTelemetry traces; look at span gaps (queueing) not just span durations |
| GC impact? | `--trace-gc`, `PerformanceObserver` on `gc` entries |

## Locating time (other runtimes, quick map)

- JVM: async-profiler, JFR, GC logs. Python: py-spy, cProfile, `tracemalloc`.
  Go: pprof (cpu, heap, block, mutex), `runtime/trace`.

## Reading the tail

p99 >> p50 usually means one of: GC pauses, lock or pool waits, cache misses,
retries, a skewed key/tenant, or queueing near saturation. Break down slow
requests by tenant, route and dependency before tuning anything global.

## Little's law

`concurrency = throughput x latency`. 500 req/s at 200 ms needs ~100 in-flight
requests; if the DB pool is 10 and every request holds a connection for the
whole 200 ms, the pool caps you at 50 req/s. Use this to size pools and
predict saturation before load testing.
