# Background jobs, queues and sweeps

## Move work off the request path

If the user does not need the result to get their response (emails, indexing,
thumbnails, analytics, external copies), enqueue it and return. But keep it
inline if correctness requires it to finish first, and say which one it is.

A request that waits on an external operation with no upper bound inherits that
operation's worst case. Put a deadline on it or make it asynchronous.

## Sweeps and pollers

- Ask how the cost scales: with **activity** (good) or with **total tenants/rows**
  (bad). A sweep that queries every tenant every minute costs O(tenants) even
  when nothing happened.
- Prefer: index on "needs work" state and query only due items, change
  streams/events, or a work queue populated on state change.
- Bound each run (batch size, time budget) and make it resumable.
- Ensure only one instance runs a given sweep (lease/lock with expiry), or that
  parallel runs cannot double-process (claim items atomically).

## Queue consumers

- Throughput = consumers x concurrency per consumer / time per job. Measure
  time per job and queue age (oldest message), not just depth.
- Batch where the downstream supports it (bulk writes, batch APIs).
- Bounded concurrency per consumer so a backlog cannot overload the DB.
- Idempotent handlers (dedup key, conditional writes): at-least-once delivery
  means duplicates will happen.
- Retry with backoff, max attempts, then a dead-letter queue with alerting.
- Poison messages must not block the queue.

## Fairness

One large tenant can starve everyone else on a shared queue. Use per-tenant
concurrency limits, partitioning, or weighted scheduling once that risk is real.

## Observability

Emit per job type: enqueued, started, succeeded, failed, retried, duration,
queue age. Alert on queue age and DLQ growth, not only on errors.
