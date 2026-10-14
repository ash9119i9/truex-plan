import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/persistence/store";
import { PlatformService, staleGoal } from "../src/app/platform-service";
import { POLICY_VERSION } from "../src/public/policy";

const goal = {
  objective: "Board deck",
  status: "active" as const,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 100,
  updatedAt: 100,
};
const saved = {
  objective: "Board deck",
  status: "complete" as const,
  createdAt: 100,
  goalUpdatedAt: 105,
  goalEventAt: "2026-09-28T00:00:05.500Z",
};
const replay = (eventAt: string) => ({ replay: true, eventAt });

test("live and command saves are never treated as stale", () => {
  assert.equal(staleGoal({ goal: saved }, { ...goal, updatedAt: 1 }, {}), false);
});

test("a replayed update older than the saved goal is stale", () => {
  const s = { goal: saved };
  assert.equal(
    staleGoal(s, { ...goal, updatedAt: 104 }, replay("2026-09-28T00:00:04.000Z")),
    true,
  );
  assert.equal(
    staleGoal(s, { ...goal, updatedAt: 106 }, replay("2026-09-28T00:00:06.000Z")),
    false,
  );
  // An earlier goal replayed after a newer one was set.
  assert.equal(
    staleGoal(s, { ...goal, createdAt: 90, updatedAt: 90 }, replay("2026-09-28T00:00:01.000Z")),
    true,
  );
});

test("within one Codex second, the agent-core event time decides", () => {
  const s = { goal: saved };
  const same = { ...goal, status: "paused" as const, updatedAt: 105 };
  assert.equal(staleGoal(s, same, replay("2026-09-28T00:00:05.200Z")), true);
  assert.equal(staleGoal(s, same, replay("2026-09-28T00:00:05.500Z")), true);
  assert.equal(staleGoal(s, same, replay("2026-09-28T00:00:05.900Z")), false);
});

test("replayed clears never remove a newer goal, and cleared goals stay cleared", () => {
  assert.equal(
    staleGoal({ goal: { ...saved, createdAt: 200 } }, null, {
      ...replay("2026-09-28T00:00:09.000Z"),
      clearedCreatedAt: 100,
    }),
    true,
  );
  assert.equal(
    staleGoal({ goal: saved }, null, {
      ...replay("2026-09-28T00:00:09.000Z"),
      clearedCreatedAt: 100,
    }),
    false,
  );
  const cleared = {
    goalCleared: { createdAt: 100, eventAt: "2026-09-28T00:00:09.000Z" },
  };
  assert.equal(staleGoal(cleared, goal, replay("2026-09-28T00:00:03.000Z")), true);
  assert.equal(
    staleGoal(cleared, { ...goal, createdAt: 110 }, replay("2026-09-28T00:00:10.000Z")),
    false,
  );
});

test("a replayed record after a live save changes nothing and logs nothing", async () => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "goal-replay-test").connect();
  try {
    const service = new PlatformService(store);
    await store.sessions.insertOne({
      _id: "s",
      createdAt: "now",
      runtimePolicyVersion: POLICY_VERSION,
    } as any);
    // The live stream saves the goal being set, then completed.
    await service.rememberGoal("s", goal, {
      turnId: "turn_1",
      eventAt: "2026-09-28T00:00:00.100Z",
    });
    await service.rememberGoal(
      "s",
      { ...goal, status: "complete", tokensUsed: 800, updatedAt: 105 },
      { turnId: "turn_2", eventAt: "2026-09-28T00:00:05.500Z" },
    );
    // Ingest then replays the same two changes, the older one last.
    await service.rememberGoal(
      "s",
      { ...goal, status: "complete", tokensUsed: 800, updatedAt: 105 },
      { turnId: "turn_2", ...replay("2026-09-28T00:00:05.500Z") },
    );
    await service.rememberGoal("s", goal, {
      turnId: "turn_1",
      ...replay("2026-09-28T00:00:00.100Z"),
    });
    const s = await store.sessions.findOne({ _id: "s" });
    assert.equal(s?.goal?.status, "complete");
    assert.deepEqual(
      s?.goalHistory?.map((e) => [e.kind, e.turnId, e.tokensUsed]),
      [
        ["set", "turn_1", 0],
        ["status", "turn_2", 800],
      ],
    );
  } finally {
    await store.client.close();
    await mongo.stop();
  }
});
