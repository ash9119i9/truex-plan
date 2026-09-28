import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyObservabilityEvent,
  cachedFraction,
  contextFraction,
  draftNote,
  emptyObservability,
  formatDuration,
  formatPercent,
  limitMeters,
  mergeTraces,
  privacyLine,
  receipt,
  resetsIn,
  splitTokens,
  summarize,
  timelineLayout,
  windowLabel,
} from "../lib/observability.ts";
import { scanText } from "../../shared/privacy.ts";
import type {
  DomainEvent,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts.ts";

const usage: TurnUsage = {
  inputTokens: 10_000,
  cachedInputTokens: 6_000,
  outputTokens: 2_300,
  reasoningOutputTokens: 800,
  totalTokens: 12_300,
  contextWindow: 200_000,
  contextUsedTokens: 76_000,
};

function trace(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    turnId: "t1",
    threadId: "th1",
    startedAt: "2026-09-28T10:00:00.000Z",
    totalMs: 4_200,
    status: "completed",
    steps: [
      {
        id: "a",
        kind: "thinking",
        label: "Thinking",
        agent: "main",
        agentThreadId: "th1",
        startMs: 0,
        durationMs: 900,
        status: "completed",
      },
      {
        id: "b",
        kind: "command",
        label: "Ran a command",
        agent: "main",
        agentThreadId: "th1",
        startMs: 900,
        durationMs: 2_400,
        status: "completed",
      },
      {
        id: "c",
        kind: "tool",
        label: "Read 3 files",
        agent: "researcher",
        agentThreadId: "h1",
        startMs: 1_000,
        durationMs: 1_000,
        status: "completed",
      },
    ],
    usage,
    helperUsage: null,
    rateLimits: null,
    privacy: { scannedChars: 100, findings: [] },
    ...over,
  };
}

const event = (type: string, data: any, turnId?: string) =>
  ({
    type,
    data,
    turnId,
    seq: 1,
    cursor: "c",
    at: "",
    threadId: "th1",
  }) as DomainEvent;

test("durations read as plain numbers", () => {
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(4_249), "4.2s");
  assert.equal(formatDuration(42_400), "42s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatPercent(0.381), "38%");
  assert.equal(formatPercent(0.001), "<1%");
});

test("token split separates cached input and reasoning", () => {
  assert.deepEqual(splitTokens(usage), {
    newInput: 4_000,
    cached: 6_000,
    output: 1_500,
    reasoning: 800,
    total: 12_300,
  });
  assert.equal(splitTokens(null).total, 0);
  assert.equal(contextFraction(usage), 0.38);
  assert.equal(contextFraction({ ...usage, contextWindow: null }), null);
});

test("receipt says detected, never clean", () => {
  const r = receipt(trace());
  assert.equal(r.duration, "4.2s");
  assert.equal(r.tokens, "12.3k tokens");
  assert.deepEqual(r.privacy, { tone: "ok", text: "No personal data detected" });
  assert.match(r.label, /Took 4\.2s, used 12\.3k tokens, No personal data detected/);
  const warn = receipt(
    trace({
      privacy: {
        scannedChars: 10,
        findings: [
          { kind: "email", source: "toolOutput", count: 1, sample: "a***@***.com" },
          { kind: "phone", source: "userMessage", count: 2, sample: "••••12" },
        ],
      },
    }),
  );
  assert.deepEqual(warn.privacy, {
    tone: "warn",
    text: "1 email address in a tool output and 2 more",
  });
  assert.doesNotMatch(JSON.stringify(warn), /clean/i);
});

test("helper usage is added to the receipt total", () => {
  const r = receipt(
    trace({
      helperUsage: {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 700,
        reasoningOutputTokens: 0,
        totalTokens: 1700,
      },
    }),
  );
  assert.equal(r.tokens, "14k tokens");
});

test("timeline puts helpers in their own lane and marks the slowest step", () => {
  const t = timelineLayout(trace());
  assert.equal(t.spanMs, 4_200);
  assert.deepEqual(
    t.lanes.map((l) => [l.label, l.helper, l.steps.length]),
    [
      ["Assistant", false, 2],
      ["researcher", true, 1],
    ],
  );
  assert.deepEqual(t.lanes.map((l) => l.rows), [1, 1]);
  const cmd = t.lanes[0].steps[1];
  assert.equal(cmd.slowest, true);
  assert.equal(t.slowest?.id, "b");
  assert.ok(Math.abs(cmd.left - (900 / 4200) * 100) < 1e-9);
  assert.ok(Math.abs(cmd.width - (2400 / 4200) * 100) < 1e-9);
});

test("running steps extend to now and tiny steps stay visible", () => {
  const t = timelineLayout(
    trace({
      totalMs: null,
      steps: [
        {
          id: "x",
          kind: "message",
          label: "",
          agent: "main",
          agentThreadId: "th1",
          startMs: 0,
          durationMs: 1,
          status: "completed",
        },
        {
          id: "y",
          kind: "command",
          label: "Ran a command",
          agent: "main",
          agentThreadId: "th1",
          startMs: 500,
          durationMs: null,
          status: "running",
        },
      ],
    }),
    2_000,
  );
  assert.equal(t.spanMs, 2_000);
  const [tiny, running] = t.lanes[0].steps;
  assert.equal(tiny.label, "Writing the reply");
  assert.equal(tiny.width, 1.5);
  assert.equal(running.left, 25);
  assert.equal(running.width, 75);
});

test("overlapping steps in one lane go to separate rows", () => {
  const step = (id: string, startMs: number, durationMs: number) => ({
    id,
    kind: "tool" as const,
    label: id,
    agent: "main",
    agentThreadId: "th1",
    startMs,
    durationMs,
    status: "completed" as const,
  });
  const t = timelineLayout(
    trace({ totalMs: 1000, steps: [step("a", 0, 600), step("b", 200, 300), step("c", 600, 400)] }),
  );
  assert.deepEqual(t.lanes[0].steps.map((s) => [s.id, s.row]), [
    ["a", 0],
    ["b", 1],
    ["c", 0],
  ]);
  assert.equal(t.lanes[0].rows, 2);
});

test("summary derives averages, p95, cache share and findings", () => {
  const s = summarize([
    trace({ turnId: "a", totalMs: 1000 }),
    trace({ turnId: "b", totalMs: 3000 }),
    trace({
      turnId: "c",
      totalMs: null,
      privacy: {
        scannedChars: 1,
        findings: [{ kind: "ip", source: "command", count: 3, sample: "10.***.***.***" }],
      },
    }),
  ]);
  assert.equal(s.turns, 3);
  assert.equal(s.avgTotalMs, 2000);
  assert.equal(s.p95TotalMs, 3000);
  assert.equal(s.inputTokens, 30_000);
  assert.equal(s.privacyFindings, 3);
  assert.equal(cachedFraction(s), 0.6);
});

test("rate limit meters show window names and reset times", () => {
  const now = Date.UTC(2026, 8, 28, 10);
  assert.equal(windowLabel(300), "5-hour limit");
  assert.equal(windowLabel(10_080), "Weekly limit");
  assert.equal(resetsIn(now / 1000 + 90 * 60, now), "resets in 1h 30m");
  assert.equal(resetsIn(now + 26 * 3600_000, now), "resets in 1d 2h");
  assert.equal(resetsIn(now - 1, now), "resets now");
  assert.deepEqual(
    limitMeters(
      {
        limitName: null,
        primaryUsedPercent: 42,
        primaryWindowMins: 300,
        primaryResetsAt: now / 1000 + 600,
        secondaryUsedPercent: null,
        secondaryWindowMins: null,
        secondaryResetsAt: null,
        reached: null,
        at: "",
      },
      now,
    ),
    [{ label: "5-hour limit", usedPercent: 42, resets: "resets in 10m" }],
  );
});

test("draft notes name what was found without blocking", () => {
  assert.equal(
    draftNote(scanText("call me on +1 415 555 0134", "userMessage")),
    "This looks like a phone number. It will be sent to the model.",
  );
  assert.equal(
    draftNote(scanText("a@example.com and 10.2.3.4", "userMessage")),
    "This looks like an email address and an IP address. It will be sent to the model.",
  );
  assert.equal(draftNote([]), "");
  assert.equal(privacyLine([]).text, "No personal data detected");
});

test("traces merge by turn id and events update state", () => {
  let s = applyObservabilityEvent(
    emptyObservability,
    event("snapshot", { traces: [trace({ turnId: "old" })], rateLimits: null }),
  );
  assert.deepEqual(s.traces.map((t) => t.turnId), ["old"]);
  s = applyObservabilityEvent(s, event("usage.updated", { usage }, "t2"));
  assert.equal(s.liveUsage.t2.totalTokens, 12_300);
  const limits = {
    limitName: null,
    primaryUsedPercent: 10,
    primaryWindowMins: 300,
    primaryResetsAt: null,
    secondaryUsedPercent: null,
    secondaryWindowMins: null,
    secondaryResetsAt: null,
    reached: null,
    at: "x",
  };
  s = applyObservabilityEvent(s, event("limits.updated", { rateLimits: limits }));
  assert.equal(s.rateLimits?.primaryUsedPercent, 10);
  s = applyObservabilityEvent(
    s,
    event(
      "turn.completed",
      { trace: trace({ turnId: "t2", startedAt: "2026-09-28T11:00:00.000Z" }) },
      "t2",
    ),
  );
  assert.deepEqual(s.traces.map((t) => t.turnId), ["old", "t2"]);
  assert.equal(s.liveUsage.t2, undefined);
  // Older payloads without a trace leave state untouched.
  assert.equal(applyObservabilityEvent(s, event("turn.completed", {}, "t3")), s);
  // A replayed snapshot or /traces fetch replaces by id, never duplicates.
  const again = mergeTraces(s.traces, [trace({ turnId: "old", totalMs: 9 }), { bad: 1 }]);
  assert.equal(again.length, 2);
  assert.equal(again[0].totalMs, 9);
});
