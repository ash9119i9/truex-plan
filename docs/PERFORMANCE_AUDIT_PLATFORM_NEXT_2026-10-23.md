# Performance Audit — platform-next

**Date:** 2026-10-23
**Scope:** `platform-next/` — HTTP API, services, MongoDB access, chat run lifecycle, file and upload paths
**Out of scope:** frontend rendering and Core Web Vitals, `runtime-adapter/`, `model-gateway/`, `platform/` and `agent-core/` (legacy)
**Mode:** Read-only source review plus local benchmarks against MongoDB 8.0.14 with the production indexes
**Reference:** branch `truex_planv2`, commit `339bb34`
**Changes made:** None to application source. This document is the only artifact.

---

## 1. Executive summary

The query layer is in good shape. Every request-serving query is index-covered
and keyset-paginated, the chat list and history have no N+1 patterns, and
tenant routes authenticate without touching MongoDB. On a 100k-row dataset the
sidebar, history and recovery queries each returned the right rows with 31–62
index keys and no blocking sort.

The scaling walls are elsewhere:

1. **The recovery sweep costs O(tenants) every 60 seconds, per process.** It
   collection-scans the tenant registry, then issues one query per tenant,
   sequentially. It is the first thing that breaks as customer count grows.
2. **A reply is not saved until an external file copy finishes, and that copy
   has no upper bound.** Every reply with file storage enabled lists the
   runtime workspace over HTTP before settling, then uploads changed files one
   at a time to S3. The S3 client has no request timeout, and the run's lease
   keeps being renewed while it waits — so a stalled upload leaves the chat
   "answering" indefinitely and the sweep will never recover it.
3. **Three secondary costs** are bounded but worth fixing before volume:
   per-stream auth on every heartbeat, 20 MiB request bodies buffered in
   memory, and an in-memory sort on the chat files endpoint.

Findings at a glance:

| ID | Finding | Severity | Confidence |
|----|---------|----------|------------|
| P-1 | Recovery sweep scales with tenant count, not active runs | **High** | Confirmed in code; cost extrapolated from measurement |
| P-2 | Reply settlement blocked by unbounded, sequential S3 uploads | **High** | Confirmed in code; SDK default verified |
| P-3 | Each open stream costs 3 catalog reads every 15 s | **Medium** | Confirmed; load extrapolated |
| P-4 | Up to 320 MiB of upload buffers per process | **Medium** | Confirmed; depends on container memory |
| P-5 | `GET /chats/:id/files` sorts all versions in memory | **Medium** | Measured |
| P-6 | JSON is emitted uncompressed; all reads are `no-store` | **Low** | Confirmed at the platform; proxy behaviour unverified |
| P-7 | MongoDB pool defaults left unbounded on the wait side | **Low** | Confirmed |

One suspected issue was tested and **rejected**: permanent command monitoring
(`monitorCommands: true`) measured 4.5% on 20k sequential reads, inside the
±10% run-to-run noise. It is not worth changing without a high-QPS measurement.

---

## 2. Method

Two kinds of evidence, kept separate:

- **Query plans and local latency.** A real `mongod` 8.0.14
  (`mongodb-memory-server`, the version the test suite pins) was seeded with
  the production index definitions copied from `tenant-indexes.ts`,
  `CHAT_INDEXES`, `AGENT_INDEXES` and `CONNECTION_INDEXES`, then queried with
  the same filters, sorts and limits the services use. `explain("executionStats")`
  supplied the plan and examined-document counts; repeated runs supplied the
  average latency.
- **Code-path reading** for the sweep, settle, streaming, upload and pool
  configuration. No production traffic, Atlas latency, RUM data or load test
  was available, so any "at scale" figure below is arithmetic from the local
  measurement and is labelled as such.

Environment: Node v24.21.0, `mongodb` driver 6.21.0, MongoDB 8.0.14, Apple
Silicon macOS, loopback connection, warm cache, single process. Local figures
are useful for relative comparison, not as production latency.

---

## 3. Query layer: measured plans

Dataset: 100,000 chats for one owner in one tenant database (50 with a lapsed
lease), 100,000 messages in one chat, 5,000 file versions across 40 paths, and
20,000 tenant registry rows (19,800 ready).

| Operation | Plan | Keys examined | Docs examined | Returned | Avg (local) |
|---|---|---|---|---|---|
| Chat list, first page | `IXSCAN owner_recent`, no SORT | 31 | 31 | 31 | 0.22 ms |
| Chat list, keyset cursor | `IXSCAN owner_recent`, no SORT | 62 | 62 | 31 | 0.21 ms |
| History page (50 + hasMore) | `IXSCAN chat_seq_unique`, no SORT | 51 | 51 | 51 | 0.275 ms |
| Recovery: lapsed chats | partial `IXSCAN active_lease`, no SORT | 50 | 50 | 50 | 0.21 ms |
| Chat files listing | `IXSCAN` + **blocking SORT** | 5,000 | 5,000 | 300 | 7.15 ms |
| Tenant registry `listReady()` | **COLLSCAN** | 0 | 20,000 | 19,800 | 19.9 ms |

Interpretation:

- The sidebar, history and recovery queries are as good as they can be: the
  index satisfies the filter, the sort and the limit, so the work is
  proportional to the page, not the collection.
- The files listing fetches every version of the chat to return the newest 300.
  At 5k versions and ~100-byte documents that is 7 ms; it grows with history.
- The tenant registry has no index for `provisioningStatus`, so every sweep
  scans the whole catalog. At 20k tenants the scan is ~20 ms and the returned
  array costs ~7.4 MiB of heap (measured 387 bytes per row).

---

## 4. Findings

### P-1 — The recovery sweep scales with tenants, not with activity

**Severity: High.** Not a correctness bug; the first hard scaling wall.

**Evidence**

- [`recovery-sweep.ts:76`](../platform-next/src/modules/chats/recovery-sweep.ts#L76)
  loads every ready tenant
  ([`tenants.service.ts:159`](../platform-next/src/modules/tenants/tenants.service.ts#L159))
  and then runs one query per tenant, awaiting each in turn.
- `listReady()` filters on `provisioningStatus` and sorts by `_id`; the catalog
  only indexes `dbName` and the default-tenant partial index, so this is a
  collection scan (measured above).
- Each tenant query is
  [`lapsedChats`](../platform-next/src/modules/chats/chat-store.ts#L361), which
  is well indexed by `active_lease`, but it is still a network round trip per
  tenant per sweep.
- Sweep-shaped benchmark: 500 sequential per-tenant queries took **46 ms**
  (0.092 ms each) on loopback; the same 500 with a 20-connection pool took
  **17 ms**. Parallelising would help, but the query count itself is the
  problem.
- Recovery then handles up to 100 lapsed chats per tenant sequentially
  ([`chats.service.ts:1054`](../platform-next/src/modules/chats/chats.service.ts#L1054)),
  and each may call the runtime (history read or reattach), so a runtime outage
  makes a sweep much longer than the tenant count alone implies.
- `runOnce()` coalesces overlapping ticks, so the failure mode is not pileup;
  it is a sweep that never stops, continuously consuming database and runtime
  capacity.

**Impact.** Extrapolating the measured per-tenant round trip (ignoring
recovery work):

| Tenants | Loopback (0.09 ms) | 1 ms RTT | 3 ms RTT |
|---|---|---|---|
| 10,000 | 0.9 s | 10 s | 30 s |
| 50,000 | 4.6 s | 50 s | 150 s |
| 100,000 | 9.2 s | 100 s | 300 s |

The sweep interval is 60 s
([`recovery-sweep.ts:15`](../platform-next/src/modules/chats/recovery-sweep.ts#L15)).
At roughly 50k tenants on a 1 ms-RTT cluster, one process's sweep fills the
interval; beyond that it is permanently running. Multiple instances multiply
the total queries, and every sweep also materialises the whole registry
(387 bytes/row: ~38 MiB at 100k tenants, ~77 MiB at 200k).

**Recommendation (smallest effective change).** Make the unit of work an
*active run*, not a tenant:

- Add a catalog collection `active_runs` keyed by `runId` with
  `{ tenantId, dbName, chatId, ownerId, leaseExpiresAt }`, written in the same
  transaction that claims the run and deleted in the settle transaction. Lease
  renewal updates the registry row alongside the chat's `activeRun`.
- The sweep reads only expired `active_runs` (one indexed range query, with a
  partial index on `leaseExpiresAt`) and opens the named tenant database for
  each. A tenant with no active reply is never contacted.
- Keep the per-tenant `active_lease` index as the backstop for runs recorded
  before the registry exists.
- If `listReady()` remains for other callers, add a partial index
  `{ provisioningStatus: 1, _id: 1 }` for ready tenants and page it instead of
  returning every row.

**Verification.** Benchmark 10k and 100k tenants with 10 active runs: sweep
duration must be flat. Add a test asserting a tenant with no active run is
never queried. Log sweep duration and tenant/registry counts (see §8).

---

### P-2 — A reply is not saved until an external file copy finishes, with no upper bound

**Severity: High.** User-visible stalls, and a stuck chat that recovery cannot take over.

**Evidence**

The completion path in
[`run-executor.ts:1379`](../platform-next/src/modules/chats/run-executor.ts#L1379)
is:

```
completed event  →  chatFiles.capture()  →  settleWithRetry()  →  saved event
```

1. When file storage is configured, **every** reply calls
   [`capture`](../platform-next/src/modules/chats/chat-files.ts#L190) first.
   Its first action is `client.files(ref)`, a runtime HTTP call, even for a
   text-only chat with no files.
2. Changed files are uploaded in a serial `for` loop
   ([`chat-files.ts:218`](../platform-next/src/modules/chats/chat-files.ts#L218)),
   each one: runtime GET → full `Buffer` → SHA-256 → S3 PUT → Mongo insert.
   Limits are 20 files, 100 MiB per run, 20 MiB per file.
3. `CAPTURE_TIMEOUT_MS` is 30 s
   ([`chat-files.ts:35`](../platform-next/src/modules/chats/chat-files.ts#L35)),
   but the signal is only checked *between* files and is **not passed to
   `store.put`** (`FileStore.put(key, data, contentType)` has no signal
   parameter).
4. The S3 client is created with region only
   ([`chat-files.ts:83`](../platform-next/src/modules/chats/chat-files.ts#L83)).
   The installed `@smithy/node-http-handler@4.12.1` sets
   `DEFAULT_REQUEST_TIMEOUT = 0`, meaning no request timeout. A stalled PUT can
   hang until the OS/network stack gives up.
5. The lease renewal interval
   ([`run-executor.ts:886`](../platform-next/src/modules/chats/run-executor.ts#L886))
   is cleared only in the `finally` after `finish()`
   ([`run-executor.ts:902`](../platform-next/src/modules/chats/run-executor.ts#L902)),
   so the process keeps renewing the lease while blocked in the upload. The
   sweep therefore never treats the run as orphaned.

**Impact.**

- *Latency:* 20 files × (runtime GET + PUT + insert) serialised. At 50–100 ms
  per PUT that is **1–2 s added to every coding reply before `saved`**, after
  the model has already finished. Plain text replies pay one runtime listing.
- *Availability:* one hung PUT holds the run, the lease and the chat's state
  indefinitely. The browser shows "answering", `activeRun` never clears, and
  the recovery sweep cannot intervene because the lease stays fresh. The same
  applies to `S3 GET` for `GET /chats/:id/files/:fileId/content`, which has no
  timeout either.

**Recommendation.**

- Configure the S3 client explicitly: `requestHandler: new NodeHttpHandler({
  requestTimeout: 10_000, connectionTimeout: 2_000 })`, `maxAttempts: 3`.
- Thread the capture `AbortSignal` through `FileStore.put`/`get`.
- Upload with bounded concurrency (for example 4) instead of strictly serially.
- Settle the reply **before** copying files, or give the copy a short budget
  (for example 3 s) and mark the remainder `unsaved` so the existing Retry card
  handles it. The chat must never wait on storage for its saved state.

**Verification.** Integration test with a stalled S3 fake: the reply settles
within the budget and the files are marked `unsaved`; the lease expires and the
sweep recovers a run whose upload never returns. Measure time-to-`saved` before
and after on a 20-file reply.

---

### P-3 — Each open stream costs three catalog reads every 15 seconds

**Severity: Medium.** Deliberate (documented revocation window), but it is the
largest avoidable steady-state query load.

**Evidence.** [`chats.controller.ts:421`](../platform-next/src/modules/chats/chats.controller.ts#L421)
runs on every heartbeat
([`STREAM_HEARTBEAT_MS = 15_000`](../platform-next/src/modules/chats/chats.controller.ts#L56)):

- `sessions.authenticate` → `sessions.findOne` + `users.findById`
- `memberships.findActive` → one membership read

That is 3 reads per stream per 15 s = **12 reads/minute per open stream**.

**Impact.** At 10,000 concurrent streams (one per active chat tab) that is
120,000 catalog reads per minute ≈ **2,000 QPS of pure authorization**, before
any chat work. At 1 ms each, roughly two cores' worth of database time plus
the connection occupancy; it also scales with tabs, not users.

**Recommendation.** Keep the cheap part, slow the expensive part:

- Re-verify the token signature every heartbeat (37.5 µs, no I/O — measured).
- Check session and membership every 60 s, or on a revocation epoch carried in
  the token that a global counter bumps.
- Drop `users.findById` from the stream check: the session's liveness plus an
  active membership is enough; account disabling is caught by the 5-minute
  token and the next refresh.

**Verification.** Count heartbeat queries in an HTTP test; assert the steady
state is at most 2 queries per stream per minute (session plus membership),
down from 12, and that a revoked membership still closes the stream within the
documented window.

---

### P-4 — Up to 320 MiB of upload buffers per process

**Severity: Medium.** Depends on the container memory limit; on a 512 MiB
container it is an OOM, not a slowdown.

**Evidence.** [`uploads.controller.ts:92`](../platform-next/src/modules/chats/uploads.controller.ts#L92)
concatenates the whole request body; `MAX_UPLOAD_BYTES` is 20 MiB
([`chat-uploads.ts:35`](../platform-next/src/modules/chats/chat-uploads.ts#L35))
and `IN_FLIGHT_PER_PROCESS` is 16
([`chat-uploads.ts:43`](../platform-next/src/modules/chats/chat-uploads.ts#L43)),
so worst case is **16 × 20 MiB = 320 MiB** of Buffers (external memory, not
bounded by `--max-old-space-size`) plus hashing and the S3 request.

The same whole-file buffering appears in `copyAttachments`
([`chat-files.ts:346`](../platform-next/src/modules/chats/chat-files.ts#L346)),
which reads each attachment fully (up to 10 per message) and posts them one at
a time before the run starts — memory *and* time-to-first-token.

**Recommendation.** Stream the body to S3 (known `content-length`, multipart or
`PutObject` with a stream) and hash incrementally; or lower `MAX_UPLOAD_BYTES`
and the in-flight cap until streaming lands. Size the per-process budget from
the actual container limit, not from a constant.

**Verification.** Load test with 16 concurrent 20 MiB uploads; watch RSS and
assert it stays within the container budget. Assert attachment copy no longer
buffers whole files.

---

### P-5 — `GET /chats/:id/files` sorts every version in memory

**Severity: Medium.** Grows with a chat's history; measured, not theoretical.

**Evidence.** [`chat-files.ts:261`](../platform-next/src/modules/chats/chat-files.ts#L261)
filters by `chatId` and sorts by `{ createdAt: -1, _id: -1 }` with limit 300.
The only index is `chat_path_version_unique` `{chatId, path, version}`, so the
plan is `IXSCAN` → `FETCH` → **blocking `SORT`**. Measured on 5,000 versions:
5,000 keys, 5,000 documents fetched, **7.15 ms**, 300 returned. The cost is
proportional to all versions the chat ever produced.

**Recommendation.** Add `{ chatId: 1, createdAt: -1, _id: -1 }` (or sort by
`{ _id: -1 }` with `{ chatId: 1, _id: -1 }`), bump `TENANT_INDEX_VERSION`, and
run `operator ensure-tenant-indexes --all` as the deploy step. The write cost is
negligible: this collection is append-only and low-volume.

**Verification.** `EXPLAIN` must show `IXSCAN` with no `SORT` node; docs
examined should equal returned (300), not the version count.

---

### P-6 — JSON is emitted uncompressed; every authenticated read is `no-store`

**Severity: Low**, but cheap and user-visible on slow networks.

**Evidence.** There is no compression middleware or dependency in
`platform-next`, and [`app.ts`](../platform-next/src/app.ts) installs none.
Two representative payloads:

- A 50-message history page with 25 command outputs near the 16 KB cap:
  **271,924 bytes** of JSON → **43,981 bytes gzipped (16.2%)** in 5.6 ms of
  CPU. At 20 Mbps that is ~110 ms of transfer versus ~18 ms.
- Every authenticated response sets `Cache-Control: no-store`
  ([`authenticated.guard.ts`](../platform-next/src/common/access/authenticated.guard.ts)),
  so `/models`, `/agents`, `/me` and `/tenant` are refetched on every app open
  even though models and built-ins are already cached server-side for 60 s.

**Caveat.** The Next forwarder drops `content-length` and `content-encoding`
and Next's default `compress: true` probably re-compresses for the browser;
this was **not verified end to end**. If the platform is ever served directly,
or the proxy is replaced, the full payload crosses the wire.

**Recommendation.** Enable compression for JSON on the platform, explicitly
skipping `text/event-stream` (compression breaks SSE buffering) and setting
`Vary: Accept-Encoding`. Separately, use `private, no-cache` with an ETag for
`/models` and `/agents` — the data is not secret from its owner, and a 304
preserves the privacy property while removing two full body transfers per app
open. This overlaps `docs/CACHING_PLAN.md`, which predates `platform-next`.

**Verification.** `curl -H 'Accept-Encoding: gzip'` against a history response:
`content-encoding: gzip` and a ~6× smaller body; SSE still streams
incrementally. Confirm the proxy does not double-compress.

---

### P-7 — MongoDB pool defaults are unbounded on the wait side

**Severity: Low** today (one process), rising with instance count.

**Evidence.** [`database.service.ts:50`](../platform-next/src/database/database.service.ts#L50)
sets `serverSelectionTimeoutMS: 2000` (good) but leaves `maxPoolSize` at the
driver default of 100 per process, `minPoolSize` at 0, `maxConnecting` at 2 and
`waitQueueTimeoutMS` at 0 — so requests queue indefinitely instead of failing.

**Impact.** With N instances the cluster sees up to 100×N connections; if a
pool is exhausted, latency grows without bound and the failure looks like a
hang, not an error. This matters when `backlog/performance/06-multi-instance-streams.md`
lands.

**Recommendation.** Set an explicit `maxPoolSize` sized against the cluster's
connection budget, a `waitQueueTimeoutMS` in the low seconds, and export
checkout wait time plus in-use connections as metrics.

**Verification.** Load test beyond the pool size: requests should fail fast
with a clear 503, not hang; pool metrics visible.

---

## 5. What is already efficient

Worth recording so future work does not "optimise" it:

- **Pagination.** Sidebar uses a covering index and keyset cursor
  ([`chats.service.ts:777`](../platform-next/src/modules/chats/chats.service.ts#L777));
  history pages by `seq`
  ([`chats.service.ts:1477`](../platform-next/src/modules/chats/chats.service.ts#L1477));
  both measured at 0.2–0.3 ms with no sort stage.
- **No N+1 in the read paths.** Chat views batch agent summaries into one
  `$in` query and read models and connectors from 60 s TTL caches
  ([`chats.service.ts:1516`](../platform-next/src/modules/chats/chats.service.ts#L1516)).
  The agent picker is normally one tenant query. Connector listings use one
  `$in` read.
- **Authentication cost on the hot path is zero queries.** Tenant routes verify
  an Ed25519 token and trust its tenant claims for up to 5 minutes
  ([`tenant.guard.ts`](../platform-next/src/common/access/tenant.guard.ts)).
  Measured 37.5 µs/op (26.7k ops/s per core).
- **Streaming has backpressure and caps.** A 1 MiB `writableLength` cutoff
  closes slow clients, command output is capped at 16 KB, deltas are batched at
  50 ms.
- **Uploads are admitted, not unbounded.** Per-member and per-process in-flight
  caps exist; per-chat byte accounting and staged-file caps are enforced.
- **Indexes are built at provisioning, never during a request**, and the
  unique ones carry idempotency, not just speed.
- **One S3 client and one Mongo client per process**, injected, not per request.

---

## 6. Overlap with existing backlog

These findings are adjacent to, but not duplicates of, open items:

- `backlog/performance/01-first-load-latency.md` — frontend request waterfall
  and repeated auth reads. Still relevant; §4/P-3 quantifies the steady-state
  variant for streams.
- `backlog/performance/05-shared-product-cache.md` — per-process 60 s caches
  for models and built-ins. Unchanged by this audit.
- `backlog/performance/06-multi-instance-streams.md` — live state is
  process-local. P-1 and P-7 are prerequisites for the multi-instance step:
  sweep cost and pool sizing both multiply by instance count.
- `docs/CACHING_PLAN.md` — compression and HTTP caching were already planned
  for the older `platform/` service; P-6 carries the same two items forward for
  `platform-next` with current measurements.
- `docs/SECURITY_AUDIT_2026-10-23.md` — F-2 (5-minute revocation window) is the
  security trade-off that P-3's heartbeat exists to soften; any change to the
  heartbeat cadence must keep that window as documented.

New in this report: P-1, P-2, P-4, P-5, P-7.

---

## 7. Recommended order

1. **P-2** — bound S3 and move file copying off the settle path. Small change,
   removes a class of stuck chats and seconds from every coding reply.
2. **P-1** — active-run registry. Larger change, removes the tenant-count wall
   before customer growth makes it urgent.
3. **P-5** — one index and a version bump. Trivial, removes a growing sort.
4. **P-3** — heartbeat cadence. Medium change, large steady-state saving.
5. **P-4** — streaming uploads, or lower caps until then. Sizing decision.
6. **P-6 / P-7** — cheap hygiene before the multi-instance step.

For each, the skill's rule applies: measure the same way before and after, keep
only changes that beat run-to-run variance, and log reverted attempts so they
are not retried blindly.

---

## 8. Observability gaps

The platform already emits `Server-Timing` per request (steps, MongoDB call
counts, connection time). Nothing aggregates it, so these paths cannot be
watched in production today.

Minimum additions before launch:

- **Sweep:** duration, tenant count, registry rows, orphans found — logged every
  sweep, not only when something is found
  ([`recovery-sweep.ts:93`](../platform-next/src/modules/chats/recovery-sweep.ts#L93)).
- **Settle:** time from `completed` to `saved`, split into file listing, each
  S3 PUT, and the database settle; count of runs that exceeded a budget.
- **S3:** latency and failure histogram per operation, including aborted and
  timed-out calls.
- **Streams:** open stream count, heartbeat auth latency, and stream duration.
- **Pool:** in-use connections and checkout wait, scraped from the driver.
- **Alerts on p95, not the mean**, for open/read endpoints and the sweep.

`Server-Timing` is the natural source: parse it into a metric rather than
adding a second timing mechanism.

---

## 9. Limitations

- Benchmarks ran against an in-memory `mongod` on loopback. No network RTT, no
  replication, no write contention, no production data distribution. The plan
  shapes and examined-document counts are the durable results; the millisecond
  figures are indicative.
- No production QPS, RUM or load test was available. All "at scale" numbers are
  arithmetic from the local measurement and are labelled as extrapolations.
- Whether the Next proxy compresses the forwarded JSON was not verified. P-6's
  impact on end users therefore depends on deployment topology.
- The runtime adapter, AgentCore, model gateway and frontend rendering were out
  of scope. First-token latency, agent-core disk work and adapter stream size
  are tracked separately in `backlog/performance/`.
- `platform-next` v1 is documented as a single process, so multi-instance
  effects (P-1, P-7) are analysis, not observation.
- Single-run measurements with ±10% variance; the command-monitoring test
  demonstrated that variance directly and was therefore not reported as a win.

---

## Appendix A — Benchmark setup

- Server: `mongodb-memory-server@10.4.3`, MongoDB 8.0.14 (the version pinned in
  `platform-next/package.json`), standalone. The test suite runs a one-node
  replica set; read plans and examined-document counts are the same either way,
  and the benchmark exercises no transactions or writes on the measured paths.
- Driver: `mongodb@6.21.0`, default pool (100) except where noted.
- Indexes copied from
  [`tenant-indexes.ts`](../platform-next/src/modules/tenants/tenant-indexes.ts)
  and the per-collection definitions in `chat.ts`, `agent.ts`, `connection.ts`.
- Queries copied from the services, including projections, sorts and limits:

```js
// sidebar, page 1
chats.find({ ownerId, status: "active" })
     .sort({ lastMessageAt: -1, _id: -1 }).limit(31)

// sidebar, keyset cursor
chats.find({ ownerId, status: "active", $or: [
         { lastMessageAt: { $lt: before } },
         { lastMessageAt: before, _id: { $lt: beforeId } } ] })
     .sort({ lastMessageAt: -1, _id: -1 }).limit(31)

// history
messages.find({ chatId, ownerId }).sort({ seq: -1 }).limit(51)

// recovery per tenant
chats.find({ "activeRun.leaseExpiresAt": { $type: "date", $lte: now } })
     .sort({ "activeRun.leaseExpiresAt": 1 }).limit(100)

// chat files
chat_files.find({ chatId }).sort({ createdAt: -1, _id: -1 }).limit(300)

// tenant registry
tenants.find({ provisioningStatus: "ready" }, { projection: { _id: 1, dbName: 1 } })
       .sort({ _id: 1 })
```

- Raw results (excerpt):

```text
CHAT PAGE1   IXSCAN owner_recent          31 keys / 31 docs   0.22 ms
CHAT PAGE2   IXSCAN owner_recent          62 keys / 62 docs   0.21 ms
HISTORY      IXSCAN chat_seq_unique       51 keys / 51 docs   0.275 ms
LAPSED       IXSCAN active_lease (part.)  50 keys / 50 docs   0.21 ms
FILES        IXSCAN + SORT              5000 keys / 5000 docs 7.15 ms
TENANTS      COLLSCAN                   20000 docs, 19800 rows 19.9 ms
SWEEP 500 tenants: sequential 46 ms, 20-way parallel 17 ms
TENANT ROWS: 20k = 7.4 MiB heap (387 B/row)
TOKEN VERIFY: 37.5 us/op
HISTORY PAYLOAD: 271,924 B -> 43,981 B gzip (16.2%), 5.61 ms
20k findOne: monitor off 938/899 ms, on 919/999 ms  (±10% noise)
S3: @smithy/node-http-handler 4.12.1 DEFAULT_REQUEST_TIMEOUT = 0
```

## Appendix B — Files referenced

| Concern | File |
|---|---|
| Sweep loop, interval | `platform-next/src/modules/chats/recovery-sweep.ts` |
| Tenant registry queries | `platform-next/src/modules/tenants/tenants.service.ts` |
| Orphan recovery | `platform-next/src/modules/chats/chats.service.ts` |
| Lease and settle | `platform-next/src/modules/chats/chat-store.ts` |
| Completion path, lease renewal | `platform-next/src/modules/chats/run-executor.ts` |
| File capture, S3 store, listing | `platform-next/src/modules/chats/chat-files.ts` |
| Stream, heartbeat, backpressure | `platform-next/src/modules/chats/chats.controller.ts` |
| Upload limits and staging | `platform-next/src/modules/chats/chat-uploads.ts`, `uploads.controller.ts` |
| Mongo client options | `platform-next/src/database/database.service.ts` |
| Index definitions | `platform-next/src/modules/chats/chat.ts`, `modules/tenants/tenant-indexes.ts` |
| Request timing | `platform-next/src/common/http/server-timing.ts` |
