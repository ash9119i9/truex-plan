# Caching

## Decide first

Cache only when all hold:

1. The thing is expensive (measured) to produce.
2. It is read much more often than it changes.
3. Some staleness is acceptable, and you can state the window.

If the source query takes 1 ms with an index, a network cache adds a hop and a
staleness bug for nothing. Fix the query first.

Never cache: permissions/authorization decisions beyond a short, explicit TTL,
balances, inventory at checkout, anything a user expects to see change
immediately after their own write.

## Layer

| Layer | Good for | Watch out |
|---|---|---|
| Per-request memo | Same lookup repeated inside one request (DataLoader) | Nothing persists; safest option |
| In-process (LRU) | Small, hot, rarely changing config/catalog | Per-pod inconsistency, memory per pod, must be bounded |
| Shared (Redis, Memcached) | Shared across pods, larger sets | Network hop, availability, serialization cost |
| HTTP / CDN | Public or per-user responses with `Cache-Control`, `ETag` | Must vary by auth; `private` vs `public` |

## Keys

Every input that changes the result goes in the key: tenant, user/role when the
output depends on permissions, locale, feature flags, API version. A key that
omits the tenant or viewer is a data-leak bug, not just a stale-data bug.
Version keys (`v3:tenant:123:catalog`) so a deploy can change the shape safely.

## Invalidation

Pick one strategy per cache and write it down:

- TTL only: simplest; staleness = TTL.
- Write-through / delete-on-write: fresher; every write path must remember it.
- Versioned key / generation counter: bump a version to invalidate a group.
- Event-driven: invalidate on change events; needs reliable delivery.

## Failure modes

- **Stampede**: hot key expires, N requests recompute at once. Use single-flight
  (coalesce concurrent misses behind one in-flight promise), stale-while-revalidate,
  or jittered TTLs.
- **Unbounded in-process caches**: always set max entries or bytes (LRU).
  A `Map` used as a cache is a memory leak.
- **Negative caching**: cache "not found" briefly to stop repeated misses on
  absent keys hammering the DB (also blunts enumeration abuse).
- **Cache down**: decide fail-open (go to source, with a concurrency limit so the
  DB survives) or fail-closed. Test it.
- **Big values**: serialization cost can exceed the query you avoided. Measure.

## Verify

Report hit rate, latency with/without cache on the same harness, memory used,
and the staleness window. A cache with a low hit rate is overhead; remove it.
