import type { Writable } from "node:stream";
import { runtimeError } from "../../shared/errors";
import { errorFields, log } from "../../shared/logging";
import { ALLOW_FOR_CHAT, AUTO_MODE_REASON } from "../../shared/contracts";
import { mcpAppIdPattern, type McpAppRef } from "../../shared/mcp-apps";
import { effectiveMode } from "./features";
import type {
  ApprovalModesConfig,
  Goal,
  Session,
  SubAgent,
  SubAgentStatus,
  SubAgentTranscript,
  TurnTiming,
  TurnTrace,
  TurnUsage,
  TokenCounts,
  RateLimitView,
  StepSpan,
  PrivacyFinding,
} from "../../shared/contracts";
export const POLICY_VERSION = 1;

export function publicSession(s: Session, approvalModes?: ApprovalModesConfig) {
  return {
    _id: s._id,
    ...(s.userId ? { userId: s.userId } : {}),
    agentId: s.agentId,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
    ...(s.projectId ? { projectId: s.projectId } : {}),
    ...(approvalModes?.enabled
      ? { approvalMode: effectiveMode(s.approvalMode, approvalModes) }
      : {}),
    ...(s.goal
      ? { goal: { objective: s.goal.objective, status: s.goal.status } }
      : {}),
  };
}
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
export type PlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};
export function publicPlan(plan: any): PlanStep[] {
  return Array.isArray(plan)
    ? plan
        .filter((p) => p && typeof p.step === "string")
        .map((p) => ({
          step: p.step,
          status: ["pending", "inProgress", "completed"].includes(p.status)
            ? p.status
            : "pending",
        }))
    : [];
}
// agent-core loses its in-memory plan on restart or eviction. A snapshot
// without steps then shows the saved plan instead; a snapshot with steps is
// the live plan and always wins.
export function withPlanFallback<T extends { plan: PlanStep[] }>(
  snapshot: T,
  saved?: { steps?: unknown } | null,
): T {
  if (snapshot.plan.length) return snapshot;
  const steps = publicPlan(saved?.steps);
  return steps.length ? { ...snapshot, plan: steps } : snapshot;
}
// The saved plan as the browser may see it: no cursor or version.
export function publicStoredPlan(p: any) {
  if (!p || !Array.isArray(p.steps)) return null;
  return {
    steps: publicPlan(p.steps),
    ...(typeof p.explanation === "string" && p.explanation
      ? { explanation: p.explanation }
      : {}),
    ...(typeof p.turnId === "string" ? { turnId: p.turnId } : {}),
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : undefined,
  };
}
const goalStatuses = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
];
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
// Allowlist projection: threadId and any future runtime fields stay private.
export function publicGoal(g: any): Goal | null {
  if (!g || typeof g.objective !== "string") return null;
  return {
    objective: g.objective,
    status: goalStatuses.includes(g.status) ? g.status : "active",
    tokenBudget: finite(g.tokenBudget),
    tokensUsed: finite(g.tokensUsed) ?? 0,
    timeUsedSeconds: finite(g.timeUsedSeconds) ?? 0,
    createdAt: finite(g.createdAt),
    updatedAt: finite(g.updatedAt),
    ...(finite(g.tokensObserved) !== null
      ? { tokensObserved: Math.max(0, finite(g.tokensObserved)!) }
      : {}),
  };
}
const SUB_AGENT_STATUSES: SubAgentStatus[] = [
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
];
const SUB_AGENT_ENDED: SubAgentStatus[] = [
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
];
export const SUB_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const clamp = (value: unknown, max: number) =>
  typeof value === "string" && value
    ? value.length > max
      ? value.slice(0, max - 1).trimEnd() + "…"
      : value
    : null;
// Allowlist projection: spawn arguments and runtime metadata stay private.
export function publicSubAgent(a: any): SubAgent | null {
  if (!a || typeof a.threadId !== "string" || !SUB_AGENT_ID.test(a.threadId))
    return null;
  const task = clamp(a.task, 2000),
    lastMessage = clamp(a.lastMessage, 2000),
    endedAt = clamp(a.endedAt, 40);
  return {
    threadId: a.threadId,
    path: clamp(a.path, 200),
    nickname: clamp(a.nickname, 80),
    role: clamp(a.role, 80),
    depth: Math.max(0, Math.min(8, Math.trunc(finite(a.depth) ?? 1))),
    status: SUB_AGENT_STATUSES.includes(a.status) ? a.status : "running",
    ...(task ? { task } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    startedAt: clamp(a.startedAt, 40) ?? new Date(0).toISOString(),
    ...(endedAt ? { endedAt } : {}),
  };
}
export function subAgentName(a: Pick<SubAgent, "nickname" | "role">) {
  const name = a.nickname || a.role;
  return name ? name[0].toUpperCase() + name.slice(1) : "Helper agent";
}
function subAgentLabel(type: string, a: SubAgent) {
  const name = subAgentName(a);
  if (type === "subagent.spawned") return `Spawned ${name}`;
  if (type === "subagent.completed")
    return a.status === "completed"
      ? `${name} finished`
      : a.status === "errored"
        ? `${name} failed`
        : `${name} stopped`;
  return SUB_AGENT_ENDED.includes(a.status)
    ? `${name} stopped`
    : `${name} is working`;
}
export function publicSubAgentTranscript(t: any): SubAgentTranscript | null {
  const agent = publicSubAgent(t?.agent);
  if (!agent) return null;
  return {
    agent,
    messages: (Array.isArray(t.messages) ? t.messages : [])
      .filter((m: any) => m && typeof m.text === "string")
      .map((m: any) => ({
        id: String(m.id ?? ""),
        text: m.text,
        final: m.final === true,
      })),
  };
}
const SUB_AGENT_EVENT_KINDS = [
  "message.delta",
  "message.final",
  "reasoning.delta",
  "turn.started",
  "turn.completed",
];
// Labels for collab tool calls name the action, never the prompt or ids.
function collabLabel(item: any, complete: boolean) {
  const count = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.length
    : 0;
  const helpers = count === 1 ? "1 helper" : `${count} helpers`;
  switch (item.tool) {
    case "spawnAgent":
      return complete ? "Helper agent started" : "Starting a helper agent";
    case "wait":
      return complete
        ? "Helper agents reported back"
        : count
          ? `Waiting on ${helpers}`
          : "Waiting on helper agents";
    case "sendInput":
      return complete ? "Sent a helper more detail" : "Messaging a helper";
    case "resumeAgent":
      return complete ? "Helper agent resumed" : "Resuming a helper agent";
    case "closeAgent":
      return complete ? "Helper agent closed" : "Closing a helper agent";
    default:
      return complete
        ? "Helper agent request finished"
        : "Coordinating helper agents";
  }
}
function message(m: any) {
  return {
    id: m.id,
    turnId: m.turnId,
    text: m.text,
    final: m.final,
    messageIndex: m.messageIndex,
  };
}
// Codex asks for MCP tool approval through requestUserInput with this id
// prefix and a question naming the server and raw tool id. Those names are
// internal, so the public copy describes the action instead.
const TOOL_APPROVAL_PREFIX = "mcp_tool_call_approval";
const TOOL_APPROVAL_QUESTION = /^Allow .+ to run tool "([^"]+)"\??$/s;
// Option labels are the values Codex matches on; only descriptions change.
const TOOL_APPROVAL_OPTIONS: Record<string, string> = {
  Allow: "Run it this one time.",
  "Allow for this session": "Don't ask again for this action in this chat.",
  [ALLOW_FOR_CHAT]: "Don't ask again for this action in this chat.",
  "Allow and don't ask me again": "Always allow this action.",
  Cancel: "Skip this action.",
};
export function toolAction(tool: string): string {
  const words = tool
    .replace(/^mcp__.+?__/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length) return "";
  const text = words.join(" ");
  return text[0].toUpperCase() + text.slice(1);
}
function question(q: any) {
  const options = q.options?.map((o: any) => ({
    label: o.label,
    description: o.description,
  }));
  if (typeof q.id === "string" && q.id.startsWith(TOOL_APPROVAL_PREFIX)) {
    const tool = TOOL_APPROVAL_QUESTION.exec(String(q.question || ""))?.[1];
    const action = tool ? toolAction(tool) : "";
    return {
      id: q.id,
      kind: "toolApproval",
      header: "Permission needed",
      question: "The assistant wants to use a connected business service.",
      ...(action ? { action } : {}),
      isOther: false,
      isSecret: false,
      options: options?.map((o: any) => ({
        label: o.label,
        description: TOOL_APPROVAL_OPTIONS[o.label] ?? o.description,
      })),
    };
  }
  return {
    id: q.id,
    header: q.header,
    question: q.question,
    isOther: q.isOther === true,
    isSecret: q.isSecret === true,
    options,
  };
}
const TOOL_DECISIONS: Record<string, string> = {
  Allow: "allowedOnce",
  "Allow for this session": "allowedSession",
  [ALLOW_FOR_CHAT]: "allowedChat",
  "Allow and don't ask me again": "allowedAlways",
  Cancel: "declined",
};
const USER_NOTE = "user_note: ";
// A resolved input request as the chat's audit trail shows it. Tool approvals
// reuse the public question projection, so raw server and tool ids stay out.
export function publicApproval(a: any) {
  if (a?.method !== "item/tool/requestUserInput") return null;
  const questions = (a.detail?.questions || []).map(question);
  // Records saved before questions were kept have nothing to show.
  if (!questions.length) return null;
  const answers = a.result?.answers || {};
  const reason = typeof a.reason === "string" ? a.reason : "";
  // Settled by the chat's approval mode, e.g. "auto-mode:readOnly".
  const autoMode = reason.startsWith(AUTO_MODE_REASON)
    ? reason.slice(AUTO_MODE_REASON.length)
    : undefined;
  // Anything other than a user answer means the request went unanswered.
  const outcome =
    a.reason === "user"
      ? "answered"
      : a.reason === "auto-recommended" || autoMode !== undefined
        ? "auto"
        : a.reason === "expired"
          ? "expired"
          : "interrupted";
  const expired = outcome !== "answered" && outcome !== "auto";
  return {
    requestId: a.requestId,
    at: typeof a.at === "string" ? a.at : undefined,
    turnId: typeof a.turnId === "string" ? a.turnId : undefined,
    outcome,
    ...(autoMode ? { autoMode } : {}),
    items: questions.map((q: any, i: number) => {
      const raw = a.detail?.questions?.[i];
      // Free-text feedback on a picked option arrives as a separate
      // "user_note: " entry (for example Revise on plan approval).
      const values: string[] = (answers[q.id]?.answers || []).filter(
        (v: unknown): v is string => typeof v === "string",
      );
      const answer = values.find((v) => !v.startsWith(USER_NOTE)) ?? "";
      const note = values
        .find((v) => v.startsWith(USER_NOTE))
        ?.slice(USER_NOTE.length)
        .trim();
      if (q.kind === "toolApproval")
        return {
          kind: "toolApproval",
          ...(q.action ? { action: q.action } : {}),
          decision: expired ? outcome : TOOL_DECISIONS[answer] || "declined",
        };
      return {
        kind: "question",
        question: q.question,
        // Secret answers are never repeated back.
        ...(raw?.isSecret === true
          ? { secret: true }
          : !expired
            ? { ...(answer ? { answer } : {}), ...(note ? { note } : {}) }
            : {}),
      };
    }),
  };
}
function request(p: any) {
  if (p.method !== "item/tool/requestUserInput") return null;
  return {
    requestId: p.requestId,
    method: p.method,
    expiresAt: p.expiresAt,
    responseSchema: null,
    detail: {
      questions: (p.detail?.questions || []).map(question),
    },
  };
}
export function publicSnapshot(s: any) {
  return {
    cursor: s.cursor,
    state: { kind: s.state?.kind || "idle", turnId: s.state?.turnId },
    messages: (s.messages || []).map(message),
    pending: (s.pending || []).map(request).filter(Boolean),
    plan: publicPlan(s.plan),
    goal: publicGoal(s.goal),
    diff: "",
    timings: (s.timings || []).map(publicTiming),
    traces: (Array.isArray(s.traces) ? s.traces : [])
      .map(publicTrace)
      .filter(Boolean),
    rateLimits: publicRateLimits(s.rateLimits),
    mcpApps: (Array.isArray(s.mcpApps) ? s.mcpApps : [])
      .map(publicMcpApp)
      .filter((app: McpAppRef | null): app is McpAppRef => app !== null),
    subAgents: (Array.isArray(s.subAgents) ? s.subAgents : [])
      .map(publicSubAgent)
      .filter(Boolean),
    thinking: (s.thinking || []).map((r: any) => ({
      id: r.id,
      turnId: r.turnId,
      summary: r.summary,
      raw: r.raw,
      done: r.done,
    })),
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
// A connector app in the conversation: labels and a safe id, no data. The
// provider's tool call id never leaves agent-core.
export function publicMcpApp(a: any): McpAppRef | null {
  if (!a || typeof a.id !== "string" || !mcpAppIdPattern.test(a.id))
    return null;
  return {
    id: a.id,
    ...(typeof a.turnId === "string" && a.turnId
      ? { turnId: a.turnId.slice(0, 120) }
      : {}),
    server: typeof a.server === "string" ? a.server.slice(0, 120) : "",
    tool: typeof a.tool === "string" ? a.tool.slice(0, 120) : "",
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
// Allowlist projection applies equally to live events, replay and snapshots.
// Unknown runtime events must never become public by default.
export function publicEvent(e: any): any | null {
  const base = {
    type: e.type,
    seq: e.seq,
    cursor: e.cursor,
    at: e.at,
    turnId: e.turnId,
    itemId: e.itemId,
  };
  const d = e.data || {};
  switch (e.type) {
    case "snapshot":
      return { ...base, data: publicSnapshot(d) };
    case "mcp.app": {
      const app = publicMcpApp(d.app);
      return app ? { ...base, itemId: app.id, data: { app } } : null;
    }
    case "resync.required":
      return {
        ...base,
        data: { reason: "Reconnect to refresh this conversation." },
      };
    case "reasoning.delta":
      return {
        ...base,
        data: {
          delta: d.delta,
          method:
            d.method === "item/reasoning/textDelta"
              ? "item/reasoning/textDelta"
              : "item/reasoning/summaryTextDelta",
        },
      };
    case "plan.updated":
      return {
        ...base,
        data: {
          plan: publicPlan(d.plan),
          ...(typeof d.explanation === "string" && d.explanation
            ? { explanation: d.explanation }
            : {}),
        },
      };
    case "goal.updated": {
      const goal = publicGoal(d.goal);
      return goal ? { ...base, data: { goal } } : null;
    }
    case "goal.cleared":
      return { ...base, data: {} };
    case "subagent.spawned":
    case "subagent.status":
    case "subagent.completed": {
      const agent = publicSubAgent(d.agent);
      if (!agent) return null;
      return {
        ...base,
        data: {
          agent,
          label: subAgentLabel(e.type, agent),
          ...([
            "spawnAgent",
            "sendInput",
            "resumeAgent",
            "wait",
            "closeAgent",
          ].includes(d.tool)
            ? { tool: d.tool }
            : {}),
        },
      };
    }
    case "subagent.event": {
      if (
        !SUB_AGENT_EVENT_KINDS.includes(d.kind) ||
        typeof d.agentThreadId !== "string" ||
        !SUB_AGENT_ID.test(d.agentThreadId)
      )
        return null;
      return {
        ...base,
        data: {
          agentThreadId: d.agentThreadId,
          agentPath: clamp(d.agentPath, 200),
          nickname: clamp(d.nickname, 80),
          role: clamp(d.role, 80),
          depth: Math.max(0, Math.min(8, Math.trunc(finite(d.depth) ?? 1))),
          kind: d.kind,
          ...(typeof d.delta === "string" ? { delta: d.delta } : {}),
          ...(typeof d.text === "string" ? { text: d.text } : {}),
          ...(typeof d.itemId === "string" ? { itemId: d.itemId } : {}),
        },
      };
    }
    case "message.delta":
      return {
        ...base,
        data: { delta: d.delta, messageIndex: d.messageIndex },
      };
    case "message.final":
      return { ...base, data: { text: d.text, messageIndex: d.messageIndex } };
    case "turn.started":
      return { ...base, data: {} };
    case "turn.completed":
      return {
        ...base,
        data: {
          ...(d.timing ? { timing: publicTiming(d.timing) } : {}),
          ...(publicTrace(d.trace) ? { trace: publicTrace(d.trace) } : {}),
          turn: {
            ...(d.turn?.status === "failed"
              ? { error: runtimeError(d.turn) }
              : {}),
            status: ["completed", "failed", "interrupted"].includes(
              d.turn?.status,
            )
              ? d.turn.status
              : "completed",
          },
        },
      };
    case "usage.updated": {
      const usage = publicUsage(d.usage);
      return usage ? { ...base, data: { usage } } : null;
    }
    case "limits.updated": {
      const rateLimits = publicRateLimits(d.rateLimits);
      return rateLimits ? { ...base, data: { rateLimits } } : null;
    }
    case "error":
      return {
        ...base,
        data: {
          ...runtimeError(d),
          ...(typeof d.willRetry === "boolean"
            ? { willRetry: d.willRetry }
            : {}),
          ...(typeof d.turnId === "string" ? { turnId: d.turnId } : {}),
        },
      };
    case "approval.requested": {
      const pending = request(d);
      return pending ? { ...base, data: pending } : null;
    }
    case "approval.resolved": {
      const audit = publicApproval({ ...d, at: e.at, turnId: e.turnId });
      return {
        ...base,
        data: { requestId: d.requestId, ...(audit ? { audit } : {}) },
      };
    }
    case "item.started":
    case "item.completed":
      if (
        [
          "webSearch",
          "collabAgentToolCall",
          "subAgentActivity",
          "dynamicToolCall",
        ].includes(d.item?.type)
      ) {
        const complete = e.type === "item.completed";
        const labels: Record<string, string> = {
          webSearch: complete ? "Web research finished" : "Researching the web",
          collabAgentToolCall: collabLabel(d.item, complete),
          subAgentActivity:
            d.item.kind === "interrupted"
              ? "Helper agent stopped"
              : d.item.kind === "interacted"
                ? "Helper agent received a message"
                : complete
                  ? "Helper agent activity finished"
                  : "Helper agent is working",
          dynamicToolCall: complete
            ? "Document request finished"
            : "Working with conversation documents",
        };
        if (
          d.item.type === "dynamicToolCall" &&
          d.item.tool === "create_visualization"
        )
          labels.dynamicToolCall = complete
            ? d.item.success === false
              ? "Visualization could not be created"
              : "Visualization created"
            : "Creating an interactive visual";
        if (
          d.item.type === "dynamicToolCall" &&
          d.item.tool === "preview_visualization"
        )
          labels.dynamicToolCall = complete
            ? d.item.success === false
              ? "Visual preview failed"
              : "Visual preview ready"
            : "Previewing visual";
        return {
          ...base,
          type: "activity.updated",
          data: { label: labels[d.item.type] },
        };
      }
      if (d.item?.type === "reasoning")
        return {
          ...base,
          data: {
            item: {
              id: d.item.id,
              type: "reasoning",
              summary: (d.item.summary || []).filter(
                (s: unknown) => typeof s === "string",
              ),
            },
          },
        };
      return d.item?.type === "mcpToolCall"
        ? {
            ...base,
            type: "activity.updated",
            data: {
              label:
                e.type === "item.started"
                  ? "Consulting a connected business service"
                  : "Business service request finished",
            },
          }
        : null;
    default:
      return null;
  }
}
export class PublicEventStream {
  private buffer = "";
  private decoder = new TextDecoder();
  // Observes each public event, for example to persist goal summaries. An
  // observer may return a replacement event (for example a snapshot with the
  // saved plan filled in).
  constructor(private readonly onEvent?: (event: any) => any) {}
  push(chunk: Uint8Array): string {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > 4 * 1024 * 1024)
      throw new Error("Event exceeds stream limit");
    let output = "",
      boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (frame.startsWith(":")) {
        output += ": heartbeat\n\n";
        continue;
      }
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      let event;
      try {
        event = publicEvent(JSON.parse(data));
      } catch (error) {
        // One bad frame is dropped; the rest of the stream stays usable.
        log("warn", "skipped malformed live update", {
          op: "stream",
          bytes: data.length,
          ...errorFields(error),
        });
        continue;
      }
      if (event && this.onEvent)
        try {
          event = this.onEvent(event) ?? event;
        } catch {
          // Observers must never interrupt the live stream.
        }
      if (event)
        output += `${event.cursor ? "id: " + event.cursor + "\n" : ""}data: ${JSON.stringify(event)}\n\n`;
    }
    return output;
  }
}
// A full socket buffer is normal after a large frame (an MCP tool result, a
// long replay); wait for the client to drain instead of dropping the stream.
export async function relay(
  body: AsyncIterable<Uint8Array>,
  res: Writable,
  stream: PublicEventStream,
) {
  for await (const chunk of body) {
    const output = stream.push(chunk);
    if (output && !res.write(output))
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    if (res.destroyed) return;
  }
}
