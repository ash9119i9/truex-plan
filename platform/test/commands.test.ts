import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/persistence/store";
import { PlatformService, ApiError } from "../src/app/platform-service";
import { orderConversation } from "../../shared/command-history";
import type { Message } from "../../shared/contracts";

test("commands persist before dispatch, survive service restart, and deduplicate concurrent retries", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "command-test").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const service = new PlatformService(store);
  service.session = async () => ({ _id: "s" }) as any;
  service.resume = async () => {};
  service.ingest = async () => {};
  service.reconcile = async () => {};
  let count = 0;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  service.capability = async () => {
    count++;
    const saved = await store.messages.findOne({ _id: "s:command:c1" });
    assert.equal(saved?.command?.state, "running");
    started();
    await finish;
    return { goal: { objective: "Write report", status: "active" } } as any;
  };
  const request = { clientId: "c1", text: "/goal Write report" };
  const first = service.command(
    "s",
    "thread/goal/set",
    { objective: "Write report" },
    request,
  );
  await ready;
  const concurrent = await service.command(
    "s",
    "thread/goal/set",
    { objective: "Write report" },
    request,
  );
  assert.equal(concurrent.commandMessage.command?.state, "running");
  release();
  const completed = await first;
  assert.equal(
    completed.commandMessage.command?.result?.goal?.objective,
    "Write report",
  );
  const restarted = new PlatformService(store);
  restarted.session = service.session;
  const replay = await restarted.command(
    "s",
    "thread/goal/set",
    { objective: "Write report" },
    request,
  );
  assert.equal(replay.commandMessage.command?.state, "succeeded");
  assert.equal(count, 1);
  assert.equal(await store.messages.countDocuments(), 1);
  await assert.rejects(
    service.command("s", "thread/goal/clear", {}, request),
    /already belongs/,
  );

  service.capability = async () => {
    throw new ApiError(422, "bad request");
  };
  const failed = await service.command(
    "s",
    "thread/settings/update",
    { model: "bad" },
    { clientId: "c2", text: "/model bad" },
  );
  assert.equal(failed.commandMessage.command?.state, "failed");
  service.capability = async () => {
    throw new Error("private connection diagnostics");
  };
  const unknown = await service.command(
    "s",
    "thread/fork",
    {},
    { clientId: "c3", text: "/fork" },
  );
  assert.equal(unknown.commandMessage.command?.state, "unknown");
  assert.ok(!JSON.stringify(unknown).includes("private connection"));
});

test("reconciled history keeps commands before their answers and continuation turns", () => {
  const m = (id: string, order?: number): Message => ({
    _id: id,
    role: "assistant",
    sessionId: "s",
    text: id,
    at: "2026-01-01",
    order,
  });
  const first = m("first", 0),
    answer = m("answer", 1),
    continuation = m("continuation", 2);
  const command: Message = {
    ...m("goal"),
    role: "user",
    at: "2026-01-02",
    command: {
      method: "thread/goal/set",
      params: { objective: "Report" },
      state: "succeeded",
      afterMessageId: "first",
    },
  };
  const check: Message = {
    ...m("check"),
    role: "user",
    at: "2026-01-03",
    command: {
      method: "thread/goal/get",
      params: {},
      state: "succeeded",
      afterMessageId: "goal",
    },
  };
  assert.deepEqual(
    orderConversation([continuation, check, command, answer, first]).map(
      (m) => m._id,
    ),
    ["first", "goal", "check", "answer", "continuation"],
  );
});
