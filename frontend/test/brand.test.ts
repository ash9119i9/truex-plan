import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { Brand } = component("auth/login-card.tsx");
const { JoinPage } = component("invite/join-page.tsx");

// DESIGN-SPEC 2.4: the application mark is a signal-filled rounded rectangle
// holding two white eyes; it replaces the old dark "t" tile and sparkle.
const EYES =
  /<ellipse[^>]*cx="8\.6"[^>]*>(<\/ellipse>)?<ellipse[^>]*cx="15\.4"/;

test("the sign-in brand is the spec's app mark and wordmark", () => {
  const html = renderToStaticMarkup(createElement(Brand));
  assert.match(html, /class="pt-brand-mark"/);
  assert.match(html, EYES);
  assert.match(html, /class="pt-brand-word"[^>]*>truex</);
  assert.doesNotMatch(html, /au-mark/);
});

test("the invitation page uses the same app mark", () => {
  const html = renderToStaticMarkup(
    createElement(JoinPage, { token: "t", invite: null }),
  );
  assert.match(html, /class="pt-brand-mark"/);
  assert.match(html, EYES);
  assert.doesNotMatch(html, /jp-brand-mark/);
});

test("the favicon is the app mark in signal blue", () => {
  const icon = new URL("../app/icon.svg", import.meta.url);
  assert.ok(existsSync(icon), "app/icon.svg is missing");
  const svg = readFileSync(icon, "utf8");
  assert.match(svg, /fill="#3691CD"/i);
  assert.equal(svg.match(/<ellipse/g)?.length, 2);
});

test("the sign-in screen keeps its one serif accent in the headline", () => {
  // DESIGN-SPEC 3.6 and 20: at most one Instrument Serif accent per surface.
  // The headline's "agents" is it; the capabilities board beside it has none.
  const board = readFileSync(
    new URL("../styles/app/capabilities-board.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(board, /var\(--f-serif\)/);
});
