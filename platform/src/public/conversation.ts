import { effectiveMode } from "../core/features";
import type {
  ApprovalModesConfig,
  Goal,
  Session,
  SubAgent,
  SubAgentStatus,
  SubAgentTranscript,
} from "../../../shared/contracts";
import { clamp, finite, SUB_AGENT_ID } from "./fields";
import { request } from "./approvals";
import { publicTiming, publicTrace, publicRateLimits } from "./telemetry";
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
export function subAgentLabel(type: string, a: SubAgent) {
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
function message(m: any) {
  return {
    id: m.id,
    turnId: m.turnId,
    text: m.text,
    final: m.final,
    messageIndex: m.messageIndex,
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
// A recent-history client already owns its loaded older pages. Snapshots
// refresh recent and active turns without resending every historical answer.
// This bounds turn count, not bytes: a single large turn stays intact.
export function recentSnapshot<T extends ReturnType<typeof publicSnapshot>>(
  snapshot: T,
  loadedTurns?: ReadonlySet<string>,
): T {
  const turns = new Set(loadedTurns);
  if (!turns.size) {
    for (
      let index = snapshot.messages.length - 1;
      index >= 0 && turns.size < 10;
      index--
    ) {
      const turnId = snapshot.messages[index].turnId;
      if (typeof turnId === "string") turns.add(turnId);
    }
  }
  if (typeof snapshot.state.turnId === "string")
    turns.add(snapshot.state.turnId);
  return {
    ...snapshot,
    messages: snapshot.messages.filter((message: any) =>
      turns.has(message.turnId),
    ),
    thinking: snapshot.thinking.filter((entry: any) => turns.has(entry.turnId)),
  };
}
