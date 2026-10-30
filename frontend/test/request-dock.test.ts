import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  countdown,
  dockQueue,
  onceAtATime,
  requestKey,
} from "../lib/request-dock.ts";
import { component } from "./next-details-runtime.ts";

const { RequestDock } = component("tenant/request-dock.tsx");

const approval = (id: string, extra: Record<string, unknown> = {}) => ({
  approvalId: id,
  itemId: `item-${id}`,
  kind: "mcp",
  connector: "crm",
  tool: "create_deal",
  params: [{ name: "amount", value: "182400" }],
  status: "pending",
  expiresAt: null,
  allowForChat: true,
  ...extra,
});
const live = (approvals: ReturnType<typeof approval>[], order: string[]) => ({
  runId: "r1",
  phase: "streaming",
  since: 0,
  items: order.map((id) => ({
    type: "tool",
    itemId: `item-${id}`,
    connector: "crm",
    tool: "create_deal",
    status: "inProgress",
    durationMs: null,
    errorCode: null,
  })),
  helpers: [],
  approvals: Object.fromEntries(approvals.map((a) => [a.approvalId, a])),
  connectorFailures: [],
  unsaved: [],
  outcome: null,
  saveFailed: false,
});

test("the countdown is text: m:ss under an hour, h mm above, warn in the last minute", () => {
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  const at = (s: number) => new Date(now + s * 1000).toISOString();
  assert.deepEqual(countdown(at(299), now), {
    text: "4:59",
    label: "Expires in 4 minutes",
    warn: false,
    expired: false,
  });
  assert.equal(countdown(at(3900), now)?.text, "1h 05m");
  assert.equal(countdown(at(42), now)?.warn, true);
  assert.equal(countdown(at(42), now)?.label, "Expires in 42 seconds");
  assert.deepEqual(countdown(at(-1), now), {
    text: "Expired",
    label: "Expired",
    warn: true,
    expired: true,
  });
  assert.equal(countdown(null, now), null);
});

test("the dock holds pending requests oldest first, in stream order", () => {
  const reply = live(
    [approval("b"), approval("a"), approval("c", { status: "allow" })],
    ["a", "b", "c"],
  );
  assert.deepEqual(
    dockQueue(reply as never).map((a) => a.approvalId),
    ["a", "b"],
  );
  assert.deepEqual(dockQueue(null), []);
});

test("1, 2 and Esc map to the decisions the card shows", () => {
  assert.equal(requestKey("1", { allowForChat: true }), "allow");
  assert.equal(requestKey("2", { allowForChat: true }), "allow_for_chat");
  assert.equal(requestKey("2", { allowForChat: false }), null);
  assert.equal(requestKey("Escape", { allowForChat: false }), "deny");
  assert.equal(requestKey("3", { allowForChat: true }), null);
});

test("a decision goes out once, even on a double click", async () => {
  let calls = 0;
  let release!: () => void;
  const decide = onceAtATime(
    () =>
      new Promise<void>((resolve) => {
        calls += 1;
        release = resolve;
      }),
  );
  void decide();
  void decide();
  assert.equal(calls, 1);
  release();
  await new Promise((r) => setTimeout(r, 0));
  void decide();
  assert.equal(calls, 2);
});

const dock = (reply: unknown, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(RequestDock, {
      live: reply,
      connectors: [{ slug: "crm", displayName: "CRM" }],
      busy: null,
      onApprove() {},
      ...extra,
    }),
  );

test("two pending requests show one card, 1 of 2, docked above the composer", () => {
  const html = dock(live([approval("a"), approval("b")], ["a", "b"]));
  assert.match(
    html,
    /^<div class="cs-pinned" role="region" aria-label="Waiting for your answer">/,
  );
  assert.equal((html.match(/<section class="rq/g) ?? []).length, 1);
  assert.match(html, /<section class="rq is-tool" aria-labelledby="[^"]+"/);
  assert.match(html, /class="rq-title"[^>]*>Permission needed</);
  assert.match(html, /class="aq-step">1 of 2</);
  assert.match(html, /class="at-name">Create deal</);
  assert.match(html, /class="at-connector">CRM</);
  assert.match(html, /role="group" aria-label="Your decision"/);
  // default-height decision buttons (D11), one primary
  const buttons = html.match(/<button[^>]*class="tx-btn[^"]*"[^>]*>/g) ?? [];
  assert.ok(buttons.length >= 3);
  for (const b of buttons) assert.doesNotMatch(b, /tx-sm|tx-xs/);
  assert.equal((html.match(/tx-primary/g) ?? []).length, 1);
  assert.match(html, /Allow once<kbd class="tx-kbd">1<\/kbd>/);
  assert.match(
    html,
    /class="tx-btn rq-soft"[^>]*>Allow for this chat<kbd class="tx-kbd">2<\/kbd>/,
  );
  assert.match(
    html,
    /class="tx-btn tx-ghost"[^>]*>Don’t allow<kbd class="tx-kbd">Esc<\/kbd>/,
  );
});

test("nothing docks without a pending request; an expired one says so and offers nothing", () => {
  assert.equal(dock(live([], [])), "");
  const html = dock(
    live([approval("a", { expiresAt: "2000-01-01T00:00:00.000Z" })], ["a"]),
  );
  assert.match(
    html,
    /This question has expired\. Send a message to continue\./,
  );
  assert.doesNotMatch(html, /Allow once/);
  assert.match(
    html,
    /class="rq-time is-warn" role="timer" aria-label="Expired">Expired</,
  );
});

test("the card names the tool once: no Action row restating the title", () => {
  const html = dock(live([approval("a")], ["a"]));
  assert.doesNotMatch(html, /aq-action|wants to/);
  assert.match(html, /class="at-name">Create deal</);
});

test("the dock lines up with the composer, and the card draws one border", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(
    new URL("../styles/app/request.css", import.meta.url),
    "utf8",
  );
  const rule = (sel: string) =>
    css.match(
      new RegExp(`(^|\\n)${sel.replace(/[.:]/g, "\\$&")} \\{([^}]*)\\}`),
    )?.[2] ?? "";
  // same column as .cs-composer-wrap (11.5): max --thread
  assert.match(rule(".cs-pinned"), /max-width: var\(--thread\)/);
  // the card is focused for keyboard reach, but it isn't a control: no
  // second ring around its border
  assert.doesNotMatch(css, /\.rq:focus(-visible)? \{[^}]*--focus/);
});
