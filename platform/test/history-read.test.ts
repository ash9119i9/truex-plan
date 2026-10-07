import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { POLICY_VERSION } from "../src/public";
import { orderConversation } from "../../shared/command-history";
import { historyAnchor, historyWindow } from "../src/history-window";
import { readHistoryWindow, SMALL_HISTORY_LIMIT } from "../src/history-read";
import type { Message } from "../../shared/contracts";
import { tenantContext } from "../src/tenant";
import { userContext } from "../src/user";

test("recent history bounds payload reads and preserves complete authoritative pages", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "history-read").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await store.sessions.insertOne({
    _id: "s",
    agentId: "a",
    threadId: "t",
    agentCoreHost: "http://fixture.invalid",
    status: "active",
    cwd: "/tmp",
    createdAt: "2026-10-05",
    runtimePolicyVersion: POLICY_VERSION,
  });
  const messages: Message[] = Array.from({ length: 400 }, (_, i) => ({
    _id: `m-${i}`,
    sessionId: "s",
    role: i % 2 ? "assistant" : "user",
    text: `body-${i}:` + "x".repeat(8192),
    at: "2026-10-05T00:00:00Z",
    order: i,
    turnId: `turn-${Math.floor(i / 2)}`,
  }));
  messages.push({
    _id: "command",
    sessionId: "s",
    role: "user",
    text: "/help",
    at: "2026-10-05T00:00:00Z",
    command: {
      method: "help",
      params: { body: "x".repeat(8192) },
      state: "succeeded",
      afterMessageId: "m-390",
    },
  });
  messages.push({
    _id: "unanchored",
    sessionId: "s",
    role: "user",
    text: "/help",
    at: "2026-10-05T00:00:00Z",
    command: { method: "help", params: {}, state: "succeeded" },
  });
  messages.push({
    _id: "command-child",
    sessionId: "s",
    role: "user",
    text: "/help",
    at: "2026-10-05T00:00:00Z",
    command: {
      method: "help",
      params: {},
      state: "succeeded",
      afterMessageId: "command",
    },
  });
  messages.push(
    {
      _id: "legacy-pending",
      sessionId: "s",
      role: "user",
      text: "未送信 😀",
      at: "2026-10-05T00:00:00Z",
      delivery: "pending",
    },
    {
      _id: "legacy-answer",
      sessionId: "s",
      role: "assistant",
      text: "Legacy context",
      at: "2026-10-05T00:00:00Z",
    },
  );
  // Corrupted/removed predecessors must keep the exact existing ordering
  // behavior, including cycle breaking, rather than silently losing commands.
  for (const [id, predecessor] of [
    ["orphan-command", "removed-predecessor"],
    ["orphan-child", "orphan-command"],
    ["cycle-a", "cycle-b"],
    ["cycle-b", "cycle-a"],
  ])
    messages.push({
      _id: id,
      sessionId: "s",
      role: "user",
      text: "/help",
      at: "2026-10-05T00:00:00Z",
      command: {
        method: "help",
        params: {},
        state: "succeeded",
        afterMessageId: predecessor,
      },
    });
  await store.messages.insertMany(messages);
  const collection = store.messages;
  Object.defineProperty(store, "messages", {
    configurable: true,
    get: () => collection,
  });
  const find = collection.find.bind(collection);
  let payloadRows = 0,
    metadataRows = 0;
  t.mock.method(collection, "find", (...args: any[]) => {
    const cursor = (find as any)(...args);
    const toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async () => {
      const data = await toArray();
      if (
        args[1]?.projection?.text === undefined &&
        args[1]?.projection?.role === 1
      )
        metadataRows += data.length;
      else payloadRows += data.length;
      return data;
    };
    return cursor;
  });
  const service = new PlatformService(store, ["http://fixture.invalid"]);
  const expected = historyWindow(orderConversation(messages), "s");
  const actual = await service.history("s", {
    persistedOnly: true,
    window: true,
  });
  assert.deepEqual(actual.messages, expected.messages);
  assert.deepEqual(actual.historyWindow, expected.historyWindow);
  assert.ok(
    payloadRows <= SMALL_HISTORY_LIMIT + 1 + expected.messages.length,
    `decoded ${payloadRows} bodies for 20-message recent window`,
  );
  assert.ok(metadataRows >= 400);
  let page = actual;
  let merged = [...page.messages];
  while (page.historyWindow!.hasOlder) {
    page = await service.history("s", {
      persistedOnly: true,
      window: true,
      before: page.historyWindow!.beforeCursor,
    });
    merged = [...page.messages, ...merged];
  }
  assert.deepEqual(merged, orderConversation(messages));
  const older = await service.history("s", {
    persistedOnly: true,
    window: true,
    before: actual.historyWindow!.beforeCursor,
  });
  const before = expected.messages[0]._id;
  assert.deepEqual(
    older.messages,
    historyWindow(orderConversation(messages), "s", before).messages,
  );
  const full = await service.history("s", { persistedOnly: true });
  assert.deepEqual(full.messages, orderConversation(messages));

  await t.test(
    "private admin pages are audited and never recover the owner's runtime",
    async () => {
      await store.sessions.updateOne(
        { _id: "s" },
        { $set: { userId: "owner" } },
      );
      const calls = t.mock.method(service, "call", async () => {
        throw new Error("A passive read must not call the runtime");
      });
      const read = (options: Parameters<typeof service.history>[1] = {}) =>
        tenantContext.run(
          { id: "private", dbName: "history-read", chatVisibility: "own" },
          () =>
            userContext.run(
              { id: "admin", email: "admin@example.com", role: "admin" },
              () => service.history("s", options),
            ),
        );
      const phases: string[] = [];
      const recent = await read({
        window: true,
        onTiming: (phase) => phases.push(phase),
      });
      assert.equal(recent.access, "readOnly");
      assert.equal(recent.snapshot, null);
      assert.equal(recent.recoveryError, null);
      assert.deepEqual(recent.messages, expected.messages);
      assert.deepEqual(recent.historyWindow, expected.historyWindow);
      assert.deepEqual(phases, ["authorization", "persisted"]);
      const olderPage = await read({
        window: true,
        before: recent.historyWindow!.beforeCursor,
      });
      assert.deepEqual(olderPage.messages, older.messages);
      assert.equal(olderPage.access, "readOnly");
      assert.deepEqual((await read()).messages, full.messages);
      assert.equal(calls.mock.callCount(), 0);
      assert.ok(
        await store.audit.findOne({
          actor: "admin",
          action: "session.read",
          "target.id": "s",
        }),
      );
      await assert.rejects(read({ window: true, before: "invalid" }), {
        code: "INVALID_HISTORY_CURSOR",
      });
    },
  );

  // Short chats retain one query; empty and huge request groups are not cut.
  await store.messages.insertMany(
    messages
      .slice(0, 20)
      .map((m) => ({ ...m, _id: "short-" + m._id, sessionId: "short" })),
  );
  payloadRows = metadataRows = 0;
  const short = await readHistoryWindow(collection, "short");
  assert.equal(short.messages.length, 20);
  assert.equal(payloadRows, 20);
  assert.equal(metadataRows, 0);
  const empty = await readHistoryWindow(collection, "empty");
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.historyWindow.hasOlder, false);
  const huge = messages.slice(0, 400).map((m, i) => ({
    ...m,
    _id: "huge-" + m._id,
    sessionId: "huge",
    role: (i === 0 ? "user" : "assistant") as Message["role"],
  }));
  await store.messages.insertMany(huge);
  assert.deepEqual(
    (await readHistoryWindow(collection, "huge")).messages,
    orderConversation(huge),
  );

  const oldPage = await readHistoryWindow(
    collection,
    "s",
    historyAnchor("s", actual.historyWindow!.beforeCursor),
  );
  await store.messages.insertMany([
    {
      _id: "append-user",
      sessionId: "s",
      role: "user",
      text: "new",
      at: "2026-10-06",
      order: 400,
    },
    {
      _id: "append-answer",
      sessionId: "s",
      role: "assistant",
      text: "new reply",
      at: "2026-10-06",
      order: 401,
    },
  ]);
  assert.deepEqual(
    await readHistoryWindow(
      collection,
      "s",
      historyAnchor("s", actual.historyWindow!.beforeCursor),
    ),
    oldPage,
  );
  await assert.rejects(readHistoryWindow(collection, "s", "removed"), {
    code: "HISTORY_CURSOR_STALE",
  });

  // DB failures after the initial count probe must propagate unchanged. They
  // cannot become a successful incomplete history page or an empty cache hit.
  for (const phase of ["metadata", "bodies"]) {
    const failure = new Error(`${phase} read unavailable`);
    t.mock.method(collection, "find", (...args: any[]) => {
      const cursor = (find as any)(...args);
      const targeted =
        phase === "metadata"
          ? args[1]?.projection?.role === 1
          : !!args[0]?._id?.$in;
      if (targeted)
        cursor.toArray = async () => {
          throw failure;
        };
      return cursor;
    });
    await assert.rejects(
      readHistoryWindow(collection, "s"),
      (error) => error === failure,
    );
  }

  // A selected document deleted between metadata and body reads must not turn
  // a partial page into a successful cacheable result.
  t.mock.method(collection, "find", (...args: any[]) => {
    const cursor = (find as any)(...args);
    if (args[0]?._id?.$in) {
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => (await toArray()).slice(1);
    }
    return cursor;
  });
  await assert.rejects(readHistoryWindow(collection, "s"), {
    status: 409,
    code: "HISTORY_CURSOR_STALE",
  });
});
