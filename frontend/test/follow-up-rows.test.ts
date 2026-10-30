import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { FollowUpRows } = component("tenant/follow-up-rows.tsx");

const items = [
  { slot: 1, intent: "act", text: "Draft an ABAP report" },
  { slot: 2, intent: "verify", text: "Check the access sequence" },
  { slot: 3, intent: "reply", text: "S/4HANA 2023, client 100" },
];

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(FollowUpRows, props));

test("renders up to three real buttons labelled Follow Up", () => {
  const html = render({ items, onSelect: async () => true });
  // DESIGN-SPEC 11.7: a .cs-next list of "↳ question" rows, labelled for AT.
  assert.match(html, /<section class="cs-next" aria-labelledby="[^"]+">/);
  assert.match(html, /<h3 class="tx-sr"[^>]*>Follow Up<\/h3>/);
  assert.equal((html.match(/class="cs-next-row"/g) ?? []).length, 3);
  assert.equal(
    (html.match(/class="cs-next-mark" aria-hidden="true">↳</g) ?? []).length,
    3,
  );
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  // Only act carries the action mark; the rest are replies.
  assert.equal((html.match(/data-intent="act"/g) ?? []).length, 1);
  // The accessible name is the row's text: no aria-label replaces it.
  assert.doesNotMatch(html, /aria-label=/);
  assert.match(html, />Check the access sequence</);
});

test("row text is plain text, never markup", () => {
  const html = render({
    items: [{ slot: 1, intent: "act", text: '<img src=x onerror="alert(1)">' }],
    onSelect: async () => true,
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("nothing renders for an empty set", () => {
  const html = render({ items: [], onSelect: async () => true });
  assert.match(html, /Follow Up/);
  assert.doesNotMatch(html, /<button/);
});
