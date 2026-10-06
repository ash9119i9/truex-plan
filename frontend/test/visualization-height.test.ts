import { test } from "node:test";
import assert from "node:assert/strict";
import { visualizationFrameHeight } from "../lib/visualization.ts";
import type { Visualization } from "../../shared/visualizations.ts";

const visual: Visualization = {
  id: "12345678-1234-1234-1234-123456789abc",
  title: "Chart",
  description: "Chart",
  mode: "inline",
  html: "<p>Chart</p>",
  heights: [
    [320, 200],
    [728, 500],
    [1000, 1200],
  ],
};

test("initial frame height picks nearest measured width and clamps", () => {
  assert.equal(visualizationFrameHeight(visual, 300), 200);
  assert.equal(visualizationFrameHeight(visual, 700), 500);
  assert.equal(visualizationFrameHeight(visual, 980), 900);
  assert.equal(visualizationFrameHeight({ ...visual, height: 300 }, 728), 300);
  assert.equal(
    visualizationFrameHeight({ ...visual, heights: undefined }, 728),
    360,
  );
  assert.equal(visualizationFrameHeight({ ...visual, heights: [] }, 728), 360);
});

test("page resize reports take over from measured height", () => {
  assert.equal(visualizationFrameHeight(visual, 728, 300), 304);
  assert.equal(visualizationFrameHeight(visual, 728, 50), 160);
  assert.equal(visualizationFrameHeight(visual, 728, 1000), 900);
});
