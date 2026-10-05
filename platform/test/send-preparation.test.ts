import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { insertFixtures, asUser, ashok } from "./fixtures";

async function fixture(t: TestContext) {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "send_preparation").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await insertFixtures(store);
  const service = new PlatformService(store, ["http://fixture.invalid"], {
    enabled: true,
    defaultMode: "ask",
    autopilot: false,
    nameHeuristic: false,
  });
  service.call = async (_host, _path, _method, body) => ({
    threadId: "fixture-thread",
    approvalMode: body.approvalMode,
  });
  const session = await asUser(ashok, () => service.create("assistant"));
  await store.sessions.updateOne(
    { _id: session._id },
    { $set: { title: "Titled" } },
  );
  return { service, store, session };
}

test("send requests operational preparation while ordinary resume keeps its full contract", async (t) => {
  const { service, session } = await fixture(t);
  const requests: { path: string; body: any }[] = [];
  service.call = async (_host, path, _method, body) => {
    requests.push({ path, body });
    if (path.endsWith("/resume"))
      return { approvalMode: body.approvalMode, messages: [], pending: [] };
    if (path.endsWith("/turns")) return { turnId: "turn", steer: false };
    throw new Error(`Unexpected fixture path ${path}`);
  };
  await asUser(ashok, () => service.resume(session));
  assert.equal(requests[0].body.response, undefined);
  requests.length = 0;
  await asUser(ashok, () =>
    service.message(session._id, "Question", "send-once"),
  );
  assert.equal(requests[0].body.response, "operational");
  assert.equal(requests[0].body.approvalMode, "ask");
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/threads/fixture-thread/resume", "/threads/fixture-thread/turns"],
  );
});

test("acceptance timing includes preparation and receipt work, preserving the old timing field", async (t) => {
  const { service, store, session } = await fixture(t);
  const configuration = service.configuration.bind(service);
  service.configuration = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return configuration(...args);
  };
  service.call = async (_host, path, _method, body) => {
    if (path.endsWith("/resume")) return { approvalMode: body.approvalMode };
    if (path.endsWith("/turns")) return { turnId: "timed-turn", steer: false };
    throw new Error(`Unexpected fixture path ${path}`);
  };
  const result = await asUser(ashok, () =>
    service.message(session._id, "Question", "timed"),
  );
  assert.ok(
    result.platformTiming,
    "send must expose all application acceptance phases",
  );
  const timing = result.platformTiming;
  assert.deepEqual(Object.keys(timing).sort(), [
    "authorizationMs",
    "dispatchMs",
    "preparationMs",
    "receiptMs",
    "totalMs",
  ]);
  for (const value of Object.values(timing))
    assert.ok(
      typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
  assert.ok(timing.preparationMs >= 20, "configuration wait is included");
  assert.ok(
    timing.totalMs >=
      timing.preparationMs + timing.dispatchMs + timing.authorizationMs,
  );
  assert.ok(
    result.platformRoundTripMs < timing.totalMs,
    "legacy runtime+receipt field is unchanged",
  );
  assert.equal(
    (
      await store.messages.findOne({
        sessionId: session._id,
        clientId: "timed",
      })
    )?.delivery,
    "accepted",
  );
});

test("operational preparation does not bypass saved settings or legacy approval confirmation", async (t) => {
  const { service, store, session } = await fixture(t);
  await store.sessions.updateOne(
    { _id: session._id },
    { $set: { settings: { model: "saved-model", effort: "medium" } } },
  );
  const paths: string[] = [];
  service.call = async (_host, path, _method, body) => {
    paths.push(path);
    if (path.endsWith("/resume")) {
      assert.equal(body.response, "operational");
      assert.equal(body.model, "saved-model");
      assert.equal(body.config.model_reasoning_effort, "medium");
      return {};
    }
    if (path.endsWith("/approval-mode")) return { mode: body.mode };
    if (path.endsWith("/capabilities")) {
      assert.deepEqual(body.params, { model: "saved-model", effort: "medium" });
      return {};
    }
    if (path.endsWith("/turns")) return { turnId: "legacy-turn" };
    throw new Error(`Unexpected fixture path ${path}`);
  };
  await asUser(ashok, () => service.message(session._id, "Question", "legacy"));
  assert.deepEqual(
    paths.map((path) => path.split("/").at(-1)),
    ["resume", "approval-mode", "capabilities", "turns"],
  );
});
