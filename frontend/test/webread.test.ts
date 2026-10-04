import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantCapabilities,
  webReadAvailabilityMessage,
} from "../../shared/assistant-capabilities.ts";
import { timelineLayout } from "../lib/observability.ts";

test("Web read has a URL prompt independent of Web search", () => {
  const read = assistantCapabilities.find(
    (capability) => capability.id === "webRead",
  );
  const search = assistantCapabilities.find(
    (capability) => capability.id === "web",
  );
  assert.equal(read?.name, "Web read");
  assert.match(read!.prompt, /Read.*URL/);
  assert.match(read!.description, /bounded Markdown/);
  assert.equal(search?.name, "Web search");
  assert.match(search!.prompt, /Search the web/);
});

test("WebRead availability reflects registration and gives old conversations a recovery action", () => {
  assert.equal(webReadAvailabilityMessage(null), null);
  assert.match(
    webReadAvailabilityMessage(true)!,
    /available in this conversation/,
  );
  assert.match(
    webReadAvailabilityMessage(false)!,
    /unavailable.*Start a new conversation/,
  );
});

test("webRead timeline fallback names webpage reading accurately", () => {
  const layout = timelineLayout({
    turnId: "read-turn",
    threadId: "main",
    startedAt: "2026-10-04T00:00:00.000Z",
    totalMs: 100,
    status: "completed",
    steps: [
      {
        id: "read-step",
        kind: "webRead",
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
  assert.equal(layout.lanes[0].steps[0].label, "Web page read");
});
