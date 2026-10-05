import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { PlatformReadCache } from "../src/cache";
import { tenantContext } from "../src/tenant";
import { userContext } from "../src/user";
import { insertFixtures, admin, ashok, asUser } from "./fixtures";
import { privateJson, responsePolicy, route } from "../src/http";

test("cached catalogs remain tenant/policy/principal scoped; writes evict and configuration stays authoritative", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "cache-platform").connect();
  const cache = new PlatformReadCache({ enabled: true }, {});
  const service = new PlatformService(
    store,
    ["http://core"],
    undefined,
    undefined,
    cache,
  );
  t.after(async () => {
    service.stop();
    await store.client.close();
    await mongo.stop();
  });
  await insertFixtures(store);
  const tenant = {
    id: "default",
    dbName: "cache-platform",
    allowedModelIds: ["default"],
  };
  await tenantContext.run(tenant, () =>
    asUser(ashok, async () => {
      const models = await service.models();
      models[0].name = "caller mutation";
      assert.equal((await service.models())[0].name, "gpt-5");
      await service.agents();
      const added = await service.createAgent({
        name: "Fresh Agent",
        modelProfileId: "default",
      });
      assert.ok((await service.agents()).some((a) => a.id === added.id));
      // Display can be stale; actual creation/dispatch eligibility cannot.
      await store.profiles.updateOne(
        { _id: "default" },
        { $set: { enabled: false } },
      );
      await assert.rejects(service.configuration("assistant"), {
        code: "MODEL_CONFIGURATION",
      });
      await assert.rejects(
        service.createAgent({
          name: "Denied Agent",
          modelProfileId: "default",
        }),
        { code: "MODEL_UNAVAILABLE" },
      );
    }),
  );
  await tenantContext.run({ ...tenant, allowedModelIds: [] }, () =>
    asUser(ashok, async () => assert.deepEqual(await service.models(), [])),
  );
  await tenantContext.run({ id: "other", dbName: "cache-other" }, () =>
    asUser(admin, async () => {
      await store.ensureTenantIndexes("cache-other");
      assert.deepEqual(await service.agents(), []);
    }),
  );
  assert.notEqual(
    cache.key([tenant, ashok.id, ashok.role], "models"),
    cache.key([tenant, admin.id, admin.role], "models"),
  );
});

test("same-session ingestion coalesces and never acknowledges before durable success", async (t) => {
  let persisted = 0,
    acks = 0,
    reads = 0;
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const store = {
    database: "test",
    persist: async () => {
      persisted++;
      await wait;
    },
  } as any;
  const service = new PlatformService(
    store,
    ["http://core"],
    undefined,
    undefined,
    new PlatformReadCache({ enabled: true }, {}),
  );
  t.mock.method(service, "owned", async (_s: any, path: string) => {
    if (path === "/records") {
      reads++;
      return [{ key: "record", event: { type: "message.final" } }];
    }
    if (path === "/records/ack") {
      acks++;
      return { ok: true };
    }
    throw new Error(path);
  });
  const session = { _id: "s1", agentCoreHost: "http://core" } as any;
  const first = service.ingest(session),
    second = service.ingest(session);
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  assert.equal(persisted, 1);
  assert.equal(acks, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(acks, 1);
  await service.ingest(session);
  assert.equal(reads, 2);
  t.mock.method(store, "persist", async () => {
    throw new Error("durable failure");
  });
  await assert.rejects(service.ingest(session), /durable failure/);
  assert.equal(acks, 2);
  service.stop();
});

test("same resource IDs in different tenants do not share ingestion", async (t) => {
  const tenants: string[] = [];
  const service = new PlatformService(
    { database: "test", persist: async () => {} } as any,
    ["http://core"],
    undefined,
    undefined,
    new PlatformReadCache({ enabled: true }, {}),
  );
  t.mock.method(service, "owned", async (_s: any, path: string) => {
    if (path === "/records") {
      tenants.push(tenantContext.getStore()!.id);
      await new Promise((r) => setImmediate(r));
      return [];
    }
    return { ok: true };
  });
  await Promise.all(
    ["a", "b"].map((id) =>
      tenantContext.run({ id, dbName: id }, () =>
        service.ingest({ _id: "same", agentCoreHost: "http://core" } as any),
      ),
    ),
  );
  assert.deepEqual(tenants.sort(), ["a", "b"]);
  service.stop();
});

test("private validators bind identity, authorize 304, and sensitive responses remain no-store", async (t) => {
  const app = express();
  app.use(responsePolicy);
  let revoked = false;
  app.use((req, res, next) => {
    if (revoked) {
      res.status(403).json({ error: "revoked" });
      return;
    }
    res.locals.tenant = { id: "t", dbName: "t" };
    res.locals.user = { id: req.get("x-test-user") || "a", role: "user" };
    next();
  });
  app.get(
    "/catalog",
    route((req, res) => privateJson(req, res, [{ id: "model" }])),
  );
  app.get(
    "/api/me",
    route((_req, res) => res.json({ user: "a" })),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const first = await fetch(`${base}/catalog`);
  const etag = first.headers.get("etag")!;
  assert.equal(first.headers.get("cache-control"), "private, no-cache");
  assert.match(first.headers.get("server-timing")!, /app;dur=/);
  assert.equal(
    (await fetch(`${base}/catalog`, { headers: { "If-None-Match": etag } }))
      .status,
    304,
  );
  assert.equal(
    (
      await fetch(`${base}/catalog`, {
        headers: { "If-None-Match": etag, "x-test-user": "b" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/api/me`)).headers.get("cache-control"),
    "no-store",
  );
  revoked = true;
  const denied = await fetch(`${base}/catalog`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("cache-control"), "no-store");
});
