import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService, ApiError } from "../src/service";
import { POLICY_VERSION } from "../src/public";
import { tenantContext, type TenantRef } from "../src/tenant";
import { asUser, ashok, dharun, admin } from "./fixtures";
import { orderConversation } from "../../shared/command-history";
import type { Message, Session } from "../../shared/contracts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tenant: TenantRef = {
  id: "history",
  dbName: "history_test",
  chatVisibility: "own",
};
function fixtureSession(overrides: Partial<Session> = {}): Session {
  return {
    _id: "s",
    userId: ashok.id,
    agentId: "assistant",
    threadId: "t",
    agentCoreHost: "http://fixture.invalid",
    status: "active",
    cwd: "/tmp",
    createdAt: "2026-10-05T00:00:00.000Z",
    runtimePolicyVersion: POLICY_VERSION,
    ...overrides,
  };
}
async function setup(t: any) {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(
    mongo.getUri(),
    tenant.dbName,
    tenant.dbName,
  ).connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const session = fixtureSession();
  await store.sessions.insertOne({
    ...session,
    plan: {
      steps: [{ step: "Saved", status: "completed" }],
      version: 1,
      updatedAt: session.createdAt,
      eventAt: session.createdAt,
    },
  });
  await store.messages.insertMany([
    {
      _id: "user",
      sessionId: "s",
      role: "user",
      text: "Saved question",
      clientId: "client",
      delivery: "pending",
      at: session.createdAt,
    },
    {
      _id: "answer",
      sessionId: "s",
      role: "assistant",
      text: "Saved answer",
      turnId: "turn",
      itemId: "answer-item",
      at: session.createdAt,
    },
  ]);
  const service = new PlatformService(store, [session.agentCoreHost]);
  return { store, service, session };
}
const owner = <T>(fn: () => T) =>
  tenantContext.run(tenant, () => asUser(ashok, fn));

test("persisted history reads saved messages and plan without runtime calls or state writes", async (t) => {
  const { store, service } = await setup(t);
  const beforeSession = await store.sessions.findOne({ _id: "s" });
  const beforeMessages = await store.messages
    .find({ sessionId: "s" })
    .toArray();
  const runtime = t.mock.method(service, "owned", async () => {
    throw Error("Runtime must not be called");
  });
  const ingest = t.mock.method(service, "ingest", async () => {
    throw Error("No ingest");
  });
  const reconcile = t.mock.method(service, "reconcile", async () => {
    throw Error("No reconciliation");
  });
  const phases: string[] = [];
  const history = await owner(() =>
    service.history("s", {
      persistedOnly: true,
      onTiming: (phase) => phases.push(phase),
    }),
  );
  assert.equal(history.messages.length, 2);
  assert.deepEqual(history.plan?.steps, [
    { step: "Saved", status: "completed" },
  ]);
  assert.equal(history.snapshot, null);
  assert.equal(history.recoveryError, null);
  assert.deepEqual(phases, ["authorization", "persisted"]);
  assert.equal(
    runtime.mock.callCount() +
      ingest.mock.callCount() +
      reconcile.mock.callCount(),
    0,
  );
  assert.deepEqual(await store.sessions.findOne({ _id: "s" }), beforeSession);
  assert.deepEqual(
    await store.messages.find({ sessionId: "s" }).toArray(),
    beforeMessages,
  );
  assert.doesNotMatch(
    JSON.stringify(history.session),
    /threadId|agentCoreHost|cwd/,
  );
});

test("persisted history applies hidden-chat, admin and legacy authorization before runtime work", async (t) => {
  const { store, service } = await setup(t);
  const runtime = t.mock.method(service, "owned", async () => {
    throw Error("No runtime");
  });
  await assert.rejects(
    tenantContext.run(tenant, () =>
      asUser(dharun, () => service.history("s", { persistedOnly: true })),
    ),
    (e: any) => e.status === 404,
  );
  assert.equal(
    (
      await tenantContext.run(tenant, () =>
        asUser(admin, () => service.history("s", { persistedOnly: true })),
      )
    ).messages.length,
    2,
  );
  await store.sessions.updateOne(
    { _id: "s" },
    { $unset: { runtimePolicyVersion: "" } },
  );
  await assert.rejects(
    owner(() => service.history("s", { persistedOnly: true })),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    tenantContext.run(tenant, () =>
      asUser(dharun, () => service.history("s", { persistedOnly: true })),
    ),
    (e: any) => e.status === 404,
  );
  assert.equal(runtime.mock.callCount(), 0);
});

test(
  "concurrent authorized history shares recovery, persisted reads do not wait, and settled work is cleared",
  { timeout: 15000 },
  async (t) => {
    const { service } = await setup(t);
    const entered = deferred(),
      release = deferred(),
      secondAuthorized = deferred();
    let snapshots = 0;
    t.mock.method(service, "owned", async (_s, path) => {
      if (path === "/snapshot") {
        snapshots++;
        entered.resolve();
        await release.promise;
        return { state: { kind: "idle" }, plan: [] };
      }
      if (path === "/records") return [];
      if (path === "/items") return { data: [], nextCursor: null };
      throw Error(path);
    });
    const first = owner(() => service.history("s"));
    await entered.promise;
    const second = owner(() =>
      service.history("s", {
        onTiming: (phase) => {
          if (phase === "authorization") secondAuthorized.resolve();
        },
      }),
    );
    await secondAuthorized.promise;
    const persisted = await owner(() =>
      service.history("s", { persistedOnly: true }),
    );
    assert.equal(persisted.messages.length, 2);
    assert.equal(snapshots, 1);
    release.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].recoveryError, null);
    assert.equal(results[1].recoveryError, null);
    assert.equal(snapshots, 1);
    await owner(() => service.history("s"));
    assert.equal(snapshots, 2);
  },
);

test("runtime recovery failures retain saved data and do not poison the next recovery", async (t) => {
  const { service } = await setup(t);
  let snapshots = 0;
  t.mock.method(service, "owned", async (_s, path) => {
    if (path === "/snapshot") {
      snapshots++;
      if (snapshots === 1)
        throw new ApiError(503, "Fixture unavailable", "OWNER_UNAVAILABLE");
      return { state: { kind: "idle" }, plan: [] };
    }
    if (path === "/records") return [];
    return { data: [], nextCursor: null };
  });
  const failed = await owner(() => service.history("s"));
  assert.equal(failed.messages.length, 2);
  assert.equal(failed.recoveryErrorRef?.code, "OWNER_UNAVAILABLE");
  assert.match(failed.recoveryError || "", /Fixture unavailable/);
  assert.equal((await owner(() => service.history("s"))).recoveryError, null);
  assert.equal(snapshots, 2);
});

test(
  "shared recovery is isolated by tenant database, user, role and visibility",
  { timeout: 15000 },
  async (t) => {
    const { store, service } = await setup(t);
    const otherTenant: TenantRef = {
      id: "other",
      dbName: "other_history_test",
      chatVisibility: "all",
    };
    await tenantContext.run(otherTenant, () =>
      store.sessions.insertOne(fixtureSession()),
    );
    await store.ensureTenantIndexes(otherTenant.dbName);
    const release = deferred(),
      allEntered = deferred();
    let snapshots = 0;
    t.mock.method(service, "owned", async (_s, path) => {
      if (path === "/snapshot") {
        if (++snapshots === 5) allEntered.resolve();
        await release.promise;
        return { state: { kind: "idle" }, plan: [] };
      }
      if (path === "/records") return [];
      return { data: [], nextCursor: null };
    });
    const allTenant = { ...tenant, chatVisibility: "all" as const };
    const requests = [
      tenantContext.run(tenant, () =>
        asUser(ashok, () => service.history("s")),
      ),
      tenantContext.run(allTenant, () =>
        asUser(ashok, () => service.history("s")),
      ),
      tenantContext.run(allTenant, () =>
        asUser(dharun, () => service.history("s")),
      ),
      tenantContext.run(allTenant, () =>
        asUser({ ...ashok, role: "admin" }, () => service.history("s")),
      ),
      tenantContext.run(otherTenant, () =>
        asUser(ashok, () => service.history("s")),
      ),
    ];
    await allEntered.promise;
    release.resolve();
    const results = await Promise.all(requests);
    assert.equal(snapshots, 5);
    assert.deepEqual(
      results.map((r) => r.messages.length),
      [2, 2, 2, 2, 0],
    );
  },
);

test("batched reconciliation preserves pending identity, assistant aliases, commands and page ordering", async (t) => {
  const { store, service, session } = await setup(t);
  await store.messages.deleteOne({ _id: "answer" });
  const command: Message = {
    _id: "command",
    sessionId: "s",
    role: "user",
    text: "/goal",
    at: session.createdAt,
    command: {
      clientId: "cmd",
      method: "thread/goal/set",
      params: {},
      state: "succeeded",
      afterMessageId: "user",
    },
  };
  await store.messages.insertOne(command);
  await store.messages.insertOne({
    _id: "s:assistant:turn:0",
    sessionId: "s",
    role: "assistant",
    text: "Durable final answer",
    turnId: "turn",
    itemId: "persisted-alias",
    messageIndex: 0,
    at: session.createdAt,
  });
  let writes = 0;
  const messages = store.messages;
  Object.defineProperty(store, "messages", {
    configurable: true,
    get: () => messages,
  });
  const bulk = messages.bulkWrite.bind(messages);
  t.mock.method(messages, "bulkWrite", async (operations, options) => {
    writes++;
    assert.equal(options?.ordered, true);
    return bulk(operations, options);
  });
  t.mock.method(service, "owned", async (_s, path) =>
    path === "/items"
      ? {
          data: [
            {
              turnId: "turn",
              item: {
                id: "runtime-user",
                type: "userMessage",
                clientId: "client",
                content: [
                  { type: "text", text: "Do not replace pending text" },
                ],
              },
            },
            {
              turnId: "turn",
              item: {
                id: "runtime-answer",
                type: "agentMessage",
                text: "Do not replace durable final",
              },
            },
          ],
          nextCursor: "page-2",
        }
      : {
          data: [
            {
              turnId: "turn",
              item: {
                id: "runtime-answer-2",
                type: "agentMessage",
                text: "Second answer",
              },
            },
            {
              turnId: "next",
              item: {
                id: "new-user",
                type: "userMessage",
                content: [{ type: "text", text: "New question" }],
              },
            },
            {
              turnId: "next",
              item: {
                id: "new-user",
                type: "userMessage",
                content: [{ type: "text", text: "Repeated item" }],
              },
            },
          ],
          nextCursor: null,
        },
  );
  await service.reconcile(session);
  assert.equal(writes, 2);
  const rows = await messages.find({ sessionId: "s" }).toArray();
  assert.equal(rows.length, 5);
  const pending = rows.find((r) => r._id === "user")!;
  assert.equal(pending.text, "Saved question");
  assert.equal(pending.delivery, "accepted");
  assert.equal(pending.itemId, "runtime-user");
  assert.equal(pending.order, 0);
  const answer = rows.find((r) => r._id === "s:assistant:turn:0")!;
  assert.equal(answer.text, "Durable final answer");
  assert.equal(answer.itemId, "persisted-alias");
  assert.equal(answer.runtimeItemId, "runtime-answer");
  assert.deepEqual(
    orderConversation(rows).map((r) => r._id),
    [
      "user",
      "command",
      "s:assistant:turn:0",
      "s:assistant:turn:1",
      "s:runtime-user:new-user",
    ],
  );
  await service.reconcile(session);
  assert.equal(await messages.countDocuments({ sessionId: "s" }), 5);
});

test("ordered bulk failure preserves committed prefix and a retry completes without duplicates", async (t) => {
  const { store, service, session } = await setup(t);
  await store.messages.deleteMany({});
  const messages = store.messages;
  Object.defineProperty(store, "messages", {
    configurable: true,
    get: () => messages,
  });
  const original = messages.bulkWrite.bind(messages);
  let fail = true;
  t.mock.method(messages, "bulkWrite", async (operations, options) => {
    if (fail) {
      fail = false;
      await original(operations.slice(0, 1), options);
      throw Error("Fixture partial bulk failure");
    }
    return original(operations, options);
  });
  t.mock.method(service, "owned", async () => ({
    data: [
      {
        turnId: "t1",
        item: {
          id: "u1",
          type: "userMessage",
          content: [{ type: "text", text: "Question" }],
        },
      },
      {
        turnId: "t1",
        item: { id: "a1", type: "agentMessage", text: "Answer" },
      },
    ],
    nextCursor: null,
  }));
  await assert.rejects(service.reconcile(session), /partial bulk failure/);
  assert.equal(await messages.countDocuments(), 1);
  await service.reconcile(session);
  const rows = await messages.find().sort({ order: 1 }).toArray();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.role, r.order]),
    [
      ["user", 0],
      ["assistant", 1],
    ],
  );
});

test("recovery acknowledges durable records only after every record is persisted", async (t) => {
  const { store, service, session } = await setup(t);
  await store.messages.deleteMany({});
  const records = [0, 1].map((index) => ({
    key: `record-${index}`,
    event: {
      type: "message.final",
      threadId: "t",
      turnId: `turn-${index}`,
      itemId: `item-${index}`,
      seq: index + 1,
      cursor: `g:${index + 1}`,
      at: session.createdAt,
      data: { text: `Answer ${index}`, messageIndex: 0 },
    },
  }));
  let acknowledged = 0,
    failure = true;
  const persist = store.persist.bind(store);
  t.mock.method(store, "persist", async (id, event) => {
    if (event.turnId === "turn-1" && failure) {
      failure = false;
      throw Error("Fixture persistence failure");
    }
    return persist(id, event);
  });
  t.mock.method(service, "owned", async (_s, path, _method, body) => {
    if (path === "/records") return records;
    if (path === "/records/ack") {
      acknowledged++;
      assert.deepEqual(body.keys, ["record-0", "record-1"]);
      return {};
    }
    throw Error(path);
  });
  await assert.rejects(service.ingest(session), /persistence failure/);
  assert.equal(acknowledged, 0);
  assert.equal(await store.messages.countDocuments(), 1);
  await service.ingest(session);
  assert.equal(acknowledged, 1);
  assert.equal(await store.messages.countDocuments(), 2);
});

test("windowed recovery bounds transcript and snapshot turns while legacy reads keep the full history", async (t) => {
  const { store, service, session } = await setup(t);
  await store.messages.deleteMany({});
  const messages: Message[] = [];
  for (let index = 0; index < 16; index++)
    messages.push(
      {
        _id: `u-${index}`,
        sessionId: "s",
        role: "user",
        text: `Question ${index}`,
        turnId: `turn-${index}`,
        order: index * 2,
        at: session.createdAt,
      },
      {
        _id: `a-${index}`,
        sessionId: "s",
        role: "assistant",
        text: `Answer ${index}`,
        turnId: `turn-${index}`,
        order: index * 2 + 1,
        at: session.createdAt,
      },
    );
  await store.messages.insertMany(messages);
  const pending = {
    requestId: "p",
    method: "item/tool/requestUserInput",
    detail: { questions: [] },
    expiresAt: session.createdAt,
    responseSchema: null,
  };
  t.mock.method(service, "owned", async (_s, path) => {
    if (path === "/snapshot")
      return {
        state: { kind: "running", turnId: "active" },
        plan: [],
        pending: [pending],
        messages: [
          ...messages
            .filter((m) => m.role === "assistant")
            .map((m) => ({ id: m._id, turnId: m.turnId, text: m.text })),
          {
            id: "active-answer",
            turnId: "active",
            text: "Working",
            final: false,
          },
        ],
        thinking: messages
          .filter((m) => m.role === "assistant")
          .map((m) => ({ id: m._id, turnId: m.turnId, raw: "Reasoning" })),
      };
    if (path === "/records") return [];
    return { data: [], nextCursor: null };
  });
  const recent = await owner(() => service.history("s", { window: true }));
  assert.equal(recent.messages.length, 20);
  assert.equal(recent.messages[0]._id, "u-6");
  assert.equal(recent.historyWindow?.hasOlder, true);
  assert.equal(recent.snapshot!.messages.length, 11);
  assert.equal(recent.snapshot!.thinking.length, 10);
  assert.equal(recent.snapshot!.messages[0].turnId, "turn-6");
  assert.equal(recent.snapshot!.state.turnId, "active");
  assert.equal(recent.snapshot!.pending.length, 1);
  const older = await owner(() =>
    service.history("s", {
      persistedOnly: true,
      window: true,
      before: recent.historyWindow!.beforeCursor,
    }),
  );
  assert.deepEqual([...older.messages, ...recent.messages], messages);
  assert.equal(older.historyWindow?.hasOlder, false);
  assert.equal(older.snapshot, null);
  const legacy = await owner(() => service.history("s"));
  assert.equal(legacy.messages.length, 32);
  assert.equal(legacy.snapshot!.messages.length, 17);
  assert.equal(legacy.historyWindow, undefined);
  await assert.rejects(
    owner(() => service.history("s", { window: true, before: "corrupt" })),
    (error: any) => error.code === "INVALID_HISTORY_CURSOR",
  );
});
