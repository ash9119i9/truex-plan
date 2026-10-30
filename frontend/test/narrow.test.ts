import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { trapTab } from "../lib/focus-trap.ts";
import { component } from "./next-details-runtime.ts";

const { Panel } = component("v2/shell.tsx");

const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };
const outside = { id: "x" };

test("Tab from the last stop wraps to the first, Shift+Tab from the first to the last", () => {
  assert.equal(trapTab([a, b, c], c, false), a);
  assert.equal(trapTab([a, b, c], a, true), c);
});

test("Tab between inner stops is left to the browser", () => {
  assert.equal(trapTab([a, b, c], a, false), null);
  assert.equal(trapTab([a, b, c], b, true), null);
});

test("focus that escaped the trap is brought back to its first stop", () => {
  assert.equal(trapTab([a, b, c], outside, false), a);
  assert.equal(trapTab([a, b, c], null, true), c);
  // nothing focusable: Tab does nothing rather than leaving
  assert.equal(trapTab([], outside, false), undefined);
});

test("an open drawer sidebar is a labelled modal dialog; a docked one is not", () => {
  const drawer = renderToStaticMarkup(
    createElement(
      Panel,
      { kind: "sidebar", open: true, modal: true, label: "Conversations" },
      "x",
    ),
  );
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-label="Conversations"/);
  const docked = renderToStaticMarkup(
    createElement(Panel, { kind: "sidebar", open: true }, "x"),
  );
  assert.doesNotMatch(docked, /role="dialog"|aria-modal/);
});
