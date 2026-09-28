import type { Writable } from "node:stream";
import { runtimeError } from "../../shared/errors";
import type {
  Goal,
  Session,
  SubAgent,
  SubAgentStatus,
  SubAgentTranscript,
  TurnTiming,
} from "../../shared/contracts";
export const POLICY_VERSION = 1;

export function publicSession(s: Session) {
  return {
    _id: s._id,
    agentId: s.agentId,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
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
function publicPlan(plan: any) {
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
  "Allow and don't ask me again": "allowedAlways",
  Cancel: "declined",
};
// A resolved input request as the chat's audit trail shows it. Tool approvals
// reuse the public question projection, so raw server and tool ids stay out.
export function publicApproval(a: any) {
  if (a?.method !== "item/tool/requestUserInput") return null;
  const questions = (a.detail?.questions || []).map(question);
  // Records saved before questions were kept have nothing to show.
  if (!questions.length) return null;
  const answers = a.result?.answers || {};
  // Anything other than a user answer means the request went unanswered.
  const outcome =
    a.reason === "user"
      ? "answered"
      : a.reason === "expired"
        ? "expired"
        : "interrupted";
  const expired = outcome !== "answered";
  return {
    requestId: a.requestId,
    at: typeof a.at === "string" ? a.at : undefined,
    turnId: typeof a.turnId === "string" ? a.turnId : undefined,
    outcome,
    items: questions.map((q: any, i: number) => {
      const raw = a.detail?.questions?.[i];
      const value = answers[q.id]?.answers?.[0];
      const answer = typeof value === "string" ? value : "";
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
          : !expired && answer
            ? { answer }
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
      return { ...base, data: { plan: publicPlan(d.plan) } };
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
          ...(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"].includes(d.tool)
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
    case "error":
      return { ...base, data: runtimeError(d) };
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
  // Observes each public event, for example to persist goal summaries.
  constructor(private readonly onEvent?: (event: any) => void) {}
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
      const event = publicEvent(JSON.parse(data));
      if (event && this.onEvent)
        try {
          this.onEvent(event);
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
