import { Store } from "../persistence/store";
import type {
  Goal,
  GoalHistoryEntry,
  GoalReview,
  Session,
} from "../../../shared/contracts";
import { ApiError } from "../core/errors";
import type { Access } from "../tenancy/access";
import type { SessionDocument } from "../persistence/store";
import {
  sameGoal,
  staleGoal,
  goalChanges,
  GOAL_HISTORY_LIMIT,
  type GoalSource,
} from "./goal-state";
export class GoalService {
  constructor(
    private readonly store: Store,
    private readonly sessionFor: (
      id: string,
      mode: Access,
    ) => Promise<SessionDocument>,
    private readonly capability: (
      id: string,
      method: string,
      params: unknown,
      loaded?: Session,
    ) => Promise<any>,
  ) {}

  // Latest goal summary for the conversation list. The runtime remains the
  // source of truth; this copy only drives list indicators and filters.
  async rememberGoal(id: string, goal: Goal | null, source: GoalSource = {}) {
    // The command response and the live event stream both save goal changes.
    // Each write only applies if the summary is still the one it read, so two
    // savers can't both log the same change; the loser re-reads and retries.
    for (let attempt = 0; ; attempt++) {
      const session = await this.store.sessions.findOne({ _id: id });
      const saved = session?.goal;
      // A replayed record never rolls back a newer saved state.
      if (staleGoal(session, goal, source)) return goal;
      // A save without an event time (snapshot, command) keeps the saved one
      // while Codex reports the same update.
      const eventAt =
        source.eventAt ??
        (goal &&
        sameGoal(saved, goal) &&
        saved?.goalUpdatedAt === goal.updatedAt
          ? saved?.goalEventAt
          : undefined);
      const changes = goalChanges(
        saved,
        goal,
        new Date().toISOString(),
        source.turnId || undefined,
      );
      // After a few lost races, save the summary without history rather than fail.
      const guarded = attempt < 5;
      const history =
        guarded && changes.length
          ? {
              $push: {
                goalHistory: { $each: changes, $slice: -GOAL_HISTORY_LIMIT },
              },
            }
          : {};
      const tokensObserved = goal
        ? Math.max(
            goal.tokensObserved ?? 0,
            sameGoal(saved, goal) ? (saved?.tokensObserved ?? 0) : 0,
          )
        : 0;
      const update = goal
        ? {
            $set: {
              goal: {
                objective: goal.objective,
                status: goal.status,
                createdAt: goal.createdAt,
                tokensObserved,
                tokenBudget: goal.tokenBudget,
                updatedAt: new Date().toISOString(),
                goalUpdatedAt: goal.updatedAt,
                ...(eventAt ? { goalEventAt: eventAt } : {}),
              },
            },
            ...history,
          }
        : {
            $unset: { goal: "" as const },
            ...(saved
              ? {
                  $set: {
                    goalCleared: {
                      createdAt: saved.createdAt ?? null,
                      ...(source.eventAt ? { eventAt: source.eventAt } : {}),
                    },
                  },
                }
              : {}),
            ...history,
          };
      const result = await this.store.sessions.updateOne(
        guarded
          ? { _id: id, goal: saved === undefined ? { $exists: false } : saved }
          : { _id: id },
        update,
      );
      if (result.matchedCount || !guarded) {
        // An agent-core restart loses its tally; keep the larger saved count.
        return goal ? { ...goal, tokensObserved } : goal;
      }
      if (!(await this.store.sessions.findOne({ _id: id }))) return goal;
    }
  }
  async goalHistory(id: string) {
    return {
      entries: (await this.sessionFor(id, "read")).goalHistory || [],
    };
  }
  // The agent marks a goal complete; the user then accepts it or reopens it
  // with feedback. Reopening makes the goal active again for the agent.
  async reviewGoal(
    id: string,
    body: { decision?: unknown; feedback?: unknown },
  ) {
    const decision = body?.decision;
    if (decision !== "accepted" && decision !== "reopened")
      throw new ApiError(400, "Choose accepted or reopened", "INVALID_REVIEW");
    const feedback =
      typeof body.feedback === "string" ? body.feedback.trim() : "";
    if (feedback.length > 4000)
      throw new ApiError(400, "Feedback is too long", "INVALID_REVIEW");
    const session = await this.sessionFor(id, "write");
    const { goal } = await this.capability(id, "thread/goal/get", {}, session);
    if (!goal || goal.status !== "complete")
      throw new ApiError(
        409,
        "Only a goal the assistant has completed can be reviewed",
        "GOAL_NOT_COMPLETE",
      );
    const review: GoalReview = {
      objective: goal.objective,
      goalCreatedAt: goal.createdAt,
      decision,
      ...(feedback ? { feedback } : {}),
      at: new Date().toISOString(),
    };
    const entry: GoalHistoryEntry = {
      at: review.at,
      kind: decision,
      objective: goal.objective,
      status: goal.status,
      tokens: Math.max(goal.tokensUsed, goal.tokensObserved ?? 0),
      ...(feedback ? { feedback } : {}),
    };
    const log = {
      $push: { goalHistory: { $each: [entry], $slice: -GOAL_HISTORY_LIMIT } },
    };
    if (decision === "reopened") {
      await this.store.sessions.updateOne({ _id: id }, log);
      const reopened = await this.capability(
        id,
        "thread/goal/set",
        { status: "active" },
        session,
      );
      return { goal: reopened.goal, review };
    }
    await this.store.sessions.updateOne(
      { _id: id },
      { $set: { goalReview: review }, ...log },
    );
    return { goal, review };
  }
}
