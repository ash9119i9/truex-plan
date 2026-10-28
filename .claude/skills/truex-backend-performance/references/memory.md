# Memory

## Symptoms

- RSS or heap-after-GC rises steadily and resets only on restart: leak.
- Spikes during specific requests: buffering (uploads, exports, large queries).
- High p99 with normal CPU: GC pauses from large or short-lived heaps.
- Container OOM-killed while the Node heap looks fine: off-heap memory
  (Buffers, native modules) or heap limit above container limit.

## Common causes

- Unbounded `Map`/object caches, memo tables keyed by request data.
- Event listeners or timers added per request and never removed.
- Closures holding large request objects in long-lived callbacks.
- Pending-promise/request maps that never get cleaned on timeout or error paths.
- Reading whole files/responses into memory (`buffer()`, `readFile`,
  `toArray()` on big cursors) instead of streaming.
- Per-request upload buffers: worst case = max upload size x concurrent uploads.
  Compute it; it is often hundreds of MB.

## Finding it

1. Reproduce growth under a harness (repeat the suspect request N times).
2. Take heap snapshot A, run N more requests, force GC if possible, take snapshot B.
3. Compare: object types whose count grows with N are the leak; follow retainers.
4. For off-heap: track `process.memoryUsage()` (`rss`, `heapUsed`, `external`,
  `arrayBuffers`).

## Fixes

- Bound everything: LRU with max size, max concurrent uploads, max buffer size.
- Stream: cursors with `batchSize`, `stream.pipeline`, multipart streaming to
  object storage.
- Clean up on every path: `finally`, `AbortSignal` listeners removed, timers
  cleared.
- Set `--max-old-space-size` below the container memory limit with headroom for
  off-heap and the rest of the process.

## Verify

Report heap-after-GC and RSS over a sustained run before and after; a flat line
over thousands of requests is the evidence, not a single snapshot.
