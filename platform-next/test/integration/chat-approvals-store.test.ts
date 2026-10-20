import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import { ChatStore } from "../../src/modules/chats/chat-store";
import {
  CHATS_COLLECTION,
  MAX_CHAT_TOOL_APPROVALS,
  TOOL_APPROVALS_COLLECTION,
  type ChatDoc,
  type ToolApprovalDoc,
} from "../../src/modules/chats/chat";
import { startReplicaSet } from "../support/test-app";

const DB_NAME = "truex_next_approvals_test";

// A tool-approval audit document for the store. `_id` is the adapter's
// approvalId string, which is what makes a reconnect replay idempotent.
function approvalDoc(over: Partial<ToolApprovalDoc> = {}): ToolApprovalDoc {
  return {
    _id: `ap_${new ObjectId().toHexString()}`,
    chatId: new ObjectId(),
    runId: new ObjectId(),
    userId: new ObjectId(),
    connector: "github",
    tool: "create_branch",
    decision: "allow_for_chat",
    auto: false,
    params: [{ name: "branch", value: "feature/x" }],
    at: new Date(),
    ...over,
  };
}

describe("ChatStore approvals (integration)", () => {
  let mongo: MongoMemoryReplSet;
  let database: DatabaseService;
  let store: ChatStore;

  before(async () => {
    mongo = await startReplicaSet();
    database = new DatabaseService({
      mongodbUri: mongo.getUri(),
      catalogDbName: "truex_next_test_catalog",
    } as AppConfig);
    database.onModuleInit();
    await database.waitUntilConnected(30_000);
    store = new ChatStore(database);
  });

  after(async () => {
    await database?.onApplicationShutdown();
    await mongo?.stop();
  });

  beforeEach(async () => {
    const db = database.tenantDb(DB_NAME);
    await db.collection(TOOL_APPROVALS_COLLECTION).deleteMany({});
    await db.collection(CHATS_COLLECTION).deleteMany({});
  });

  function approvals(): Promise<ToolApprovalDoc[]> {
    return database
      .tenantDb(DB_NAME)
      .collection<ToolApprovalDoc>(TOOL_APPROVALS_COLLECTION)
      .find({})
      .toArray();
  }

  async function insertChat(
    chatId: ObjectId,
    ownerId: ObjectId,
    toolApprovals?: ChatDoc["toolApprovals"],
  ): Promise<void> {
    const now = new Date();
    await database
      .tenantDb(DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION)
      .insertOne({
        _id: chatId,
        ownerId,
        title: "Chat",
        agent: { source: "personal", id: new ObjectId(), revision: 1 },
        model: { id: new ObjectId(), revision: 1 },
        platformInstructionsVersion: "v4",
        runtime: { threadId: null, state: "none" },
        activeRun: null,
        nextSeq: 2,
        status: "active",
        createdByMessageId: "cm-1",
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
        ...(toolApprovals ? { toolApprovals } : {}),
      });
  }

  function chatApprovals(chatId: ObjectId): Promise<ChatDoc["toolApprovals"]> {
    return database
      .tenantDb(DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION)
      .findOne({ _id: chatId })
      .then((c) => c?.toolApprovals);
  }

  test("recordApproval inserts the audit document", async () => {
    const doc = approvalDoc();
    await store.recordApproval(DB_NAME, doc);
    const rows = await approvals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?._id, doc._id);
    assert.equal(rows[0]?.decision, "allow_for_chat");
    assert.deepEqual(rows[0]?.params, [{ name: "branch", value: "feature/x" }]);
  });

  test("recordApproval is idempotent: a replayed resolution is one record", async () => {
    const doc = approvalDoc();
    await store.recordApproval(DB_NAME, doc);
    // The same approvalId (a reconnect replay) must not add a second record,
    // and must not throw.
    await store.recordApproval(DB_NAME, { ...doc, decision: "deny" });
    const rows = await approvals();
    assert.equal(rows.length, 1);
    // The first write wins (duplicate _id ignored).
    assert.equal(rows[0]?.decision, "allow_for_chat");
  });

  test("allowToolForChat adds the tool once and never duplicates it", async () => {
    const chatId = new ObjectId();
    const ownerId = new ObjectId();
    await insertChat(chatId, ownerId);
    await store.allowToolForChat(
      DB_NAME,
      chatId,
      ownerId,
      "github",
      "create_branch",
    );
    await store.allowToolForChat(
      DB_NAME,
      chatId,
      ownerId,
      "github",
      "create_branch",
    );
    const list = await chatApprovals(chatId);
    assert.equal(list?.length, 1);
    assert.equal(list?.[0]?.connector, "github");
    assert.equal(list?.[0]?.tool, "create_branch");
    // A different tool is added alongside it.
    await store.allowToolForChat(DB_NAME, chatId, ownerId, "github", "open_pr");
    assert.equal((await chatApprovals(chatId))?.length, 2);
  });

  test("allowToolForChat respects the MAX_CHAT_TOOL_APPROVALS cap", async () => {
    const chatId = new ObjectId();
    const ownerId = new ObjectId();
    // Seed the chat at the cap, then a further allow must not grow it.
    const full = Array.from({ length: MAX_CHAT_TOOL_APPROVALS }, (_, i) => ({
      connector: "github",
      tool: `tool_${i}`,
      at: new Date(),
    }));
    await insertChat(chatId, ownerId, full);
    await store.allowToolForChat(
      DB_NAME,
      chatId,
      ownerId,
      "github",
      "one_too_many",
    );
    const list = await chatApprovals(chatId);
    assert.equal(list?.length, MAX_CHAT_TOOL_APPROVALS);
    assert.equal(
      list?.some((a) => a.tool === "one_too_many"),
      false,
    );
  });

  test("allowToolForChat only matches the owner's own chat", async () => {
    const chatId = new ObjectId();
    const ownerId = new ObjectId();
    const stranger = new ObjectId();
    await insertChat(chatId, ownerId);
    // A different owner never grows the chat's approvals.
    await store.allowToolForChat(
      DB_NAME,
      chatId,
      stranger,
      "github",
      "create_branch",
    );
    assert.equal((await chatApprovals(chatId))?.length ?? 0, 0);
    // The owner does grow it.
    await store.allowToolForChat(
      DB_NAME,
      chatId,
      ownerId,
      "github",
      "create_branch",
    );
    assert.equal((await chatApprovals(chatId))?.length, 1);
  });
});
