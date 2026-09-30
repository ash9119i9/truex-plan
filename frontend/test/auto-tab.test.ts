import { test } from "node:test";
import assert from "node:assert/strict";
import {
  followAction,
  followTab,
  noteSeen,
  emptySeen,
  pickTab,
  settleTab,
  MANUAL_HOLD_MS,
  type FollowContext,
  type FollowSeen,
} from "../lib/auto-tab.ts";

const now = Date.parse("2026-09-30T12:00:00Z");
const at = new Date(now - 1000).toISOString();
const goal = (status: string, createdAt = 1) =>
  ({ objective: "x", status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt, updatedAt: 1 }) as any;
const seen = (s: Partial<FollowSeen> = {}): FollowSeen => ({ goal: null, plan: [], agentIds: [], ...s });
const ev = (type: string, data: any, when = at) => ({ type, data, at: when }) as any;

test("a new active goal opens the Goal tab", () => {
  assert.equal(followTab(ev("goal.updated", { goal: goal("active") }), seen(), now), "goal");
  assert.equal(followTab(ev("goal.updated", { goal: goal("active", 2) }), seen({ goal: goal("complete") }), now), "goal");
});

test("goal progress, pauses and completion do not switch", () => {
  assert.equal(followTab(ev("goal.updated", { goal: goal("active") }), seen({ goal: goal("active") }), now), null);
  assert.equal(followTab(ev("goal.updated", { goal: goal("paused") }), seen(), now), null);
  assert.equal(followTab(ev("goal.updated", { goal: goal("complete") }), seen(), now), null);
});

test("a new or revised plan opens the Plan tab, progress does not", () => {
  const plan = [{ step: "a", status: "pending" }];
  assert.equal(followTab(ev("plan.updated", { plan }), seen(), now), "plan");
  const done = [{ step: "a", status: "completed" }];
  assert.equal(followTab(ev("plan.updated", { plan: done }), seen({ plan }), now), null);
  const revised = [{ step: "a", status: "pending" }, { step: "b", status: "pending" }];
  assert.equal(followTab(ev("plan.updated", { plan: revised }), seen({ plan }), now), "plan");
  assert.equal(followTab(ev("plan.updated", { plan: [] }), seen(), now), null);
});

test("a plan during an active goal keeps the Goal tab", () => {
  const plan = [{ step: "a", status: "pending" }];
  assert.equal(followTab(ev("plan.updated", { plan }), seen({ goal: goal("active") }), now), null);
});

test("a new helper opens the Agents tab once", () => {
  const e = ev("subagent.spawned", { agent: { threadId: "t1" } });
  assert.equal(followTab(e, seen(), now), "agents");
  assert.equal(followTab(e, seen({ agentIds: ["t1"] }), now), null);
  assert.equal(followTab(ev("subagent.status", { agent: { threadId: "t2" } }), seen(), now), null);
});

test("replayed history does not switch", () => {
  const old = new Date(now - 5 * 60_000).toISOString();
  assert.equal(followTab(ev("goal.updated", { goal: goal("active") }, old), seen(), now), null);
});

test("the most specific tab wins a batch", () => {
  assert.equal(pickTab("goal", "agents"), "agents");
  assert.equal(pickTab("agents", "plan"), "agents");
  assert.equal(pickTab(null, "plan"), "plan");
  assert.equal(pickTab("goal", null), "goal");
});

const ctx = (c: Partial<FollowContext> = {}): FollowContext => ({
  enabled: true, vw: 1440, now, manualAt: 0, dismissed: false,
  panelOpen: false, fitsOpen: true, ...c,
});

test("opens a closed panel, switches an open one", () => {
  assert.equal(followAction(ctx()), "open");
  assert.equal(followAction(ctx({ panelOpen: true })), "switch");
});

test("holds off for the user", () => {
  assert.equal(followAction(ctx({ enabled: false })), null);
  assert.equal(followAction(ctx({ manualAt: now - 1000 })), null);
  assert.equal(followAction(ctx({ manualAt: now - MANUAL_HOLD_MS })), "open");
  assert.equal(followAction(ctx({ dismissed: true })), null);
});

test("never opens a drawer or pushes the sidebar out", () => {
  assert.equal(followAction(ctx({ vw: 900 })), null);
  assert.equal(followAction(ctx({ fitsOpen: false })), null);
  // An already open drawer may still change tabs.
  assert.equal(followAction(ctx({ vw: 800, panelOpen: true })), "switch");
});

test("seen state follows the stream", () => {
  const plan = [{ step: "a", status: "pending" }];
  let s = noteSeen(emptySeen(), ev("snapshot", { goal: goal("active"), plan, subAgents: [{ threadId: "t1" }] }));
  assert.deepEqual(s.agentIds, ["t1"]);
  // Output that beats its spawn event still counts as a new helper, once.
  const early = ev("subagent.event", { agentThreadId: "t2" });
  assert.equal(followTab(early, s, now), "agents");
  s = noteSeen(s, early);
  assert.deepEqual(s.agentIds, ["t1", "t2"]);
  assert.equal(followTab(ev("subagent.spawned", { agent: { threadId: "t2" } }), s, now), null);
  assert.deepEqual(s.plan, plan);
  s = noteSeen(s, ev("goal.cleared", {}));
  assert.equal(s.goal, null);
});

test("a goal's plan in the same burst lands on the Goal tab", () => {
  const plan = [{ step: "a", status: "pending" }];
  // Plan first, goal second, inside one burst.
  let s = emptySeen();
  let want = followTab(ev("plan.updated", { plan }), s, now);
  s = noteSeen(s, ev("plan.updated", { plan }));
  want = pickTab(want, followTab(ev("goal.updated", { goal: goal("active") }), s, now));
  s = noteSeen(s, ev("goal.updated", { goal: goal("active") }));
  assert.equal(settleTab(want, s), "goal");
  // Without a goal a plan keeps its tab, and helpers still win.
  assert.equal(settleTab("plan", emptySeen()), "plan");
  assert.equal(settleTab("agents", s), "agents");
});
