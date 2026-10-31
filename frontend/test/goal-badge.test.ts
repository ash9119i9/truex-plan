import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  goalBadge,
  withGoalBadge,
  type TenantGoal,
} from "../lib/tenant-goal.ts";
import type { ChatSummary } from "../lib/tenant-chat.ts";
import { component } from "./next-details-runtime.ts";

const { ChatList } = component("tenant/chat-list.tsx");

const summary = (id: string, goal: ChatSummary["goal"] = null) =>
  ({
    id,
    title: `Chat ${id}`,
    lastMessageAt: new Date().toISOString(),
    activeRunId: null,
    goal,
  }) as unknown as ChatSummary;

const goal = (over: Partial<TenantGoal> = {}): TenantGoal => ({
  objective: "Report",
  status: "active",
  tokenBudget: 200_000,
  tokensUsed: 1_000,
  timeUsedSeconds: 10,
  origin: "user",
  review: "none",
  rev: 2,
  ...over,
});

test("each goal status has a badge in words, not only colour", () => {
  const cases: Array<[ChatSummary["goal"], string]> = [
    [{ status: "active", review: "none" }, "Pursuing goal"],
    [{ status: "paused", review: "none" }, "Goal paused"],
    [{ status: "blocked", review: "none" }, "Goal stalled"],
    [{ status: "usageLimited", review: "none" }, "Goal hit usage limits"],
    [{ status: "budgetLimited", review: "none" }, "Goal unmet"],
    [{ status: "complete", review: "pending" }, "Waiting for your review"],
    [{ status: "complete", review: "approved" }, "Goal achieved"],
    [{ status: "budgetLimited", review: "accepted_as_is" }, "Goal achieved"],
  ];
  for (const [badge, text] of cases)
    assert.equal(goalBadge(badge)?.text, text, JSON.stringify(badge));
  assert.equal(goalBadge(null), null);
  const html = renderToStaticMarkup(
    createElement(ChatList, {
      chats: [
        summary("a", { status: "complete", review: "pending" }),
        summary("b"),
      ],
      activeId: null,
      state: "ready",
      error: "",
      hasMore: false,
      loadingMore: false,
      onOpen() {},
      onRetry() {},
      onMore() {},
    }),
  );
  const rows = html.match(/<button[^>]*pt-session[\s\S]*?<\/button>/g) ?? [];
  assert.equal(rows.length, 2);
  assert.match(
    rows[0],
    /tx-pill[^"]*"[^>]*>(<span[^>]*>[^<]*<\/span>)?Waiting for your review</,
  );
  assert.doesNotMatch(rows[1], /tx-pill/);
});

test("the open chat's goal keeps its row's badge current without a reload", () => {
  const list = [
    summary("a", { status: "active", review: "none" }),
    summary("b"),
  ];
  // Codex marked the goal complete: the row now waits for review.
  const done = withGoalBadge(list, "a", {
    goal: goal({ status: "complete", review: "pending" }),
    ended: false,
  });
  assert.deepEqual(done[0]!.goal, { status: "complete", review: "pending" });
  assert.equal(done[1], list[1]);
  // Nothing changed: the same list, so nothing re-renders.
  assert.equal(
    withGoalBadge(done, "a", {
      goal: goal({ status: "complete", review: "pending", rev: 3 }),
      ended: false,
    }),
    done,
  );
  // Goal mode ended: the badge goes.
  assert.equal(
    withGoalBadge(done, "a", { goal: null, ended: true })[0]!.goal,
    null,
  );
  // Still waiting for the snapshot: the list's badge stands.
  assert.equal(withGoalBadge(done, "a", { goal: null, ended: false }), done);
  // A chat not in the list.
  assert.equal(withGoalBadge(done, "zz", { goal: goal(), ended: false }), done);
});
