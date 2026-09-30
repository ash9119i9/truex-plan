import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService, goalChanges } from "../src/service";
import {
  POLICY_VERSION,
  publicGoal,
  publicSession,
  PublicEventStream,
} from "../src/public";

test("only a completed goal can be reviewed; accepting persists and reopening reactivates", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "goal-test").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const service = new PlatformService(store);
  // reviewGoal loads the session itself (owner check), so it must be current.
  await store.sessions.insertOne({
    _id: "s",
    runtimePolicyVersion: POLICY_VERSION,
  } as any);
  let goal: any = {
    objective: "Quarterly report",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const calls: { method: string; params: any }[] = [];
  service.capability = async (_id: string, method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/goal/set") goal = { ...goal, ...params };
    return { goal } as any;
  };
  await assert.rejects(
    service.reviewGoal("s", { decision: "maybe" }),
    /accepted or reopened/,
  );
  await assert.rejects(
    service.reviewGoal("s", { decision: "accepted" }),
    /completed/,
  );
  goal = { ...goal, status: "complete" };
  const accepted = await service.reviewGoal("s", { decision: "accepted" });
  assert.equal(accepted.review.decision, "accepted");
  const saved = await store.sessions.findOne({ _id: "s" });
  assert.equal(saved?.goalReview?.objective, "Quarterly report");
  assert.equal(saved?.goalReview?.goalCreatedAt, 1);
  const reopened = await service.reviewGoal("s", {
    decision: "reopened",
    feedback: "  Add sources  ",
  });
  assert.equal(reopened.goal?.status, "active");
  assert.equal(reopened.review.feedback, "Add sources");
  assert.deepEqual(calls.at(-1), {
    method: "thread/goal/set",
    params: { status: "active" },
  });
});

test("goal summaries follow the runtime goal and reach the conversation list", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "goal-summary-test").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const service = new PlatformService(store);
  await store.sessions.insertOne({ _id: "s", createdAt: "now" } as any);
  await service.rememberGoal("s", {
    objective: "Board deck",
    status: "blocked",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const saved = await store.sessions.findOne({ _id: "s" });
  assert.equal(saved?.goal?.status, "blocked");
  assert.deepEqual(publicSession(saved as any).goal, {
    objective: "Board deck",
    status: "blocked",
  });
  await service.rememberGoal("s", null);
  assert.equal((await store.sessions.findOne({ _id: "s" }))?.goal, undefined);
});

test("the public stream reports goal events to an observer without failing on observer errors", () => {
  const seen: string[] = [];
  const stream = new PublicEventStream((event) => {
    seen.push(event.type);
    throw new Error("observer failure");
  });
  const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  const output = stream.push(
    new TextEncoder().encode(
      frame({ type: "goal.updated", cursor: "g:1", data: { goal: { objective: "A", status: "active" } } }) +
        frame({ type: "goal.cleared", cursor: "g:2", data: {} }),
    ),
  );
  assert.deepEqual(seen, ["goal.updated", "goal.cleared"]);
  assert.match(output, /goal\.updated[\s\S]*goal\.cleared/);
});

test("observed goal tokens are public and never drop for the same goal", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "goal-tokens-test").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const service = new PlatformService(store);
  await store.sessions.insertOne({ _id: "s", createdAt: "now" } as any);
  const goal = {
    objective: "Board deck",
    status: "complete" as const,
    tokenBudget: 25000,
    tokensUsed: 0,
    timeUsedSeconds: 5,
    createdAt: 1,
    updatedAt: 2,
  };
  assert.equal(publicGoal({ ...goal, threadId: "t", tokensObserved: 900 })?.tokensObserved, 900);
  assert.equal("tokensObserved" in publicGoal(goal)!, false);
  assert.equal((await service.rememberGoal("s", { ...goal, tokensObserved: 900 }))?.tokensObserved, 900);
  // A restarted assistant service reports a smaller tally for the same goal.
  assert.equal((await service.rememberGoal("s", { ...goal, tokensObserved: 0 }))?.tokensObserved, 900);
  assert.equal((await store.sessions.findOne({ _id: "s" }))?.goal?.tokensObserved, 900);
  // An edited objective is the same goal, so the count is kept.
  assert.equal(
    (await service.rememberGoal("s", { ...goal, objective: "Board deck v2", tokensObserved: 0 }))?.tokensObserved,
    900,
  );
  // A different goal starts from its own count.
  assert.equal(
    (await service.rememberGoal("s", { ...goal, createdAt: 3, tokensObserved: 40 }))?.tokensObserved,
    40,
  );
});

test("goal history records set, edits, budget and status changes but not token updates", async () => {
  const at = "2026-09-27T00:00:00.000Z";
  const goal = {
    objective: "Board deck",
    status: "active" as const,
    tokenBudget: 25000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const saved = {
    objective: goal.objective,
    status: goal.status,
    createdAt: 1,
    tokenBudget: 25000,
  };
  assert.deepEqual(goalChanges(undefined, goal, at).map((e) => e.kind), ["set"]);
  assert.deepEqual(goalChanges(saved, { ...goal, tokensObserved: 900 }, at), []);
  assert.deepEqual(
    goalChanges(saved, { ...goal, objective: "Board deck v2", tokenBudget: 50000, status: "paused" }, at).map((e) => e.kind),
    ["objective", "budget", "status"],
  );
  assert.equal(goalChanges(saved, { ...goal, status: "complete", tokensObserved: 900 }, at)[0].tokens, 900);
  // A summary saved before budgets were tracked doesn't invent a budget change.
  const { tokenBudget: _, ...older } = saved;
  assert.deepEqual(goalChanges(older, goal, at), []);
  assert.deepEqual(goalChanges(saved, { ...goal, createdAt: 2 }, at).map((e) => e.kind), ["set"]);
  assert.deepEqual(goalChanges(saved, null, at).map((e) => e.kind), ["cleared"]);
  assert.deepEqual(goalChanges(undefined, null, at), []);
});

test("goal history is saved on the session and returned with the conversation", async () => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "goal-history-test").connect();
  try {
    const service = new PlatformService(store);
    await store.sessions.insertOne({
      _id: "s",
      createdAt: "now",
      runtimePolicyVersion: POLICY_VERSION,
    } as any);
    const goal = {
      objective: "Board deck",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await service.rememberGoal("s", goal);
    await service.rememberGoal("s", { ...goal, tokensObserved: 500 });
    await service.rememberGoal("s", { ...goal, status: "complete", tokensObserved: 800 });
    await service.rememberGoal("s", null);
    const { entries } = await service.goalHistory("s");
    assert.deepEqual(entries.map((e) => [e.kind, e.status ?? null]), [
      ["set", "active"],
      ["status", "complete"],
      ["cleared", null],
    ]);
    assert.equal(entries[1].tokens, 800);
  } finally {
    await store.client.close();
    await mongo.stop();
  }
});

test("concurrent saves of the same goal change log it once", async () => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "goal-race-test").connect();
  try {
    const service = new PlatformService(store);
    await store.sessions.insertOne({
      _id: "s",
      createdAt: "now",
      runtimePolicyVersion: POLICY_VERSION,
    } as any);
    const goal = {
      objective: "Board deck",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await Promise.all([service.rememberGoal("s", goal), service.rememberGoal("s", goal)]);
    const paused = { ...goal, status: "paused" as const };
    await Promise.all([
      service.rememberGoal("s", paused),
      service.rememberGoal("s", paused),
      service.rememberGoal("s", paused),
    ]);
    await Promise.all([service.rememberGoal("s", null), service.rememberGoal("s", null)]);
    const { entries } = await service.goalHistory("s");
    assert.deepEqual(entries.map((e) => e.kind), ["set", "status", "cleared"]);
    assert.equal((await store.sessions.findOne({ _id: "s" }))?.goal, undefined);
  } finally {
    await store.client.close();
    await mongo.stop();
  }
});
