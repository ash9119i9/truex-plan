import type { DomainEvent, Goal } from "../../shared/contracts";
import type { PlanStep } from "./plan";

// "Follow activity": the session panel moves to the tab for what the
// conversation just started (a goal, a plan, a helper agent).
export type FollowTab = "goal" | "plan" | "agents";

// Events this close together make one switch; the most specific tab wins.
export const FOLLOW_BATCH_MS = 300;
// A tab the user picked is kept this long before following resumes.
export const MANUAL_HOLD_MS = 8000;
// Older events are history being replayed, not something happening now.
const STALE_MS = 60_000;
const RANK: Record<FollowTab, number> = { goal: 0, plan: 1, agents: 2 };

export interface FollowSeen {
  goal: Goal | null;
  plan: PlanStep[];
  agentIds: string[];
}

// The tab an event asks for, or null. Only a start counts, never progress.
export function followTab(
  event: Pick<DomainEvent, "type" | "data" | "at">,
  seen: FollowSeen,
  now = Date.now(),
): FollowTab | null {
  const at = Date.parse(event.at);
  if (Number.isFinite(at) && now - at > STALE_MS) return null;
  const d = event.data || {};
  switch (event.type) {
    case "goal.updated": {
      const next = d.goal as Goal | undefined;
      if (next?.status !== "active") return null;
      const prev = seen.goal;
      const fresh =
        !prev || prev.status !== "active" || prev.createdAt !== next.createdAt;
      return fresh ? "goal" : null;
    }
    case "plan.updated": {
      // The Goal tab already shows the plan, so a goal keeps its tab.
      if (seen.goal?.status === "active") return null;
      // Step status changes are progress; new or reworded steps are a new plan.
      const steps = (p: PlanStep[]) => p.map((s) => s?.step).join("\n");
      const next = Array.isArray(d.plan) ? (d.plan as PlanStep[]) : [];
      return next.length && steps(next) !== steps(seen.plan) ? "plan" : null;
    }
    case "subagent.spawned":
    case "subagent.event": {
      // A helper's output can arrive before its spawn event.
      const id = d.agent?.threadId ?? d.agentThreadId;
      return id && !seen.agentIds.includes(id) ? "agents" : null;
    }
  }
  return null;
}

export const emptySeen = (): FollowSeen => ({
  goal: null,
  plan: [],
  agentIds: [],
});

// What the stream has shown so far, so only starts are followed.
export function noteSeen(
  seen: FollowSeen,
  event: Pick<DomainEvent, "type" | "data">,
): FollowSeen {
  const d = event.data || {};
  const withAgent = (id: unknown) =>
    typeof id === "string" && !seen.agentIds.includes(id)
      ? { ...seen, agentIds: [...seen.agentIds, id] }
      : seen;
  switch (event.type) {
    case "snapshot":
      return {
        goal: d.goal || null,
        plan: Array.isArray(d.plan) ? d.plan : [],
        agentIds: Array.isArray(d.subAgents)
          ? d.subAgents.map((a: any) => a?.threadId).filter(Boolean)
          : seen.agentIds,
      };
    case "goal.updated":
      return { ...seen, goal: d.goal || null };
    case "goal.cleared":
      return { ...seen, goal: null };
    case "plan.updated":
      return { ...seen, plan: Array.isArray(d.plan) ? d.plan : [] };
    case "subagent.spawned":
    case "subagent.status":
    case "subagent.completed":
      return withAgent(d.agent?.threadId);
    case "subagent.event":
      return withAgent(d.agentThreadId);
  }
  return seen;
}

export function pickTab(a: FollowTab | null, b: FollowTab | null) {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

export interface FollowContext {
  enabled: boolean;
  vw: number;
  now: number;
  // When the user last picked a tab themselves.
  manualAt: number;
  // The user closed the panel during this turn.
  dismissed: boolean;
  panelOpen: boolean;
  // Pointer or focus is inside the panel.
  inPanel: boolean;
  // Opening the panel leaves an open sidebar in place.
  fitsOpen: boolean;
}

// What following may do right now: switch the open panel's tab, open the
// panel on that tab, or nothing.
export function followAction(ctx: FollowContext): "switch" | "open" | null {
  if (!ctx.enabled || ctx.now - ctx.manualAt < MANUAL_HOLD_MS) return null;
  if (ctx.panelOpen) return ctx.inPanel ? null : "switch";
  // At drawer widths the panel would cover the chat (spec: innerWidth > 900).
  if (ctx.dismissed || ctx.vw <= 900 || !ctx.fitsOpen) return null;
  return "open";
}

const KEY = "truex-follow-activity";

export function readFollow(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeFollow(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {}
}
