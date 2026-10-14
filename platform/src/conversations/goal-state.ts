import type {
  Goal,
  GoalHistoryEntry,
  Session,
  SessionGoal,
} from "../../../shared/contracts";

// Codex edits an objective in place, so the creation time identifies a goal.
export function sameGoal(saved: SessionGoal | undefined, goal: Goal) {
  return !!saved && (saved.createdAt ?? null) === (goal.createdAt ?? null);
}
export const GOAL_HISTORY_LIMIT = 60;
// What changed between the saved goal summary and the latest goal.
export function goalChanges(
  saved: SessionGoal | undefined,
  goal: Goal | null,
  at: string,
  turnId?: string,
): GoalHistoryEntry[] {
  const turn = turnId ? { turnId } : {};
  if (!goal)
    return saved
      ? [{ at, kind: "cleared", objective: saved.objective, ...turn }]
      : [];
  const tokens = Math.max(goal.tokensUsed, goal.tokensObserved ?? 0);
  const entry = (kind: GoalHistoryEntry["kind"]): GoalHistoryEntry => ({
    at,
    kind,
    objective: goal.objective,
    status: goal.status,
    tokens,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    ...turn,
  });
  if (!sameGoal(saved, goal)) return [entry("set")];
  const changes: GoalHistoryEntry[] = [];
  if (saved!.objective !== goal.objective) changes.push(entry("objective"));
  // Older summaries have no budget, so a budget change is only known once saved.
  if (
    saved!.tokenBudget !== undefined &&
    saved!.tokenBudget !== goal.tokenBudget
  )
    changes.push(entry("budget"));
  if (saved!.status !== goal.status) changes.push(entry("status"));
  return changes;
}
// Where a goal save came from. Event times come from agent-core, so they are
// only compared with each other, never with platform time.
export interface GoalSource {
  turnId?: string | null;
  eventAt?: string;
  // A durable record replayed by ingest, possibly out of order.
  replay?: boolean;
  // Creation time of the goal a replayed clear removed.
  clearedCreatedAt?: number | null;
}
// Whether saving this goal would roll back a newer saved state.
export function staleGoal(
  s: Pick<Session, "goal" | "goalCleared"> | null,
  goal: Goal | null,
  source: GoalSource,
) {
  // The live stream is ordered and command results are current.
  if (!source.replay) return false;
  const saved = s?.goal;
  const { eventAt } = source;
  const notAfter = (known?: string) => !!known && !!eventAt && eventAt <= known;
  if (!goal) {
    if (!saved) return false;
    const cleared = source.clearedCreatedAt;
    if (
      cleared != null &&
      saved.createdAt != null &&
      saved.createdAt !== cleared
    )
      return saved.createdAt > cleared;
    return notAfter(saved.goalEventAt);
  }
  if (!saved) {
    const cleared = s?.goalCleared;
    if (!cleared || cleared.createdAt == null || goal.createdAt == null)
      return false;
    if (goal.createdAt !== cleared.createdAt)
      return goal.createdAt < cleared.createdAt;
    // A new goal set in the same second as the clear is newer than it.
    return !cleared.eventAt || !eventAt || eventAt <= cleared.eventAt;
  }
  if (!sameGoal(saved, goal))
    return (
      saved.createdAt != null &&
      goal.createdAt != null &&
      goal.createdAt < saved.createdAt
    );
  const known = saved.goalUpdatedAt;
  if (known == null || goal.updatedAt == null) return false;
  if (goal.updatedAt !== known) return goal.updatedAt < known;
  // Codex times are whole seconds; the event time breaks a tie.
  return notAfter(saved.goalEventAt);
}
// The saved goal summary, shaped like a live goal, for views that must not
// ask the runtime.
export function storedGoal(goal?: SessionGoal): Goal | null {
  if (!goal) return null;
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensObserved ?? 0,
    timeUsedSeconds: 0,
    createdAt: goal.createdAt ?? null,
    updatedAt: goal.goalUpdatedAt ?? null,
    ...(goal.tokensObserved !== undefined
      ? { tokensObserved: goal.tokensObserved }
      : {}),
  };
}
