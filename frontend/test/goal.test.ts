import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awaitingReview,
  extendedBudget,
  formatDuration,
  formatTokens,
  goalAccepted,
  goalCommand,
  goalStateLabel,
  goalTokens,
  historyLabel,
  parseTokenBudget,
  sameGoal,
} from "../lib/goal.ts";

const goal = {
  objective: "Quarterly report",
  status: "complete" as const,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 10,
  updatedAt: 20,
};

test("a completed goal awaits review until the user accepts that same goal", () => {
  assert.equal(awaitingReview(goal, null), true);
  const review = {
    objective: "Quarterly report",
    goalCreatedAt: 10,
    decision: "accepted" as const,
    at: "",
  };
  assert.equal(goalAccepted(goal, review), true);
  assert.equal(awaitingReview(goal, review), false);
  // A new goal with the same wording is a different goal.
  assert.equal(awaitingReview({ ...goal, createdAt: 11 }, review), true);
  assert.equal(awaitingReview({ ...goal, status: "active" }, null), false);
});

test("durations and token counts read naturally", () => {
  assert.equal(formatDuration(42), "42s");
  assert.equal(formatDuration(252), "4m 12s");
  assert.equal(formatDuration(3900), "1h 5m");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12345), "12.3k");
  assert.equal(formatTokens(250000), "250k");
});

test("a goal-first submission sets the goal with an optional budget", () => {
  assert.deepEqual(goalCommand("  Draft the launch plan  ", null), {
    kind: "command",
    method: "thread/goal/set",
    params: { objective: "Draft the launch plan" },
    success: "Goal set.",
  });
  assert.deepEqual(goalCommand("Plan", 25000).params, {
    objective: "Plan",
    tokenBudget: 25000,
  });
});

test("goal state label follows the review", () => {
  const review = {
    objective: goal.objective,
    goalCreatedAt: goal.createdAt,
    decision: "accepted" as const,
    at: "2026-09-27T00:00:00.000Z",
  };
  assert.equal(goalStateLabel(goal, review), "Accepted");
  assert.equal(goalStateLabel(goal, null), "Ready for review");
  assert.equal(goalStateLabel({ ...goal, status: "active" }, null), "In progress");
});

test("same goal matches on creation time, so an edited objective is the same goal", () => {
  assert.equal(sameGoal(goal, { ...goal, status: "active", tokensUsed: 9 }), true);
  assert.equal(sameGoal(goal, { ...goal, objective: "Edited" }), true);
  assert.equal(sameGoal(goal, { ...goal, createdAt: 11 }), false);
  assert.equal(sameGoal(goal, null), false);
});

test("goal tokens show the larger of Codex's count and Truex's count", () => {
  assert.equal(goalTokens(goal), 0);
  assert.equal(goalTokens({ ...goal, tokensObserved: 19763 }), 19763);
  assert.equal(goalTokens({ ...goal, tokensUsed: 500, tokensObserved: 200 }), 500);
});

test("token budgets accept plain, grouped and k amounts within limits", () => {
  for (const [text, tokens] of [
    ["50000", 50000],
    ["50,000", 50000],
    [" 50k ", 50000],
    ["10000k", 10_000_000],
  ] as const)
    assert.equal(parseTokenBudget(text), tokens, text);
  for (const text of ["", "0", "-5", "1.5k", "lots", "10001k", "9".repeat(20)])
    assert.equal(parseTokenBudget(text), null, text);
});

test("extending a budget leaves room above Codex's own count", () => {
  const limited = { ...goal, status: "budgetLimited" as const, tokenBudget: 25000 };
  assert.equal(extendedBudget({ ...limited, tokensUsed: 25400 }, 25000), 50400);
  assert.equal(extendedBudget({ ...limited, tokensUsed: 20000 }, 25000), 50000);
  assert.equal(extendedBudget({ ...limited, tokenBudget: null, tokensUsed: 0 }, 50000), 50000);
  assert.equal(extendedBudget({ ...limited, tokenBudget: 9_990_000 }, 50000), 10_000_000);
});

test("goal history entries read as plain sentences", () => {
  const base = { at: "2026-09-27T00:00:00.000Z", objective: "Report" };
  assert.equal(historyLabel({ ...base, kind: "set" }), "Goal set");
  assert.equal(historyLabel({ ...base, kind: "budget", tokenBudget: 50000 }), "Budget set to 50k tokens");
  assert.equal(historyLabel({ ...base, kind: "budget", tokenBudget: null }), "Budget removed");
  assert.equal(historyLabel({ ...base, kind: "status", status: "budgetLimited" }), "Status: Budget reached");
  assert.equal(historyLabel({ ...base, kind: "reopened" }), "You reopened the goal");
});
