// Run: node --experimental-strip-types docs/performance/visual-replies/shared-preparation.mjs
// Add --output <path> to save the measured summary. Uses synthetic data only.
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import {
  prepareVisualizationDocument,
  validateVisualizationDocument,
  maximumVisualizationDepth,
} from "../../../shared/visualization-document.ts";

function source(size, script = false) {
  const start =
    "<!doctype html><html><head></head><body>" +
    (script ? '<script>const data="' : "<div>");
  const end = script ? '";</script></body></html>' : "</div></body></html>";
  return start + "a".repeat(size - start.length - end.length) + end;
}
const iterations = 30;
const warmups = 3;
const results = [];
for (const size of [5000, 180000]) {
  for (const script of [false, true]) {
    const html = source(size, script);
    const prepare = () =>
      prepareVisualizationDocument(
        {
          title: "Synthetic preparation fixture",
          html,
          sourceFormat: "document",
        },
        null,
        { appearance: "light" },
      );
    for (let n = 0; n < warmups; n++) prepare();
    const times = [];
    let preparedCharacters = 0;
    for (let n = 0; n < iterations; n++) {
      const start = performance.now();
      preparedCharacters = prepare().length;
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    results.push({
      fixture: script ? "inline script" : "text block",
      sourceCharacters: html.length,
      preparedCharacters,
      medianMs: times[Math.floor(iterations / 2)],
      p95Ms: times[Math.ceil(iterations * 0.95) - 1],
    });
  }
}
for (const depth of [50, 128, 1000, 5000]) {
  const html =
    "<html><head></head><body>" +
    "<div>".repeat(depth) +
    "data" +
    "</div>".repeat(depth) +
    "</body></html>";
  const start = performance.now();
  const accepted = validateVisualizationDocument(html);
  results.push({
    fixture: "nested document validation",
    nestedDivs: depth,
    sourceCharacters: html.length,
    accepted,
    durationMs: performance.now() - start,
  });
}
const summary = {
  measuredAt: new Date().toISOString(),
  runtime: process.version,
  platform: process.platform,
  architecture: process.arch,
  iterations,
  warmups,
  maximumTreeDepth: maximumVisualizationDepth,
  notes: [
    "Synthetic local JavaScript microbenchmark; excludes Chromium, transport and model latency.",
    "Preparation parses then normalizes and serializes; validation parses with source locations before checking structure/depth.",
    "The nesting guard prevents recursive serialization overflow; parsing occurs before rejection, so hostile nesting still incurs parser work.",
    "Host theme/bootstrap add approximately 10 KiB to prepared documents.",
  ],
  results,
};
const json = JSON.stringify(summary, null, 2) + "\n";
const output = process.argv.indexOf("--output");
if (output >= 0) {
  if (!process.argv[output + 1]) throw new Error("--output requires a path");
  writeFileSync(process.argv[output + 1], json);
}
process.stdout.write(json);
