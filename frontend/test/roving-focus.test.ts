import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import { rovingMove, rovingStop } from "../lib/roving-focus.ts";

const { Tabs } = component("tx/tabs.tsx");
const { Segmented } = component("tx/segmented.tsx");
const four = [{}, {}, {}, {}];

test("arrow keys move and wrap; Home and End jump", () => {
  assert.equal(rovingMove("ArrowRight", 0, four, "horizontal"), 1);
  assert.equal(rovingMove("ArrowLeft", 0, four, "horizontal"), 3);
  assert.equal(rovingMove("ArrowRight", 3, four, "horizontal"), 0);
  assert.equal(rovingMove("Home", 2, four, "horizontal"), 0);
  assert.equal(rovingMove("End", 1, four, "horizontal"), 3);
  // Tabs ignore up/down; radiogroups rove on both axes (D14).
  assert.equal(rovingMove("ArrowDown", 1, four, "horizontal"), null);
  assert.equal(rovingMove("ArrowDown", 1, four, "both"), 2);
  assert.equal(rovingMove("ArrowUp", 0, four, "both"), 3);
  assert.equal(rovingMove("a", 1, four, "both"), null);
  assert.equal(rovingMove("ArrowRight", 0, [], "both"), null);
});

test("disabled items are skipped, and the tab order has exactly one stop", () => {
  const items = [{ disabled: true }, {}, { disabled: true }, {}];
  assert.equal(rovingMove("ArrowRight", 1, items, "horizontal"), 3);
  assert.equal(rovingMove("ArrowRight", 3, items, "horizontal"), 1);
  assert.equal(rovingMove("Home", 3, items, "horizontal"), 1);
  assert.equal(
    rovingMove("End", 1, [{}, {}, { disabled: true }], "horizontal"),
    1,
  );
  assert.equal(
    rovingMove("ArrowRight", 0, [{ disabled: true }], "horizontal"),
    null,
  );
  // The selected item holds the stop; with none usable, the first enabled one does.
  assert.equal(rovingStop(2, four), 2);
  assert.equal(rovingStop(-1, items), 1);
  assert.equal(rovingStop(0, items), 1);
  assert.equal(rovingStop(0, [{ disabled: true }]), -1);
});

test("Tabs render a tablist whose selection and stop follow the selected tab", () => {
  const html = renderToStaticMarkup(
    createElement(Tabs, {
      label: "Activity panel sections",
      idBase: "ap",
      panelId: "ap-panel",
      selected: "files",
      onSelect() {},
      items: [
        { id: "activity", label: "Activity" },
        { id: "files", label: "Files", count: 3 },
        { id: "insights", label: "Insights", disabled: true },
      ],
    }),
  );
  assert.match(
    html,
    /^<div class="tx-tabs" role="tablist" aria-label="Activity panel sections">/,
  );
  const tabs = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 3);
  assert.match(tabs[0], /role="tab"/);
  assert.match(tabs[0], /aria-selected="false"/);
  assert.match(tabs[0], /tabindex="-1"/);
  assert.match(tabs[1], /id="ap-tab-files"/);
  assert.match(tabs[1], /aria-selected="true"/);
  assert.match(tabs[1], /tabindex="0"/);
  assert.match(tabs[1], /aria-controls="ap-panel"/);
  assert.match(tabs[2], /disabled=""/);
  assert.match(html, /Files <span class="num">3<\/span>/);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
});

test("Segmented renders a roving radiogroup with aria-checked", () => {
  const html = renderToStaticMarkup(
    createElement(Segmented, {
      label: "Detail",
      value: "technical",
      onChange() {},
      size: "sm",
      options: [
        { value: "plain", label: "Plain" },
        { value: "technical", label: "Technical" },
      ],
    }),
  );
  assert.match(
    html,
    /^<div class="tx-seg tx-seg-sm" role="radiogroup" aria-label="Detail">/,
  );
  assert.match(
    html,
    /role="radio" aria-checked="false" tabindex="-1"[^>]*>Plain</,
  );
  assert.match(
    html,
    /role="radio" aria-checked="true" tabindex="0"[^>]*>Technical</,
  );
});

test("the segmented selected look also covers aria-checked radios", () => {
  for (const file of [
    "../../system/primitives.css",
    "../styles/system/primitives.css",
  ]) {
    const css = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(css, /\.tx-seg button\[aria-checked="true"\]/, file);
  }
});
