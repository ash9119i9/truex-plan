import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/persistence/store";
import { PlatformService } from "../src/app/platform-service";
import {
  creationApprovalOptions,
  confirmRuntimeApproval,
} from "../src/conversations/session-creation";
import { asUser, ashok, dharun, insertFixtures } from "./fixtures";
import type { ApprovalModesConfig } from "../../shared/contracts";

const flags: ApprovalModesConfig = {
  enabled: true,
  defaultMode: "ask",
  autopilot: false,
  nameHeuristic: true,
};

test("creation validates the existing approval-mode schema and keeps old defaults", () => {
  assert.deepEqual(
    creationApprovalOptions(undefined, { ...flags, enabled: false }),
    {},
  );
  assert.deepEqual(creationApprovalOptions(undefined, flags), {
    approvalMode: "ask",
    approvalNameHeuristic: true,
  });
  assert.deepEqual(creationApprovalOptions("readOnly", flags), {
    approvalMode: "readOnly",
    approvalNameHeuristic: true,
  });
  assert.deepEqual(
    creationApprovalOptions("auto", { ...flags, autopilot: true }),
    { approvalMode: "auto", approvalNameHeuristic: true },
  );
  for (const value of [null, 1, {}, "", "unknown", "auto"])
    assert.throws(() => creationApprovalOptions(value, flags), {
      status: 422,
      code: "INVALID_APPROVAL_MODE",
    });
  assert.throws(
    () => creationApprovalOptions("ask", { ...flags, enabled: false }),
    { status: 404, code: "FEATURE_DISABLED" },
  );
});

test("creation confirmation uses exact ack or the supported older-runtime endpoint", async () => {
  let requests = 0;
  const legacy = async () => {
    requests++;
    return { mode: "readOnly" };
  };
  const options = creationApprovalOptions("readOnly", flags);
  await confirmRuntimeApproval({ approvalMode: "readOnly" }, options, legacy);
  assert.equal(requests, 0);
  await confirmRuntimeApproval({}, options, legacy);
  assert.equal(requests, 1);
  await assert.rejects(
    confirmRuntimeApproval({ approvalMode: "ask" }, options, legacy),
    { code: "APPROVAL_MODE_UNCONFIRMED" },
  );
  assert.equal(requests, 1, "contradictory mode is not silently corrected");
  for (const response of [undefined, {}, { mode: "ask" }, { mode: 1 }])
    await assert.rejects(
      confirmRuntimeApproval({}, options, async () => response),
      { code: "APPROVAL_MODE_UNCONFIRMED" },
    );
  await assert.rejects(
    confirmRuntimeApproval({}, options, async () => {
      throw new Error("lost acknowledgment");
    }),
    /lost acknowledgment/,
  );
  await confirmRuntimeApproval({}, {}, async () => {
    throw new Error("feature-off should not call runtime");
  });
});

test(
  "configured creation applies and persists the selected mode without a follow-up update",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "configured_creation",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    const calls: { path: string; body: any }[] = [];
    service.call = async (_host, path, _method, body) => {
      calls.push({ path, body });
      if (path === "/threads")
        return {
          threadId: "configured-thread",
          approvalMode: body.approvalMode,
        };
      throw new Error(`Unexpected runtime call: ${path}`);
    };
    const create = service.create.bind(service) as (
      ...args: unknown[]
    ) => Promise<any>;
    const result = await asUser(ashok, () =>
      create("assistant", undefined, undefined, "readOnly"),
    );
    assert.equal(result.approvalMode, "readOnly");
    assert.equal(calls[0].body.approvalMode, "readOnly");
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/threads"],
    );
    const saved = await store.sessions.findOne({ _id: result._id });
    assert.equal(saved?.approvalMode, "readOnly");
    assert.equal(saved?.userId, ashok.id);
  },
);

test(
  "invalid creation mode rejects before configuration or runtime side effects",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "invalid_configured_creation",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    for (const [config, value, status] of [
      [flags, "auto", 422],
      [flags, "bogus", 422],
      [{ ...flags, enabled: false }, "readOnly", 404],
    ] as const) {
      const service = new PlatformService(
        store,
        ["http://fixture.invalid"],
        config,
      );
      const configuration = t.mock.method(
        service,
        "configuration",
        async () => {
          throw new Error("Configuration should not run");
        },
      );
      const runtime = t.mock.method(service, "call", async () => {
        throw new Error("Runtime should not run");
      });
      const create = service.create.bind(service) as (
        ...args: unknown[]
      ) => Promise<any>;
      await assert.rejects(create("assistant", undefined, undefined, value), {
        status,
      });
      assert.equal(configuration.mock.callCount(), 0);
      assert.equal(runtime.mock.callCount(), 0);
      assert.equal(await store.sessions.countDocuments({}), 0);
    }
  },
);

test(
  "older runtime mode confirmation and failed acknowledgment keep creation safe",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "legacy_configured_creation",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    const calls: string[] = [];
    let response: any = { mode: "readOnly" };
    service.call = async (_host, path, method, body) => {
      calls.push(`${method} ${path}`);
      if (path === "/threads") return { threadId: "legacy-thread" };
      if (path.endsWith("/approval-mode")) return response;
      if (method === "DELETE") return { ok: true };
      throw new Error(`Unexpected runtime call: ${path}`);
    };
    const create = service.create.bind(service) as (
      ...args: unknown[]
    ) => Promise<any>;
    const result = await create("assistant", undefined, undefined, "readOnly");
    assert.equal(result.approvalMode, "readOnly");
    assert.deepEqual(calls, [
      "POST /threads",
      "POST /threads/legacy-thread/approval-mode",
    ]);
    calls.length = 0;
    response = { mode: "ask" };
    const before = await store.sessions.countDocuments({});
    await assert.rejects(
      create("assistant", undefined, undefined, "readOnly"),
      { code: "APPROVAL_MODE_UNCONFIRMED" },
    );
    assert.equal(await store.sessions.countDocuments({}), before);
    assert.deepEqual(calls, [
      "POST /threads",
      "POST /threads/legacy-thread/approval-mode",
      "DELETE /threads/legacy-thread",
    ]);
  },
);

test(
  "configured creation rejects forbidden projects before provisioning",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "configured_project_creation",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    const project = await asUser(dharun, () =>
      service.createProject("Other owner's project"),
    );
    const runtime = t.mock.method(service, "call", async () => {
      throw new Error("Runtime should not run");
    });
    const create = service.create.bind(service) as (
      ...args: unknown[]
    ) => Promise<any>;
    await assert.rejects(
      asUser(ashok, () =>
        create("assistant", undefined, project._id, "readOnly"),
      ),
      { status: 403 },
    );
    assert.equal(runtime.mock.callCount(), 0);
    assert.equal(await store.sessions.countDocuments({}), 0);
  },
);

test(
  "mismatched creation acknowledgment cleans up without storing or silently updating",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "mismatched_creation",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    const calls: string[] = [];
    service.call = async (_host, path, method) => {
      calls.push(`${method} ${path}`);
      if (path === "/threads")
        return { threadId: "mismatched-thread", approvalMode: "ask" };
      if (method === "DELETE") return { ok: true };
      throw new Error(
        "Mismatched acknowledgment must not fall back to an update",
      );
    };
    await assert.rejects(
      service.create("assistant", undefined, undefined, "readOnly"),
      { code: "APPROVAL_MODE_UNCONFIRMED" },
    );
    assert.deepEqual(calls, [
      "POST /threads",
      "DELETE /threads/mismatched-thread",
    ]);
    assert.equal(await store.sessions.countDocuments({}), 0);
  },
);

test(
  "database failure after configured runtime creation keeps its failure and attempts cleanup",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "creation_insert_failure",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    const calls: string[] = [];
    service.call = async (_host, path, method, body) => {
      calls.push(`${method} ${path}`);
      if (path === "/threads")
        return { threadId: "created-thread", approvalMode: body.approvalMode };
      if (method === "DELETE") throw new Error("cleanup unavailable");
      throw new Error(`Unexpected request: ${path}`);
    };
    const sessions = store.sessions;
    Object.defineProperty(store, "sessions", {
      configurable: true,
      get: () => sessions,
    });
    const databaseFailure = new Error("fixture database write failure");
    t.mock.method(sessions, "insertOne", async () => {
      throw databaseFailure;
    });
    await assert.rejects(
      service.create("assistant", undefined, undefined, "readOnly"),
      databaseFailure,
    );
    assert.deepEqual(calls, [
      "POST /threads",
      "DELETE /threads/created-thread",
    ]);
    assert.equal(await sessions.countDocuments({}), 0);
  },
);

test(
  "configured mode survives a new service instance and is reapplied before its first turn",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "configured_creation_restart",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    service.call = async (_host, _path, _method, body) => ({
      threadId: "durable-thread",
      approvalMode: body.approvalMode,
    });
    const created = await asUser(ashok, () =>
      service.create("assistant", undefined, undefined, "readOnly"),
    );
    const restarted = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    const calls: { path: string; body: any }[] = [];
    restarted.call = async (_host, path, _method, body) => {
      calls.push({ path, body });
      if (path.endsWith("/resume"))
        return { approvalMode: body.approvalMode, items: [], pending: [] };
      if (path.endsWith("/turns"))
        return { turnId: "durable-turn", steer: false };
      throw new Error(`Unexpected request: ${path}`);
    };
    await asUser(ashok, () =>
      restarted.message(
        created._id,
        "Synthetic restart question",
        "restart-message",
      ),
    );
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/threads/durable-thread/resume", "/threads/durable-thread/turns"],
    );
    assert.equal(calls[0].body.approvalMode, "readOnly");
    assert.equal(
      (await store.messages.findOne({ sessionId: created._id }))?.delivery,
      "accepted",
    );
  },
);
