import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compactCount, modelLabel, traceTimings } from "../lib/turn.ts";
import { component } from "./next-details-runtime.ts";

const { Receipt, TraceCard } = component("tenant/receipt.tsx");

const run = (extra: Record<string, unknown> = {}) => ({
  id: "run_7f3a21",
  status: "completed",
  error: null,
  usage: {
    input: 15_200,
    cached: 4_000,
    cacheWrite: 0,
    output: 3_200,
    reasoning: 500,
  },
  timings: {
    acceptedAt: "2026-10-28T10:00:00.000Z",
    dispatchedAt: "2026-10-28T10:00:00.300Z",
    firstTextAt: "2026-10-28T10:00:01.500Z",
    completedAt: "2026-10-28T10:00:04.200Z",
  },
  ...extra,
});

test("counts of a thousand or more read as k, without .0", () => {
  assert.equal(compactCount(999), "999");
  assert.equal(compactCount(1_000), "1k");
  assert.equal(compactCount(18_400), "18.4k");
  assert.equal(compactCount(18_449), "18.4k");
  assert.equal(compactCount(1_250_000), "1.3M");
});

test("model names drop the Claude prefix (D7)", () => {
  assert.equal(modelLabel("Claude Haiku 5.5"), "Haiku 5.5");
  assert.equal(modelLabel("GPT-5"), "GPT-5");
  assert.equal(modelLabel(null), "");
});

test("trace timings come only from the timestamps the platform sends", () => {
  assert.deepEqual(traceTimings(run() as never), [
    ["Accept", "0.3s"],
    ["First token", "1.5s"],
    ["Stream", "2.7s"],
    ["Total", "4.2s"],
  ]);
  assert.deepEqual(
    traceTimings(
      run({
        timings: {
          acceptedAt: "2026-10-28T10:00:00.000Z",
          completedAt: "2026-10-28T10:00:09.000Z",
        },
      }) as never,
    ),
    [["Total", "9.0s"]],
  );
});

test("the receipt line reads duration, tokens and model, with a Details toggle", () => {
  const html = renderToStaticMarkup(
    createElement(Receipt, { run: run(), model: "Claude Haiku 5.5", steps: 3 }),
  );
  assert.match(html, /<div class="cs-receipt num">/);
  assert.match(html, /#i-clock[\s\S]*4\.2s/);
  assert.match(html, /#i-sigma[\s\S]*18\.4k tokens/);
  assert.match(html, /#i-spark[\s\S]*Haiku 5\.5/);
  assert.match(
    html,
    /<button type="button" class="tx-chip cs-receipt-details" aria-expanded="false"[^>]*>Details</,
  );
  assert.doesNotMatch(html, /privacy|\$/i);
});

test("the trace card shows status, timing and billed tokens, and nothing it doesn't have", () => {
  const html = renderToStaticMarkup(
    createElement(TraceCard, {
      run: run(),
      steps: 3,
      helpers: 0,
      onClose() {},
    }),
  );
  assert.match(
    html,
    /<section class="cs-trace" role="region" aria-label="Turn trace"/,
  );
  assert.match(html, /3 steps · no helpers/);
  assert.match(html, /class="tx-pill tx-pill-ok"[^>]*>[\s\S]*Completed/);
  assert.match(html, /<dt>First token<\/dt><dd class="num">1\.5s<\/dd>/);
  assert.match(html, /<th scope="row">Input<\/th><td class="num">15,200<\/td>/);
  assert.match(html, /<th scope="row">Total<\/th><td class="num">18,400<\/td>/);
  assert.doesNotMatch(html, /Context|Privacy|Model context|cost/i);
  assert.match(html, /aria-label="Close turn trace"/);
});
