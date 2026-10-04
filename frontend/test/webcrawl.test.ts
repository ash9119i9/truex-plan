import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantCapabilities,
  webCrawlAvailabilityMessage,
} from "../../shared/assistant-capabilities.ts";
import {
  cancelCrawl,
  crawlIsActive,
  crawlMarkdown,
  crawlResults,
  crawlSourceUrl,
  listCrawls,
} from "../lib/crawls.ts";
import { timelineLayout } from "../lib/observability.ts";

test("WebCrawl capability explains background collection and new-conversation availability", () => {
  const capability = assistantCapabilities.find(
    (item) => item.id === "webCrawl",
  );
  assert.match(capability!.prompt, /Crawl.*public website/);
  assert.match(
    capability!.description,
    /background.*progress.*cancel.*Markdown/,
  );
  assert.equal(webCrawlAvailabilityMessage(null), null);
  assert.match(
    webCrawlAvailabilityMessage(true)!,
    /available in this conversation/,
  );
  assert.match(webCrawlAvailabilityMessage(false)!, /Start a new conversation/);
});

test("saved job API calls scope list/results/cancel to an encoded session without tenant or ownership headers", async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(calls.length === 1 ? { jobs: [] } : {}),
      );
    },
  );
  const controller = new AbortController();
  assert.deepEqual(await listCrawls("session/one", controller.signal), []);
  await crawlResults("session/one", "job/one", 3, controller.signal);
  await cancelCrawl("session/one", "job/one", controller.signal);
  assert.match(calls[0].url, /\/api\/sessions\/session%2Fone\/crawls$/);
  assert.match(
    calls[1].url,
    /job%2Fone\/results\?offset=3&limit=3&maxChars=20000$/,
  );
  assert.match(calls[2].url, /job%2Fone\/cancel$/);
  assert.equal(calls[2].init?.method, "POST");
  assert.equal(calls[2].init?.body, "{}");
  for (const call of calls)
    assert.deepEqual(call.init?.headers, {
      "Content-Type": "application/json",
    });
});

test("active states include cancellation in progress, terminal jobs stop polling, and unsafe source links are inert", () => {
  for (const state of ["queued", "running", "cancelling"] as const)
    assert.equal(crawlIsActive(state), true);
  for (const state of ["completed", "partial", "failed", "cancelled"] as const)
    assert.equal(crawlIsActive(state), false);
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "https://user:secret@example.com",
    "http://localhost/",
    "http://127.1/",
    "http://[::1]/",
    "http://10.1.1.1/",
  ])
    assert.equal(crawlSourceUrl(url), null, url);
  assert.equal(
    crawlSourceUrl("https://example.com/a"),
    "https://example.com/a",
  );
});

test("Markdown downloads identify their source and retain truncation disclosure without generating HTML", () => {
  const content = crawlMarkdown({
    sourceId: "source-1",
    requestedUrl: "https://example.com",
    url: "https://example.com/a",
    title: "Page\nTitle",
    retrievedAt: "2026-10-04T00:00:00Z",
    statusCode: 200,
    depth: 1,
    markdown: "# Actual saved page\n\n<script>untrusted text</script>",
    totalChars: 5000,
    truncated: true,
  });
  assert.match(content, /# Page Title/);
  assert.match(content, /Source: https:\/\/example.com\/a/);
  assert.match(content, /bounded excerpt/);
  assert.match(content, /Actual saved page/);
});

test("webCrawl timeline fallback keeps background job requests distinct", () => {
  const layout = timelineLayout({
    turnId: "crawl-turn",
    threadId: "main",
    startedAt: "2026-10-04T00:00:00.000Z",
    totalMs: 100,
    status: "completed",
    steps: [
      {
        id: "crawl-step",
        kind: "webCrawl",
        label: "",
        agent: "main",
        agentThreadId: "main",
        startMs: 0,
        durationMs: 100,
        status: "completed",
      },
    ],
    usage: null,
    helperUsage: null,
    rateLimits: null,
    privacy: { scannedChars: 0, findings: [] },
  });
  assert.equal(layout.lanes[0].steps[0].label, "Web crawl request");
});
