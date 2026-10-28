# Database

## Always read the plan

- MongoDB: `.explain("executionStats")`. Check `winningPlan` stage (`IXSCAN`
  vs `COLLSCAN`), `SORT` stage (in-memory sort), and the ratio
  `totalKeysExamined : totalDocsExamined : nReturned`. Ideal is close to 1:1:1.
- PostgreSQL: `EXPLAIN (ANALYZE, BUFFERS)`. Look for `Seq Scan` on large
  tables, `Sort` above a scan, estimated vs actual `rows` off by 10x (stale
  stats: run `ANALYZE`), high `Buffers: read`.
- MySQL: `EXPLAIN ANALYZE`; `type: ALL` is a full scan, `Using filesort`,
  `Using temporary`.

Use the service's exact filter, sort, projection and limit. A plan for a
hand-written approximation proves nothing.

## Indexes

- Design for the query shape. MongoDB ESR rule: **E**quality fields, then
  **S**ort fields, then **R**ange fields. SQL composite indexes follow the same
  idea: equality columns first, then the sort/range column.
- Tenant- or owner-scoped queries need the scope field first in the index.
- Covered queries (index contains all projected fields) skip the document fetch.
- Indexes do not help: leading-wildcard `LIKE '%x'`/unanchored regex, functions
  on the column (index the expression instead), low-selectivity values (use a
  partial index for the rare value), `$ne`/`$nin`/`NOT IN` in most cases.
- Every index costs writes, memory and storage. Verify the plan changed and
  latency moved; otherwise drop it. Look for unused indexes
  (`$indexStats`, `pg_stat_user_indexes`).
- Build indexes on large live collections with the database's online option and
  plan it as a migration.

## N+1 and chatty access

- Symptom: DB call count grows with the number of items on the page.
- Fix: one query with `$in` / `WHERE id = ANY($1)`, a join, `$lookup` (measure
  it; `$lookup` on unindexed foreign fields is its own N+1), or a DataLoader-style
  batcher per request.
- Guard with a test asserting calls per request.

## Bound every query

- Every list query has a `limit` and a stable sort with a unique tie-breaker
  (`createdAt, _id`).
- Pagination: keyset/cursor (`WHERE (createdAt, _id) < ($1, $2)`) instead of
  `skip`/`OFFSET`, which reads and discards every skipped row.
- Project only the fields you return. Large fields (bodies, blobs, embeddings)
  dominate I/O and memory.
- `count()` over large sets is a scan. Use estimated counts, capped counts
  (`limit: 1001` -> "1000+"), or maintained counters.
- Watch unbounded growth inside one record: ever-growing arrays in a document,
  JSON columns that accumulate history. Move to a child collection/table.

## Writes

- Batch: `bulkWrite`/`insertMany` with `ordered: false` where independent;
  multi-row `INSERT`; `COPY` for bulk loads.
- Upserts and conditional updates (`findOneAndUpdate` with a filter) instead of
  read-modify-write round trips; they are also safer under concurrency.
- Hot rows/documents (global counters, per-tenant "last updated") serialize
  writers. Shard the counter, aggregate asynchronously, or accept approximate.
- Transactions: keep them short; no network calls inside. Long transactions
  hold locks (SQL) or cause write conflicts and retries (MongoDB).
- Write concern / durability settings are a correctness decision first; do not
  lower them for speed without explicit sign-off.

## Connections

- Pool size, max wait/queue timeout, connect timeout, socket/idle timeout:
  read the installed driver's defaults from source. Defaults are often
  "wait forever".
- Pool too small: requests queue (watch pool wait time). Too large: the DB
  drowns in connections (pods x pool size <= DB connection limit, with headroom
  for deploys where old and new pods overlap).
- One client per process, created at startup, reused. Never per request.
- Serverless/many-pod setups may need a proxy (PgBouncer, RDS Proxy) or a
  driver mode built for it.

## Aggregations and reports

- Put `$match` and `$project` first so later stages see less data; check that the
  first `$match`/`$sort` uses an index.
- `$group`/`$sort` over large sets spill to disk or hit memory limits; precompute
  (materialized views, rollup collections) if read often.
- Run heavy analytics on a replica/warehouse, not the primary serving traffic.

## Data growth

- Ask: does this query's cost grow with total data, tenant data, or the page?
  Only "the page" is safe forever.
- TTL indexes / partition dropping for data with a retention period.
- Archive cold data out of hot collections.
