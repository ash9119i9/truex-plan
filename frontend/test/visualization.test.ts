import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitVisualizations,
  validWidgetState,
  visualizationDocument,
  visualizationExport,
} from "../lib/visualization.ts";
const id = "12345678-1234-1234-1234-123456789abc";
const reference = `[truex-visualization:${id}]`;
const visual = {
  id,
  title: "Sales",
  description: "Sales by region",
  mode: "inline" as const,
  html: '<div id="chart">Chart</div><script>document.getElementById("chart").textContent="Ready"</script>',
};

test("visual references render inline while prose and code remain intact", () => {
  assert.deepEqual(splitVisualizations(`Before\n\n${reference}\n\nAfter`), [
    { type: "markdown", text: "Before\n\n" },
    { type: "visualization", id },
    { type: "markdown", text: "\nAfter" },
  ]);
  for (const text of [
    `\`\`\`text\n${reference}\n\`\`\``,
    `Example ${reference}`,
    `    ${reference}`,
    "[truex-visualization:../../private]",
    "<script>alert(1)</script>",
  ]) {
    assert.deepEqual(splitVisualizations(text), [{ type: "markdown", text }]);
  }
  assert.deepEqual(
    splitVisualizations("Before\n[truex-visualization:1234", true),
    [{ type: "markdown", text: "Before\n" }],
  );
  assert.deepEqual(splitVisualizations(reference), [
    { type: "visualization", id },
  ]);
});
test("saved widget state is bounded and rejects invalid envelopes", () => {
  assert.ok(
    validWidgetState({
      modelContent: { rate: 4 },
      privateContent: { open: true },
    }),
  );
  for (const state of [
    null,
    [],
    "text",
    { extra: true },
    { modelContent: "a".repeat(16385) },
    { modelContent: "界".repeat(6000) },
  ])
    assert.equal(validWidgetState(state), false);
  const circular: any = {};
  circular.modelContent = circular;
  assert.equal(validWidgetState(circular), false);
});
test("visual wrapper confines scripts and prevents title and saved-state injection", () => {
  const doc = visualizationDocument(
    { ...visual, title: "</title><script>titleAttack()</script>" },
    {
      modelContent: "</script><script>stateAttack()</script>",
      privateContent: null,
    },
  );
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /frame-src 'none'/);
  assert.match(doc, /form-action 'none'/);
  assert.match(doc, /base-uri 'none'/);
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf(visual.html));
  assert.ok(!doc.includes("<script>titleAttack()"));
  assert.ok(!doc.includes("<script>stateAttack()"));
  assert.ok(doc.includes("\\u003c/script\\u003e"));
  assert.match(doc, /setWidgetState/);
  assert.match(doc, /sendFollowUpMessage/);
});
test("download preserves sandboxing instead of exporting an unrestricted document", () => {
  const html = visualizationExport(visual, null);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(
    html,
    /allow-same-origin|allow-top-navigation|allow-popups/,
  );
  assert.match(html, /frame-src 'self'/);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes(visual.html));
});
