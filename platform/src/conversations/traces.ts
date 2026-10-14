import type {
  TurnTrace,
  TraceSummary,
  SessionTraces,
} from "../../../shared/contracts";

const num = (x: unknown) =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

// Nearest-rank percentile of an ascending list.
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summariseTraces(traces: TurnTrace[]): TraceSummary {
  const totals = traces
    .map((t) => t.totalMs)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    .sort((a, b) => a - b);
  const sum = (pick: (t: TurnTrace) => unknown) =>
    traces.reduce((a, t) => a + num(pick(t)), 0);
  return {
    turns: traces.length,
    avgTotalMs: totals.length
      ? totals.reduce((a, b) => a + b, 0) / totals.length
      : null,
    p95TotalMs: percentile(totals, 95),
    inputTokens: sum((t) => t.usage?.inputTokens),
    cachedInputTokens: sum((t) => t.usage?.cachedInputTokens),
    outputTokens: sum((t) => t.usage?.outputTokens),
    reasoningOutputTokens: sum((t) => t.usage?.reasoningOutputTokens),
    helperTokens: sum((t) => t.helperUsage?.totalTokens),
    privacyFindings: traces.reduce(
      (a, t) =>
        a + (t.privacy?.findings || []).reduce((b, f) => b + num(f.count), 0),
      0,
    ),
  };
}

export const sessionTraces = (traces: TurnTrace[]): SessionTraces => ({
  traces,
  summary: summariseTraces(traces),
});
