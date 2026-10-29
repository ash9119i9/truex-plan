import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import { CHATS_COLLECTION } from "../../src/modules/chats/chat";
import type { RuntimeGoal } from "../../src/modules/chats/runtime-client";
import {
  GOAL_SLOTS_COLLECTION,
  GOAL_WATCH_LEASE_MS,
  GOALS_COLLECTION,
  type GoalDoc,
  type GoalSlotsDoc,
} from "../../src/modules/goals/goal";
import { GoalStore } from "../../src/modules/goals/goal-store";
import { createTenantIndexes } from "../../src/modules/tenants/tenant-indexes";
import { startReplicaSet } from "../support/test-app";

const DB_NAME = "truex_next_goal_watch_test";

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

describe("GoalStore watches and recorded updates (integration)", () => {
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
    await db.collection(CHATS_COLLECTION).deleteMany({});
  });

  const goals = () =>
    database.tenantDb(DB_NAME).collection<GoalDoc>(GOALS_COLLECTION);
  const slots = () =>
    database
      .tenantDb(DB_NAME)
      .collection<GoalSlotsDoc>(GOAL_SLOTS_COLLECTION)
      // The counts; the write counter is the slot repair's (tested there).
      .findOne({ _id: tenantId }, { projection: { writes: 0 } });
  // Only the fields this store writes; a real chat has many more.
  const chats = () =>
    database.tenantDb(DB_NAME).collection<{
      _id: ObjectId;
      ownerId?: ObjectId;
      createdByMessageId?: ObjectId;
      goal?: unknown;
    }>(CHATS_COLLECTION);

  async function goalFor(
    over: Partial<RuntimeGoal> = {},
    ownerId = new ObjectId(),
  ): Promise<{ chatId: ObjectId; ownerId: ObjectId }> {
    const chat = { chatId: new ObjectId(), ownerId };
    // Fields of the chats indexes, so fixture chats never collide on them.
    await chats().insertOne({
      _id: chat.chatId,
      ownerId,
      createdByMessageId: new ObjectId(),
    });
    const { applied } = await store.applyUpdate(DB_NAME, chat, {
      goal: runtimeGoal(over),
      origin: "user",
      position: null,
    });
    assert.equal(applied, true);
    return chat;
  }

  const lapse = (chatId: ObjectId) =>
    goals().updateOne(
      { chatId },
      { $set: { "watch.leaseExpiresAt": new Date(Date.now() - 1_000) } },
    );

  test("a free or lapsed watch goes to exactly one of two concurrent claimers; a held one to nobody else", async () => {
    const { chatId } = await goalFor();
    // A document written before watches has no field at all.
    await goals().updateOne({ chatId }, { $unset: { watch: "" } });
    const [a, b] = await Promise.all([
      store.claimWatch(DB_NAME, chatId, "proc-a"),
      store.claimWatch(DB_NAME, chatId, "proc-b"),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const winner = a ? "proc-a" : "proc-b";
    const loser = a ? "proc-b" : "proc-a";
    const won = (a ?? b)!;
    assert.equal(won.watch?.owner, winner);
    assert.equal(won.watch?.cursor, null);
    const lease = won.watch!.leaseExpiresAt.getTime() - Date.now();
    assert.ok(
      lease > GOAL_WATCH_LEASE_MS - 5_000 && lease <= GOAL_WATCH_LEASE_MS,
    );

    // Held and unexpired: refused to others, granted again to its owner.
    assert.equal(await store.claimWatch(DB_NAME, chatId, loser), null);
    assert.equal(
      (await store.claimWatch(DB_NAME, chatId, winner))?.watch?.owner,
      winner,
    );

    // Lapsed: two new processes race; one wins and gets the saved cursor.
    const cursor = { streamId: "s-1", seq: 7 };
    assert.equal(await store.saveCursor(DB_NAME, chatId, winner, cursor), true);
    await lapse(chatId);
    const [c, d] = await Promise.all([
      store.claimWatch(DB_NAME, chatId, "proc-c"),
      store.claimWatch(DB_NAME, chatId, "proc-d"),
    ]);
    assert.equal([c, d].filter(Boolean).length, 1);
    assert.deepEqual((c ?? d)!.watch?.cursor, cursor);
    assert.equal(await store.claimWatch(DB_NAME, chatId, winner), null);

    // An ended goal and a chat without a goal are never watched.
    await goals().updateOne({ chatId }, { $set: { ended: true } });
    await lapse(chatId);
    assert.equal(await store.claimWatch(DB_NAME, chatId, "proc-e"), null);
    assert.equal(
      await store.claimWatch(DB_NAME, new ObjectId(), "proc-e"),
      null,
    );
  });

  test("renew and saveCursor work only for the holder; release keeps the cursor for the next claimer", async () => {
    const { chatId } = await goalFor();
    assert.ok(await store.claimWatch(DB_NAME, chatId, "proc-a"));
    const cursor = { streamId: "s-1", seq: 3 };
    assert.equal(await store.renewWatch(DB_NAME, chatId, "proc-b"), false);
    assert.equal(
      await store.saveCursor(DB_NAME, chatId, "proc-b", cursor),
      false,
    );
    assert.equal((await goals().findOne({ chatId }))?.watch?.cursor, null);

    await goals().updateOne(
      { chatId },
      { $set: { "watch.leaseExpiresAt": new Date(Date.now() + 1_000) } },
    );
    assert.equal(await store.renewWatch(DB_NAME, chatId, "proc-a"), true);
    const renewed = (await goals().findOne({ chatId }))!.watch!;
    assert.ok(
      renewed.leaseExpiresAt.getTime() >
        Date.now() + GOAL_WATCH_LEASE_MS - 5_000,
    );
    assert.equal(
      await store.saveCursor(DB_NAME, chatId, "proc-a", cursor),
      true,
    );

    // A release by someone else changes nothing.
    await store.releaseWatch(DB_NAME, chatId, "proc-b");
    assert.equal((await goals().findOne({ chatId }))?.watch?.owner, "proc-a");

    await store.releaseWatch(DB_NAME, chatId, "proc-a");
    const released = (await goals().findOne({ chatId }))!.watch!;
    assert.equal(released.owner, "");
    assert.deepEqual(released.cursor, cursor);
    // The old holder can no longer write; the next claimer resumes there.
    assert.equal(await store.renewWatch(DB_NAME, chatId, "proc-a"), false);
    assert.deepEqual(
      (await store.claimWatch(DB_NAME, chatId, "proc-b"))?.watch?.cursor,
      cursor,
    );
  });

  test("lapsedWatches lists active, unended goals no process holds, unwatched first, within the limit", async () => {
    const unwatched = await goalFor();
    const lapsed = await goalFor();
    const held = await goalFor();
    const released = await goalFor();
    const paused = await goalFor({ status: "paused" });
    const ended = await goalFor();
    for (const chat of [lapsed, held, released])
      assert.ok(await store.claimWatch(DB_NAME, chat.chatId, "proc-a"));
    await lapse(lapsed.chatId);
    await goals().updateOne(
      { chatId: released.chatId },
      { $set: { "watch.leaseExpiresAt": new Date(Date.now() - 60_000) } },
    );
    await store.releaseWatch(DB_NAME, released.chatId, "proc-a");
    await goals().updateOne(
      { chatId: ended.chatId },
      { $set: { ended: true } },
    );
    void paused;

    const found = await store.lapsedWatches(DB_NAME, new Date(), 10);
    assert.deepEqual(
      found.map((g) => g.chatId.toHexString()),
      [unwatched, released, lapsed].map((c) => c.chatId.toHexString()),
    );
    assert.equal((await store.lapsedWatches(DB_NAME, new Date(), 2)).length, 2);
  });

  test("a recorded completion sets review pending, releases the slot once and writes the chat's summary", async () => {
    const chat = await goalFor();
    assert.equal(
      await store.claimSlot(DB_NAME, tenantId, chat.chatId, 10),
      true,
    );
    // An active update never claims or releases a slot itself.
    const active = await store.recordUpdate(DB_NAME, tenantId, chat, {
      goal: runtimeGoal({ updatedAt: 1_800_000_010, tokensUsed: 10 }),
      origin: "user",
      position: { streamId: "s-1", seq: 1 },
    });
    assert.equal(active.applied, true);
    assert.equal((await slots())?.total, 1);
    assert.equal(
      (await goals().findOne({ chatId: chat.chatId }))?.slotHeld,
      true,
    );

    const complete = {
      goal: runtimeGoal({
        status: "complete",
        updatedAt: 1_800_000_020,
        tokensUsed: 20,
      }),
      origin: "user" as const,
      position: { streamId: "s-1", seq: 2 },
    };
    const done = await store.recordUpdate(DB_NAME, tenantId, chat, complete);
    assert.equal(done.applied, true);
    assert.equal(done.goal?.review, "pending");
    assert.equal(done.goal?.slotHeld, false);
    const saved = (await goals().findOne({ chatId: chat.chatId }))!;
    assert.equal(saved.review, "pending");
    assert.equal(saved.slotHeld, false);
    assert.deepEqual(await slots(), {
      _id: tenantId,
      total: 0,
      users: { [chat.ownerId.toHexString()]: 0 },
    });
    assert.deepEqual((await chats().findOne({ _id: chat.chatId }))?.goal, {
      status: "complete",
      review: "pending",
      rev: saved.rev,
    });

    // A replay is not applied and changes nothing, counts included.
    const replay = await store.recordUpdate(DB_NAME, tenantId, chat, complete);
    assert.equal(replay.applied, false);
    assert.equal((await slots())?.total, 0);
    assert.equal(
      (await goals().findOne({ chatId: chat.chatId }))?.rev,
      saved.rev,
    );
  });

  test("an update that does not apply changes nothing; an older summary write never replaces a newer one", async () => {
    const chat = await goalFor({ updatedAt: 1_800_000_050 });
    assert.equal(
      await store.claimSlot(DB_NAME, tenantId, chat.chatId, 10),
      true,
    );
    const before = (await goals().findOne({ chatId: chat.chatId }))!;
    const stale = await store.recordUpdate(DB_NAME, tenantId, chat, {
      goal: runtimeGoal({ status: "paused", updatedAt: 1_800_000_040 }),
      origin: "user",
      position: null,
    });
    assert.equal(stale.applied, false);
    assert.deepEqual(await goals().findOne({ chatId: chat.chatId }), before);
    assert.equal((await slots())?.total, 1);
    assert.equal(
      (await chats().findOne({ _id: chat.chatId }))?.goal,
      undefined,
    );

    // A summary already written from a newer revision is kept.
    const newer = { status: "active", review: "none", rev: 99 };
    await chats().updateOne({ _id: chat.chatId }, { $set: { goal: newer } });
    const paused = await store.recordUpdate(DB_NAME, tenantId, chat, {
      goal: runtimeGoal({ status: "paused", updatedAt: 1_800_000_060 }),
      origin: "user",
      position: null,
    });
    assert.equal(paused.applied, true);
    assert.equal((await slots())?.total, 0);
    assert.deepEqual(
      (await chats().findOne({ _id: chat.chatId }))?.goal,
      newer,
    );
  });
});
