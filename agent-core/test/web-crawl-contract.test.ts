import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWebCrawlInput,
  parseWebCrawlResultsQuery,
  isWebCrawlTerminal,
} from "../../shared/web-crawl";
const jobId = "12345678-1234-1234-1234-123456789abc";
test("crawl action contract normalizes defaults and separates action arguments", () => {
  assert.deepEqual(
    parseWebCrawlInput({
      action: "start",
      url: "https://example.com/#ignored",
    }),
    { action: "start", url: "https://example.com/", maxPages: 25, maxDepth: 2 },
  );
  assert.deepEqual(parseWebCrawlInput({ action: "results", jobId }), {
    action: "results",
    jobId,
    offset: 0,
    limit: 3,
    maxChars: 20000,
  });
  for (const input of [
    { action: "start", url: "https://example.com", maxPages: null },
    { action: "start", url: "https://example.com", maxPages: 101 },
    { action: "start", url: "https://example.com", maxDepth: 4 },
    { action: "start", url: "https://user:secret@example.com" },
    { action: "start", url: "https://localhost/" },
    { action: "start", url: "https://example.com", tenantId: "other" },
    { action: "start", url: "https://example.com", jobId },
    { action: "status", jobId: "../../other" },
    { action: "status", jobId, url: "https://example.com" },
    { action: "cancel", jobId, offset: 0 },
    { action: "results", jobId, maxChars: 50001 },
    { action: "results", jobId, limit: 0 },
    { action: "results", jobId, offset: -1 },
    { action: "unknown", jobId },
  ])
    assert.throws(() => parseWebCrawlInput(input));
});
test("crawl HTTP query validation rejects duplicate, coercible and unknown values", () => {
  assert.deepEqual(
    parseWebCrawlResultsQuery({ offset: "2", limit: "5", maxChars: "100" }),
    { offset: 2, limit: 5, maxChars: 100 },
  );
  for (const input of [
    { limit: ["1", "2"] },
    { limit: "1.0" },
    { offset: "-1" },
    { offset: "01" },
    { maxChars: " 10" },
    { jobId },
    { limit: 1 },
    { limit: "11" },
  ])
    assert.throws(() => parseWebCrawlResultsQuery(input));
  for (const state of ["completed", "partial", "failed", "cancelled"] as const)
    assert.equal(isWebCrawlTerminal(state), true);
  for (const state of ["queued", "running", "cancelling"] as const)
    assert.equal(isWebCrawlTerminal(state), false);
});
