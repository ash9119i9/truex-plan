# WebCrawl

WebCrawl is a self-hosted native `web_crawl` tool. Crawlee BasicCrawler 3.18.2 owns a persistent URL queue; the isolated Crawl4AI 0.9.2 browser extracts Markdown and links from the same page load. No cloud crawler account or second page download is needed.

## Run locally

Existing Search/Read configuration and credentials are reused. In the ignored `deploy/websearch.env`, set `WEB_CRAWL=on`, retain `COMPOSE_PROFILES=webread` and existing tokens. In `agent-core/.env`, set `WEB_CRAWL=on` with the matching `WEB_SERVICE_URL` and `WEB_SERVICE_TOKEN`. Optional `WEB_CRAWL_TIMEOUT_MS` bounds API requests (default 15000, maximum 60000); it is not the background job deadline.

```sh
docker compose --env-file deploy/websearch.env -f deploy/websearch.compose.yaml up -d --build
npm run webcrawl:smoke
```

Create a **new conversation** after enabling the feature. Dynamic tools cannot be added to an existing conversation through resume. Example: “Crawl https://quotes.toscrape.com/ with a maximum of 3 pages and depth 1; show the job status.” Then ask the agent to inspect that job's saved results. Search and Read remain independently configured.

One web-service process owns the `webcrawl-data` Docker volume mounted at `/data/webcrawl`. Direct host development additionally requires Python 3 and an absolute, private `WEB_CRAWL_DATA_DIR`. Do not run multiple service workers against one data directory: an OS advisory lock rejects a second owner. Keep the volume when recreating containers; `docker compose down -v` removes saved crawl data.

## Tool and API

| Action    | Arguments                                       | Result                                                    |
| --------- | ----------------------------------------------- | --------------------------------------------------------- |
| `start`   | `url`, optional `maxPages`, `maxDepth`          | Durable job handle and progress                           |
| `status`  | `jobId`                                         | Current state, counts, limits and terminal reason         |
| `results` | `jobId`, optional `offset`, `limit`, `maxChars` | Saved Markdown pages, stable source IDs/URLs and failures |
| `cancel`  | `jobId`                                         | Cancellation state; successful pages remain readable      |

Defaults are 25 pages and depth 2; maximum 100 pages/depth 3. Crawls follow public HTML links on the **exact seed hostname**, with fragments removed and URL deduplication. Off-host navigation/redirects are blocked before their browser requests; public cross-host assets may load through the existing egress proxy. Private/reserved addresses, unsafe ports, robots-disallowed pages, PDFs/binary content and authenticated browsing remain unavailable.

One crawl job executes at a time with one page attempt in flight. Durable admission limits unique attempted pages; transient failures receive at most two retries. Bounds include 1000 frontier URLs, an absolute five-minute deadline from admission,10MB stored Markdown/job,100 retained jobs and seven-day retention. Individual stored pages are bounded to 50000 Markdown characters. Results default to 3 pages / 20000 total Markdown characters, maximum 10 pages / 50000 total characters. Truncation is explicit. A bounded crawl can finish `partial` at a limit and does not establish that an entire website was read.

Jobs are scoped to the trusted tenant and root conversation. Identity and start idempotency derive from the harness, not tool arguments. Repeating the same native call is idempotent; reusing a key with different input returns a conflict. Foreign-scope lookups return 404. The authenticated platform authorizes session read access for status/results and write access for cancellation.

Internal routes: `POST/GET/DELETE /crawl/jobs`, `GET /crawl/jobs/:jobId`, `GET /crawl/jobs/:jobId/results`, `POST /crawl/jobs/:jobId/cancel`, independent `GET /crawl/ready`. Agent-core forwards under `/threads/:id/crawls`; platform exposes `/api/sessions/:id/crawls` with corresponding job/results/cancel routes. No public browser route accepts trusted tenant/session headers or service credentials.

## Durability, cancellation and UI

Atomic file replacement plus file/directory fsync persists admission, manifest checkpoints and each page together with its discovered links. Recovery reconciles saved pages and rebuilds pending requests into a fresh persistent Crawlee queue generation, avoiding stale library request locks. A crash can repeat an external fetch; logical saved pages remain deduplicated. This initial single-worker release stores jobs/pages on a private filesystem volume; the earlier Mongo/GridFS design remains a later scaling option.

States: `queued`, `running`, `cancelling`, `completed`, `partial`, `failed`, `cancelled`. Terminal reasons report queue exhaustion, page/depth/frontier/byte/deadline limits, cancellation or error. Successful pages remain available after partial failure or cancellation. Stopping a model turn stops its waiting API call; **the background crawl continues**. Explicit Cancel aborts active extraction and stops further scheduling. Deleting its conversation requires successful scoped job cancellation and purge first. Forks get their own scope and do not transfer existing jobs. Disabling admission still permits registered conversations to inspect/cancel existing jobs.

The Assistant tools panel restores persisted crawl jobs and exposes counts, state, limits, sources, saved Markdown, downloads and Cancel. Active jobs poll every 3 seconds, pause while hidden, back off after failures and stop on terminal state. Model activity refreshes job listings. Public activity contains safe labels rather than raw arguments or full page content. Only the main agent invokes WebCrawl in this release.

## Verification

The service suite uses real BasicCrawler traversal over controlled reader fixtures, including cycles, host/depth/page boundaries, retries, idempotency, scope, cancellation, retention and single-owner locking. A subprocess is hard-killed and restarted to verify durable admission/results/frontier recovery. The harness suite verifies native registration/resume/fork/policy, trusted identity, strict response validation, deletion cleanup and RPC-only abort. Gateway tests cover Chat Completions, Anthropic and Gemini; the pinned runtime fixture verifies the native function path. Platform ownership and frontend polling tests cover read/write boundaries and lifecycle.

`npm run webcrawl:smoke` calls the live Docker API and actual Crawl4AI browser, crawls at most 3 pages of a public fixture, checks limits/idempotency/session isolation and purges only its unique test scope. Repository tests use temporary storage/databases. Browser UI and configured-agent live checks are performed separately; mocked provider tests alone do not establish live crawling behavior.

Official references: [BasicCrawler](https://crawlee.dev/js/api/basic-crawler/class/BasicCrawler), [request storage](https://crawlee.dev/js/docs/guides/request-storage), [Crawl4AI result fields](https://docs.crawl4ai.com/api/crawl-result/).

Dependency audit: the pinned Crawlee dependency tree currently reports the `http-cache-semantics` cross-user cached-response advisory through `got-scraping`; npm's latest 4.2.0 has no patch at implementation time. This adapter performs page reads through its own authenticated `fetch` client and disables Crawl4AI caching; it never uses Crawlee `sendRequest`, Got or the affected response cache. Recheck this advisory before enabling that path or expanding deployment. Do not apply npm's suggested old Crawlee downgrade as an automatic fix.

Live acceptance (2026-10-04): the configured Ashok Agent started and checked a real three-page crawl, then retrieved its saved Markdown and returned direct citations. Recreating the service container retained all three source IDs/pages. The browser restored both progress cards, opened saved pages and cancelled a separate JavaScript-page crawl; three successful pages remained readable. Final live Search/Read/Crawl smoke checks passed. Build, 58 service tests, 149 platform tests, 76 gateway tests, 187 frontend tests, 11 Python worker tests and the focused pinned-runtime/core-HTTP crawl suite passed. Agent-core full suite passed with the separately opt-in live-search test skipped.
