import type { Session, TurnTiming } from "../../shared/contracts";
export const POLICY_VERSION = 1;

export function publicSession(s: Session) {
  return {
    _id: s._id,
    agentId: s.agentId,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
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
function message(m: any) {
  return {
    id: m.id,
    turnId: m.turnId,
    text: m.text,
    final: m.final,
    messageIndex: m.messageIndex,
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
      questions: (p.detail?.questions || []).map((q: any) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        isOther: q.isOther,
        isSecret: q.isSecret,
        options: q.options?.map((o: any) => ({
          label: o.label,
          description: o.description,
        })),
      })),
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
    diff: "",
    timings: (s.timings || []).map(publicTiming),
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
            status: ["completed", "failed", "interrupted"].includes(
              d.turn?.status,
            )
              ? d.turn.status
              : "completed",
          },
        },
      };
    case "error":
      return {
        ...base,
        data: {
          message: "The request could not be completed. Please try again.",
        },
      };
    case "approval.requested": {
      const pending = request(d);
      return pending ? { ...base, data: pending } : null;
    }
    case "approval.resolved":
      return { ...base, data: { requestId: d.requestId } };
    case "item.started":
    case "item.completed":
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
      if (event)
        output += `${event.cursor ? "id: " + event.cursor + "\n" : ""}data: ${JSON.stringify(event)}\n\n`;
    }
    return output;
  }
}
