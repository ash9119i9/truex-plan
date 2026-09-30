// View models for the r2 observability UI: receipt line, trace card
// (waterfall, tokens, context, timing, privacy, limits), dev-only model
// context and the Insights tab rollup. Pure functions over the contracts, so
// components never read TurnTrace and friends directly.
import type {
  PrivacyFinding,
  PrivacyKind,
  PrivacyReport,
  PrivacySource,
  RateLimitView,
  StepKind,
  StepSpan,
  TurnContext,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts";
import {
  formatDuration,
  percentile,
  splitTokens,
  turnCounts,
  turnTokens,
} from "./observability.ts";

// --- Formatting -----------------------------------------------------------

// Wireframe token style: 850, 6.1k, 34.0k, 142.2k, 258k.
export function fmtK(n: number | null | undefined) {
  const v = Math.max(0, Math.round(n ?? 0));
  if (v < 1000) return String(v);
  const k = (v / 1000).toFixed(1);
  return `${v >= 100_000 ? k.replace(/\.0$/, "") : k}k`;
}

// 66%, <1%, 0%.
export function sharePct(part: number, total: number) {
  if (!total || part <= 0) return "0%";
  const p = (part / total) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

// "10:02" in the viewer's clock.
export function clockTime(iso: string | number | null | undefined) {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// "3:40 PM" for reset times.
function resetClock(resetsAt: number | null) {
  if (!resetsAt) return null;
  const at = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// --- Status ---------------------------------------------------------------

export type Tone = "ok" | "warn" | "bad" | "live";

export const isFailedStep = (s: StepSpan) =>
  s.status === "failed" || s.status === "declined";

export function isRunningTrace(t: TurnTrace) {
  return t.status === "running" || t.status === "inProgress" || t.totalMs === null;
}

export function failedSteps(t: TurnTrace) {
  return (t.steps || []).filter(isFailedStep);
}

// Completed, Completed with N errors (warn), Failed (bad), Stopped, Running.
export function traceStatus(t: TurnTrace): { tone: Tone; label: string } {
  if (isRunningTrace(t)) return { tone: "live", label: "Running" };
  const errors = failedSteps(t).length;
  if (t.status === "failed") return { tone: "bad", label: "Failed" };
  if (t.status === "interrupted" || t.status === "stopped" || t.status === "cancelled")
    return { tone: "warn", label: "Stopped" };
  if (errors)
    return { tone: "warn", label: `Completed with ${plural(errors, "error")}` };
  return { tone: "ok", label: "Completed" };
}

// --- Receipt --------------------------------------------------------------

export interface ReceiptVM {
  running: boolean;
  duration: string | null;
  tokens: string | null;
  model: string | null;
  privacy: number;
  errors: number;
  // Full sentence for the Details button's accessible name.
  label: string;
}

export function receiptVM(t: TurnTrace, nowMs?: number): ReceiptVM {
  const running = isRunningTrace(t);
  const elapsed =
    t.totalMs ?? (nowMs !== undefined ? Math.max(0, nowMs - Date.parse(t.startedAt)) : null);
  const total = turnTokens(t);
  const privacy = (t.privacy?.findings || []).reduce((s, f) => s + f.count, 0);
  const errors = failedSteps(t).length;
  const duration = elapsed === null ? null : formatDuration(elapsed);
  const tokens = total ? `${fmtK(total)} tokens${running ? " so far" : ""}` : null;
  const parts = [
    running ? "Running" : null,
    duration && (running ? `${duration} so far` : `Took ${duration}`),
    tokens,
    t.model || null,
    privacy ? plural(privacy, "privacy finding") : null,
    errors ? plural(errors, "error") : null,
  ].filter(Boolean);
  return {
    running,
    duration,
    tokens,
    model: t.model || null,
    privacy,
    errors,
    label: parts.join(", "),
  };
}

// Receipt while only live usage is known (no trace yet).
export function liveReceiptVM(u: TurnUsage | null | undefined) {
  const total = u ? u.totalTokens || u.inputTokens + u.outputTokens : 0;
  return { tokens: total ? `${fmtK(total)} tokens so far` : null };
}

// --- Trace header ---------------------------------------------------------

export function helperCount(t: TurnTrace) {
  return new Set(
    (t.steps || []).filter((s) => s.agent !== "main").map((s) => s.agentThreadId || s.agent),
  ).size;
}

// "T1 · 10:02 · 12 steps · 3 helpers"
export function traceSubtitle(t: TurnTrace, turnNumber?: number) {
  const helpers = helperCount(t);
  return [
    turnNumber ? `T${turnNumber}` : null,
    clockTime(t.startedAt) || null,
    plural((t.steps || []).length, "step"),
    helpers ? plural(helpers, "helper") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// --- Waterfall ------------------------------------------------------------

export type BarKind = "think" | "file" | "tool" | "write" | "wait" | "err" | "live";

const kindBar: Record<StepKind, BarKind> = {
  thinking: "think",
  message: "write",
  command: "tool",
  tool: "tool",
  fileChange: "file",
  webSearch: "tool",
  agent: "wait",
  other: "tool",
};

export interface WfTick {
  left: number;
  label: string;
  now?: boolean;
}
export interface WfRow {
  id: string;
  label: string;
  kind: BarKind;
  left: number;
  width: number;
  duration: string;
  error: boolean;
  // Left edge of the x cap on a failed bar.
  errAt: number | null;
}
export interface WfGroup {
  id: string;
  label: string;
  initial: string;
  tone: string;
  left: number;
  width: number;
  duration: string;
  rows: WfRow[];
}
export interface WaterfallVM {
  spanMs: number;
  wall: string;
  running: boolean;
  ticks: WfTick[];
  // Grid line positions (percent); the last one is the "now" line when running.
  grid: { left: number; now?: boolean }[];
  groups: WfGroup[];
}

const TICK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600].map(
  (s) => s * 1000,
);
const pct = (n: number) => Math.round(n * 1000) / 1000;
const axisLabel = (ms: number) =>
  ms < 1000 ? formatDuration(ms) : `${Math.round(ms / 1000)}s`;

// Shared time axis: about five ticks, then the turn's end (or "now").
export function axisTicks(spanMs: number, running = false) {
  const ticks: WfTick[] = [{ left: 0, label: "0s" }];
  const grid: { left: number; now?: boolean }[] = [];
  if (spanMs >= 2000) {
    const step = TICK_STEPS.find((s) => spanMs / s <= 5) ?? TICK_STEPS.at(-1)!;
    for (let at = step; at < spanMs; at += step) {
      const left = pct((at / spanMs) * 100);
      // Keep clear of the end label.
      if (left > 92) break;
      ticks.push({ left, label: axisLabel(at) });
      grid.push({ left });
    }
  }
  ticks.push({
    left: 100,
    label: running ? `now ${axisLabel(spanMs)}` : axisLabel(spanMs),
    ...(running ? { now: true } : {}),
  });
  grid.push(running ? { left: 100, now: true } : { left: 100 });
  return { ticks, grid };
}

// Rows grouped by agent (main first, helpers by first start), on one axis.
// Running steps grow to `nowMs` (offset from the turn's start).
export function waterfallVM(
  t: TurnTrace,
  opts: { nowMs?: number; agentName?: string } = {},
): WaterfallVM {
  const running = isRunningTrace(t);
  const steps = [...(t.steps || [])].sort((a, b) => a.startMs - b.startMs);
  const endOf = (s: StepSpan) =>
    s.startMs + (s.durationMs ?? Math.max(0, (opts.nowMs ?? 0) - s.startMs));
  const spanMs = Math.max(1, t.totalMs ?? 0, opts.nowMs ?? 0, ...steps.map(endOf));
  const { ticks, grid } = axisTicks(spanMs, running);
  const groups = new Map<string, WfGroup & { start: number; end: number }>();
  let helpers = 0;
  for (const s of steps) {
    const main = s.agent === "main";
    const key = main ? "main" : s.agentThreadId || s.agent;
    let g = groups.get(key);
    if (!g) {
      const name = main ? "Main" : cap(s.agent || "Helper");
      const initialSrc = main ? opts.agentName || "Main" : name;
      g = {
        id: key,
        label: name,
        initial: (initialSrc.trim()[0] || "?").toUpperCase(),
        tone: main ? "tone-main" : `tone-${helpers++ % 3}`,
        left: 0,
        width: 0,
        duration: "",
        rows: [],
        start: s.startMs,
        end: endOf(s),
      };
      groups.set(key, g);
    }
    const start = Math.min(Math.max(0, s.startMs), spanMs);
    const end = Math.min(spanMs, Math.max(start, endOf(s)));
    const left = pct((start / spanMs) * 100);
    const width = pct(Math.min(100 - left, ((end - start) / spanMs) * 100));
    const error = isFailedStep(s);
    const live = s.status === "running";
    g.start = Math.min(g.start, start);
    g.end = Math.max(g.end, end);
    g.rows.push({
      id: s.id,
      label: s.label?.trim() || cap(s.kind),
      kind: error ? "err" : live ? "live" : kindBar[s.kind] || "tool",
      left,
      width,
      duration: formatDuration(end - start),
      error,
      errAt: error ? pct(left + width) : null,
    });
  }
  const ordered = [...groups.values()].sort(
    (a, b) => Number(a.id !== "main") - Number(b.id !== "main") || a.start - b.start,
  );
  // Main's lifetime is the whole turn; helpers span their own steps.
  const out: WfGroup[] = ordered.map(({ start, end, ...g }) => {
    const s = g.id === "main" ? 0 : start;
    const e = g.id === "main" ? spanMs : end;
    return {
      ...g,
      left: pct((s / spanMs) * 100),
      width: pct(((e - s) / spanMs) * 100),
      duration: formatDuration(e - s),
    };
  });
  return {
    spanMs,
    wall: formatDuration(t.totalMs ?? spanMs),
    running,
    ticks,
    grid,
    groups: out,
  };
}

// --- Step errors ----------------------------------------------------------

export interface StepErrorVM {
  id: string;
  title: string;
  detail: string;
  // No error id in the contract yet; the step id stands in.
  ref: string;
}

export function stepErrorsVM(t: TurnTrace): StepErrorVM[] {
  return failedSteps(t).map((s) => ({
    id: s.id,
    title: s.status === "declined" ? `${s.label} was declined` : `${s.label} failed`,
    detail:
      s.status === "declined"
        ? "The step was not run."
        : `Failed after ${formatDuration(s.durationMs)}.`,
    ref: s.id,
  }));
}

// --- Tokens ---------------------------------------------------------------

export interface TokenPart {
  key: "in" | "cache" | "out" | "rsn";
  label: string;
  value: number;
  text: string;
  pct: string;
}
export interface TokensVM {
  total: number;
  totalText: string;
  parts: TokenPart[];
  // Main vs helpers: helper usage is only reported as one sum.
  agents: { key: string; label: string; tone: string; value: number; text: string }[];
  helpersText: string | null;
}

export function tokensVM(t: TurnTrace): TokensVM | null {
  const counts = turnCounts(t);
  if (!counts) return null;
  const s = splitTokens(counts);
  const parts: TokenPart[] = (
    [
      ["in", "Input", s.newInput],
      ["cache", "Cached input", s.cached],
      ["out", "Output", s.output],
      ["rsn", "Reasoning", s.reasoning],
    ] as const
  ).map(([key, label, value]) => ({
    key,
    label,
    value,
    text: fmtK(value),
    pct: sharePct(value, s.total),
  }));
  const main = t.usage?.totalTokens ?? 0;
  const helper = t.helperUsage?.totalTokens ?? 0;
  const agents = [
    { key: "main", label: "Main", tone: "tone-main", value: main, text: fmtK(main) },
    ...(helper > 0
      ? [{ key: "helpers", label: "Helpers", tone: "tone-0", value: helper, text: fmtK(helper) }]
      : []),
  ];
  return {
    total: s.total,
    totalText: fmtK(s.total),
    parts,
    agents,
    helpersText: helper > 0 ? fmtK(helper) : null,
  };
}

// --- Context --------------------------------------------------------------

export interface ContextVM {
  used: number;
  window: number;
  percent: number;
  pctText: string;
  text: string;
  tone: "ok" | "warn" | "bad";
}

// Reported tokens over the model window. Warn at 75%, bad at 90%.
export function contextVM(u: TurnUsage | null | undefined): ContextVM | null {
  if (!u?.contextWindow || u.contextUsedTokens === null || u.contextUsedTokens === undefined)
    return null;
  const percent = Math.min(100, Math.max(0, (u.contextUsedTokens / u.contextWindow) * 100));
  return {
    used: u.contextUsedTokens,
    window: u.contextWindow,
    percent,
    pctText: sharePct(u.contextUsedTokens, u.contextWindow),
    text: `${fmtK(u.contextUsedTokens)} of ${fmtK(u.contextWindow)}`,
    tone: percent >= 90 ? "bad" : percent >= 75 ? "warn" : "ok",
  };
}

// --- Timing ---------------------------------------------------------------

export function timingVM(t: TurnTiming | null | undefined) {
  if (!t) return [];
  return [
    { label: "Accept", value: formatDuration(t.acceptMs) },
    { label: "First token", value: formatDuration(t.ttftMs) },
    { label: "Stream", value: formatDuration(t.streamMs) },
    { label: "Longest gap", value: formatDuration(t.maxGapMs) },
    // The contract counts stream deltas, not tokens.
    { label: "Rate", value: `${Math.round(t.deltaRate || 0)} deltas/s` },
    { label: "Finalize", value: formatDuration(t.finalizeMs) },
  ];
}

// --- Privacy --------------------------------------------------------------

const kindLabels: Record<PrivacyKind, string> = {
  email: "Email",
  phone: "Phone number",
  card: "Card number",
  iban: "IBAN",
  ssn: "Social security number",
  aadhaar: "Aadhaar number",
  pan: "PAN",
  ip: "IP address",
  secret: "Secret or access key",
};
const sourceLabels: Record<PrivacySource, string> = {
  userMessage: "Your message",
  toolOutput: "Tool output",
  command: "Command",
  fileContent: "File content",
  assistant: "Reply",
};

export interface FindingVM {
  key: string;
  kind: string;
  sample: string;
  source: string;
  count: string;
}

export function privacyVM(reports: (PrivacyReport | null | undefined)[]) {
  const merged = new Map<string, PrivacyFinding>();
  for (const r of reports)
    for (const f of r?.findings || []) {
      const key = `${f.kind}:${f.source}`;
      const prev = merged.get(key);
      merged.set(key, prev ? { ...prev, count: prev.count + f.count } : f);
    }
  const findings: FindingVM[] = [...merged.entries()].map(([key, f]) => ({
    key,
    kind: kindLabels[f.kind] ?? f.kind,
    sample: f.sample,
    source: sourceLabels[f.source] ?? f.source,
    count: `×${f.count}`,
  }));
  const total = [...merged.values()].reduce((s, f) => s + f.count, 0);
  return { findings, total, summary: plural(total, "finding") };
}

// --- Rate limits ----------------------------------------------------------

export function meterWindow(mins: number | null) {
  if (!mins) return "Usage";
  if (mins === 10_080) return "Weekly";
  if (mins === 1440) return "Daily";
  if (mins % 1440 === 0) return `${mins / 1440}d window`;
  if (mins % 60 === 0) return `${mins / 60}h window`;
  return `${mins}m window`;
}

export interface LimitMeterVM {
  key: string;
  label: string;
  percent: number;
  pctText: string;
  tone: "ok" | "warn" | "bad";
  // "resets 3:40 PM" or "Limit reached · resets 3:40 PM".
  note: string | null;
}

// Warn at 70% or more; reached turns the meter bad.
export function limitsVM(r: RateLimitView | null | undefined): LimitMeterVM[] {
  if (!r) return [];
  const windows = [
    { key: "primary", used: r.primaryUsedPercent, mins: r.primaryWindowMins, at: r.primaryResetsAt },
    { key: "secondary", used: r.secondaryUsedPercent, mins: r.secondaryWindowMins, at: r.secondaryResetsAt },
  ].filter((w) => w.used !== null);
  // `reached` names no window, so it applies to the fullest one.
  const fullest = r.reached
    ? windows.reduce<(typeof windows)[number] | null>(
        (a, b) => (!a || (b.used ?? 0) > (a.used ?? 0) ? b : a),
        null,
      )
    : null;
  return windows.map((w) => {
    const percent = Math.min(100, Math.max(0, w.used ?? 0));
    const reached = w === fullest || percent >= 100;
    const resets = resetClock(w.at);
    return {
      key: w.key,
      label: meterWindow(w.mins),
      percent,
      pctText: `${Math.round(percent)}%`,
      tone: reached ? "bad" : percent >= 70 ? "warn" : "ok",
      note: reached
        ? `Limit reached${resets ? ` · resets ${resets}` : ""}`
        : percent >= 70 && resets
          ? `resets ${resets}`
          : null,
    };
  });
}

// --- Model context (dev only) ---------------------------------------------

export type CtxBucket = "tools" | "docs" | "convo";
const bucketOf: Record<TurnContext["sections"][number]["kind"], CtxBucket> = {
  user: "convo",
  assistant: "convo",
  toolOutput: "tools",
  command: "tools",
  fileContent: "docs",
};
const bucketLabels: Record<CtxBucket, string> = {
  tools: "Tools",
  docs: "Workspace docs",
  convo: "Conversation",
};

// Chars only are reported; ~4 chars per token is the usual estimate.
export const estTokens = (chars: number) => Math.round(Math.max(0, chars) / 4);

export interface CtxSectionVM {
  key: CtxBucket;
  label: string;
  tokens: number;
  text: string;
  share: number;
  files: { key: string; label: string; text: string }[];
  body: string;
}
export interface ModelContextVM {
  used: number;
  usedText: string;
  window: number | null;
  // "≈15.2k of 258k · 6%" or "≈15.2k".
  summary: string;
  // Flex weights for the composition bar, plus the unused remainder.
  composition: { key: CtxBucket | "free"; weight: number }[];
  sections: CtxSectionVM[];
  truncated: boolean;
}

export function modelContextVM(
  ctx: TurnContext,
  contextWindow?: number | null,
): ModelContextVM {
  const byBucket = new Map<CtxBucket, TurnContext["sections"]>();
  for (const s of ctx.sections || []) {
    const b = bucketOf[s.kind] ?? "convo";
    byBucket.set(b, [...(byBucket.get(b) || []), s]);
  }
  const order: CtxBucket[] = ["tools", "docs", "convo"];
  const raw = order
    .filter((k) => byBucket.has(k))
    .map((key) => {
      const list = byBucket.get(key)!;
      const tokens = estTokens(list.reduce((s, x) => s + (x.chars || x.text.length), 0));
      return { key, list, tokens };
    });
  const used = raw.reduce((s, r) => s + r.tokens, 0);
  const sections: CtxSectionVM[] = raw.map(({ key, list, tokens }) => ({
    key,
    label: bucketLabels[key],
    tokens,
    text: `≈${fmtK(tokens)}`,
    share: used ? pct((tokens / used) * 100) : 0,
    files:
      key === "docs"
        ? list.map((s, i) => ({
            key: `${i}:${s.label}`,
            label: s.label,
            text: `≈${fmtK(estTokens(s.chars || s.text.length))}`,
          }))
        : [],
    body: list.map((s) => (key === "docs" ? s.text : `${s.label}\n${s.text}`)).join("\n\n"),
  }));
  const window = contextWindow || null;
  const composition: ModelContextVM["composition"] = sections.map((s) => ({
    key: s.key,
    weight: s.tokens,
  }));
  if (window && window > used) composition.push({ key: "free", weight: window - used });
  return {
    used,
    usedText: `≈${fmtK(used)}`,
    window,
    summary: window
      ? `≈${fmtK(used)} of ${fmtK(window)} · ${sharePct(used, window)}`
      : `≈${fmtK(used)}`,
    composition,
    sections,
    truncated: !!ctx.truncated,
  };
}

// Split masked text so masked spans (e.g. j***@***.com, ••••42) can be marked.
export function maskedParts(text: string): { text: string; masked: boolean }[] {
  const out: { text: string; masked: boolean }[] = [];
  const re = /\S*(?:\*{3}|•{2,})\S*/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ text: text.slice(at, i), masked: false });
    out.push({ text: m[0], masked: true });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), masked: false });
  return out;
}

// --- Insights: session rollup and this-turn slice ---------------------------

const TOOL_KINDS = new Set<StepKind>(["command", "tool", "webSearch"]);

function toolCalls(traces: TurnTrace[]) {
  const steps = traces.flatMap((t) => t.steps || []).filter((s) => TOOL_KINDS.has(s.kind));
  const failed = steps.filter(isFailedStep).length;
  return `${steps.length}${failed ? ` · ${failed} failed` : ""}`;
}

export interface ChartColVM {
  id: string;
  label: string;
  value: string;
  height: number;
  on: boolean;
  live: boolean;
}

export interface SessionVM {
  turns: number;
  stats: { label: string; value: string }[];
  chartMax: string;
  columns: ChartColVM[];
  chartLabel: string;
  kv: { label: string; value: string }[];
}

// Session scope: sums, averages, p95 turn time, tokens per turn, main vs
// helpers. `live` is usage for a running turn that has no trace yet.
export function sessionVM(
  traces: TurnTrace[],
  opts: { live?: TurnUsage | null; selectedTurnId?: string | null } = {},
): SessionVM {
  const liveTotal = opts.live ? opts.live.totalTokens : 0;
  const values = traces.map(turnTokens);
  const cols = traces.map((t, i) => ({ id: t.turnId, label: `T${i + 1}`, v: values[i], live: false }));
  if (liveTotal) cols.push({ id: "live", label: `T${cols.length + 1} live`, v: liveTotal, live: true });
  const total = values.reduce((a, b) => a + b, 0) + liveTotal;
  const turns = cols.length;
  const times = traces.map((t) => t.totalMs).filter((v): v is number => typeof v === "number");
  const avgMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const max = Math.max(0, ...cols.map((c) => c.v));
  const main = traces.reduce((s, t) => s + (t.usage?.totalTokens ?? 0), 0) + liveTotal;
  const helpers = traces.reduce((s, t) => s + (t.helperUsage?.totalTokens ?? 0), 0);
  const selected = opts.selectedTurnId ?? null;
  const columns = cols.map((c) => ({
    id: c.id,
    label: c.label,
    value: fmtK(c.v),
    height: max ? pct((c.v / max) * 100) : 0,
    on: c.id === selected,
    live: c.live,
  }));
  return {
    turns,
    stats: [
      { label: "tokens", value: fmtK(total) },
      { label: "avg per turn", value: turns ? fmtK(total / turns) : "0" },
      { label: "p95 turn", value: formatDuration(percentile(times, 0.95)) },
    ],
    chartMax: fmtK(max),
    columns,
    chartLabel: `Tokens per turn: ${columns
      .map((c) => `${c.label} ${c.value}${c.live ? " so far" : ""}`)
      .join(", ")}`,
    kv: [
      { label: "Main agent", value: fmtK(main) },
      { label: "Helpers", value: fmtK(helpers) },
      { label: "Avg turn time", value: formatDuration(avgMs) },
      { label: "Tool calls", value: toolCalls(traces) },
    ],
  };
}

// This turn scope: the turn's own trace numbers and its share of the session.
export function turnSliceVM(traces: TurnTrace[], turnId: string) {
  const i = traces.findIndex((t) => t.turnId === turnId);
  if (i < 0) return null;
  const t = traces[i];
  const counts = turnCounts(t);
  const session = traces.reduce((s, x) => s + turnTokens(x), 0);
  return {
    label: `T${i + 1}`,
    kv: [
      {
        label: "Tokens in / out",
        value: `${fmtK(counts?.inputTokens ?? 0)} / ${fmtK(counts?.outputTokens ?? 0)}`,
      },
      { label: "Of session", value: sharePct(turnTokens(t), session) },
      { label: "Duration", value: formatDuration(t.totalMs) },
      { label: "Tool calls", value: toolCalls([t]) },
      { label: "Helpers", value: fmtK(t.helperUsage?.totalTokens ?? 0) },
    ],
  };
}

// Goal budget split by turn, widths to scale of the budget.
export function budgetByTurnVM(
  traces: TurnTrace[],
  budget: number,
  opts: { live?: TurnUsage | null; selectedTurnId?: string | null } = {},
) {
  if (!budget || budget <= 0) return null;
  const segs = traces.map((t, i) => ({
    id: t.turnId,
    label: `T${i + 1}`,
    value: turnTokens(t),
    live: false,
  }));
  if (opts.live?.totalTokens)
    segs.push({ id: "live", label: `T${segs.length + 1}`, value: opts.live.totalTokens, live: true });
  return {
    segments: segs.map((s) => ({
      id: s.id,
      width: pct(Math.min(100, (s.value / budget) * 100)),
      on: s.id === opts.selectedTurnId,
      live: s.live,
    })),
    label: `Tokens per turn against a ${fmtK(budget)} budget: ${segs
      .map((s) => `${s.label} ${fmtK(s.value)}${s.live ? " so far" : ""}${s.id === opts.selectedTurnId ? " selected" : ""}`)
      .join(", ")}`,
  };
}
