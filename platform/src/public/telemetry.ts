import type {
  TurnTiming,
  TurnTrace,
  TurnUsage,
  TokenCounts,
  RateLimitView,
  StepSpan,
  PrivacyFinding,
} from "../../../shared/contracts";
import { finite, SUB_AGENT_ID } from "./fields";
export function publicTiming(t: any): TurnTiming {
  const number = (key: string) =>
    typeof t[key] === "number" && Number.isFinite(t[key]) ? t[key] : 0;
  return {
    turnId: t.turnId,
    acceptMs: t.acceptMs === null ? null : number("acceptMs"),
    ttftMs: t.ttftMs === null ? null : number("ttftMs"),
    streamMs: number("streamMs"),
    adapterStreamMs: number("adapterStreamMs"),
    idleStreamMs: number("idleStreamMs"),
    maxGapMs: number("maxGapMs"),
    deltaRate: number("deltaRate"),
    finalizeMs: number("finalizeMs"),
    totalMs: number("totalMs"),
    deltaCount: number("deltaCount"),
    nonStreaming: t.nonStreaming === true,
    status: ["completed", "failed", "interrupted"].includes(t.status)
      ? t.status
      : "completed",
  };
}
const count = (value: unknown) => Math.max(0, finite(value) ?? 0);
const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : null;
const pick = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
) => (allowed.includes(value as T) ? (value as T) : fallback);
function publicCounts(u: any): TokenCounts | null {
  if (!u || typeof u !== "object") return null;
  return {
    inputTokens: count(u.inputTokens),
    cachedInputTokens: count(u.cachedInputTokens),
    outputTokens: count(u.outputTokens),
    reasoningOutputTokens: count(u.reasoningOutputTokens),
    totalTokens: count(u.totalTokens),
  };
}
export function publicUsage(u: any): TurnUsage | null {
  const counts = publicCounts(u);
  if (!counts) return null;
  return {
    ...counts,
    contextWindow: finite(u.contextWindow),
    contextUsedTokens: finite(u.contextUsedTokens),
  };
}
export function publicRateLimits(r: any): RateLimitView | null {
  if (!r || typeof r !== "object") return null;
  return {
    limitName: text(r.limitName, 80),
    primaryUsedPercent: finite(r.primaryUsedPercent),
    primaryWindowMins: finite(r.primaryWindowMins),
    primaryResetsAt: finite(r.primaryResetsAt),
    secondaryUsedPercent: finite(r.secondaryUsedPercent),
    secondaryWindowMins: finite(r.secondaryWindowMins),
    secondaryResetsAt: finite(r.secondaryResetsAt),
    reached: text(r.reached, 80),
    at: text(r.at, 40) ?? new Date(0).toISOString(),
  };
}
const STEP_KINDS = [
  "thinking",
  "message",
  "command",
  "tool",
  "fileChange",
  "webSearch",
  "agent",
  "other",
] as const;
const STEP_STATUSES = ["running", "completed", "failed", "declined"] as const;
const PRIVACY_KINDS = [
  "email",
  "phone",
  "card",
  "iban",
  "ssn",
  "aadhaar",
  "pan",
  "ip",
  "secret",
] as const;
const PRIVACY_SOURCES = [
  "userMessage",
  "toolOutput",
  "command",
  "fileContent",
  "assistant",
] as const;
function publicStep(s: any): StepSpan | null {
  if (!s || typeof s.id !== "string") return null;
  const main = s.agent === "main";
  return {
    id: s.id.slice(0, 200),
    kind: pick(s.kind, STEP_KINDS, "other"),
    label: text(s.label, 120) ?? "Step",
    agent: main ? "main" : (text(s.agent, 80) ?? "helper"),
    // The main thread id is internal; helper ids are already public.
    agentThreadId:
      !main &&
      typeof s.agentThreadId === "string" &&
      SUB_AGENT_ID.test(s.agentThreadId)
        ? s.agentThreadId
        : main
          ? "main"
          : "",
    startMs: count(s.startMs),
    durationMs: s.durationMs === null ? null : count(s.durationMs),
    status: pick(s.status, STEP_STATUSES, "completed"),
  };
}
function publicFinding(f: any): PrivacyFinding | null {
  if (!f || !PRIVACY_KINDS.includes(f.kind)) return null;
  return {
    kind: f.kind,
    source: pick(f.source, PRIVACY_SOURCES, "toolOutput"),
    count: count(f.count),
    // Samples are masked at the source; the length cap keeps them that way.
    sample: text(f.sample, 24) ?? "",
  };
}
// Allowlist projection of an observability trace: no thread ids or raw text.
export function publicTrace(t: any): TurnTrace | null {
  if (!t || typeof t.turnId !== "string") return null;
  return {
    turnId: t.turnId,
    startedAt: text(t.startedAt, 40) ?? "",
    totalMs: t.totalMs === null ? null : finite(t.totalMs),
    status: pick(
      t.status,
      ["completed", "failed", "interrupted"] as const,
      "completed",
    ),
    ...(typeof t.model === "string" ? { model: t.model.slice(0, 120) } : {}),
    steps: (Array.isArray(t.steps) ? t.steps : [])
      .slice(0, 300)
      .map(publicStep)
      .filter((s: StepSpan | null): s is StepSpan => s !== null),
    usage: publicUsage(t.usage),
    helperUsage: publicCounts(t.helperUsage),
    rateLimits: publicRateLimits(t.rateLimits),
    privacy: {
      scannedChars: count(t.privacy?.scannedChars),
      findings: (Array.isArray(t.privacy?.findings) ? t.privacy.findings : [])
        .map(publicFinding)
        .filter((f: PrivacyFinding | null): f is PrivacyFinding => f !== null),
    },
  };
}
