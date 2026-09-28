import type {
  Goal,
  GoalHistoryEntry,
  GoalReview,
  GoalStatus,
} from "../../shared/contracts";

export const goalStatus: Record<
  GoalStatus,
  { label: string; hint: string; tone: "good" | "neutral" | "warn" }
> = {
  active: {
    label: "In progress",
    hint: "The assistant is working toward this goal.",
    tone: "good",
  },
  paused: {
    label: "Paused",
    hint: "Resume the goal when you want the assistant to continue.",
    tone: "neutral",
  },
  blocked: {
    label: "Needs input",
    hint: "The assistant stopped. It needs your input or hit an error; check the latest reply, then resume the goal.",
    tone: "warn",
  },
  usageLimited: {
    label: "Usage limit reached",
    hint: "Work stopped because model usage ran out. Resume once usage is available again.",
    tone: "warn",
  },
  budgetLimited: {
    label: "Budget reached",
    hint: "The token budget is used up. Extend it to let the assistant keep going.",
    tone: "warn",
  },
  complete: {
    label: "Complete",
    hint: "The assistant marked this goal complete.",
    tone: "good",
  },
};

// A review only counts for the goal it was made for.
export function goalAccepted(goal: Goal | null, review: GoalReview | null) {
  return (
    !!goal &&
    goal.status === "complete" &&
    review?.decision === "accepted" &&
    review.objective === goal.objective &&
    review.goalCreatedAt === goal.createdAt
  );
}

// The agent marks a goal complete; the user confirms it.
export function awaitingReview(goal: Goal | null, review: GoalReview | null) {
  return !!goal && goal.status === "complete" && !goalAccepted(goal, review);
}

// What the user sees as the goal's state, including their review.
export function goalStateLabel(goal: Goal, review: GoalReview | null) {
  if (goalAccepted(goal, review)) return "Accepted";
  if (awaitingReview(goal, review)) return "Ready for review";
  return goalStatus[goal.status]?.label || goal.status;
}

// Codex edits an objective in place, so the creation time identifies a goal.
export function sameGoal(a: Goal | null | undefined, b: Goal | null | undefined) {
  return !!a && !!b && a.createdAt === b.createdAt;
}

// A short sentence for one goal timeline entry.
export function historyLabel(entry: GoalHistoryEntry) {
  switch (entry.kind) {
    case "set":
      return "Goal set";
    case "objective":
      return "Objective edited";
    case "budget":
      return entry.tokenBudget
        ? `Budget set to ${formatTokens(entry.tokenBudget)} tokens`
        : "Budget removed";
    case "status":
      return entry.status
        ? `Status: ${goalStatus[entry.status]?.label || entry.status}`
        : "Status changed";
    case "accepted":
      return "You accepted the result";
    case "reopened":
      return "You reopened the goal";
    case "cleared":
      return "Goal cleared";
  }
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Codex misses usage reported after a goal completes; Truex counts it too.
export function goalTokens(goal: Goal) {
  return Math.max(goal.tokensUsed ?? 0, goal.tokensObserved ?? 0);
}

// Codex's token count since the previous change of the same goal, or null
// when the entry starts a goal, has no count, or the count didn't grow.
export function tokenChange(entries: GoalHistoryEntry[], index: number) {
  const entry = entries[index];
  if (!entry || entry.kind === "set" || entry.tokensUsed === undefined)
    return null;
  for (let i = index - 1; i >= 0; i--) {
    const prev = entries[i];
    if (prev.kind === "cleared") return null;
    if (prev.tokensUsed !== undefined) {
      const change = entry.tokensUsed - prev.tokensUsed;
      return change > 0 ? change : null;
    }
    if (prev.kind === "set") return null;
  }
  return null;
}

export function formatTokens(tokens: number) {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  const k = tokens / 1000;
  return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

export const MAX_TOKEN_BUDGET = 10_000_000;
export const budgetHelp =
  "Enter a whole number of tokens, like 50000 or 50k (up to 10M).";

// Accepts 50000, 50,000 or 50k. Returns null for anything else.
export function parseTokenBudget(text: string) {
  const value = /^(\d[\d,_]*)(k?)$/i.exec(text.trim());
  if (!value) return null;
  const tokens =
    Number(value[1].replace(/[,_]/g, "")) * (value[2] ? 1000 : 1);
  return Number.isSafeInteger(tokens) &&
    tokens > 0 &&
    tokens <= MAX_TOKEN_BUDGET
    ? tokens
    : null;
}

// A budget that leaves `extra` tokens of room. Codex compares its own count
// with the budget, so the new budget builds on whichever of the two is larger.
export function extendedBudget(goal: Goal, extra: number) {
  return Math.min(
    MAX_TOKEN_BUDGET,
    Math.max(goal.tokenBudget ?? 0, goal.tokensUsed) + extra,
  );
}
export const budgetExtensions = [25_000, 50_000];

export const budgetOptions: { label: string; value: number | null }[] = [
  { label: "No budget", value: null },
  { label: "25k tokens", value: 25_000 },
  { label: "100k tokens", value: 100_000 },
  { label: "250k tokens", value: 250_000 },
];

// Setting an active goal starts the assistant working on it, so a goal-first
// submission sets the goal and does not also send a chat message.
export function goalCommand(objective: string, tokenBudget: number | null) {
  return {
    kind: "command" as const,
    method: "thread/goal/set",
    params: {
      objective: objective.trim(),
      ...(tokenBudget ? { tokenBudget } : {}),
    } as Record<string, unknown>,
    success: "Goal set.",
  };
}
