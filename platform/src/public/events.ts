import { runtimeError } from "../../../shared/errors";
import {
  publicGoal,
  publicPlan,
  publicSnapshot,
  publicSubAgent,
  subAgentLabel,
} from "./conversation";
import { publicApproval, request } from "./approvals";
import {
  publicTiming,
  publicTrace,
  publicUsage,
  publicRateLimits,
} from "./telemetry";
import { clamp, finite, SUB_AGENT_ID } from "./fields";
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
    case "sync.completed":
      if (
        d.protocol !== 1 ||
        !["replay", "snapshot"].includes(d.mode) ||
        typeof d.highWaterCursor !== "string" ||
        d.highWaterCursor !== e.cursor ||
        !(d.fromCursor === null || typeof d.fromCursor === "string") ||
        !d.snapshot ||
        typeof d.snapshot !== "object" ||
        d.snapshot.cursor !== d.highWaterCursor ||
        !d.snapshot.state ||
        typeof d.snapshot.state !== "object" ||
        !["idle", "starting", "running", "interrupting"].includes(
          d.snapshot.state.kind,
        ) ||
        (["running", "interrupting"].includes(d.snapshot.state.kind) &&
          (typeof d.snapshot.state.turnId !== "string" ||
            !d.snapshot.state.turnId)) ||
        !Array.isArray(d.snapshot.pending) ||
        !Array.isArray(d.snapshot.messages) ||
        d.snapshot.messages.length ||
        !Array.isArray(d.snapshot.thinking) ||
        d.snapshot.thinking.length
      )
        return null;
      return {
        ...base,
        data: {
          protocol: 1,
          mode: d.mode,
          fromCursor: d.fromCursor,
          highWaterCursor: d.highWaterCursor,
          // Only explicit operational fields cross this trust boundary. No
          // historical message/reasoning bodies can enter a completion marker.
          snapshot: publicSnapshot({
            ...d.snapshot,
            messages: [],
            thinking: [],
          }),
          ...(typeof d.reason === "string"
            ? {
                reason:
                  "Conversation synchronization required a fresh snapshot.",
              }
            : {}),
        },
      };
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
