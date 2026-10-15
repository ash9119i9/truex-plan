import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/persistence/store";
import { PlatformService, ApiError } from "../src/app/platform-service";
import { asUser, ashok, insertFixtures } from "./fixtures";

async function fixture(t: TestContext) {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "first_message").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await insertFixtures(store);
  const service = new PlatformService(store, ["http://fixture.invalid"]);
  const calls: { path: string; body: any }[] = [];
  service.call = async (_host, path, _method, body) => {
    calls.push({ path, body });
    if (path === "/threads") return { threadId: "fresh-thread" };
    if (path.endsWith("/turns")) return { turnId: "first-turn", steer: false };
    if (path.endsWith("/resume")) return {};
    throw new Error(`Unexpected runtime call: ${path}`);
  };
  const configuration = t.mock.method(service, "configuration");
  // Keep the regression runnable against the old four-argument API.
  const create = service.create.bind(service) as (
    ...args: unknown[]
  ) => Promise<any>;
  return { service, store, calls, configuration, create };
}

test("creation dispatches its first message with one configuration build and no resume", async (t) => {
  const { service, store, calls, configuration, create } = await fixture(t);
  const result = await asUser(ashok, () =>
    create("assistant", undefined, undefined, undefined, {
      text: "Hello",
      clientId: "first",
    }),
  );
  assert.equal(result.initialMessage?.clientId, "first");
  assert.equal(result.initialMessage.result.turnId, "first-turn");
  assert.equal(configuration.mock.callCount(), 1);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/threads", "/threads/fresh-thread/turns"],
  );
  const saved = await store.messages.findOne({
    sessionId: result._id,
    clientId: "first",
  });
  assert.equal(saved?.delivery, "accepted");
  assert.equal(saved?.text, "Hello");
  assert.equal(saved?.turnId, "first-turn");
  calls.length = 0;
  await asUser(ashok, () => service.message(result._id, "Next", "next"));
  assert.equal(configuration.mock.callCount(), 2);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/threads/fresh-thread/resume", "/threads/fresh-thread/turns"],
  );
});

test("invalid first messages fail before creating a runtime or database session", async (t) => {
  const { store, calls, configuration, create } = await fixture(t);
  for (const input of [
    null,
    [],
    "hello",
    {},
    { text: "", clientId: "id" },
    { text: "hello" },
    { text: "x".repeat(100001), clientId: "id" },
  ]) {
    await assert.rejects(
      asUser(ashok, () =>
        create("assistant", undefined, undefined, undefined, input),
      ),
      { status: 400 },
    );
  }
  assert.equal(configuration.mock.callCount(), 0);
  assert.equal(calls.length, 0);
  assert.equal(await store.sessions.countDocuments({}), 0);
});

test("a first-message timeout returns the created session and an unknown receipt without retrying", async (t) => {
  const { service, store, calls, create } = await fixture(t);
  const call = service.call.bind(service);
  service.call = async (...args) => {
    if (args[1].endsWith("/turns")) {
      calls.push({ path: args[1], body: args[3] });
      throw new ApiError(
        504,
        "Check the conversation before retrying",
        "OWNER_TIMEOUT",
      );
    }
    return call(...args);
  };
  const result = await asUser(ashok, () =>
    create("assistant", undefined, undefined, undefined, {
      text: "Hello",
      clientId: "timeout",
    }),
  );
  assert.equal(result.initialMessage?.error?.code, "OWNER_TIMEOUT");
  assert.equal(result.initialMessage?.error?.status, 504);
  assert.equal(result.initialMessage?.clientId, "timeout");
  assert.ok(await store.sessions.findOne({ _id: result._id }));
  assert.equal(
    (await store.messages.findOne({ sessionId: result._id }))?.delivery,
    "unknown",
  );
  assert.equal(calls.filter((c) => c.path.endsWith("/turns")).length, 1);
});

test("first dispatch revalidates access and retains the created session on refusal", async (t) => {
  const { service, store, calls, create } = await fixture(t);
  service.dispatchGuard = async () => {
    throw new ApiError(403, "Access revoked", "FORBIDDEN");
  };
  const result = await asUser(ashok, () =>
    create("assistant", undefined, undefined, undefined, {
      text: "Hello",
      clientId: "revoked",
    }),
  );
  assert.equal(result.initialMessage?.error?.code, "FORBIDDEN");
  assert.ok(await store.sessions.findOne({ _id: result._id }));
  assert.equal(await store.messages.countDocuments({}), 0);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/threads"],
  );
});

test("a refused first turn is recorded once, releases its quota, and exposes only a safe error", async (t) => {
  const { service, store, create } = await fixture(t);
  let releases = 0,
    turns = 0;
  service.quota = {
    applies: () => true,
    reserve: async () => ({ duplicate: false }),
    release: async () => {
      releases++;
    },
  } as any;
  service.call = async (_host, path) => {
    if (path === "/threads") return { threadId: "fresh-thread" };
    turns++;
    throw new ApiError(409, "Bearer fixture-secret rejected", "TURN_REFUSED");
  };
  const result = await asUser(ashok, () =>
    create("assistant", undefined, undefined, undefined, {
      text: "Hello",
      clientId: "refused",
    }),
  );
  assert.equal(result.initialMessage.error.code, "TURN_REFUSED");
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  assert.equal(
    (await store.messages.findOne({ sessionId: result._id }))?.delivery,
    "failed",
  );
  assert.equal(turns, 1);
  assert.equal(releases, 1);
});
