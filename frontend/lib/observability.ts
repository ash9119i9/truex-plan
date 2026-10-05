// Pure helpers for the observability UI: formatting, receipts, timeline
// layout, token splits, session KPIs and the traces/usage/limits reducer.
import type {
  DomainEvent,
  PrivacyFinding,
  RateLimitView,
  StepKind,
  StepSpan,
  TokenCounts,
  TraceSummary,
  TurnCost,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts";
import { describeFinding, privacyLabels } from "../../shared/privacy.ts";
import { formatTokens } from "./goal.ts";

export { formatTokens };

// 850ms, 4.2s, 42s, 1m 5s.
export function formatDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10_000) return `${(Math.floor(v / 100) / 10).toFixed(1)}s`;
  if (v < 60_000) return `${Math.round(v / 1000)}s`;
  const m = Math.floor(v / 60_000),
    s = Math.round((v % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function formatPercent(fraction: number | null) {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  const p = Math.max(0, fraction) * 100;
  return `${p > 0 && p < 1 ? "<1" : Math.round(p)}%`;
}

// --- Tokens ---------------------------------------------------------------

export interface TokenSplit {
  newInput: number;
  cached: number;
  // Visible reply tokens: output minus reasoning.
  output: number;
  reasoning: number;
  total: number;
}

// Codex reports reasoning as part of output and cached input as part of input.
export function splitTokens(u: TokenCounts | null | undefined): TokenSplit {
  if (!u) return { newInput: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  const cached = Math.max(0, Math.min(u.cachedInputTokens, u.inputTokens));
  const reasoning = Math.max(0, Math.min(u.reasoningOutputTokens, u.outputTokens));
  const split = {
    newInput: Math.max(0, u.inputTokens - cached),
    cached,
    output: Math.max(0, u.outputTokens - reasoning),
    reasoning,
  };
  return {
    ...split,
    total: split.newInput + split.cached + split.output + split.reasoning,
  };
}

export const tokenSegments = [
  { key: "newInput", label: "New input" },
  { key: "cached", label: "Cached input" },
  { key: "output", label: "Reply" },
  { key: "reasoning", label: "Reasoning" },
] as const;

function addCounts(a: TokenCounts | null, b: TokenCounts | null): TokenCounts | null {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

// Main agent plus helpers for one turn.
export function turnCounts(t: TurnTrace): TokenCounts | null {
  return addCounts(t.usage, t.helperUsage);
}

export function turnTokens(t: TurnTrace) {
  return turnCounts(t)?.totalTokens ?? 0;
}

export function contextFraction(u: TurnUsage | null | undefined) {
  if (!u?.contextWindow || u.contextUsedTokens === null) return null;
  return Math.min(1, Math.max(0, u.contextUsedTokens / u.contextWindow));
}

// --- Privacy --------------------------------------------------------------

export function findingCount(findings: PrivacyFinding[]) {
  return findings.reduce((s, f) => s + f.count, 0);
}

export interface PrivacyLine {
  tone: "ok" | "warn";
  text: string;
}

// Only ever says "detected", never "clean": pattern matching can miss things.
export function privacyLine(findings: PrivacyFinding[]): PrivacyLine {
  if (!findings.length) return { tone: "ok", text: "No personal data detected" };
  const [first, ...rest] = findings;
  const more = findingCount(rest);
  return {
    tone: "warn",
    text: describeFinding(first) + (more ? ` and ${more} more` : ""),
  };
}

const vowelLabel = (label: string) => /^[aeiou]/i.test(label);

// "This looks like a phone number and an email address."
export function draftNote(findings: PrivacyFinding[]) {
  if (!findings.length) return "";
  const items = [...new Set(findings.map((f) => f.kind))].map((kind) => {
    const label = privacyLabels[kind];
    return `${vowelLabel(label) ? "an" : "a"} ${label}`;
  });
  const list =
    items.length === 1
      ? items[0]
      : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  return `This looks like ${list}. It will be sent to the model.`;
}

// --- Cost -----------------------------------------------------------------

// Micro-USD for display. Small amounts keep four decimals so a cheap turn
// does not read as free; zero is only ever shown for a priced turn.
export function formatCost(micros: number) {
  if (!Number.isFinite(micros) || micros < 0) return "—";
  if (micros === 0) return "$0.00";
  if (micros < 100) return "<$0.0001";
  const usd = micros / 1e6;
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

// What to say about a turn's cost. Null when no cost was recorded for it.
// Unpriced requests are unknown, never counted as free.
export function costText(cost: TurnCost | null | undefined) {
  if (!cost || !cost.requests) return null;
  if (cost.unpricedRequests >= cost.requests) return "no price set";
  const amount = `≈ ${formatCost(cost.costMicros)}`;
  return cost.unpricedRequests ? `${amount} + unpriced` : amount;
}

// Cost of a whole session from its turns' costs.
export function sessionCostTotals(traces: TurnTrace[]) {
  let costMicros = 0,
    requests = 0,
    unpricedRequests = 0;
  for (const t of traces) {
    if (!t.cost) continue;
    costMicros += t.cost.costMicros;
    requests += t.cost.requests;
    unpricedRequests += t.cost.unpricedRequests;
  }
  return { costMicros, requests, unpricedRequests };
}

// --- Receipt --------------------------------------------------------------

export interface Receipt {
  duration: string | null;
  tokens: string | null;
  cost: string | null;
  privacy: PrivacyLine;
  label: string;
}

export function receipt(t: TurnTrace): Receipt {
  const duration = t.totalMs === null ? null : formatDuration(t.totalMs);
  const total = turnTokens(t);
  const tokens = total ? `${formatTokens(total)} tokens` : null;
  const cost = costText(t.cost);
  const privacy = privacyLine(t.privacy?.findings || []);
  const parts = [
    duration && `Took ${duration}`,
    tokens && `used ${tokens}`,
    cost && `estimated cost ${cost}`,
    privacy.text,
  ].filter(Boolean);
  return { duration, tokens, cost, privacy, label: parts.join(", ") };
}

// --- Timeline -------------------------------------------------------------

export const stepKindLabels: Record<StepKind, string> = {
  thinking: "Thinking",
  message: "Writing the reply",
  command: "Ran a command",
  tool: "Used a tool",
  fileChange: "Changed files",
  webSearch: "Searched the web",
  agent: "Worked with a helper",
  other: "Other step",
};

export interface TimelineStep {
  id: string;
  label: string;
  kind: StepKind;
  status: StepSpan["status"];
  startMs: number;
  durationMs: number | null;
  left: number;
  width: number;
  slowest: boolean;
  // Sub-row inside the lane, so overlapping steps never cover each other.
  row: number;
}
export interface TimelineLane {
  id: string;
  label: string;
  helper: boolean;
  rows: number;
  steps: TimelineStep[];
}
export interface Timeline {
  spanMs: number;
  lanes: TimelineLane[];
  slowest: TimelineStep | null;
}

const MIN_WIDTH = 1.5;

// Lanes by agent (main first), bars positioned as percentages of the turn.
// Running steps extend to `nowMs` (offset from the turn's start) or the end.
export function timelineLayout(t: TurnTrace, nowMs?: number): Timeline {
  const steps = t.steps || [];
  const ends = steps.map((s) => s.startMs + (s.durationMs ?? 0));
  const spanMs = Math.max(1, t.totalMs ?? 0, nowMs ?? 0, ...ends);
  const done = steps.filter((s) => s.durationMs !== null);
  const slowestSpan =
    steps.length > 1 && done.length
      ? done.reduce((a, b) => ((b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a))
      : null;
  const lanes = new Map<string, TimelineLane>();
  const rowEnds = new Map<string, number[]>();
  let slowest: TimelineStep | null = null;
  for (const s of [...steps].sort((a, b) => a.startMs - b.startMs)) {
    const helper = s.agent !== "main";
    const key = helper ? s.agentThreadId || s.agent : "main";
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        id: key,
        label: helper ? s.agent || "Helper" : "Assistant",
        helper,
        rows: 0,
        steps: [],
      };
      lanes.set(key, lane);
      rowEnds.set(key, []);
    }
    const start = Math.min(Math.max(0, s.startMs), spanMs);
    const dur = s.durationMs ?? Math.max(0, spanMs - start);
    const left = (start / spanMs) * 100;
    const width = Math.min(100 - left, Math.max(MIN_WIDTH, (dur / spanMs) * 100));
    const step: TimelineStep = {
      id: s.id,
      label: s.label?.trim() || stepKindLabels[s.kind] || "Step",
      kind: s.kind,
      status: s.status,
      startMs: s.startMs,
      durationMs: s.durationMs,
      left,
      width: Math.max(0, width),
      slowest: s === slowestSpan,
      row: 0,
    };
    const ends = rowEnds.get(key)!;
    let row = ends.findIndex((end) => left >= end - 1e-9);
    if (row < 0) row = ends.length;
    ends[row] = left + step.width;
    step.row = row;
    lane.rows = Math.max(lane.rows, row + 1);
    if (step.slowest) slowest = step;
    lane.steps.push(step);
  }
  const ordered = [...lanes.values()].sort(
    (a, b) => Number(a.helper) - Number(b.helper),
  );
  return { spanMs, lanes: ordered, slowest };
}

// --- Session summary ------------------------------------------------------

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarize(traces: TurnTrace[]): TraceSummary {
  const times = traces
    .map((t) => t.totalMs)
    .filter((v): v is number => typeof v === "number");
  const s: TraceSummary = {
    turns: traces.length,
    avgTotalMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
    p95TotalMs: percentile(times, 0.95),
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    helperTokens: 0,
    privacyFindings: 0,
  };
  for (const t of traces) {
    if (t.usage) {
      s.inputTokens += t.usage.inputTokens;
      s.cachedInputTokens += t.usage.cachedInputTokens;
      s.outputTokens += t.usage.outputTokens;
      s.reasoningOutputTokens += t.usage.reasoningOutputTokens;
    }
    s.helperTokens += t.helperUsage?.totalTokens ?? 0;
    s.privacyFindings += findingCount(t.privacy?.findings || []);
  }
  return s;
}

export function cachedFraction(s: TraceSummary) {
  return s.inputTokens ? s.cachedInputTokens / s.inputTokens : null;
}

export function totalTokens(s: TraceSummary) {
  return s.inputTokens + s.outputTokens + s.helperTokens;
}

// --- Rate limits ----------------------------------------------------------

export function windowLabel(mins: number | null) {
  if (!mins) return "Usage limit";
  if (mins % 10_080 === 0) return mins === 10_080 ? "Weekly limit" : `${mins / 10_080}-week limit`;
  if (mins % 1440 === 0) return mins === 1440 ? "Daily limit" : `${mins / 1440}-day limit`;
  if (mins % 60 === 0) return `${mins / 60}-hour limit`;
  return `${mins}-minute limit`;
}

// Codex reports resets as unix seconds; accept milliseconds too.
export function resetsIn(resetsAt: number | null, now = Date.now()) {
  if (!resetsAt) return null;
  const at = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const ms = at - now;
  if (ms <= 0) return "resets now";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60),
    m = mins % 60;
  if (h < 24) return `resets in ${h}h${m ? ` ${m}m` : ""}`;
  const d = Math.floor(h / 24);
  return `resets in ${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

export interface LimitMeter {
  label: string;
  usedPercent: number;
  resets: string | null;
}

export function limitMeters(r: RateLimitView | null | undefined, now = Date.now()) {
  if (!r) return [];
  const meters: LimitMeter[] = [];
  if (r.primaryUsedPercent !== null)
    meters.push({
      label: windowLabel(r.primaryWindowMins),
      usedPercent: clampPercent(r.primaryUsedPercent),
      resets: resetsIn(r.primaryResetsAt, now),
    });
  if (r.secondaryUsedPercent !== null)
    meters.push({
      label: windowLabel(r.secondaryWindowMins),
      usedPercent: clampPercent(r.secondaryUsedPercent),
      resets: resetsIn(r.secondaryResetsAt, now),
    });
  return meters;
}
const clampPercent = (v: number) => Math.min(100, Math.max(0, v));

// --- State ----------------------------------------------------------------

export interface ObservabilityState {
  // Completed turn traces, oldest first.
  traces: TurnTrace[];
  // Usage reported for turns that have no trace yet.
  liveUsage: Record<string, TurnUsage>;
  rateLimits: RateLimitView | null;
}
export const emptyObservability: ObservabilityState = {
  traces: [],
  liveUsage: {},
  rateLimits: null,
};

const valid = (t: unknown): t is TurnTrace =>
  !!t && typeof (t as TurnTrace).turnId === "string";

// Merge by turnId; incoming wins. Order by start time.
export function mergeTraces(old: TurnTrace[], incoming: unknown): TurnTrace[] {
  const list = Array.isArray(incoming) ? incoming.filter(valid) : [];
  if (!list.length) return old;
  const byId = new Map(old.map((t) => [t.turnId, t]));
  for (const t of list) byId.set(t.turnId, t);
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || 0,
  );
}

function dropLive(live: Record<string, TurnUsage>, ids: string[]) {
  if (!ids.some((id) => id in live)) return live;
  const next = { ...live };
  for (const id of ids) delete next[id];
  return next;
}

export function applyObservabilityEvent(
  state: ObservabilityState,
  event: DomainEvent,
): ObservabilityState {
  const d = event.data || {};
  switch (event.type) {
    case "snapshot": {
      const traces = mergeTraces(state.traces, d.traces);
      return {
        traces,
        liveUsage: dropLive(state.liveUsage, traces.map((t) => t.turnId)),
        rateLimits: d.rateLimits !== undefined ? d.rateLimits : state.rateLimits,
      };
    }
    case "usage.updated":
      if (!event.turnId || !d.usage) return state;
      return {
        ...state,
        liveUsage: { ...state.liveUsage, [event.turnId]: d.usage },
      };
    case "limits.updated":
      return d.rateLimits ? { ...state, rateLimits: d.rateLimits } : state;
    case "turn.completed": {
      if (!valid(d.trace)) return state;
      return {
        traces: mergeTraces(state.traces, [d.trace]),
        liveUsage: dropLive(state.liveUsage, [d.trace.turnId]),
        rateLimits: d.trace.rateLimits ?? state.rateLimits,
      };
    }
    default:
      return state;
  }
}
