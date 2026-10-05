import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import type { DomainEvent } from "../../shared/contracts.ts";

const { ThinkingBlock } = component("thinking-block.tsx");
const { SessionActivity } = component("session-activity.tsx");
const { StreamingMarkdown } = component("streaming-markdown.tsx");
const { ChatMessages } = component("chat-messages.tsx");
const render = (Component: any, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(Component, props));
const done = (status: string): DomainEvent => ({
  type: "turn.completed",
  seq: 2,
  cursor: "fixture:2",
  threadId: "fixture",
  turnId: "turn-fixture",
  at: "2026-10-05T00:00:01Z",
  data: { turn: { status } },
});
const activity = {
  events: [],
  plan: [],
  timings: [],
  goal: null,
  goalReview: null,
};

test("closed reasoning excludes the full body and never joins or counts it", () => {
  const parts = [{ text: "fixture reasoning ".repeat(50_000) }];
  const stringMarkup = render(ThinkingBlock, { text: parts[0].text });
  assert.ok(stringMarkup.length < 1200);
  assert.ok(!stringMarkup.includes("fixture reasoning"));
  Object.defineProperty(parts, "map", {
    value() {
      throw new Error("Hidden trace joined");
    },
  });
  const html = render(ThinkingBlock, { text: parts });
  assert.ok(html.length < 1200);
  assert.ok(!html.includes("fixture reasoning"));
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls=/);
  assert.match(html, /Complete/);
});

test("empty reasoning disappears; streaming empty trace remains a disclosure", () => {
  assert.equal(render(ThinkingBlock, { text: " \n\t" }), "");
  assert.equal(render(ThinkingBlock, { text: [{ text: "" }] }), "");
  assert.match(
    render(ThinkingBlock, { text: "", streaming: true }),
    /Thinking…/,
  );
});

test("failed, interrupted and unknown terminal outcomes never guess 100 percent", () => {
  for (const status of ["failed", "interrupted", "completed", "unknown"]) {
    const html = render(SessionActivity, {
      ...activity,
      events: [done(status)],
    });
    assert.ok(!html.includes("100%"), status);
    assert.ok(!html.includes('role="progressbar"'), status);
    if (status !== "completed") assert.ok(!html.includes("Completed in"));
    if (status === "unknown") assert.match(html, /Request ended/);
  }
});

test("terminal percentage uses authoritative plan progress including partial plans", () => {
  const plan = [
    { step: "A", status: "completed" },
    { step: "B", status: "pending" },
  ];
  for (const status of ["failed", "interrupted", "completed"]) {
    const html = render(SessionActivity, {
      ...activity,
      plan,
      events: [done(status)],
    });
    assert.match(html, /aria-label="Plan progress"/);
    assert.match(html, /aria-valuenow="50"/);
    assert.ok(!html.includes("100%"));
  }
});

test("closed activity never enumerates event bodies", () => {
  const events = new Proxy([], {
    get(target, property, receiver) {
      if (property === "forEach" || property === "map")
        throw new Error("Hidden activity projected");
      return Reflect.get(target, property, receiver);
    },
  });
  const html = render(SessionActivity, { ...activity, events, open: false });
  assert.ok(!html.includes("live-head"));
  assert.match(html, /tabindex="-1"/);
});

test("Markdown controls leave code bytes and safe Markdown handling intact", () => {
  const html = render(StreamingMarkdown, {
    text: "```txt\n  λ <tag> & value\n\n```\n\n[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>",
    streaming: false,
  });
  assert.match(html, /aria-label="Copy code"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(
    html,
    /<code class="language-txt">  λ &lt;tag&gt; &amp; value\n\n<\/code>/,
  );
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes("<script>"));
});

test("long prompts expose an accessible disclosure and preserve stable turn anchors and full text", () => {
  const text = "Unicode λ\n".repeat(90);
  const html = render(ChatMessages, {
    entries: [
      { kind: "message", id: "prompt", role: "user", text },
      {
        kind: "message",
        id: "answer",
        role: "assistant",
        text: "**exact answer**",
        turnId: "turn-fixture",
        done: true,
      },
    ],
    agentName: "Fixture",
    running: false,
  });
  assert.match(html, /Show full message/);
  assert.match(html, /data-collapsed="true"/);
  assert.ok(html.includes(text));
  assert.match(html, /id="request-prompt"/);
  assert.match(html, /id="turn-turn-fixture"/);
  assert.match(html, /aria-label="Copy answer"/);
});
