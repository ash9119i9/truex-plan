import assert from "node:assert/strict";
import { test } from "node:test";
import { publicEvent, publicTrace } from "../src/public";

test("WebCrawl activities use action-specific safe labels and never expose args, jobs or raw results", () => {
  for (const [action, started, completed] of [
    ["start", "Starting a web crawl", "Background web crawl started"],
    ["status", "Checking web crawl progress", "Web crawl progress checked"],
    ["results", "Reading web crawl results", "Web crawl results read"],
    ["cancel", "Cancelling a web crawl", "Web crawl cancellation requested"],
  ]) {
    for (const [type, success, label] of [
      ["item.started", undefined, started],
      ["item.completed", true, completed],
      ["item.completed", false, "Web crawl request could not be completed"],
    ]) {
      for (const arguments_ of [
        { action, url: "https://private.example/", jobId: "private-job" },
        JSON.stringify({ action, jobId: "private-job" }),
      ]) {
        const event = publicEvent({
          type,
          data: {
            item: {
              type: "dynamicToolCall",
              tool: "web_crawl",
              arguments: arguments_,
              success,
              result: {
                pages: [{ markdown: "raw-private-page" }],
                url: "http://web-service.internal",
                credential: "service-key",
              },
            },
          },
        });
        assert.deepEqual(event.data, { label });
        assert.equal(event.type, "activity.updated");
        assert.doesNotMatch(
          JSON.stringify(event),
          /private|internal|service-key|markdown|jobId|credential/,
        );
      }
    }
  }
});

test("unknown or malformed WebCrawl actions receive generic labels without parsing diagnostics", () => {
  for (const arguments_ of [
    "not json",
    { action: "private-query" },
    undefined,
  ]) {
    const event = publicEvent({
      type: "item.completed",
      data: {
        item: {
          type: "dynamicToolCall",
          tool: "web_crawl",
          arguments: arguments_,
          success: true,
        },
      },
    });
    assert.deepEqual(event.data, { label: "Web crawl request finished" });
  }
});

test("public traces retain WebCrawl type but project away backend/raw page metadata", () => {
  const trace = publicTrace({
    turnId: "crawl-turn",
    steps: [
      {
        id: "crawl-step",
        kind: "webCrawl",
        label: "Background web crawl started",
        agent: "main",
        agentThreadId: "internal-thread",
        startMs: 0,
        durationMs: 10,
        status: "completed",
        arguments: { jobId: "private-job" },
        markdown: "private-raw-page",
      },
    ],
  });
  assert.equal(trace?.steps[0].kind, "webCrawl");
  assert.equal(trace?.steps[0].agentThreadId, "main");
  assert.doesNotMatch(
    JSON.stringify(trace),
    /private|internal-thread|arguments|markdown/,
  );
});
