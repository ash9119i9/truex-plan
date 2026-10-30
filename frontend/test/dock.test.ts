import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DOCK,
  dockOpen,
  keySize,
  magnifies,
  restCentres,
  riseBand,
  settle,
  spring,
} from "../lib/dock.ts";
import { component } from "./next-details-runtime.ts";

const { FloatingDock } = component("tenant/floating-dock.tsx");

test("a key swells to the peak under the pointer and falls off by cosine to the base at reach", () => {
  assert.equal(keySize(0, 0, 1), DOCK.peak);
  assert.equal(keySize(DOCK.reach, 0, 1), DOCK.base);
  assert.equal(keySize(DOCK.reach * 3, 0, 1), DOCK.base);
  // halfway along the reach the cosine shoulder gives exactly half the growth
  assert.equal(keySize(DOCK.reach / 2, 0, 1), (DOCK.base + DOCK.peak) / 2);
  // presence scales the whole swell: no presence, no growth
  assert.equal(keySize(0, 0, 0), DOCK.base);
  assert.equal(keySize(0, 0, 0.5), (DOCK.base + DOCK.peak) / 2);
});

test("resting key centres come from the base layout, centred on the dock", () => {
  assert.deepEqual(restCentres(3, 12), [-52, 0, 52]);
  assert.deepEqual(restCentres(2, 12), [-26, 26]);
});

test("the pointer and presence springs settle on their targets without overshoot", () => {
  const s = { x: 0, v: 0, t: 100 };
  let max = 0;
  for (let i = 0; i < 240; i++) {
    spring(s, DOCK.wPointer, 1 / 60);
    max = Math.max(max, s.x);
  }
  assert.ok(max <= 100.0001, `overshot to ${max}`);
  assert.ok(Math.abs(s.x - 100) < 0.05);
  // a dropped frame is integrated in fixed sub-steps, so it stays stable
  const big = { x: 0, v: 0, t: 1 };
  spring(big, DOCK.wPresence, 0.064);
  assert.ok(big.x > 0 && big.x < 1);
  assert.equal(settle({ x: 0.9999, v: 0.0001, t: 1 }, 0.001), true);
  assert.equal(settle({ x: 0.5, v: 0, t: 1 }, 0.001), false);
});

test("the dock rises within 10px of the bottom and only stows past its reach (hysteresis)", () => {
  const reach = 100;
  // stowed: 11px from the bottom is not enough; 10px is
  assert.equal(dockOpen(false, 11, reach, false), false);
  assert.equal(dockOpen(false, 10, reach, false), true);
  // up: moving within the reach keeps it up, so it does not flicker
  assert.equal(dockOpen(true, 60, reach, false), true);
  assert.equal(dockOpen(true, 99, reach, false), true);
  assert.equal(dockOpen(true, 100, reach, false), false);
  // a focused key keeps it up wherever the pointer is
  assert.equal(dockOpen(true, 400, reach, true), true);
});

test("an empty row raises the dock across its whole footprint", () => {
  // empty chat: nothing shares the dock's row, so all 60px raise it
  assert.equal(riseBand(60, Infinity), 60);
  assert.equal(dockOpen(false, 55, 84, false, riseBand(60, Infinity)), true);
  assert.equal(dockOpen(false, 61, 84, false, riseBand(60, Infinity)), false);
  // open chat: the band stops at the composer 12px up, not over it
  assert.equal(riseBand(60, 12), 12);
  assert.equal(dockOpen(false, 20, 84, false, riseBand(60, 12)), false);
  // never thinner than the 10px edge, even when content sits on the edge
  assert.equal(riseBand(60, 2), DOCK.rise);
  // the gap below the stage is negative and always raises it
  assert.equal(dockOpen(false, -4, 84, false, riseBand(60, 12)), true);
});

test("only keyboard focus holds the dock up, so a clicked key doesn't pin it", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const css = read("../styles/app/dock.css");
  assert.doesNotMatch(css, /:focus-within/);
  assert.match(css, /\.cs-dock\.is-stowed:has\(:focus-visible\)/);
  const dock = read("../components/tenant/floating-dock.tsx");
  assert.match(dock, /el\.matches\(":focus-visible"\)/);
  assert.doesNotMatch(dock, /const focusIn = \(\) => set\(true\)/);
});

test("magnification needs a fine pointer and full motion", () => {
  assert.equal(magnifies({ reduced: false, fine: true }), true);
  assert.equal(magnifies({ reduced: true, fine: true }), false);
  assert.equal(magnifies({ reduced: false, fine: false }), false);
});

test("every dock key is a labelled button with its tooltip; toggles report their state", () => {
  const html = renderToStaticMarkup(
    createElement(FloatingDock, {
      sidebarOpen: true,
      onSidebar() {},
      onSearch() {},
      onNew() {},
      onAgent() {},
      onAccount() {},
    }),
  );
  assert.match(
    html,
    /<nav class="cs-dock is-stowed" aria-label="Workspace dock">/,
  );
  const keys: string[] = html.match(/<button[^>]*>/g) ?? [];
  assert.deepEqual(
    keys.map((k) => k.match(/aria-label="([^"]+)"/)?.[1]),
    ["Sidebar", "Search", "New chat", "Agent", "Account"],
  );
  for (const key of keys) {
    assert.match(key, /type="button"/);
    assert.match(key, /class="cs-dock-btn"/);
  }
  assert.match(keys[0], /aria-pressed="true"/);
  assert.match(keys[0], /aria-keyshortcuts="Meta\+B Control\+B"/);
  assert.match(keys[1], /aria-keyshortcuts="Meta\+K Control\+K"/);
  assert.match(keys[2], /aria-keyshortcuts="Meta\+J Control\+J"/);
  assert.equal((html.match(/role="tooltip"/g) ?? []).length, 5);
  assert.match(html, /Sidebar <kbd class="tx-kbd">⌘B<\/kbd>/);
});
