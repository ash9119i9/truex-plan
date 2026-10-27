# Concurrency, I/O and resilience

## Event loop (Node.js)

One blocked tick delays every request on the process. Common blockers:

- `JSON.parse`/`JSON.stringify` on multi-MB payloads.
- Sync APIs after startup: `fs.*Sync`, `zlib.*Sync`, `crypto.pbkdf2Sync`,
  `child_process.execSync`.
- Catastrophic-backtracking regex on user input (ReDoS). Bound input length;
  avoid nested quantifiers.
- Large in-memory sorts, loops over full result sets, big array spreads.
- Password hashing / heavy crypto on the main thread (use async variants, which
  run on the libuv pool).

Measure with `monitorEventLoopDelay()` (p99). Fixes, in order: do less work
(bound the input), stream instead of buffer, chunk with `setImmediate` yields,
move CPU work to `worker_threads` or a separate service.

libuv threadpool (default 4) is shared by `fs`, `dns.lookup`, `crypto`, `zlib`.
Saturating it stalls unrelated I/O. Size `UV_THREADPOOL_SIZE` based on measurement.

## Bounded concurrency

- `Promise.all(items.map(fetch))` over an unbounded list is a self-inflicted
  DoS on your DB or a third party. Use a concurrency limit (a small worker pool
  or an existing limiter already in the repo).
- Fan-out per request should be bounded and measured.
- Sequential `await` in a loop over independent calls is a latency bug; parallel
  with a limit is usually right.

## Connection reuse

- HTTP clients: keep-alive agents with a max sockets limit. A new TLS handshake
  per call costs a lot of latency and CPU.
- Read SDK defaults from the installed package (socket timeout, max sockets,
  retries). AWS SDK, DB drivers and HTTP clients differ widely by version.

## Timeouts and deadlines

- Every outbound call needs a timeout. "No timeout" means a slow dependency
  holds a socket, a pool slot and memory forever.
- Propagate a request deadline: downstream timeouts must be shorter than the
  caller's, or work continues after the caller gave up.
- Cancel abandoned work (`AbortController`) when the client disconnects or the
  deadline passes.
- Timeout != failure of the remote operation. It may still succeed later;
  only retry if the operation is idempotent.

## Retries

- Retry only idempotent operations, or ones guarded by an idempotency key.
- Exponential backoff with jitter, a max attempt count, and an overall budget.
- Retry at one layer. Client + gateway + service + SDK each retrying 3x means
  81 attempts on the database during an incident.
- Do not retry on 4xx validation errors or on overload signals without backoff.

## Backpressure and overload

- Bounded queues everywhere (in-memory queues, pending-request maps, buffers).
  When full, reject quickly (429/503 with `Retry-After`) instead of growing.
- Load shedding beats slow death: serve fewer requests well rather than all
  requests badly.
- Circuit breakers for dependencies that fail hard, so callers fail fast.
- Streams: respect `write()` returning `false` / use `pipeline()`; ignoring
  backpressure buffers the whole stream in memory.

## Locks and contention

- Distributed locks and DB row locks serialize work. Measure lock wait time.
- Keep critical sections small; no network calls while holding a lock.
- Prefer atomic conditional updates over lock -> read -> write -> unlock.

## Long-lived connections (SSE, WebSocket)

- Cost per open connection: memory, file descriptors, and any periodic work
  (heartbeats, polling). Multiply by expected concurrent connections.
- Periodic per-connection DB reads scale with connections x frequency; prefer
  change streams/pub-sub or a shared poller per process.
- Check proxy and load balancer idle timeouts against heartbeat interval.
