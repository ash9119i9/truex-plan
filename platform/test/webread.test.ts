import { test } from "node:test";
import assert from "node:assert/strict";
import { publicEvent, publicTrace } from "../src/public";

test("web reading activity exposes accurate labels without page content or service data", () => {
  for (const [type, success, label] of [
    ["item.started", undefined, "Reading the web"],
    ["item.completed", true, "Web page read"],
    ["item.completed", false, "Web page could not be read"],
  ] as const) {
    const event = publicEvent({
      type,
      data: {
        item: {
          type: "dynamicToolCall",
          tool: "web_read",
          success,
          arguments: { url: "https://private.example/page" },
          result: {
            provider: "crawl4ai",
            markdown: "# Private raw page content",
            url: "http://web-service.internal",
            secret: "service-key",
          },
          error: "raw vendor stack trace",
        },
      },
    });
    assert.equal(event.type, "activity.updated");
    assert.deepEqual(event.data, { label });
    assert.doesNotMatch(
      JSON.stringify(event),
      /private|Private|crawl4ai|internal|service-key|vendor|markdown/,
    );
  }
});

test("public traces preserve webRead kind while dropping internal page fields", () => {
  const trace = publicTrace({
    turnId: "turn-read",
    steps: [
      {
        id: "read-step",
        kind: "webRead",
        label: "Web page read",
        agent: "main",
        agentThreadId: "internal-thread",
        startMs: 1,
        durationMs: 20,
        status: "completed",
        arguments: { url: "https://private.example/page" },
        markdown: "raw page content",
        provider: "crawl4ai",
      },
    ],
  });
  assert.equal(trace?.steps[0].kind, "webRead");
  assert.equal(trace?.steps[0].label, "Web page read");
  assert.equal(trace?.steps[0].agentThreadId, "main");
  assert.doesNotMatch(
    JSON.stringify(trace),
    /private|raw page|crawl4ai|internal-thread/,
  );
});
