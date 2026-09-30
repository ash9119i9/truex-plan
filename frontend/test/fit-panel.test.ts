import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_MIN, fitPanel, PANEL_W } from "../lib/fit-panel.ts";

const fit = (vw: number, size: "min" | "max", sidebarOpen = true, panelOpen = true) =>
  fitPanel(vw, PANEL_W[size], CHAT_MIN[size], sidebarOpen, panelOpen);

test("min size: sidebar and docked panel from 1148px", () => {
  for (const vw of [1148, 1440, 1920])
    assert.deepEqual(fit(vw, "min"), { width: 360, sidebar: true, overlay: false });
});

test("min size: sidebar yields between 901 and 1147px, panel never floats", () => {
  for (const vw of [901, 1000, 1147])
    assert.deepEqual(fit(vw, "min"), { width: 360, sidebar: false, overlay: false });
});

test("max size: both from 1508px", () => {
  for (const vw of [1508, 1600])
    assert.deepEqual(fit(vw, "max"), { width: 560, sidebar: true, overlay: false });
});

test("max size: sidebar hidden between 1230 and 1507px", () => {
  for (const vw of [1230, 1400, 1507])
    assert.deepEqual(fit(vw, "max"), { width: 560, sidebar: false, overlay: false });
});

test("max size: panel floats between 901 and 1229px", () => {
  for (const vw of [901, 1100, 1229])
    assert.deepEqual(fit(vw, "max"), { width: 560, sidebar: false, overlay: true });
});

test("≤900px: sidebar allowed, panel is a CSS drawer (no overlay flag)", () => {
  for (const size of ["min", "max"] as const)
    for (const vw of [721, 800, 900])
      assert.deepEqual(fit(vw, size), { width: PANEL_W[size], sidebar: true, overlay: false });
});

test("≤720px: one drawer at a time, width clamps to vw − 20", () => {
  assert.deepEqual(fit(720, "min"), { width: 360, sidebar: false, overlay: false });
  assert.deepEqual(fit(375, "min"), { width: 355, sidebar: false, overlay: false });
  assert.deepEqual(fit(375, "max", true, false), { width: 355, sidebar: true, overlay: false });
});

test("panel closed: sidebar always allowed", () => {
  for (const vw of [901, 1100, 1600])
    assert.deepEqual(fit(vw, "max", true, false), { width: 560, sidebar: true, overlay: false });
});

test("sidebar not requested: panel docks unless chat is too narrow", () => {
  assert.deepEqual(fit(1300, "max", false), { width: 560, sidebar: true, overlay: false });
  assert.deepEqual(fit(1100, "max", false), { width: 560, sidebar: true, overlay: true });
  assert.deepEqual(fit(1000, "min", false), { width: 360, sidebar: true, overlay: false });
});
