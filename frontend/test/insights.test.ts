import { test } from "node:test";
import assert from "node:assert/strict";
import {
  axisTicks,
  budgetByTurnVM,
  contextVM,
  estTokens,
  fmtK,
  limitsVM,
  maskedParts,
  modelContextVM,
  privacyVM,
  receiptVM,
  sessionVM,
  sharePct,
  stepErrorsVM,
  tokensVM,
  traceStatus,
  traceSubtitle,
  turnSliceVM,
  waterfallVM,
} from "../lib/vm-insights.ts";
import type {
  RateLimitView,
  StepSpan,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts.ts";

const usage: TurnUsage = {
  inputTokens: 49_600,
  cachedInputTokens: 11_200,
  outputTokens: 8_600,
  reasoningOutputTokens: 2_500,
  totalTokens: 58_200,
  contextWindow: 258_000,
  contextUsedTokens: 61_400,
};

const step = (over: Partial<StepSpan>): StepSpan => ({
  id: "s",
  kind: "thinking",
  label: "Thinking",
  agent: "main",
  agentThreadId: "th1",
  startMs: 0,
  durationMs: 1000,
  status: "completed",
  ...over,
});

function trace(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    turnId: "t1",
    threadId: "th1",
    startedAt: "2026-09-28T10:02:00.000Z",
    totalMs: 72_000,
    status: "completed",
    model: "Sonnet 5.5",
    steps: [
      step({ id: "a", startMs: 0, durationMs: 4_000 }),
      step({ id: "b", kind: "agent", label: "Waiting on 1 helper", startMs: 14_000, durationMs: 36_000 }),
      step({ id: "c", kind: "message", label: "Writing answer", startMs: 54_000, durationMs: 18_000 }),
      step({ id: "d", kind: "tool", label: "Search handbook", agent: "atlas", agentThreadId: "h1", startMs: 14_000, durationMs: 8_000 }),
    ],
    usage,
    helperUsage: null,
    rateLimits: null,
    privacy: { scannedChars: 100, findings: [] },
    ...over,
  };
}

test("fmtK and sharePct follow the wireframe's number style", () => {
  assert.equal(fmtK(850), "850");
  assert.equal(fmtK(6_100), "6.1k");
  assert.equal(fmtK(34_000), "34.0k");
  assert.equal(fmtK(142_200), "142.2k");
  assert.equal(fmtK(258_000), "258k");
  assert.equal(sharePct(0, 10), "0%");
  assert.equal(sharePct(1, 1000), "<1%");
  assert.equal(sharePct(66, 100), "66%");
});

test("receipt shows time, tokens, model and only non-zero chips", () => {
  const r = receiptVM(trace());
  assert.equal(r.duration, "1m 12s");
  assert.equal(r.tokens, "58.2k tokens");
  assert.equal(r.model, "Sonnet 5.5");
  assert.equal(r.privacy, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.running, false);

  const withBoth = receiptVM(
    trace({
      privacy: { scannedChars: 1, findings: [{ kind: "email", source: "fileContent", count: 1, sample: "j***@***.com" }] },
      steps: [step({ id: "x", status: "failed" })],
    }),
  );
  assert.equal(withBoth.privacy, 1);
  assert.equal(withBoth.errors, 1);
  assert.match(withBoth.label, /1 privacy finding/);
  assert.match(withBoth.label, /1 error/);
});

test("running receipt reads 'so far'", () => {
  const r = receiptVM(trace({ status: "running", totalMs: null }), Date.parse("2026-09-28T10:02:24.000Z"));
  assert.equal(r.running, true);
  assert.equal(r.duration, "24s");
  assert.equal(r.tokens, "58.2k tokens so far");
});

test("status: warn when a step failed, bad when the turn failed", () => {
  assert.deepEqual(traceStatus(trace()), { tone: "ok", label: "Completed" });
  assert.deepEqual(
    traceStatus(trace({ steps: [step({ status: "failed" })] })),
    { tone: "warn", label: "Completed with 1 error" },
  );
  assert.equal(traceStatus(trace({ status: "failed" })).tone, "bad");
  assert.equal(traceStatus(trace({ status: "interrupted" })).label, "Stopped");
  assert.equal(traceStatus(trace({ totalMs: null })).label, "Running");
});

test("subtitle counts steps and helpers", () => {
  const t = trace();
  const sub = traceSubtitle(t, 1);
  assert.match(sub, /^T1 · \d\d:\d\d · 4 steps · 1 helper$/);
  assert.doesNotMatch(traceSubtitle(trace({ steps: [step({})] })), /helper/);
});

test("waterfall groups by agent, main first, on one axis", () => {
  const wf = waterfallVM(trace(), { agentName: "Qlik Analyst" });
  assert.equal(wf.spanMs, 72_000);
  assert.equal(wf.wall, "1m 12s");
  assert.deepEqual(
    wf.groups.map((g) => [g.label, g.initial, g.tone, g.rows.length]),
    [
      ["Main", "Q", "tone-main", 3],
      ["Atlas", "A", "tone-0", 1],
    ],
  );
  const main = wf.groups[0];
  assert.equal(main.left, 0);
  assert.equal(main.width, 100);
  assert.deepEqual(main.rows.map((r) => r.kind), ["think", "wait", "write"]);
  assert.equal(main.rows[0].width, 5.556);
  const atlas = wf.groups[1];
  assert.equal(atlas.left, 19.444);
  assert.equal(atlas.width, 11.111);
  assert.equal(atlas.duration, "8.0s");
  assert.equal(atlas.rows[0].kind, "tool");
});

test("axis ticks every 15s for a 72s turn, ending at the turn", () => {
  const { ticks, grid } = axisTicks(72_000);
  assert.deepEqual(ticks.map((t) => t.label), ["0s", "15s", "30s", "45s", "60s", "72s"]);
  assert.equal(ticks[1].left, 20.833);
  assert.deepEqual(grid.map((g) => g.left), [20.833, 41.667, 62.5, 83.333, 100]);
  const live = axisTicks(24_000, true);
  assert.equal(live.ticks.at(-1)?.label, "now 24s");
  assert.equal(live.grid.at(-1)?.now, true);
});

test("failed steps draw red with an x cap and an error panel", () => {
  const t = trace({
    steps: [
      step({ id: "e", kind: "tool", label: "Google Drive: list folders", agent: "birch", agentThreadId: "h2", startMs: 3_000, durationMs: 18_000, status: "failed" }),
    ],
    totalMs: 48_000,
  });
  const row = waterfallVM(t).groups.find((g) => g.label === "Birch")!.rows[0];
  assert.equal(row.kind, "err");
  assert.equal(row.error, true);
  assert.equal(row.errAt, 43.75);
  const [e] = stepErrorsVM(t);
  assert.equal(e.title, "Google Drive: list folders failed");
  assert.equal(e.detail, "Failed after 18s.");
  assert.equal(e.ref, "e");
});

test("running steps grow to now and use the live kind", () => {
  const t = trace({
    totalMs: null,
    status: "running",
    steps: [step({ id: "w", kind: "message", startMs: 9_000, durationMs: null, status: "running" })],
  });
  const wf = waterfallVM(t, { nowMs: 24_000 });
  assert.equal(wf.spanMs, 24_000);
  assert.equal(wf.running, true);
  const row = wf.groups[0].rows[0];
  assert.equal(row.kind, "live");
  assert.equal(row.left, 37.5);
  assert.equal(row.width, 62.5);
});

test("tokens split into four parts plus main vs helpers", () => {
  const vm = tokensVM(trace({ helperUsage: { inputTokens: 5_000, cachedInputTokens: 0, outputTokens: 1_000, reasoningOutputTokens: 0, totalTokens: 6_000 } }))!;
  assert.deepEqual(vm.parts.map((p) => p.key), ["in", "cache", "out", "rsn"]);
  assert.equal(vm.parts[0].text, "43.4k");
  assert.equal(vm.total, 64_200);
  assert.deepEqual(vm.agents.map((a) => [a.label, a.text]), [["Main", "58.2k"], ["Helpers", "6.0k"]]);
  assert.equal(vm.helpersText, "6.0k");
  assert.equal(tokensVM(trace({ usage: null })), null);
});

test("context fill warns at 75% and turns bad at 90%", () => {
  const c = contextVM({ ...usage, contextUsedTokens: 31_000, contextWindow: 142_200 })!;
  assert.equal(c.text, "31.0k of 142.2k");
  assert.equal(c.pctText, "22%");
  assert.equal(c.tone, "ok");
  assert.equal(contextVM({ ...usage, contextUsedTokens: 75, contextWindow: 100 })!.tone, "warn");
  assert.equal(contextVM({ ...usage, contextUsedTokens: 90, contextWindow: 100 })!.tone, "bad");
  assert.equal(contextVM({ ...usage, contextWindow: null }), null);
});

test("limits warn at 70% and read 'Limit reached' when reached", () => {
  const r: RateLimitView = {
    limitName: null,
    primaryUsedPercent: 72,
    primaryWindowMins: 300,
    primaryResetsAt: 1_900_000_000,
    secondaryUsedPercent: 18,
    secondaryWindowMins: 10_080,
    secondaryResetsAt: null,
    reached: null,
    at: "",
  };
  const [p, s] = limitsVM(r);
  assert.equal(p.label, "5h window");
  assert.equal(p.tone, "warn");
  assert.match(p.note ?? "", /^resets \d{1,2}:\d\d (AM|PM)$/);
  assert.equal(s.label, "Weekly");
  assert.equal(s.tone, "ok");
  assert.equal(s.note, null);
  const [hit] = limitsVM({ ...r, reached: "primary" });
  assert.equal(hit.tone, "bad");
  assert.match(hit.note ?? "", /^Limit reached · resets /);
  assert.deepEqual(limitsVM(null), []);
});

test("privacy merges findings across reports", () => {
  const f = { kind: "email" as const, source: "fileContent" as const, count: 1, sample: "j***@***.com" };
  const vm = privacyVM([{ scannedChars: 1, findings: [f] }, { scannedChars: 1, findings: [f] }, null]);
  assert.equal(vm.findings.length, 1);
  assert.equal(vm.findings[0].kind, "Email");
  assert.equal(vm.findings[0].source, "File content");
  assert.equal(vm.findings[0].count, "×2");
  assert.equal(vm.summary, "2 findings");
  assert.equal(privacyVM([]).findings.length, 0);
});

test("model context estimates tokens from chars and shares the window", () => {
  const vm = modelContextVM(
    {
      turnId: "t1",
      reconstructed: true,
      truncated: false,
      sections: [
        { kind: "fileContent", label: "handbook/week-one.md", text: "x", chars: 40_000 },
        { kind: "user", label: "Your message", text: "hi", chars: 8_000 },
        { kind: "toolOutput", label: "search", text: "y", chars: 2_000 },
      ],
    },
    100_000,
  );
  assert.equal(estTokens(4_000), 1_000);
  assert.deepEqual(vm.sections.map((s) => [s.key, s.tokens]), [["tools", 500], ["docs", 10_000], ["convo", 2_000]]);
  assert.equal(vm.used, 12_500);
  assert.equal(vm.summary, "≈12.5k of 100k · 13%");
  assert.equal(vm.sections[1].files[0].label, "handbook/week-one.md");
  assert.equal(vm.composition.at(-1)?.key, "free");
  assert.equal(vm.composition.at(-1)?.weight, 87_500);
});

test("masked spans are split out for highlighting", () => {
  assert.deepEqual(maskedParts("Send to j***@***.com today"), [
    { text: "Send to ", masked: false },
    { text: "j***@***.com", masked: true },
    { text: " today", masked: false },
  ]);
  assert.deepEqual(maskedParts("card ••••42"), [
    { text: "card ", masked: false },
    { text: "••••42", masked: true },
  ]);
});

test("session rollup: totals, chart, p95 and live column", () => {
  const traces = [
    trace({ turnId: "t1", totalMs: 60_000 }),
    trace({ turnId: "t2", totalMs: 124_000, usage: { ...usage, totalTokens: 9_400 } }),
  ];
  const vm = sessionVM(traces, { live: { ...usage, totalTokens: 26_600 }, selectedTurnId: "t2" });
  assert.equal(vm.turns, 3);
  assert.deepEqual(vm.stats.map((s) => s.value), ["94.2k", "31.4k", "2m 4s"]);
  assert.equal(vm.chartMax, "58.2k");
  assert.deepEqual(vm.columns.map((c) => [c.label, c.value, c.on, c.live]), [
    ["T1", "58.2k", false, false],
    ["T2", "9.4k", true, false],
    ["T3 live", "26.6k", false, true],
  ]);
  assert.equal(vm.columns[1].height, 16.151);
  assert.match(vm.chartLabel, /T3 live 26\.6k so far/);
  assert.equal(vm.kv.find((k) => k.label === "Tool calls")?.value, "2");
});

test("this-turn slice and budget by turn", () => {
  const traces = [trace({ turnId: "t1" }), trace({ turnId: "t2" })];
  const slice = turnSliceVM(traces, "t2")!;
  assert.equal(slice.label, "T2");
  assert.equal(slice.kv.find((k) => k.label === "Of session")?.value, "50%");
  assert.equal(turnSliceVM(traces, "nope"), null);
  const b = budgetByTurnVM(traces, 500_000, { selectedTurnId: "t1" })!;
  assert.deepEqual(b.segments.map((s) => [s.width, s.on]), [[11.64, true], [11.64, false]]);
  assert.equal(budgetByTurnVM(traces, 0), null);
});
