import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import type { RuntimeGoal } from "../../src/modules/chats/runtime-client";
import {
  GOAL_SLOT_REPAIR_QUIET_MS,
  GOAL_SLOTS_COLLECTION,
  GOAL_SLOTS_PER_USER,
  GOALS_COLLECTION,
  type GoalDoc,
  type GoalPosition,
  type GoalSlotsDoc,
} from "../../src/modules/goals/goal";
import { GoalStore } from "../../src/modules/goals/goal-store";
import { createTenantIndexes } from "../../src/modules/tenants/tenant-indexes";
import { startReplicaSet } from "../support/test-app";

const DB_NAME = "truex_next_goals_test";

function runtimeGoal(over: Partial<RuntimeGoal> = {}): RuntimeGoal {
  return {
    objective: "Write the quarterly report",
    status: "active",
    tokenBudget: 300_000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    ...over,
  };
}

describe("GoalStore (integration)", () => {
  let mongo: MongoMemoryReplSet;
  let database: DatabaseService;
  let store: GoalStore;
  const tenantId = new ObjectId();

  before(async () => {
    mongo = await startReplicaSet();
    database = new DatabaseService({
      mongodbUri: mongo.getUri(),
      catalogDbName: "truex_next_test_catalog",
    } as AppConfig);
    database.onModuleInit();
    await database.waitUntilConnected(30_000);
    // The unique index on chatId is what refuses a second goal per chat.
    await createTenantIndexes(database.tenantDb(DB_NAME));
    store = new GoalStore(database);
  });

  after(async () => {
    await database?.onApplicationShutdown();
    await mongo?.stop();
  });

  beforeEach(async () => {
    const db = database.tenantDb(DB_NAME);
    await db.collection(GOALS_COLLECTION).deleteMany({});
    await db.collection(GOAL_SLOTS_COLLECTION).deleteMany({});
  });

  const goals = () =>
    database.tenantDb(DB_NAME).collection<GoalDoc>(GOALS_COLLECTION);
  const slots = () =>
    database
      .tenantDb(DB_NAME)
      .collection<GoalSlotsDoc>(GOAL_SLOTS_COLLECTION)
      // The counts; the write counter is the slot repair's (tested there).
      .findOne({ _id: tenantId }, { projection: { writes: 0 } });

  // A goal document for a chat of `ownerId`, as Codex first reports it.
  async function goalFor(ownerId: ObjectId): Promise<ObjectId> {
    const chatId = new ObjectId();
    const { applied } = await store.applyUpdate(
      DB_NAME,
      { chatId, ownerId },
      { goal: runtimeGoal(), origin: "user", position: null },
    );
    assert.equal(applied, true);
    return chatId;
  }

  test("20 concurrent claims for one user grant exactly the per-user cap; across users, exactly the tenant cap", async () => {
    assert.equal(GOAL_SLOTS_PER_USER, 3);
    const alice = new ObjectId();
    const chats = await Promise.all(
      Array.from({ length: 20 }, () => goalFor(alice)),
    );
    // No slots document exists yet, so the first claims also race to make it.
    const granted = await Promise.all(
      chats.map((chatId) => store.claimSlot(DB_NAME, tenantId, chatId, 10)),
    );
    assert.equal(granted.filter(Boolean).length, 3);
    assert.deepEqual(await slots(), {
      _id: tenantId,
      total: 3,
      users: { [alice.toHexString()]: 3 },
    });
    // Exactly the granted goals hold a slot; a refused claim holds none.
    const held = await goals().find({ slotHeld: true }).toArray();
    assert.deepEqual(
      held.map((g) => g.chatId.toHexString()).sort(),
      chats
        .filter((_, i) => granted[i])
        .map((id) => id.toHexString())
        .sort(),
    );

    // Ten users with two goals each, tenant cap 10.
    await goals().deleteMany({});
    await database
      .tenantDb(DB_NAME)
      .collection(GOAL_SLOTS_COLLECTION)
      .deleteMany({});
    const users = Array.from({ length: 10 }, () => new ObjectId());
    const many = await Promise.all(
      users.flatMap((user) => [goalFor(user), goalFor(user)]),
    );
    const results = await Promise.all(
      many.map((chatId) => store.claimSlot(DB_NAME, tenantId, chatId, 10)),
    );
    assert.equal(results.filter(Boolean).length, 10);
    const doc = await slots();
    assert.equal(doc?.total, 10);
    assert.equal(
      Object.values(doc?.users ?? {}).reduce((a, b) => a + b, 0),
      10,
    );
    assert.equal(await goals().countDocuments({ slotHeld: true }), 10);

    // A claim repeated for a goal that holds a slot takes no second one.
    const holder = many[results.indexOf(true)]!;
    assert.equal(await store.claimSlot(DB_NAME, tenantId, holder, 10), true);
    assert.equal((await slots())?.total, 10);
  });

  test("releasing twice for one transition decrements once; the sweep's repair lowers a hand-added excess", async () => {
    const alice = new ObjectId();
    const bob = new ObjectId();
    const [a1, a2, b1] = await Promise.all([
      goalFor(alice),
      goalFor(alice),
      goalFor(bob),
    ]);
    for (const chatId of [a1!, a2!, b1!])
      assert.equal(await store.claimSlot(DB_NAME, tenantId, chatId, 10), true);

    // Two releases racing, then a late repeat: one decrement.
    const released = await Promise.all([
      store.releaseSlot(DB_NAME, tenantId, a1!),
      store.releaseSlot(DB_NAME, tenantId, a1!),
    ]);
    assert.deepEqual(released.sort(), [false, true]);
    assert.equal(await store.releaseSlot(DB_NAME, tenantId, a1!), false);
    assert.deepEqual(await slots(), {
      _id: tenantId,
      total: 2,
      users: { [alice.toHexString()]: 1, [bob.toHexString()]: 1 },
    });
    // A goal that never held a slot releases nothing.
    assert.equal(
      await store.releaseSlot(DB_NAME, tenantId, await goalFor(bob)),
      false,
    );
    assert.equal((await slots())?.total, 2);

    // Edited by hand: a user with no goals counted 7 times, and one extra
    // for alice. The repair only lowers counts, after the quiet period.
    const nobody = new ObjectId().toHexString();
    await database
      .tenantDb(DB_NAME)
      .collection<GoalSlotsDoc>(GOAL_SLOTS_COLLECTION)
      .updateOne(
        { _id: tenantId },
        {
          $inc: {
            total: 8,
            [`users.${nobody}`]: 7,
            [`users.${alice.toHexString()}`]: 1,
          },
        },
      );
    assert.equal(
      (await store.repairSlots(DB_NAME, tenantId, 0)).repaired,
      false,
    );
    assert.equal(
      (await store.repairSlots(DB_NAME, tenantId, GOAL_SLOT_REPAIR_QUIET_MS))
        .repaired,
      true,
    );
    assert.deepEqual(await slots(), {
      _id: tenantId,
      total: 2,
      users: {
        [alice.toHexString()]: 1,
        [bob.toHexString()]: 1,
        [nobody]: 0,
      },
    });
    // The repaired counts are the ones claims check against.
    assert.equal(await store.claimSlot(DB_NAME, tenantId, a1!, 3), true);
    assert.equal(
      await store.claimSlot(DB_NAME, tenantId, await goalFor(bob), 3),
      false,
    );
  });

  test("an older or replayed Codex update never overwrites a newer one", async () => {
    const chat = { chatId: new ObjectId(), ownerId: new ObjectId() };
    const at = (streamId: string, seq: number): GoalPosition => ({
      streamId,
      seq,
    });
    const apply = (goal: RuntimeGoal, position: GoalPosition | null) =>
      store.applyUpdate(DB_NAME, chat, { goal, origin: "user", position });
    const saved = async () => (await goals().findOne({ chatId: chat.chatId }))!;

    const first = runtimeGoal({ tokensUsed: 100, updatedAt: 1_800_000_010 });
    assert.deepEqual(await apply(first, at("s1", 5)), {
      applied: true,
      before: null,
    });

    // Older by Codex time, though later on the stream.
    const older = runtimeGoal({ tokensUsed: 50, updatedAt: 1_800_000_009 });
    assert.equal((await apply(older, at("s1", 6))).applied, false);
    // A goal created before the saved one.
    const earlierGoal = runtimeGoal({
      objective: "An older goal",
      createdAt: 1_799_999_000,
      updatedAt: 1_800_000_020,
    });
    assert.equal((await apply(earlierGoal, null)).applied, false);
    // The same second: the stream position decides. A replay of seq 5, or
    // an earlier seq, changes nothing.
    const sameSecond = runtimeGoal({
      status: "paused",
      tokensUsed: 120,
      updatedAt: 1_800_000_010,
    });
    assert.equal((await apply(sameSecond, at("s1", 5))).applied, false);
    assert.equal((await apply(sameSecond, at("s1", 4))).applied, false);
    assert.deepEqual((await saved()).goal, first);
    assert.deepEqual((await saved()).position, at("s1", 5));
    assert.equal(await goals().countDocuments(), 1);

    // Later on the same stream in the same second: applied, and the
    // document before it is returned.
    const later = await apply(sameSecond, at("s1", 7));
    assert.equal(later.applied, true);
    assert.deepEqual(later.before?.goal, first);
    assert.deepEqual((await saved()).goal, sameSecond);

    // A newer Codex time wins on any stream, and so does a new goal.
    const newer = runtimeGoal({
      status: "active",
      tokensUsed: 200,
      updatedAt: 1_800_000_030,
    });
    assert.equal((await apply(newer, at("s2", 1))).applied, true);
    const replaced = runtimeGoal({
      objective: "A new goal",
      createdAt: 1_800_000_040,
      updatedAt: 1_800_000_040,
    });
    assert.equal((await apply(replaced, at("s2", 2))).applied, true);
    // A replay of the old goal's last update after that changes nothing.
    assert.equal((await apply(newer, at("s2", 1))).applied, false);
    assert.deepEqual((await saved()).goal, replaced);

    // History: the first goal, its status changes, the new goal; replays and
    // unchanged statuses add nothing.
    assert.deepEqual(
      (await saved()).history.map((h) => [h.kind, h.status, h.tokensUsed]),
      [
        ["set", "active", 100],
        ["status", "paused", 120],
        ["status", "active", 200],
        ["set", "active", 0],
      ],
    );

    // An ended goal takes no update at all.
    await goals().updateOne({ chatId: chat.chatId }, { $set: { ended: true } });
    const afterEnd = runtimeGoal({
      objective: "A new goal",
      createdAt: 1_800_000_040,
      updatedAt: 1_800_000_050,
      status: "complete",
    });
    assert.equal((await apply(afterEnd, at("s2", 3))).applied, false);
    assert.deepEqual((await saved()).goal, replaced);
    assert.equal(await goals().countDocuments(), 1);

    // An objective that looks like a field path is stored as written.
    const other = { chatId: new ObjectId(), ownerId: chat.ownerId };
    const odd = runtimeGoal({ objective: "$history" });
    await store.applyUpdate(DB_NAME, other, {
      goal: odd,
      origin: "model",
      position: null,
    });
    const oddDoc = (await goals().findOne({ chatId: other.chatId }))!;
    assert.equal(oddDoc.goal?.objective, "$history");
    assert.equal(oddDoc.origin, "model");
    assert.equal(oddDoc.review, "none");
    assert.equal(oddDoc.slotHeld, false);
    assert.equal(oddDoc.ended, false);
  });

  test("concurrent updates to one chat keep the newest; a cap of 0 grants nothing", async () => {
    const chat = { chatId: new ObjectId(), ownerId: new ObjectId() };
    // Five writers race, the first ones to create the document. Each lost
    // round is won by another writer, which is then done, so the newest one
    // lands within as many attempts as there are writers: five is the most
    // the store's MAX_UPDATE_ATTEMPTS guarantees, and more than a chat has.
    const updates = Array.from({ length: 5 }, (_, i) =>
      runtimeGoal({ tokensUsed: i, updatedAt: 1_800_000_000 + i }),
    );
    await Promise.all(
      updates.map((goal) =>
        store.applyUpdate(DB_NAME, chat, {
          goal,
          origin: "user",
          position: null,
        }),
      ),
    );
    const saved = (await goals().findOne({ chatId: chat.chatId }))!;
    assert.deepEqual(saved.goal, updates[4]);
    assert.equal(await goals().countDocuments(), 1);

    // No slots document exists, so only the guard can refuse.
    assert.equal(
      await store.claimSlot(DB_NAME, tenantId, chat.chatId, 0),
      false,
    );
    assert.equal(await slots(), null);
    assert.equal(
      (await goals().findOne({ chatId: chat.chatId }))?.slotHeld,
      false,
    );
  });

  // The goal sweep's slot repair (repairSlots). Each test has its own tenant,
  // so what one sweep saw never carries into another test.
  const Q = GOAL_SLOT_REPAIR_QUIET_MS;
  const T0 = 1_000_000;
  const slotsOf = (id: ObjectId) =>
    database
      .tenantDb(DB_NAME)
      .collection<GoalSlotsDoc>(GOAL_SLOTS_COLLECTION)
      .findOne({ _id: id }, { projection: { writes: 0 } });
  const counted = (id: ObjectId, users: Record<string, number>) => ({
    _id: id,
    total: Object.values(users).reduce((sum, n) => sum + n, 0),
    users,
  });
  const nothing = { released: 0, repaired: false };

  test("a slot taken but never marked (a crash mid-start) is given back once the excess has lasted the quiet period, not before", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const a = alice.toHexString();
    const chatId = await goalFor(alice);
    assert.equal(await store.takeSlot(DB_NAME, tenant, alice, 10), true);
    for (const at of [T0, T0 + 60_000, T0 + Q - 1])
      assert.deepEqual(await store.repairSlots(DB_NAME, tenant, at), nothing);
    assert.deepEqual(await slotsOf(tenant), counted(tenant, { [a]: 1 }));
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0 + Q), {
      released: 0,
      repaired: true,
    });
    assert.deepEqual(await slotsOf(tenant), counted(tenant, { [a]: 0 }));
    // Repaired once; the member can take the slot again.
    assert.deepEqual(
      await store.repairSlots(DB_NAME, tenant, T0 + 2 * Q),
      nothing,
    );
    assert.equal(await store.claimSlot(DB_NAME, tenant, chatId, 10), true);
    assert.deepEqual(await slotsOf(tenant), counted(tenant, { [a]: 1 }));
  });

  test("a slot taken or given between two sweeps starts the quiet period again", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const bob = new ObjectId();
    await goalFor(alice);
    assert.equal(await store.takeSlot(DB_NAME, tenant, alice, 10), true);
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0), nothing);
    // Another member's start moves the counts in between.
    assert.equal(
      await store.claimSlot(DB_NAME, tenant, await goalFor(bob), 10),
      true,
    );
    for (const at of [T0 + Q, T0 + 2 * Q - 1])
      assert.deepEqual(await store.repairSlots(DB_NAME, tenant, at), nothing);
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0 + 2 * Q), {
      released: 0,
      repaired: true,
    });
    assert.deepEqual(
      await slotsOf(tenant),
      counted(tenant, { [alice.toHexString()]: 0, [bob.toHexString()]: 1 }),
    );
  });

  test("a goal that ended or stopped while still holding its slot (a crash inside a clear or a pause) gives it back at the next sweep, once", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const a = alice.toHexString();
    const [ended, paused, running] = await Promise.all([
      goalFor(alice),
      goalFor(alice),
      goalFor(alice),
    ]);
    for (const chatId of [ended!, paused!, running!])
      assert.equal(await store.claimSlot(DB_NAME, tenant, chatId, 10), true);
    await goals().updateOne({ chatId: ended }, { $set: { ended: true } });
    await goals().updateOne(
      { chatId: paused },
      { $set: { "goal.status": "paused" } },
    );
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0), {
      released: 2,
      repaired: false,
    });
    assert.deepEqual(await slotsOf(tenant), counted(tenant, { [a]: 1 }));
    const held = async (chatId: ObjectId) =>
      (await goals().findOne({ chatId }))?.slotHeld;
    assert.deepEqual(
      [await held(ended!), await held(paused!), await held(running!)],
      [false, false, true],
    );
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0 + Q), nothing);
    assert.deepEqual(await slotsOf(tenant), counted(tenant, { [a]: 1 }));
  });

  test("a sweep while a start waits on Codex never lowers the count", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const chatId = await goalFor(alice);
    // The start has taken its slot and is waiting on Codex.
    assert.equal(await store.takeSlot(DB_NAME, tenant, alice, 10), true);
    for (const at of [T0, T0 + Q / 2])
      assert.deepEqual(await store.repairSlots(DB_NAME, tenant, at), nothing);
    // Codex answered: the goal is marked as holding it.
    assert.equal(await store.adoptSlot(DB_NAME, tenant, chatId, alice), true);
    for (const at of [T0 + Q, T0 + 2 * Q])
      assert.deepEqual(await store.repairSlots(DB_NAME, tenant, at), nothing);
    assert.deepEqual(
      await slotsOf(tenant),
      counted(tenant, { [alice.toHexString()]: 1 }),
    );
    assert.equal((await goals().findOne({ chatId }))?.slotHeld, true);
  });

  test("a sweep that lands mid-release never leaves the count too low", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const [releasing, kept] = await Promise.all([
      goalFor(alice),
      goalFor(alice),
    ]);
    for (const chatId of [releasing!, kept!])
      assert.equal(await store.claimSlot(DB_NAME, tenant, chatId, 10), true);
    // The release has cleared the goal's mark but not yet lowered the count.
    await goals().updateOne(
      { chatId: releasing },
      { $set: { slotHeld: false } },
    );
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0), nothing);
    // The release finishes.
    await store.giveSlot(DB_NAME, tenant, alice);
    for (const at of [T0 + Q, T0 + 2 * Q])
      assert.deepEqual(await store.repairSlots(DB_NAME, tenant, at), nothing);
    assert.deepEqual(
      await slotsOf(tenant),
      counted(tenant, { [alice.toHexString()]: 1 }),
    );
  });

  test("two processes sweeping at once repair a leak only once", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const other = new GoalStore(database);
    // One goal holds its slot, and one slot leaked from a crashed start.
    assert.equal(
      await store.claimSlot(DB_NAME, tenant, await goalFor(alice), 10),
      true,
    );
    assert.equal(await store.takeSlot(DB_NAME, tenant, alice, 10), true);
    for (const sweeper of [store, other])
      assert.deepEqual(await sweeper.repairSlots(DB_NAME, tenant, T0), nothing);
    const results = await Promise.all(
      [store, other].map((sweeper) =>
        sweeper.repairSlots(DB_NAME, tenant, T0 + Q),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.repaired).sort(),
      [false, true],
      JSON.stringify(results),
    );
    assert.deepEqual(
      await slotsOf(tenant),
      counted(tenant, { [alice.toHexString()]: 1 }),
    );
  });

  test("a release finished between two sweeps starts the quiet period again, so two different releases in flight never add up to a repair", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const [a, b, c] = await Promise.all([
      goalFor(alice),
      goalFor(alice),
      goalFor(alice),
    ]);
    for (const chatId of [a!, b!, c!])
      assert.equal(await store.claimSlot(DB_NAME, tenant, chatId, 10), true);
    const unmark = (chatId: ObjectId) =>
      goals().updateOne({ chatId }, { $set: { slotHeld: false } });
    // A's release is between unmarking and giving back at the first sweep.
    await unmark(a!);
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0), nothing);
    await store.giveSlot(DB_NAME, tenant, alice);
    // B's release is at the same point at the second.
    await unmark(b!);
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0 + Q), nothing);
    await store.giveSlot(DB_NAME, tenant, alice);
    // C still holds its slot.
    assert.deepEqual(
      await slotsOf(tenant),
      counted(tenant, { [alice.toHexString()]: 1 }),
    );
  });

  test("an excess that grew between two sweeps is lowered only by what both saw", async () => {
    const tenant = new ObjectId();
    const alice = new ObjectId();
    const [x, y] = await Promise.all([goalFor(alice), goalFor(alice)]);
    for (const chatId of [x!, y!])
      assert.equal(await store.claimSlot(DB_NAME, tenant, chatId, 10), true);
    // One slot leaked from a crashed start.
    assert.equal(await store.takeSlot(DB_NAME, tenant, alice, 10), true);
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0), nothing);
    // X's release is between unmarking and giving back at the second sweep.
    await goals().updateOne({ chatId: x }, { $set: { slotHeld: false } });
    assert.deepEqual(await store.repairSlots(DB_NAME, tenant, T0 + Q), {
      released: 0,
      repaired: true,
    });
    await store.giveSlot(DB_NAME, tenant, alice);
    // Y still holds its slot; only the leak was given back.
    assert.deepEqual(
      await slotsOf(tenant),
      counted(tenant, { [alice.toHexString()]: 1 }),
    );
  });
});
