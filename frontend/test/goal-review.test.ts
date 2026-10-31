import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canAcceptAsIs,
  goalStatusText,
  mergedObjectiveLength,
  raiseOptions,
  type TenantGoal,
} from "../lib/tenant-goal.ts";
import { component } from "./next-details-runtime.ts";

const { GoalReview } = component("tenant/goal-review.tsx");

const PRESETS: [number, number, number] = [100_000, 300_000, 1_000_000];
const MAX = 3_000_000;

const goal = (over: Partial<TenantGoal> = {}): TenantGoal => ({
  objective: "Write the quarterly report",
  status: "complete",
  tokenBudget: 300_000,
  tokensUsed: 120_000,
  timeUsedSeconds: 600,
  origin: "user",
  review: "pending",
  rev: 7,
  ...over,
});

const review = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(GoalReview, {
      goal: goal(),
      presets: PRESETS,
      maxTokenBudget: MAX,
      working: null,
      onAction() {},
      ...props,
    }),
  );

test("request changes shows the merged objective's length and refuses over 4000", () => {
  // The platform merges "<objective>\n\nChanges requested: <feedback>".
  const objective = "Write the quarterly report";
  assert.equal(
    mergedObjectiveLength(objective, "  Add charts  "),
    [...`${objective}\n\nChanges requested: Add charts`].length,
  );
  const html = review({ feedback: "Add charts" });
  assert.match(html, /<label[^>]*>Changes to make/);
  assert.match(html, /57 \/ 4,000 characters with the objective/);
  assert.doesNotMatch(
    html,
    /<button type="submit"[^>]*disabled[^>]*>Request changes/,
  );
  // Over the limit: Request changes is off and says what to do.
  const long = "x".repeat(4_000 - 46);
  assert.equal(mergedObjectiveLength(objective, long), 4_001);
  const over = review({ feedback: long });
  assert.match(over, /Shorten the feedback/);
  assert.match(over, /<button type="submit"[^>]*disabled[^>]*>Request changes/);
  // Empty feedback is not sent either.
  assert.match(review({ feedback: "" }), /<button type="submit"[^>]*disabled/);
});

test("raise offers only budgets above what the goal used, up to the maximum", () => {
  const limited = goal({
    status: "budgetLimited",
    review: "none",
    tokenBudget: 300_000,
    tokensUsed: 300_400,
  });
  assert.deepEqual(raiseOptions(limited, PRESETS, MAX), [1_000_000, MAX]);
  // At or below tokensUsed is never offered.
  assert.deepEqual(
    raiseOptions(
      goal({
        status: "budgetLimited",
        tokenBudget: 1_000_000,
        tokensUsed: 1_000_000,
      }),
      PRESETS,
      MAX,
    ),
    [MAX],
  );
  // A running goal is only raised above its budget.
  assert.deepEqual(
    raiseOptions(
      goal({
        status: "active",
        review: "none",
        tokenBudget: 300_000,
        tokensUsed: 10,
      }),
      PRESETS,
      MAX,
    ),
    [1_000_000, MAX],
  );
  // At the maximum there is nothing to raise to.
  assert.deepEqual(
    raiseOptions(
      goal({ status: "budgetLimited", tokenBudget: MAX, tokensUsed: MAX }),
      PRESETS,
      MAX,
    ),
    [],
  );
  const html = review({ goal: limited });
  const raises = [...html.matchAll(/<button[^>]*>(Raise to [^<]+)</g)].map(
    (m) => m[1],
  );
  assert.deepEqual(raises, ["Raise to 1M tokens", "Raise to 3M tokens"]);
  assert.doesNotMatch(html, />Accept as is</);
});

test("approve and accept as is end the review as achieved", () => {
  const pending = review();
  assert.match(pending, /<button[^>]*>Approve<\/button>/);
  assert.equal(
    goalStatusText(goal({ review: "approved" })),
    "Goal achieved (120K tokens)",
  );
  // Accept as is only for a budget-limited goal at the chat's maximum.
  const atMax = goal({
    status: "budgetLimited",
    review: "none",
    tokenBudget: MAX,
    tokensUsed: MAX + 5,
  });
  assert.equal(canAcceptAsIs(atMax, MAX), true);
  assert.equal(canAcceptAsIs({ ...atMax, tokenBudget: 1_000_000 }, MAX), false);
  assert.equal(canAcceptAsIs({ ...atMax, status: "paused" }, MAX), false);
  const html = review({ goal: atMax });
  assert.match(html, /<button[^>]*>Accept as is<\/button>/);
  assert.doesNotMatch(html, /Raise to/);
  assert.equal(
    goalStatusText({ ...atMax, review: "accepted_as_is" }),
    "Goal achieved (stopped at budget)",
  );
  // Nothing to review on an approved goal.
  assert.equal(review({ goal: goal({ review: "approved" }) }), "");
});
