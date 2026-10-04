# Crawl4AI WebRead

WebRead opens one public HTTP(S) page and extracts Markdown through Crawl4AI. The native `web_read` function works through ordinary function calls across supported model providers. It complements [WebSearch](WEBSEARCH.md): search finds sources; read retrieves their page content.

## Contract and behavior

Input is `{ url, maxChars? }`. The default is 20,000 Markdown characters and the maximum is 50,000. URLs are limited to 2,048 characters and default HTTP/HTTPS ports. Credentials, custom browser settings, cookies, headers, JavaScript, extraction hooks and recursive traversal are not model arguments.

The result contains `provider: "crawl4ai"`, requested and final URLs, title, retrieval time, final HTTP status, Markdown, total character count, truncation flag and bounded warnings. Page content is untrusted evidence, never agent instructions. The agent cites the returned page URL and discloses failed, empty or truncated reads. Search snippets alone do not count as having read a page.

This first Read slice is stateless: no cross-session cache, durable source handles, pagination, private website login, binary/PDF extraction or crawl jobs. The conversation's existing history retains the tool result. Durable snapshots and crawling remain subsequent work in the [web tools plan](WEB_TOOLS_IMPLEMENTATION_PLAN.md).

## Local setup

The WebRead containers extend the existing private WebSearch Compose stack. Keep the existing Search token and SearXNG configuration. Add a separate `CRAWL4AI_API_TOKEN` to ignored `deploy/websearch.env` (generate it with `openssl rand -hex 32`). Keep it distinct from `WEB_SERVICE_TOKEN`. Then enable the optional reader profile:

```sh
docker compose --env-file deploy/websearch.env -f deploy/websearch.compose.yaml --profile webread up -d --build
npm run websearch:smoke
npm run webread:smoke
```

Set the following in `agent-core/.env`, retaining the same existing service URL/token:

```dotenv
WEB_READ=on
WEB_SERVICE_URL=http://127.0.0.1:4400
WEB_SERVICE_TOKEN=<the private API token already used for Search>
WEB_READ_TIMEOUT_MS=50000
```

Restart agent-core and start a **new conversation**. Ask “Read https://example.com/ and summarize what the page says.” Check `/api/sessions/:id/documents` for `webReadAvailable: true`, and `/api/sessions/:id/traces` for a completed `webRead` step. Confirm the reply cites the URL and uses extracted content. Service tests alone do not prove that the configured model selects the tool.

New native tools are registered only at conversation creation. Existing WebSearch conversations continue working but cannot gain WebRead on resume. Forks preserve tool registration and policy. A model profile with `webSearch: "disabled"` disables live reading too; cached-only search profiles can read live pages. Helper agents ask the main agent to read pages in this release.

## Network and execution boundary

The browser worker uses fixed server-owned Crawl4AI settings on an internal Docker network. Its only public network path is the dedicated HTTP/CONNECT proxy. The proxy resolves every destination, rejects non-public addresses, and connects to a vetted address directly, so DNS is not resolved a second time before dialing. Redirect destinations and browser subresources pass through the same boundary. Chromium's implicit loopback proxy bypass is disabled.

The reader and its proxy have no published host ports. The existing authenticated API is the host-running harness entry point. Internal API and reader credentials stay in service configuration and do not enter the model subprocess environment. Routine logs exclude target URLs, page text and credentials.

Reads admit two simultaneous operations independently of searches. The worker has a 30-second outer deadline, the adapter defaults to 35 seconds and the harness to 50 seconds, allowing cancellation and cleanup to finish. Responses are bounded, and no browser worker survives a completed request. Interruption, policy disablement, thread deletion and runtime shutdown abort active reads. Worker cancellation must also terminate the browser process group; aborting only the HTTP request is insufficient. Empty content, unsupported formats, denied destinations, missing pages and upstream failures use distinct safe error codes.

## Validation

```sh
npm test
npm --prefix frontend test
npm run build
npm run codex:verify
npm run websearch:smoke
npm run webread:smoke
docker compose --env-file deploy/websearch.env -f deploy/websearch.compose.yaml --profile webread exec -T crawl4ai python < scripts/webread-browser-smoke.py
```

The browser smoke injects controlled public-page HTML into the actual worker/browser configuration and checks private subresource/redirect denial against a loopback sentinel, direct network egress denial, JavaScript rendering and Unicode accounting. The fixture override exists only in the developer test process; it is not exposed by the reader API.

The reader smoke uses real Crawl4AI for a static page and a JavaScript-rendered page, checks provenance and content bounds, and verifies private-target denial. `WEB_READ_SMOKE_URL` can replace its public fixture URLs. Gateway fixtures and pinned-runtime fixtures validate function-call translation and dispatch; actual configured-model acceptance is tested separately against the running local app.

### Acceptance observed on 2026-10-04

- Actual configured `claude-sonnet-5` through the running platform/gateway called native `web_read` on the JavaScript quotes page (4,862 ms) and answered from its content with a direct page citation.
- A second real-model conversation found the official SearXNG API documentation via `web_search` (893 ms), read it with `web_read` (2,321 ms), then explained JSON requests with the documentation link.
- Final deployed image passed static and JavaScript extraction, initial private URL refusal, real browser private redirects/subresources, zero loopback sentinel hits, direct egress denial and UTF-16 accounting. An aborted API read left no `truex-read-*` scratch directories after completion; per-read process groups and scratch directories are cleaned on success/cancellation.
- Backend regressions passed: 228 core, 146 platform, 64 gateway and 43 service tests; the separate frontend suite passed 178. One opt-in Search live test was skipped in the ordinary core run. Seven offline Python worker regressions passed inside the pinned image, including cancellation arriving during process cleanup. Root production builds and pinned runtime verification passed.

The local Search/Read stack remains running and the actual harness has `WEB_READ=on`. Credentials remain in ignored env files. Existing conversations created without Read still need a new conversation.

The SDK worker is built on official Crawl4AI `0.9.2`, pinned to multiarchitecture image digest `sha256:bd36741e7bdd35ddc1a05d9183e1d6d8cefb61dd640d944a25d026b76e917690`. A narrow authenticated API replaces its general-purpose server: the upstream API does not accept the fixed proxy/launch options needed by this isolated browser configuration.

## References

- [Crawl4AI self-hosting](https://docs.crawl4ai.com/core/self-hosting/)
- [Browser and crawler configuration](https://docs.crawl4ai.com/core/browser-crawler-config/)
- [Crawl result and Markdown fields](https://docs.crawl4ai.com/api/crawl-result/)
