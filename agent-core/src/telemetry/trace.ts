// Per-turn observability: timed steps in plain words, token usage, rate
// limits and a privacy report. Pure; the manager feeds it runtime events.
import type {
  PrivacyReport,
  PrivacySource,
  RateLimitView,
  StepKind,
  StepSpan,
  TokenCounts,
  TurnContext,
  TurnTrace,
  TurnUsage,
} from "../../../shared/contracts";
import { addToReport, emptyReport, maskText } from "../../../shared/privacy";

export const stepLimit = 300;
export const sectionLimit = 20_000;
export const contextLimit = 200_000;

type Section = TurnContext["sections"][number];
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const name = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const collabLabels: Record<string, string> = {
  spawnAgent: "Started a helper",
  sendInput: "Sent a helper a message",
  resumeAgent: "Resumed a helper",
  wait: "Waited for helpers",
  closeAgent: "Closed a helper",
};

// The step an item stands for, or null for items that are not work.
export function stepOf(item: any): { kind: StepKind; label: string } | null {
  switch (item?.type) {
    case "reasoning":
      return { kind: "thinking", label: "Thinking" };
    case "agentMessage":
      return { kind: "message", label: "Wrote the reply" };
    case "plan":
      return { kind: "other", label: "Made a plan" };
    case "commandExecution":
      return { kind: "command", label: "Ran a command" };
    case "mcpToolCall": {
      const server = name(item.server),
        tool = name(item.tool);
      return {
        kind: "tool",
        label: tool
          ? `Used ${tool}${server ? ` from ${server}` : ""}`
          : `Used ${server ?? "a"} tool`,
      };
    }
    case "dynamicToolCall":
      return { kind: "tool", label: `Used ${name(item.tool) ?? "a tool"}` };
    case "fileChange": {
      const n = Array.isArray(item.changes) ? item.changes.length : 0;
      return { kind: "fileChange", label: `Changed ${plural(n, "file")}` };
    }
    case "webSearch":
      return { kind: "webSearch", label: "Searched the web" };
    case "collabAgentToolCall":
      return {
        kind: "agent",
        label: collabLabels[item.tool] ?? "Worked with helpers",
      };
    case "imageView":
      return { kind: "other", label: "Looked at an image" };
    case "imageGeneration":
      return { kind: "other", label: "Made an image" };
    case "contextCompaction":
      return { kind: "other", label: "Compacted the conversation" };
    case "enteredReviewMode":
      return { kind: "other", label: "Started a review" };
    case "exitedReviewMode":
      return { kind: "other", label: "Finished a review" };
    case "sleep":
      return { kind: "other", label: "Waited" };
    case "userMessage":
    case "hookPrompt":
    case "subAgentActivity":
    case undefined:
      return null;
    default:
      return { kind: "other", label: "Worked" };
  }
}

function itemStatus(item: any): StepSpan["status"] {
  if (item?.status === "failed" || item?.success === false || item?.error)
    return "failed";
  if (item?.status === "declined") return "declined";
  return "completed";
}

const texts = (list: unknown) =>
  (Array.isArray(list) ? list : [])
    .map((c: any) =>
      typeof c?.text === "string" ? c.text : c ? JSON.stringify(c) : "",
    )
    .filter(Boolean)
    .join("\n");

// Model-facing text an item carries: [section kind, label, text, source].
function sourcesOf(
  item: any,
): [Section["kind"], string, string, PrivacySource][] {
  switch (item?.type) {
    case "userMessage": {
      const text = (item.content ?? [])
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n");
      return [["user", "Your message", text, "userMessage"]];
    }
    case "commandExecution":
      return [
        ["command", "Command", String(item.command ?? ""), "command"],
        [
          "toolOutput",
          "Command output",
          String(item.aggregatedOutput ?? ""),
          "toolOutput",
        ],
      ];
    case "mcpToolCall":
      return [
        [
          "toolOutput",
          `${name(item.tool) ?? "Tool"} result`,
          texts(item.result?.content) ||
            (typeof item.error?.message === "string" ? item.error.message : ""),
          "toolOutput",
        ],
      ];
    case "dynamicToolCall":
      return [
        [
          "toolOutput",
          `${name(item.tool) ?? "Tool"} result`,
          texts(item.contentItems),
          "toolOutput",
        ],
      ];
    case "fileChange":
      return [
        [
          "fileContent",
          "File changes",
          (item.changes ?? [])
            .map((c: any) => (typeof c?.diff === "string" ? c.diff : ""))
            .join("\n"),
          "fileContent",
        ],
      ];
    default:
      return [];
  }
}

export function countsOf(b: any): TokenCounts {
  return {
    inputTokens: num(b?.inputTokens),
    cachedInputTokens: num(b?.cachedInputTokens),
    outputTokens: num(b?.outputTokens),
    reasoningOutputTokens: num(b?.reasoningOutputTokens),
    totalTokens: num(b?.totalTokens),
  };
}
const add = (a: TokenCounts | null, b: TokenCounts): TokenCounts => ({
  inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
  cachedInputTokens: (a?.cachedInputTokens ?? 0) + b.cachedInputTokens,
  outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
  reasoningOutputTokens:
    (a?.reasoningOutputTokens ?? 0) + b.reasoningOutputTokens,
  totalTokens: (a?.totalTokens ?? 0) + b.totalTokens,
});

// Merges a sparse rate limit update into the last known view.
export function rateLimitView(
  snapshot: any,
  prev: RateLimitView | null = null,
  at = new Date().toISOString(),
): RateLimitView {
  const n = (v: unknown, keep: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : (keep ?? null);
  const p = snapshot?.primary,
    s = snapshot?.secondary;
  return {
    limitName:
      typeof snapshot?.limitName === "string"
        ? snapshot.limitName
        : (prev?.limitName ?? null),
    primaryUsedPercent: n(p?.usedPercent, prev?.primaryUsedPercent),
    primaryWindowMins: n(p?.windowDurationMins, prev?.primaryWindowMins),
    primaryResetsAt: n(p?.resetsAt, prev?.primaryResetsAt),
    secondaryUsedPercent: n(s?.usedPercent, prev?.secondaryUsedPercent),
    secondaryWindowMins: n(s?.windowDurationMins, prev?.secondaryWindowMins),
    secondaryResetsAt: n(s?.resetsAt, prev?.secondaryResetsAt),
    // Reaching a limit is current state, not sticky metadata.
    reached:
      typeof snapshot?.rateLimitReachedType === "string"
        ? snapshot.rateLimitReachedType
        : null,
    at,
  };
}

export interface StepAgent {
  agent: string;
  agentThreadId: string;
}

export class TraceBuilder {
  private steps = new Map<string, StepSpan>();
  private sawUserMessage = false;
  private usage: TurnUsage | null = null;
  private helperUsage: TokenCounts | null = null;
  private rateLimits: RateLimitView | null;
  private privacy: PrivacyReport = emptyReport();
  private sections: Section[] = [];
  private contextChars = 0;
  private truncated = false;
  constructor(
    readonly turnId: string,
    readonly threadId: string,
    readonly startedAtMs = Date.now(),
    rateLimits: RateLimitView | null = null,
    // Text sent in turn/start, used when no userMessage item reports it.
    private input = "",
  ) {
    this.rateLimits = rateLimits;
  }
  private offset(at: unknown) {
    return Math.max(0, (num(at) || Date.now()) - this.startedAtMs);
  }
  onItem(
    phase: "started" | "completed",
    item: any,
    atMs: unknown,
    who: StepAgent,
  ) {
    const main = who.agentThreadId === this.threadId;
    // A helper's own prompt comes from the main agent, not the user.
    if (phase === "completed" && (main || item?.type !== "userMessage"))
      this.scan(item);
    const step = stepOf(item);
    if (!step || typeof item?.id !== "string") return;
    const id = main ? item.id : `${who.agentThreadId}:${item.id}`;
    let span = this.steps.get(id);
    if (!span) {
      if (this.steps.size >= stepLimit) return;
      span = {
        id,
        ...step,
        agent: who.agent,
        agentThreadId: who.agentThreadId,
        startMs: this.offset(atMs),
        durationMs: null,
        status: "running",
      };
      this.steps.set(id, span);
    }
    if (phase === "completed") {
      span.label = step.label;
      span.durationMs = Math.max(0, this.offset(atMs) - span.startMs);
      span.status = itemStatus(item);
    }
  }
  // Codex reports "last" per model call; a turn's usage is their sum.
  // Context used is the latest call's input: the whole conversation it read.
  onUsage(tokenUsage: any) {
    const last = countsOf(tokenUsage?.last);
    const window = tokenUsage?.modelContextWindow;
    this.usage = {
      ...add(this.usage, last),
      contextWindow:
        typeof window === "number"
          ? window
          : (this.usage?.contextWindow ?? null),
      contextUsedTokens: tokenUsage?.last ? last.inputTokens : null,
    };
    return this.usage;
  }
  onHelperUsage(last: any) {
    this.helperUsage = add(this.helperUsage, countsOf(last));
  }
  onRateLimits(view: RateLimitView) {
    this.rateLimits = view;
  }
  private scan(item: any) {
    if (item?.type === "userMessage") this.sawUserMessage = true;
    for (const [kind, label, text, source] of sourcesOf(item))
      this.addText(kind, label, text, source);
  }
  private addText(
    kind: Section["kind"],
    label: string,
    text: string,
    source: PrivacySource,
  ) {
    if (!text) return;
    addToReport(this.privacy, text, source);
    const room = contextLimit - this.contextChars;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const limit = Math.min(sectionLimit, room);
    // Mask a little past the cut so a value on the boundary is still caught.
    let masked = maskText(text.slice(0, limit + 200));
    if (text.length > limit || masked.length > limit) {
      masked = masked.slice(0, limit);
      this.truncated = true;
    }
    this.sections.push({ kind, label, text: masked, chars: text.length });
    this.contextChars += masked.length;
  }
  finish(status: string, totalMs?: number | null) {
    if (!this.sawUserMessage && this.input)
      this.addText("user", "Your message", this.input, "userMessage");
    this.input = "";
    const total = totalMs ?? Date.now() - this.startedAtMs;
    const steps = [...this.steps.values()].map((s) =>
      s.durationMs === null
        ? {
            ...s,
            durationMs: Math.max(0, total - s.startMs),
            status: (status === "completed"
              ? "completed"
              : "failed") as StepSpan["status"],
          }
        : { ...s },
    );
    const trace: TurnTrace = {
      turnId: this.turnId,
      threadId: this.threadId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      totalMs: total,
      status,
      steps: steps.sort((a, b) => a.startMs - b.startMs),
      usage: this.usage,
      helperUsage: this.helperUsage,
      rateLimits: this.rateLimits,
      privacy: {
        scannedChars: this.privacy.scannedChars,
        findings: this.privacy.findings.map((f) => ({ ...f })),
      },
    };
    return trace;
  }
  // Live-only masked view of what the model read this turn.
  context(): TurnContext {
    return {
      turnId: this.turnId,
      reconstructed: true,
      sections: this.sections.map((s) => ({ ...s })),
      truncated: this.truncated,
    };
  }
}
