import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recordOf } from "../lib/request-dock.ts";
import { component } from "./next-details-runtime.ts";

const { ApprovalRecord, SavedBody } = component("tenant/chat-transcript.tsx");

test("each decision has its badge, tone and summary", () => {
  assert.deepEqual(recordOf("allow"), {
    badge: "Allowed once",
    tone: "ok",
    summary: "You answered",
  });
  assert.deepEqual(recordOf("allow_for_chat"), {
    badge: "Allowed for this chat",
    tone: "ok",
    summary: "You answered",
  });
  // declined, stopped and skipped are neutral, never an error colour (spec 12, 20)
  assert.deepEqual(recordOf("deny"), {
    badge: "Not allowed",
    tone: "neutral",
    summary: "You answered",
  });
  assert.deepEqual(recordOf("expired"), {
    badge: "No answer — timed out",
    tone: "neutral",
    summary: "Closed",
  });
  assert.deepEqual(recordOf("cancelled"), {
    badge: "No answer — stopped",
    tone: "neutral",
    summary: "Closed",
  });
});

const record = (decision: string) =>
  renderToStaticMarkup(
    createElement(ApprovalRecord, {
      id: "item-1",
      title: "CRM · Create deal",
      decision,
    }),
  );

test("an ApprovalRecord is a labelled audit row with a glyph and a word", () => {
  const html = record("allow");
  assert.match(
    html,
    /^<div class="ar" role="group" aria-label="Your decision" id="approval-item-1">/,
  );
  assert.match(html, /class="ar-k">Your decision</);
  assert.match(html, /class="ar-dot is-ok" aria-hidden="true"/);
  assert.match(html, /class="ar-title">CRM · Create deal</);
  assert.match(
    html,
    /class="ar-badge is-ok">[\s\S]*#i-check[\s\S]*Allowed once</,
  );
  assert.match(html, /class="ar-foot">You answered</);
  const denied = record("deny");
  assert.match(denied, /ar-dot is-neutral/);
  assert.match(
    denied,
    /class="ar-badge is-neutral">[\s\S]*#i-ban[\s\S]*Not allowed</,
  );
  assert.doesNotMatch(denied, /is-bad/);
});

test("a saved call with a decision leaves one record in the reply's asks slot", () => {
  const html = renderToStaticMarkup(
    createElement(SavedBody, {
      entries: [
        {
          id: "m1",
          runId: "r1",
          role: "tool",
          state: "complete",
          text: "",
          createdAt: "2026-10-28T10:00:00.000Z",
          tool: {
            connector: "crm",
            name: "create_deal",
            status: "completed",
            durationMs: 900,
            errorCode: null,
            approval: "allow_for_chat",
          },
        },
        {
          id: "m2",
          runId: "r1",
          role: "assistant",
          state: "complete",
          text: "Deal created.",
          createdAt: "2026-10-28T10:00:01.000Z",
        },
      ],
      connectors: [{ slug: "crm", displayName: "CRM" }],
      note: null,
      usage: null,
      card: null,
    }),
  );
  assert.equal((html.match(/class="ar"/g) ?? []).length, 1);
  assert.match(html, /Allowed for this chat/);
  assert.ok(html.indexOf('class="ar"') < html.indexOf("Deal created."));
});
