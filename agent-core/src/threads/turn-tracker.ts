import { TraceBuilder } from "../telemetry/trace";
import type { RateLimitView, TurnTiming } from "../../../shared/contracts";
import type { Thread, TurnEnd } from "./state";
import { activeTurn } from "./state";
const traceLimit = 100;
const contextTurnLimit = 20;
// Codex edits an objective in place and keeps the goal's usage, so a goal is
// identified by its creation time. Clearing a goal always resets the tally.
const goalKey = (goal: any) =>
  goal && typeof goal.objective === "string"
    ? String(goal.createdAt ?? "")
    : null;
// Mirrors the runtime's goal accounting: fresh input plus output tokens.
export function goalTokenDelta(usage: any) {
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return (
    Math.max(0, n(usage?.inputTokens) - n(usage?.cachedInputTokens)) +
    Math.max(0, n(usage?.outputTokens))
  );
}

// The running turn's trace; created lazily for a turn resumed mid-way.
export function builder(
  t: Thread,
  turnId: string | undefined,
  rateLimits: RateLimitView | null,
) {
  if (!turnId) return undefined;
  if (t.trace?.turnId === turnId) return t.trace;
  if (activeTurn(t) !== turnId) return undefined;
  t.trace = new TraceBuilder(
    turnId,
    t.id,
    Date.now(),
    rateLimits,
    t.input ?? "",
  );
  t.input = undefined;
  return t.trace;
}

export function finishTurn(
  t: Thread,
  turnId: string,
  status: string | undefined,
  at: number,
): TurnEnd {
  const end: TurnEnd = {};
  if (t.clock && t.clock.turnId === turnId) {
    const c = t.clock,
      total = at - c.start,
      stream = c.first !== null && c.last !== null ? c.last - c.first : 0;
    const timing: TurnTiming = {
      turnId,
      acceptMs: c.accept,
      ttftMs: c.first === null ? null : c.first - c.start,
      streamMs: stream,
      adapterStreamMs: Math.min(stream, c.handler),
      idleStreamMs: Math.max(0, stream - c.handler),
      maxGapMs: c.gap,
      deltaRate: stream > 0 ? c.count / (stream / 1000) : 0,
      finalizeMs: c.last === null ? total : at - c.last,
      totalMs: total,
      deltaCount: c.count,
      nonStreaming: c.count === 0,
      status: status as string,
    };
    t.timings.push(timing);
    if (t.timings.length > 100) t.timings.shift();
    end.timing = timing;
    t.clock = undefined;
  }
  const b = t.trace;
  if (b && b.turnId === turnId) {
    t.trace = undefined;
    const trace = b.finish(status ?? "completed", end.timing?.totalMs ?? null);
    t.traces.push(trace);
    if (t.traces.length > traceLimit) t.traces.shift();
    t.contexts.set(turnId, b.context());
    if (t.contexts.size > contextTurnLimit)
      t.contexts.delete(t.contexts.keys().next().value!);
    end.trace = trace;
  }
  return end;
}

export function seeTurn(t: Thread, turnId: string) {
  if (t.turnOrder.includes(turnId)) return;
  t.turnOrder.push(turnId);
  if (t.turnOrder.length > 500) t.turnOrder.shift();
}

// True when turnId is older than the turn that produced the stored plan.
// An unknown turn counts as older once the stored plan's turn is known.
export function stalePlan(t: Thread, turnId: string) {
  if (!t.planTurnId || t.planTurnId === turnId) return false;
  const stored = t.turnOrder.indexOf(t.planTurnId);
  if (stored < 0) return false;
  return t.turnOrder.indexOf(turnId) < stored;
}

// A different goal starts a fresh tally.
export function setGoal(t: Thread, goal: any) {
  const key = goalKey(goal);
  if (key !== t.goalTokens.key) t.goalTokens = { key, observed: 0, turns: [] };
  t.goal = goal;
}

// Turns that ran while the goal was active count toward it, including usage
// reported after the goal was marked complete within the same turn.
export function trackGoalTurn(t: Thread, turnId: string) {
  const goal = t.goal as any;
  if (goal?.status !== "active" || t.goalTokens.turns.includes(turnId)) return;
  t.goalTokens.turns.push(turnId);
  if (t.goalTokens.turns.length > 200) t.goalTokens.turns.shift();
}

export function goalView(t: Thread) {
  const goal = t.goal as any;
  return goal ? { ...goal, tokensObserved: t.goalTokens.observed } : null;
}

// (Re)arms the running turn's inactivity watchdog. A turn waiting on the
// user is not stalled, so the watchdog is off while a request is pending.
export function watch(
  t: Thread,
  stallMs: number,
  stalled: (t: Thread, turnId: string) => void,
) {
  unwatch(t);
  if (t.state.kind !== "running" || t.pending.size) return;
  const turnId = t.state.turnId;
  t.stall = setTimeout(() => stalled(t, turnId), stallMs);
  t.stall.unref?.();
}
export function unwatch(t: Thread) {
  clearTimeout(t.stall);
  t.stall = undefined;
}
