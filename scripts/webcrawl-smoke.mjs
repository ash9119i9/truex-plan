import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = new URL(process.env.WEB_SERVICE_URL || "http://127.0.0.1:4400");
const token = process.env.WEB_SERVICE_TOKEN || "";
assert.ok(
  /^[A-Za-z0-9_-]{32,256}$/.test(token),
  "Configure WEB_SERVICE_TOKEN.",
);
const sessionId = `smoke_${randomUUID()}`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "x-truex-tenant-id": "webcrawl-smoke",
  "x-truex-session-id": sessionId,
};
async function request(path, method = "GET", input, extra = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...headers, ...extra },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json();
  assert.ok(
    response.ok,
    `${path} failed: HTTP${response.status} (${body.code || "unknown"}).`,
  );
  return body;
}
try {
  await request("/crawl/ready");
  const input = {
    url: process.env.WEB_CRAWL_SMOKE_URL || "https://quotes.toscrape.com/",
    maxPages: 3,
    maxDepth: 1,
  };
  const key = randomUUID();
  const job = await request("/crawl/jobs", "POST", input, {
    "x-truex-idempotency-key": key,
  });
  const duplicate = await request("/crawl/jobs", "POST", input, {
    "x-truex-idempotency-key": key,
  });
  assert.equal(duplicate.jobId, job.jobId);
  let status;
  for (let i = 0; i < 100; i++) {
    status = await request(`/crawl/jobs/${job.jobId}`);
    if (["completed", "partial", "failed", "cancelled"].includes(status.state))
      break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert.ok(
    ["completed", "partial"].includes(status.state),
    "Crawl did not produce successful terminal results.",
  );
  assert.ok(status.counts.attempted <= 3 && status.counts.attempts <= 9);
  const results = await request(
    `/crawl/jobs/${job.jobId}/results?offset=0&limit=3&maxChars=20000`,
  );
  assert.equal(results.totalPages, status.counts.succeeded);
  assert.ok(results.pages.length > 0 && results.pages.length <= 3);
  assert.ok(results.pages.reduce((n, p) => n + p.markdown.length, 0) <= 20000);
  const unique = new Set();
  for (const page of results.pages) {
    assert.equal(new URL(page.url).hostname, new URL(input.url).hostname);
    assert.ok(page.markdown.trim());
    assert.ok(page.depth <= 1);
    assert.ok(page.totalChars >= page.markdown.length);
    assert.ok(!unique.has(page.sourceId));
    unique.add(page.sourceId);
  }
  const foreign = await fetch(new URL(`/crawl/jobs/${job.jobId}`, base), {
    headers: { ...headers, "x-truex-session-id": `foreign_${randomUUID()}` },
  });
  assert.equal(foreign.status, 404);
  console.log(
    JSON.stringify({
      jobId: job.jobId,
      state: status.state,
      reason: status.reason,
      counts: status.counts,
      sources: results.pages.map(({ sourceId, url, title, depth }) => ({
        sourceId,
        url,
        title,
        depth,
      })),
    }),
  );
  console.log(
    "Live Crawlee+Crawl4AI traversal, idempotency, bounds and session isolation passed.",
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.replaceAll(token, "[redacted]")
      : "WebCrawl smoke failed.",
  );
  process.exitCode = 1;
} finally {
  try {
    await request("/crawl/jobs", "DELETE");
  } catch {
    console.error("Smoke-job cleanup failed; remove only its test scope.");
    process.exitCode = 1;
  }
}
