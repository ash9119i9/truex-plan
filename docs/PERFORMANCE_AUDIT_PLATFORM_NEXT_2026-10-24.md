# Performance Audit — platform-next (re-measurement)

**Date:** 2026-10-24
**Scope:** `platform-next/` — HTTP API, services, MongoDB access and connection
configuration, the chat run lifecycle, file capture and uploads, skills and
network approvals
**Out of scope:** frontend rendering and Core Web Vitals, `runtime-adapter/`,
`model-gateway/`, legacy `platform/` and `agent-core/`
**Mode:** Read-only source review plus a reproducible local benchmark against
MongoDB 8.0.14 with the production index definitions
**Reference:** branch `truex_planv2`, commit `d66ee95`
**Changes made:** no application (runtime) source. Artifacts: this document,
the harness [`platform-next/bench/perf-audit.ts`](../platform-next/bench/perf-audit.ts),
its raw output [`platform-next/bench/results-2026-10-24.txt`](../platform-next/bench/results-2026-10-24.txt),
and the `bench:perf` npm script / `bench/**` tsconfig include that keep the
harness runnable and typechecked.

---

## 1. Executive summary

Re-measured rather than re-read. The read path is still in good shape: every
request-serving query is index-covered and paginated, a page of chats costs one
database call, one chat with its history costs three, and the app-open path
costs six calls across five endpoints. On 100,000 chats and 100,000 messages
each request answered in 0.2–1.0 ms locally with the expected number of
examined keys.

**No finding from the 2026-10-23 audit has been addressed in code.** The tree
that audit described was committed as `d66ee95` (65 files, +10,219). What
landed after its snapshot is more feature surface — skills, network approvals,
the GitHub/Gmail connector catalog and the attachment flow inside send — which
adds a few costs of its own without changing the shape of the old ones.
Re-measuring confirms every prior finding and adds one new minor one.

The walls, in order:

1. **The recovery sweep still costs O(tenants) every 60 s, per process.** It
   returns the whole ready-tenant registry (19,800 rows, 15.9 ms local, ~7.4 MiB
   of heap) and then makes one query per tenant, sequentially. Adding an index
   does not help — measured neutral — because the cost is the row count, not
   the scan.
2. **A reply is still not saved until the external file copy finishes, and the
   copy still has no upper bound.** The 30 s capture signal is only checked
   between files and is not passed to S3; the S3 client is still built with a
   region only, and the installed Smithy handler's `requestTimeout` default is
   `0` (verified in `node_modules`, not just in docs). The lease keeps being
   renewed while a stalled upload blocks, so recovery cannot take over.
3. **`GET /chats/:id/files` still sorts every version of the chat in memory.**
   Now measured with a before/after: 5,000 versions → 5,000 keys and documents
   examined, 2.88 ms; with a `{chatId, createdAt:-1, _id:-1}` index → 300/300,
   0.75 ms. The cost grows with everything the chat ever produced.
4. **Each open stream still costs three catalog reads every 15 s** — session,
   user, membership. 10,000 open tabs is 2,000 catalog reads per second of
   pure authorization.
5. **Upload bodies are still buffered whole**, up to 320 MiB per process at the
   in-flight cap. The new content check adds three more passes over the buffer
   (measured 15.5 ms per 20 MiB — real but secondary).
6. **JSON is still uncompressed and every authenticated response is
   `no-store`.** Measured on current payloads: a chat list is 13 KB and a chat
   with its history 18 KB; both gzip to ~1 KB (6%). Every app open re-transfers
   them.
7. **The MongoDB pool is still on driver defaults**: 100 connections per
   process, no wait-queue bound, no idle reaping, and no socket timeout — a
   half-open connection can hold a request open indefinitely.

Findings at a glance (P-* continue the 2026-10-23 numbering; N-* are new):

| ID | Finding | Severity | Status vs 2026-10-23 | Evidence |
|----|---------|----------|----------------------|----------|
| P-1 | Recovery sweep scales with tenants, not active runs | **High** | open, unchanged | measured: 16 ms + 19,800 rows per sweep; 68 ms for 500 tenants |
| P-2 | Reply settlement blocked by unbounded, sequential S3 uploads | **High** | open, unchanged | code; Smithy `DEFAULT_REQUEST_TIMEOUT = 0` |
| P-3 | 3 catalog reads per stream per heartbeat | **Medium** | open, unchanged | measured: 0.26 ms per beat, 2,000 reads/s at 10k streams |
| P-4 | Up to 320 MiB of upload buffers per process | **Medium** | open, unchanged | code; 15.5 ms CPU per 20 MiB |
| P-5 | Chat file listing sorts every version in memory | **Medium** | open, now measured | 2.88 ms → 0.75 ms with the index |
| P-6 | JSON uncompressed; authenticated reads `no-store` | **Low** | open, now measured | 13–18 KB → 1 KB gzip |
| P-7 | Pool, queue, idle and socket timeouts at defaults | **Low now, Medium with instances** | open, extended | options read from the running client |
| N-1 | Answering a network card costs 4 round trips | **Low** | new | code |

Two ideas were re-tested and **rejected** again (numbers in §6): the tenant
registry index (neutral), and `monitorCommands` (neutral at 20k reads). One
optimization proposed by the previous audit — an index for `chat_files` — is
now measured as a clear win and is the only index worth adding.

---

## 2. What changed since the previous audit

The whole tree is commit `d66ee95`, 65 files, +10,219/−146. Grouped by area,
with the parts that touch performance:

| Area | Files | Cost added to a hot path |
|---|---|---|
| Chat files (S3) | `chat-files.ts`, `chats.controller` file routes | One runtime HTTP call per reply before settle; per-file S3 PUT + insert |
| Uploads | `chat-uploads.ts`, `uploads.controller.ts` | 20 MiB body buffered per upload; 3 read passes for content check; one extra insert per file; a serial S3-read + runtime-write per attachment before a run starts |
| Skills | `skills.service.ts`, `skill-bundle.ts` | Catalog cached 60 s (no query per chat); archive from a 64 MiB process cache; N parallel runtime PUTs on a new thread's first turn |
| Network approvals | `network-*.ts`, `chat-store` grant writes | Tenant policy cached per process; one read on the first run after the TTL; grant writes are single conditional updates |
| Directory connectors | `connector.ts`, `connectors.service.ts` | One tenant read per start when the agent has connectors; connector catalog cached 60 s |

Chat files and uploads were already covered by P-2/P-4 in the previous audit;
skills, network approvals and the connector catalog are the surface area added
after it.

None of these introduced an N+1 in a read path: the chat list, chat view,
history, agent picker and model list still batch or cache. The added costs are
on **write/turn boundaries** (start a run, finish a run, store a file), which
is the right place for them, with the exception of the settle path (P-2).

---

## 3. Method

- **HTTP, through the real app.** `bench/perf-audit.ts` boots `createApp` with
  the real Nest modules against a one-node replica set, provisions a tenant
  through `OperatorService`, signs in a member through `SessionsService`, and
  seeds 100,000 chats (all owned by that member), 100,000 messages in one chat
  and 5,000 file versions across 40 paths. Each endpoint is called 30 times
  after 3 warm-ups; the MongoDB call count and database time come from the
  app's own `Server-Timing` header, so they are the counts the app reports, not
  a re-derivation.
- **Query plans.** Same dataset, queried with the services' exact filters,
  sorts, projections and limits; `executionStats` supplies the plan, keys and
  documents examined.
- **Candidate indexes** are created, measured, then dropped, so the plan and
  the latency are compared on identical data.
- **Client options** are read from the live `MongoClient` in the app; SDK
  timeouts are read from the installed package, not from documentation.
- Environment: Node v24.21.0, `mongodb` 6.21.0, MongoDB 8.0.14 (the version
  `package.json` pins), `@smithy/node-http-handler` 4.12.1, Apple Silicon
  macOS, loopback, warm cache, single process. Local milliseconds are for
  relative comparison; every "at scale" figure is labelled arithmetic.

Reproduce with:

```bash
cd platform-next && npm run bench:perf
```

---

## 4. Measurements

### 4.1 HTTP requests (100k chats, one chat with 100k messages)

| Endpoint | MongoDB calls | p50 | p95 | Body | gzip |
|---|---|---|---|---|---|
| `GET /me` | 2 | 0.58 ms | 0.97 ms | <1 KB | — |
| `GET /tenant` | 2 | 0.47 ms | 0.56 ms | <1 KB | — |
| `GET /models` | **0** (60 s cache) | 0.23 ms | 0.29 ms | <1 KB | — |
| `GET /agents` | 1 | 0.41 ms | 0.54 ms | <1 KB | — |
| `GET /chats` | 1 | 0.68 ms | 0.74 ms | 13 KB | 1 KB (6%) |
| `GET /chats?cursor=…` | 1 | 0.63 ms | 0.70 ms | 13 KB | 1 KB (6%) |
| `GET /chats/:id` | 3 | 0.90 ms | 1.01 ms | 18 KB | 1 KB (6%) |
| `GET /chats/:id/messages?before=…` | 3 | 0.81 ms | 0.95 ms | 18 KB | 1 KB (5%) |
| `GET /chats/:id/files` | 1 | 0.33 ms | 0.39 ms | — | — |

The file listing reports one call because file storage is unconfigured in the
benchmark, so the service returns early after the ownership read; its query is
measured directly in §4.2.

An app open (me + tenant + models + agents + chat list) is **six catalog or
tenant reads and three full body transfers**, warm. With cold caches add one
read each for models and built-in agents, plus the connector catalog when a
visible chat has connectors (the skills catalog is only read when an agent has
skills).

### 4.2 Query plans

| Operation | Plan | Keys | Docs | Returned | p50 |
|---|---|---|---|---|---|
| Sidebar, first page | `LIMIT > FETCH > IXSCAN owner_recent` | 31 | 31 | 31 | 0.29 ms |
| Sidebar, keyset cursor | `LIMIT > FETCH > IXSCAN owner_recent` | 61 | 61 | 31 | — |
| History page (50+1) | `LIMIT > FETCH > IXSCAN chat_seq_unique` | 51 | 51 | 51 | 0.24 ms |
| Recovery: lapsed chats | `LIMIT > FETCH > IXSCAN active_lease` | 50 | 50 | 50 | — |
| Chat files listing (300) | `SORT > FETCH > IXSCAN` | **5,000** | **5,000** | 300 | 2.88 ms |
| File capture: latest versions | `FETCH > DISTINCT_SCAN` | 40 | 40 | 40 | 0.23 ms |
| Tenant registry `listReady()` | `PROJECTION_SIMPLE > FETCH > IXSCAN` | **20,000** | **20,000** | 19,800 | 15.96 ms |

Reading:

- Sidebar, history and recovery are as good as they can get: the index serves
  the filter, sort and limit, so work is proportional to the page. (The cursor
  row examines 61 keys for 31 rows because the seed has one chat per minute
  and the boundary timestamp resolves to a second key; still page-sized.)
- The chat file listing fetches every version the chat ever produced to return
  the newest 300. At 5,000 versions that is 2.9 ms; it is linear in history.
- `latestVersions` (the per-capture aggregation, added with chat files) is
  **not** a problem: `DISTINCT_SCAN` on `chat_path_version_unique` reads one
  key per path (40), not per version. Leave it alone.
- The tenant registry returns 19,800 rows every sweep because that is what the
  sweep asks for. The plan is fine; the caller is wrong.

### 4.3 Candidate index experiments

Measured on the same collection, index created, measured, dropped.

| Change | Before | After | Verdict |
|---|---|---|---|
| `chat_files {chatId:1, createdAt:-1, _id:-1}` | `SORT` 5,000/5,000, 2.88 ms | `LIMIT` 300/300, 0.75 ms | **keep** (3.8×) |
| `tenants {provisioningStatus:1, _id:1}` | 20,000/20,000, 15.96 ms | 19,800/19,800, 15.29 ms | **revert** (inside noise) |

### 4.4 Sweep shape

500 sequential per-tenant `lapsedChats` queries: **67.7 ms**. The same 500 in
20-way parallel batches: **19.7 ms**. Parallelising recovers 3.4× locally, but it
does not change the query count, which is what a networked cluster charges.

### 4.5 Stream heartbeat

`sessions.authenticate` (session + user) plus `memberships.findActive`:
**0.26 ms p50** for the three reads on loopback. At 10,000 concurrently open
streams, 4 beats per stream per minute → **2,000 catalog reads per second**,
roughly the read load of a busy product surface spent on re-authorization.

### 4.6 MongoDB connections and client options

Read from the live client:

```text
maxPoolSize                100
minPoolSize                0
maxConnecting              2
waitQueueTimeoutMS         0     (wait forever)
maxIdleTimeMS              0     (never reap)
connectTimeoutMS           30000
socketTimeoutMS            0     (no inactivity timeout)
serverSelectionTimeoutMS   2000
retryWrites                true
monitorCommands            true
```

Fifty concurrent `GET /chats` opened **0 new connections**; the server reported
10 current connections (including the driver's monitors). One process's real
concurrency need is far below 100 — which is exactly why 100 is a poor
`maxPoolSize` to leave in place: it is 100 × instance count against the
cluster's ceiling, and nothing reaps what is idle.

### 4.7 CPU per 20 MiB upload

`readBody` buffer + content check + hash, measured in isolation:

```text
nul scan 2.3 ms | utf8 decode 4.6 ms | sha256 7.2 ms | concat copy 1.3 ms | total 15.5 ms
```

0.8 ms/MiB. Not worth restructuring on its own; it matters only because the
buffer is held whole (P-4).

---

## 5. Findings

### P-1 — The recovery sweep scales with tenants, not with activity

**Severity: High. Unchanged since 2026-10-23; re-measured.**

**Evidence.**

- [`recovery-sweep.ts:67`](../platform-next/src/modules/chats/recovery-sweep.ts#L67)
  calls `listReady()`, which returns every ready tenant
  ([`tenants.service.ts:159`](../platform-next/src/modules/tenants/tenants.service.ts#L159)).
  Measured: 19,800 rows, 20,000 keys and documents examined, **15.96 ms** and
  ~7.4 MiB of heap at 20k tenants (the heap figure is from the previous audit;
  the row count and timing were re-measured here).
- The sweep then awaits one `lapsedChats` query per tenant in a `for` loop
  ([`recovery-sweep.ts:79`](../platform-next/src/modules/chats/recovery-sweep.ts#L79)).
  Measured: **67.7 ms** for 500 tenants sequential, **19.7 ms** parallel.
- Recovery itself runs sequentially over up to 100 lapsed chats per tenant
  ([`chats.service.ts:1109`](../platform-next/src/modules/chats/chats.service.ts#L1109)),
  each potentially a runtime call.
- `runOnce()` coalesces overlapping ticks, so the failure mode is a sweep that
  never stops, continuously consuming database and runtime capacity.

**Impact.** Extrapolating the measured per-tenant round trip (0.13 ms local;
1 ms and 3 ms RTT):

| Tenants | Loopback | 1 ms RTT | 3 ms RTT |
|---|---|---|---|
| 10,000 | 1.3 s | 10 s | 30 s |
| 50,000 | 6.6 s | 50 s | 150 s |
| 100,000 | 13 s | 100 s | 300 s |

The interval is 60 s. At ~50k tenants and 1 ms RTT one process's sweep fills
the interval; beyond that it never idles. Multiple instances multiply it.

**Smallest effective change.** Keep the backstop, change the unit of work:

1. Read lapsed chats from a **catalog `active_runs` collection** keyed by
   `runId` (`{tenantId, dbName, chatId, leaseExpiresAt}`), with a partial index
   on `leaseExpiresAt`, written in the same transaction that claims a run and
   deleted in settle; renewal updates it with the chat's lease. The sweep then
   makes **one** range query and contacts only tenants with a lapsed run.
2. Keep `active_lease` per tenant as the backstop for runs recorded before the
   registry exists (and as the access-path recovery check).
3. Do not add an index to `tenants` for this: measured neutral.
4. Parallelise recovery across tenants (measured 3.5× locally), bounded — worth
   doing only after (1), which removes most of the work.

**Verification.** Seed 10k and 100k tenants with 10 active runs; sweep duration
must be flat and no tenant without a lapsed run may be queried (assert on
command count).

---

### P-2 — A reply is not saved until an external file copy finishes, with no upper bound

**Severity: High. Unchanged; SDK default re-verified in the installed package.**

**Evidence.**

- [`run-executor.ts:1533`](../platform-next/src/modules/chats/run-executor.ts#L1533)
  still runs `capture()` **before** `settleWithRetry()`: the browser sees
  `saved` only after the copy.
- `capture()` always starts with `client.files(ref)` — a runtime HTTP call —
  even for a text-only reply
  ([`chat-files.ts:206`](../platform-next/src/modules/chats/chat-files.ts#L206)).
- Changed files are still uploaded in a serial `for` loop
  ([`chat-files.ts:218`](../platform-next/src/modules/chats/chat-files.ts#L218)):
  runtime GET → full `Buffer` → SHA-256 → S3 PUT → Mongo insert, per file,
  20 files and 100 MiB per run.
- `CAPTURE_TIMEOUT_MS` (30 s) is now the default `AbortSignal.timeout(...)` of
  `capture()`, but the signal is only checked **between** files and is still
  not passed into `store.put`/`store.get` (`FileStore` has no signal
  parameter).
- The S3 client is still `new S3Client({ region })`
  ([`chat-files.ts:87`](../platform-next/src/modules/chats/chat-files.ts#L87)).
  The installed `@smithy/node-http-handler@4.12.1` sets
  `DEFAULT_REQUEST_TIMEOUT = 0` and `setRequestTimeout` returns without arming
  a timer when the value is `0` — verified in `dist-cjs/index.js`, not inferred
  from docs.
- The lease interval is cleared in the `finally` of `execute()`, which runs
  after `finish()` ([`run-executor.ts:960`](../platform-next/src/modules/chats/run-executor.ts#L960)),
  so the process keeps renewing the lease while blocked. The sweep therefore
  never treats the run as orphaned.

**Impact.**

- *Latency:* one runtime round trip on every reply with storage enabled, plus
  20 × (GET + PUT + insert) for a coding reply. The database part of that is
  ~0.2 ms per file (measured insert); the rest is external I/O. At 50–100 ms
  per PUT that is **1–2 s added before `saved`** after the model has finished.
- *Availability:* one stalled PUT holds the run, the lease and the chat's
  `activeRun` indefinitely. The tab shows "answering", recovery cannot
  intervene, and the member's only escape is to reload and re-ask.
  `GET /chats/:id/files/:fileId/content` has the same exposure on the read side.

**Smallest effective change.**

1. Configure the client explicitly:
   `requestHandler: new NodeHttpHandler({ requestTimeout: 10_000, connectionTimeout: 2_000, throwOnRequestTimeout: true })`,
   `maxAttempts: 3`.
2. Add an optional `AbortSignal` to `FileStore.put`/`get` and pass the capture
   signal through (S3 `send(command, { abortSignal })`).
3. Upload with bounded concurrency (4) instead of strictly serially.
4. Give the copy a **hard** budget that ends before the settle: race the
   capture against a timer, mark the remainder `unsaved`, and settle. The
   existing Retry card already handles `unsavedFiles`. A reply must never wait
   unbounded for storage.

**Verification.** Integration test with a stalled S3 fake: settle happens
within the budget, files are `unsaved`, and a run whose upload never returns
has its lease expire so the sweep recovers it. Measure time-to-`saved` on a
20-file reply before/after.

---

### P-3 — Each open stream costs three catalog reads every 15 seconds

**Severity: Medium. Unchanged; re-measured.**

**Evidence.** [`chats.controller.ts:443`](../platform-next/src/modules/chats/chats.controller.ts#L443)
runs on every heartbeat (`STREAM_HEARTBEAT_MS = 15_000`):

- `sessions.authenticate` → `sessions.findOne` **and** `users.findById`
  ([`sessions.service.ts:299`](../platform-next/src/modules/sessions/sessions.service.ts#L299))
- `memberships.findActive` → one membership read

Three reads per stream per 15 s = **12 reads per stream per minute**. Measured
0.26 ms p50 for the three on loopback; at 10k open streams that is **2,000
catalog reads/s** — before any chat work.

**Smallest effective change.** Keep the cheap part, slow the expensive part:

- Verify the token signature every beat (no I/O, measured 37.5 µs previously).
- Re-check session + membership every 60 s (or on a revocation epoch carried in
  the token and bumped by a global counter).
- Drop `users.findById` from the stream check: a live session plus an active
  membership is enough; account disabling is caught by the next access-token
  refresh.

**Verification.** Count heartbeat queries in an HTTP test: steady state ≤ 2
queries per stream per minute (down from 12), and a revoked membership still
closes the stream within the documented window.

---

### P-4 — Up to 320 MiB of upload buffers per process

**Severity: Medium (an OOM on a 512 MiB container, not a slowdown). Unchanged.**

**Evidence.** [`uploads.controller.ts:66`](../platform-next/src/modules/chats/uploads.controller.ts#L66)
concatenates the whole body; `MAX_UPLOAD_BYTES` is 20 MiB and
`IN_FLIGHT_PER_PROCESS` is 16 → **320 MiB** of Buffers (external memory, not
bounded by `--max-old-space-size`) plus the S3 request. The new content check
adds three full passes (measured 15.5 ms per 20 MiB) and `copyAttachments`
([`chat-files.ts:346`](../platform-next/src/modules/chats/chat-files.ts#L346))
still reads each attachment fully (up to 10 per message) and posts them one at a
time before the run starts — memory **and** time-to-first-token.

**Smallest effective change.** Stream the body to S3 (multipart or `PutObject`
with a stream, known `content-length`), hash incrementally, and check the
leading bytes plus a UTF-8 decoder incrementally; or, until that lands, lower
`MAX_UPLOAD_BYTES`/the in-flight cap to fit the container and copy attachments
with bounded concurrency (4).

**Verification.** 16 concurrent 20 MiB uploads: RSS stays inside the container
budget; attachment copy no longer buffers whole files.

---

### P-5 — `GET /chats/:id/files` sorts every version in memory

**Severity: Medium. Now measured with a before/after.**

**Evidence.** [`chat-files.ts:261`](../platform-next/src/modules/chats/chat-files.ts#L261)
filters by `chatId` and sorts `{createdAt:-1, _id:-1}` with limit 300; the only
index is  `{chatId, path, version:-1}`. Plan: `IXSCAN → FETCH → SORT`, **5,000
keys and 5,000 documents** fetched, 2.88 ms. With
`{chatId:1, createdAt:-1, _id:-1}`: `LIMIT → FETCH → IXSCAN`, **300/300**,
0.75 ms.

**Smallest effective change.** Add the index to `CHAT_INDEXES.chat_files`, bump
`TENANT_INDEX_VERSION` to 6, and run
`operator ensure-tenant-indexes --operator <name> --all` as the deploy step.
The collection is append-only and low-volume, so the write tax is negligible.

**Verification.** `EXPLAIN` shows `IXSCAN` with no `SORT` node and 300
documents examined at any history size.

---

### P-6 — JSON is uncompressed and every authenticated read is `no-store`

**Severity: Low, but cheap and user-visible on slow networks.**

**Evidence.** No compression middleware or dependency in `platform-next`
(`app.ts` installs none), and [`authenticated.guard.ts:34`](../platform-next/src/common/access/authenticated.guard.ts#L34)
sets `Cache-Control: no-store`. Measured on current payloads: chat list 13 KB →
1 KB gzip (6%), chat with history 18 KB → 1 KB (6%). At 20 Mbps that is ~5 ms
versus ~0.4 ms of transfer per request, per app open, per tab.

**Smallest effective change.**

- Compression for JSON, explicitly skipping `text/event-stream` (compression
  breaks SSE buffering) and setting `Vary: Accept-Encoding`.
- For `/models`, `/agents` and `/skills` — product-managed, non-secret to their
  owner — use `private, no-cache` with an ETag so a re-open gets a 304 instead
  of a body. Keep `no-store` for chats and account data.

**Verification.** `curl -H 'Accept-Encoding: gzip'` returns
`content-encoding: gzip` and a ~6× smaller body; SSE still streams
incrementally; a second `/models` request returns 304. Confirm the Next
forwarder does not double-compress.

---

### P-7 — MongoDB pool, queue, idle and socket timeouts are left at defaults

**Severity: Low today (one process), Medium as instance count grows.**

**Evidence.** [`database.service.ts:50`](../platform-next/src/database/database.service.ts#L50)
sets only `serverSelectionTimeoutMS: 2000`, `appName` and `monitorCommands`.
Options read from the live client: `maxPoolSize 100`, `minPoolSize 0`,
`maxConnecting 2`, `waitQueueTimeoutMS 0`, `maxIdleTimeMS 0`,
`socketTimeoutMS 0`, `connectTimeoutMS 30000`. Fifty concurrent requests needed
10 server connections.

**Impact.**

- `100 × instances` connections is the cluster-connection risk; nothing shrinks
  the pool when traffic falls (`maxIdleTimeMS: 0`).
- `waitQueueTimeoutMS: 0` turns exhaustion into unbounded latency, not an
  error.
- `socketTimeoutMS: 0` means an operation on a connection that died silently
  waits for the OS/network to notice — with Node HTTP keep-alive that can be
  minutes. `serverSelectionTimeoutMS` only covers *selecting* a server.

**Smallest effective change.** Set an explicit `maxPoolSize` sized against the
cluster's connection budget for the maximum instance count (20–30 is generous
for the measured concurrency), `waitQueueTimeoutMS: 5_000`,
`maxIdleTimeMS: 60_000`, and `socketTimeoutMS` at 2–3× the slowest expected
operation (60 s covers the largest bulk write). Export in-use connections and
checkout wait.

**Verification.** Load beyond the pool size: requests fail fast with a clear
503, not a hang; pool metrics visible; a killed connection surfaces as an
error, not a stalled request.

---

### N-1 — Answering a network card costs four round trips

**Severity: Low (a rare, member-initiated action, not a hot path).**

**Evidence.** [`chats.service.ts:1328`](../platform-next/src/modules/chats/chats.service.ts#L1328)
reads the chat, then the card message, then `ChatStore.decideNetwork`
([`chat-store.ts`](../platform-next/src/modules/chats/chat-store.ts)) runs an
`updateOne` **and** a `findOne` to return the winning answer: four round trips
where two suffice.

**Smallest effective change.** One `findOneAndUpdate` (returning the document)
with the "undecided" filter, plus a single fallback read only when the update
matched nothing (a repeated answer). Do it when the path is next touched; it is
not worth a change on its own.

---

## 6. Attempts ledger (kept and reverted)

| Idea | Baseline → result | Verdict | Why |
|---|---|---|---|
| Index `tenants {provisioningStatus, _id}` for `listReady` | 15.96 ms → 15.29 ms, 20,000 → 19,800 keys | **reverted** | Inside run-to-run noise; the cost is returning 19,800 rows, not the scan |
| `monitorCommands: true` overhead | 20k `findOne`: 1,227 ms off → 1,221 ms on | **rejected** | No measurable cost; it is what produces `Server-Timing` |
| Index `chat_files {chatId, createdAt:-1, _id:-1}` | 2.88 ms / 5,000 docs → 0.75 ms / 300 docs | **keep (recommended)** | Clear, structural win that does not degrade with history |
| Rewrite `latestVersions` aggregation | `DISTINCT_SCAN`, 40 keys, 0.23 ms | **rejected** | Already optimal; one key per path |
| Streamline upload content validation | 15.5 ms CPU per 20 MiB | **no change** | ~0.8 ms/MiB; dwarfed by the buffer-size problem (P-4) |

The previous audit's `monitorCommands` rejection is confirmed with a second
independent run; recorded here so it is not re-opened.

---

## 7. What is already efficient

Worth recording so it is not "optimised" later:

- **Pagination.** Sidebar is keyset on a covering index; history pages by `seq`.
  Both measured at 0.2–0.3 ms with no sort stage on 100k rows.
- **No N+1 in read paths.** Chat views batch agent summaries into one `$in`,
  models/connectors/skills come from 60 s TTL caches, connector listings use one
  `$in`, and the agent picker is one bounded query with `limit`.
- **One MongoDB client per process, and tenant databases share its pool.**
  `client.db(name)` opens no connection; only `new MongoClient` does, and there
  is exactly one. Sessions used by `withTransaction` are logical, not
  connection checkouts.
- **Startup never blocks on MongoDB**; readiness reports it, and reconnect uses
  jittered backoff.
- **Chat start is two round trips** for a text-only chat (agent + save), with
  connectors adding exactly one read, skills zero (cached), network policy zero
  (cached).
- **Streaming has backpressure and caps** (1 MiB writable cutoff, 16 KB command
  output, 50 ms delta batching).
- **Every list is bounded** by a `limit`, including the operator-facing ones.
- **Indexes are built at provisioning**, never in a request, and the unique ones
  carry idempotency, not just speed.
- **Skills archives are cached in memory** (64 MiB, LRU, in-flight coalescing),
  so S3 is read once per version per process.
- **`Server-Timing` already reports steps, MongoDB calls and connection time**
  per request — the observability substrate exists; only aggregation is missing.

---

## 8. Recommended order

1. **P-5** — one index and a version bump; removes a sort that grows with
   history. Lowest risk, measured win.
2. **P-2** — bound the S3 client, thread the signal, bound concurrency, and
   settle before storage can hold the reply. Removes stuck chats and seconds
   from coding replies.
3. **P-1** — active-run registry; removes the tenant-count wall before growth
   makes it urgent.
4. **P-3** — heartbeat cadence; large steady-state saving, medium change.
5. **P-4** — streaming uploads, or lower caps until then (a sizing decision
   against the container limit).
6. **P-7** — pool, queue, idle and socket timeouts before the multi-instance
   step (`backlog/performance/06-multi-instance-streams.md`).
7. **P-6, N-1** — hygiene: compression + ETags, one fewer round trip on network
   answers.

For each: measure the same way before and after, keep only what beats
run-to-run variance, and add the attempt to §6.

---

## 9. Observability gaps

The platform emits `Server-Timing` per request (steps, MongoDB call counts,
connection time) but nothing aggregates it. Minimum additions before launch:

- **Sweep:** duration, tenant count, rows read, orphans found — every sweep, not
  only when something is found.
- **Settle:** time from `completed` to `saved`, split into file listing, each
  S3 PUT, and the database settle; count of runs over budget.
- **S3:** latency and failure histogram per operation, including aborted and
  timed-out calls.
- **Streams:** open stream count, heartbeat authorization latency, duration.
- **Pool:** in-use connections and checkout wait, scraped from the driver.
- **Alerts on p95, not the mean**, for open/read endpoints and the sweep.

`Server-Timing` is the natural source: parse it into a metric rather than adding
a second timing mechanism.

---

## 10. Limitations

- Benchmarks run against a local replica set on loopback: no network RTT, no
  replication lag, no write contention, no production data distribution. Plan
  shapes and examined-document counts are the durable results; milliseconds are
  indicative.
- No production QPS, RUM data or load test was available. Every "at scale"
  number is arithmetic from a local measurement and is labelled as such.
- S3, the runtime adapter and the model gateway are not exercised by the
  harness; P-2's latency figure is an external-I/O extrapolation, while its
  timeout defaults are verified in the installed packages.
- The file listing and capture paths are measured at the query level; the HTTP
  figure for `/chats/:id/files` is with storage unconfigured (early return).
- Single-run measurements with ±10% variance; where a delta fell inside that
  band it is reported as a revert, not a win.
- Suite status on this tree: 551 of 552 tests pass. The one failure
  (`chats.test.ts`, "a message that arrives as a reply ends waits for it to be
  saved") is a 2-second wait that expired while the whole suite ran in
  parallel; it passes 45/45 when that file runs alone. No source was changed by
  this audit, so it is pre-existing and load-sensitive, not a regression from
  this work.
- The frontend, `runtime-adapter/` and first-token latency are out of scope and
  tracked separately in `backlog/performance/`.

---

## Appendix A — Raw results

[`platform-next/bench/results-2026-10-24.txt`](../platform-next/bench/results-2026-10-24.txt)

```text
sidebar page 1                     LIMIT>FETCH>IXSCAN    keys=31    docs=31    returned=31
sidebar cursor page 2              LIMIT>FETCH>IXSCAN    keys=61    docs=61    returned=31
history page (50 + 1)              LIMIT>FETCH>IXSCAN    keys=51    docs=51    returned=51
recovery: lapsed chats             LIMIT>FETCH>IXSCAN    keys=50    docs=50    returned=50
chat files listing (300)           SORT>FETCH>IXSCAN     keys=5000  docs=5000  returned=300
file capture: latest versions      FETCH>DISTINCT_SCAN   keys=40    docs=40    returned=40
tenant registry listReady          PROJECTION>FETCH>IXSCAN keys=20000 docs=20000 returned=19800
chat files listing (+index)        LIMIT>FETCH>IXSCAN    keys=300   docs=300   returned=300
tenant registry listReady (+index) PROJECTION>FETCH>IXSCAN keys=19800 docs=19800 returned=19800
sweep 500 tenants: sequential 67.7 ms, 20-way parallel 19.7 ms
monitorCommands=false 1216 ms | monitorCommands=true 1248 ms   (20k findOne)
heartbeat: 3 catalog reads p50 0.26 ms
pool: 50 concurrent requests opened 0 connections; server current=10
```

## Appendix B — Files referenced

| Concern | File |
|---|---|
| Sweep loop, interval | `platform-next/src/modules/chats/recovery-sweep.ts` |
| Tenant registry queries | `platform-next/src/modules/tenants/tenants.service.ts` |
| Orphan recovery, answer network | `platform-next/src/modules/chats/chats.service.ts` |
| Lease, settle, approvals | `platform-next/src/modules/chats/chat-store.ts` |
| Completion path, lease renewal | `platform-next/src/modules/chats/run-executor.ts` |
| File capture, S3 store, listing | `platform-next/src/modules/chats/chat-files.ts` |
| Upload buffering, staged claims | `platform-next/src/modules/chats/chat-uploads.ts`, `uploads.controller.ts` |
| Stream, heartbeat, backpressure | `platform-next/src/modules/chats/chats.controller.ts` |
| Mongo client options | `platform-next/src/database/database.service.ts` |
| Index definitions | `platform-next/src/modules/chats/chat.ts`, `modules/tenants/tenant-indexes.ts` |
| Request timing | `platform-next/src/common/http/server-timing.ts` |
| Skills cache and archives | `platform-next/src/modules/skills/skills.service.ts` |
| Tenant network policy cache | `platform-next/src/modules/network/tenant-network.service.ts` |
| Benchmark harness | `platform-next/bench/perf-audit.ts` |
