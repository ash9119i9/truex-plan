#!/usr/bin/env node
// Medians across Lighthouse JSON reports, grouped by URL and form factor, with the spread
// (min–max) so a change can be judged against run-to-run noise. Also lists the audits that
// failed in at least half the runs of a group, and the LCP element.
//
//   node .claude/skills/truex-frontend-performance/scripts/lh-summary.mjs /tmp/lh/*.json
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: lh-summary.mjs <lighthouse-report.json>...");
  process.exit(2);
}

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const METRICS = [
  ["first-contentful-paint", "FCP", "ms"],
  ["largest-contentful-paint", "LCP", "ms"],
  ["total-blocking-time", "TBT", "ms"],
  ["cumulative-layout-shift", "CLS", ""],
  ["speed-index", "SI", "ms"],
  ["server-response-time", "TTFB", "ms"],
];

const groups = new Map();
for (const file of files) {
  let lhr;
  try {
    lhr = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`skipped ${file}: ${error.message}`);
    continue;
  }
  if (lhr.runtimeError?.code && lhr.runtimeError.code !== "NO_ERROR") {
    console.error(`skipped ${file}: ${lhr.runtimeError.code} ${lhr.runtimeError.message ?? ""}`);
    continue;
  }
  const url = lhr.finalDisplayedUrl ?? lhr.finalUrl ?? lhr.requestedUrl;
  const key = `${url}  [${lhr.configSettings?.formFactor ?? "?"}, ${lhr.configSettings?.throttlingMethod ?? "?"} throttling, Lighthouse ${lhr.lighthouseVersion}]`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(lhr);
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fmt = (v, unit) => (unit === "ms" ? `${Math.round(v)} ms` : v.toFixed(3));

for (const [key, runs] of groups) {
  console.log(`\n${key}\n  runs: ${runs.length}${runs.length < 3 ? "  (fewer than 3: not enough to judge a change)" : ""}`);
  const scores = CATEGORIES.map((id) => {
    const values = runs.map((r) => r.categories?.[id]?.score).filter((v) => v != null).map((v) => Math.round(v * 100));
    return values.length ? `${id} ${median(values)} [${Math.min(...values)}–${Math.max(...values)}]` : null;
  }).filter(Boolean);
  console.log(`  scores: ${scores.join("   ")}`);
  for (const [id, label, unit] of METRICS) {
    const values = runs.map((r) => r.audits?.[id]?.numericValue).filter((v) => typeof v === "number");
    if (values.length) console.log(`  ${label.padEnd(4)} ${fmt(median(values), unit).padStart(9)}  [${fmt(Math.min(...values), unit)}–${fmt(Math.max(...values), unit)}]`);
  }

  const lcp = runs[0].audits?.["largest-contentful-paint-element"]?.details?.items?.[0];
  const node = lcp?.node ?? lcp?.items?.[0]?.node;
  if (node?.snippet) console.log(`  LCP element: ${node.snippet.slice(0, 160)}`);

  const failing = new Map();
  for (const r of runs) {
    for (const [id, audit] of Object.entries(r.audits ?? {})) {
      if (audit.score == null || audit.score >= 0.9) continue;
      if (!["binary", "numeric", "metricSavings"].includes(audit.scoreDisplayMode)) continue;
      const entry = failing.get(id) ?? { title: audit.title, count: 0 };
      entry.count += 1;
      failing.set(id, entry);
    }
  }
  const common = [...failing].filter(([, e]) => e.count * 2 >= runs.length).sort((a, b) => b[1].count - a[1].count);
  if (common.length) {
    console.log("  failing in at least half the runs:");
    for (const [id, e] of common) console.log(`    ${id}: ${e.title} (${e.count}/${runs.length})`);
  }
}
