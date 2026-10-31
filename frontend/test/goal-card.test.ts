import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyGoalEvent,
  goalActions,
  NO_GOAL,
  promptOnOpen,
  resumePrompt,
  type TenantGoal,
} from "../lib/tenant-goal.ts";
import { component } from "./next-details-runtime.ts";

const { GoalCard } = component("tenant/goal-card.tsx");

const goal = (over: Partial<TenantGoal> = {}): TenantGoal => ({
  objective: "Write the quarterly report",
  status: "active",
  tokenBudget: 200_000,
  tokensUsed: 40_000,
  timeUsedSeconds: 90,
  origin: "user",
  review: "none",
  rev: 3,
  ...over,
});

const card = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(GoalCard, {
      goal: goal(),
      presets: [100_000, 300_000, 1_000_000],
      working: null,
      error: "",
      prompt: false,
      onAction() {},
      onDismissPrompt() {},
      ...props,
    }),
  );

test("Stop during a goal turn leaves the card on Goal paused, with Resume", () => {
  // The adapter pauses the goal on Stop; the platform relays the update.
  const running = applyGoalEvent(NO_GOAL, {
    type: "snapshot",
    data: { goal: goal() },
  });
  const stopped = applyGoalEvent(running, {
    type: "goal.updated",
    data: { goal: goal({ status: "paused", rev: 4 }) },
  });
  const html = card({ goal: stopped.goal });
  assert.match(html, /Goal paused/);
  assert.match(html, /<button[^>]*>Resume<\/button>/);
  assert.doesNotMatch(html, />Pause</);
  assert.deepEqual(goalActions(stopped.goal!), {
    edit: true,
    pause: false,
    resume: true,
    clear: true,
  });
  // While running: Pause, not Resume.
  assert.deepEqual(goalActions(goal()), {
    edit: true,
    pause: true,
    resume: false,
    clear: true,
  });
});

test("the meter and time follow goal.updated while turns run", () => {
  const first = card({ goal: goal() });
  assert.match(first, /Pursuing goal \(40K \/ 200K\)/);
  assert.match(
    first,
    /role="meter"[^>]*aria-valuemax="200000"[^>]*aria-valuenow="40000"/,
  );
  assert.match(first, /1m/);
  const later = applyGoalEvent(
    { goal: goal(), ended: false },
    {
      type: "goal.updated",
      data: {
        goal: goal({ tokensUsed: 120_000, timeUsedSeconds: 5_400, rev: 9 }),
      },
    },
  ).goal;
  const html = card({ goal: later });
  assert.match(html, /Pursuing goal \(120K \/ 200K\)/);
  assert.match(html, /aria-valuenow="120000"/);
  assert.match(html, /1h 30m/);
});

test("the resume prompt is offered only for paused, stalled and usage-limited goals", () => {
  for (const status of ["paused", "blocked", "usageLimited"] as const)
    assert.equal(resumePrompt(goal({ status })), true, status);
  for (const status of ["active", "budgetLimited", "complete"] as const)
    assert.equal(resumePrompt(goal({ status })), false, status);
  // A proposed goal asks for a budget instead.
  assert.equal(
    resumePrompt(goal({ status: "paused", origin: "model" })),
    false,
  );
  assert.equal(resumePrompt(null), false);
  const html = card({ goal: goal({ status: "blocked" }), prompt: true });
  assert.match(html, /Resume paused goal\?/);
  assert.match(html, />Not now</);
  assert.doesNotMatch(
    card({ goal: goal({ status: "blocked" }) }),
    /Resume paused goal\?/,
  );
});

test("a goal the agent proposed asks for a budget to start", () => {
  const proposed = goal({ status: "paused", origin: "model", tokensUsed: 0 });
  const html = card({ goal: proposed });
  assert.match(html, /The agent proposed a goal\. Choose a budget to start\./);
  assert.match(html, /Write the quarterly report/);
  const budgets = [...html.matchAll(/<button[^>]*>(Start with [^<]+)</g)].map(
    (m) => m[1],
  );
  assert.deepEqual(budgets, [
    "Start with 100K tokens",
    "Start with 300K tokens",
    "Start with 1M tokens",
  ]);
  assert.doesNotMatch(html, />Resume</);
  assert.deepEqual(goalActions(proposed), {
    edit: false,
    pause: false,
    resume: false,
    clear: true,
  });
});

test("clear asks for confirmation; a refusal shows in the card", () => {
  const html = card();
  assert.match(html, /<button[^>]*>Clear<\/button>/);
  const confirming = card({ confirming: true });
  assert.match(confirming, /End goal mode in this chat\?/);
  assert.match(confirming, /<button[^>]*>Clear goal<\/button>/);
  const refused = card({ error: "3 goals running. Pause or finish one." });
  assert.match(refused, /role="alert"[^>]*>[^<]*3 goals running/);
  assert.match(
    card({ goal: goal({ status: "paused" }), working: "resume" }),
    /Resuming…/,
  );
});

test("the resume prompt is decided once per opening, from the goal the chat opened with", () => {
  const paused = goal({ status: "paused" });
  // Waiting for the snapshot decides nothing.
  let prompt = promptOnOpen(null, "c1", null);
  assert.equal(prompt, null);
  prompt = promptOnOpen(prompt, "c1", paused);
  assert.deepEqual(prompt, { chatId: "c1", show: true });
  // Later updates in the same opening change nothing (dismissed stays so).
  const dismissed = { chatId: "c1", show: false };
  assert.equal(promptOnOpen(dismissed, "c1", paused), dismissed);
  // A goal that was running when the chat opened never prompts, even after
  // Stop pauses it.
  const running = promptOnOpen(null, "c2", goal());
  assert.deepEqual(running, { chatId: "c2", show: false });
  assert.equal(promptOnOpen(running, "c2", paused), running);
  // Leaving and reopening asks again.
  const left = promptOnOpen(dismissed, null, null);
  assert.equal(left, null);
  assert.deepEqual(promptOnOpen(left, "c1", paused), {
    chatId: "c1",
    show: true,
  });
});
