import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../src/store";
import { withAuthorizationContext } from "../src/authorization-context";
import type { AuthorizationContext } from "../../shared/authorization";
import type { TenantDocument } from "../src/tenant";

function enterpriseStore(uri: string) {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "oidc";
  try {
    return new Store(uri, "default_fixture", "catalog_fixture");
  } finally {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  }
}
function context(id: string, generation = "tenant-g1"): AuthorizationContext {
  return {
    version: 1,
    principal: { kind: "human", id: "human", generation: "principal-g1" },
    tenant: { id, generation },
    binding: { id: "binding", generation: "binding-g1" },
    credential: {
      kind: "session",
      id: "credential",
      issuedAtMs: Date.now() - 1000,
      expiresAtMs: Date.now() + 60_000,
      scopes: ["conversation.read"],
    },
    requestId: "fixture-storage",
  };
}
function document(id: string, dbName = `fixture_${id}`): TenantDocument {
  return {
    _id: id,
    dbName,
    name: id,
    status: "active",
    authorizationGeneration: "tenant-g1",
    allowedModelIds: ["model-a"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test(
  "enterprise storage denies missing, forged, cross-tenant and stale contexts before selecting a database",
  { timeout: 120_000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = enterpriseStore(mongo.getUri());
    const otherStore = enterpriseStore(mongo.getUri());
    t.after(async () => {
      await Promise.all([store.client.close(), otherStore.client.close()]);
      await mongo.stop();
    });
    await store.connect();
    await otherStore.connect();
    await store.tenantRegistry.insertMany([
      document("alpha"),
      document("beta"),
    ]);
    for (const id of ["alpha", "beta"])
      await store.client
        .db(`fixture_${id}`)
        .collection("sessions")
        .insertOne({ _id: id } as any);
    const alpha = await store.resolveTenant("alpha");
    const beta = await store.resolveTenant("beta");
    const otherAlpha = await otherStore.resolveTenant("alpha");
    assert.equal(Object.isFrozen(alpha), true);
    assert.equal(Reflect.set(alpha, "dbName", beta.dbName), false);
    assert.throws(() => alpha.allowedModelIds!.push("forged-model"), TypeError);
    const originalDb = store.client.db.bind(store.client);
    let selections = 0;
    store.client.db = ((...args: Parameters<typeof originalDb>) => {
      selections++;
      return originalDb(...args);
    }) as typeof store.client.db;
    const boundaries = [
      () => store.db,
      () => store.indexesReady(),
      () => store.mcpReady(),
      () => store.ensureTenantIndexes("fixture_alpha"),
      () => store.agents,
      () => store.sessions,
    ];
    for (const boundary of boundaries) {
      assert.throws(boundary, { code: "AUTHORIZATION_CONTEXT_REQUIRED" });
      withAuthorizationContext(context("alpha"), () => {
        assert.throws(boundary, {
          code: "AUTHORIZATION_TENANT_CONTEXT_DENIED",
        });
        for (const ref of [
          beta,
          { ...alpha },
          { ...alpha, dbName: beta.dbName },
          otherAlpha,
        ])
          store.withTenant(ref, () =>
            assert.throws(boundary, {
              code: "AUTHORIZATION_TENANT_CONTEXT_DENIED",
            }),
          );
      });
      withAuthorizationContext(context("alpha", "old-generation"), () =>
        store.withTenant(alpha, () =>
          assert.throws(boundary, {
            code: "AUTHORIZATION_TENANT_CONTEXT_DENIED",
          }),
        ),
      );
    }
    assert.equal(
      selections,
      0,
      "denied access must not select or index any database",
    );
    const expiring = context("alpha");
    expiring.credential.expiresAtMs = Date.now() + 30;
    await withAuthorizationContext(expiring, () =>
      store.withTenant(alpha, async () => {
        await delay(60);
        assert.throws(() => store.db, {
          code: "AUTHORIZATION_CREDENTIAL_EXPIRED",
        });
      }),
    );
    assert.equal(selections, 0);
    await Promise.all(
      [alpha, beta].map((ref) =>
        withAuthorizationContext(context(ref.id), () =>
          store.withTenant(ref, async () => {
            await delay(ref.id === "alpha" ? 15 : 5);
            assert.equal(store.db.databaseName, ref.dbName);
            const rows = await store.sessions.find({}).toArray();
            assert.deepEqual(
              rows.map((row) => row._id),
              [ref.id],
            );
            await store.indexesReady();
            await store.mcpReady();
            assert.throws(
              () =>
                store.ensureTenantIndexes(
                  ref.id === "alpha" ? beta.dbName : alpha.dbName,
                ),
              { code: "AUTHORIZATION_TENANT_CONTEXT_DENIED" },
            );
          }),
        ),
      ),
    );
    // Trusted catalog identity work before tenant selection remains available.
    assert.equal(await store.tenantRegistry.countDocuments(), 2);
    assert.throws(() => store.db, { code: "AUTHORIZATION_CONTEXT_REQUIRED" });
  },
);

test(
  "enterprise registry never synthesizes the default tenant or accepts corrupt storage mappings",
  { timeout: 120_000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = enterpriseStore(mongo.getUri());
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await store.connect();
    await assert.rejects(store.resolveTenant("default"), {
      code: "TENANT_NOT_FOUND",
    });
    assert.deepEqual(await store.activeTenants(), []);
    for (const doc of [
      { ...document("missing-generation"), authorizationGeneration: undefined },
      {
        ...document("array-generation"),
        authorizationGeneration: ["tenant-g1"],
      },
      document("system-db", "admin"),
      document("case-alias", "Fixture_Alpha"),
      document("catalog-db", "catalog_fixture"),
      document("default", "wrong_default"),
      document("invalid-db", "database.with.dot"),
    ]) {
      await store.tenantRegistry.insertOne(doc as TenantDocument);
      await assert.rejects(store.resolveTenant(doc._id), {
        code: "TENANT_REGISTRY_INVALID",
      });
      await store.tenantRegistry.deleteOne({ _id: doc._id });
    }
    await store.tenantRegistry.insertOne(document("active"));
    await store.resolveTenant("active");
    await store.tenantRegistry.updateOne(
      { _id: "active" },
      { $set: { status: "disabled" } },
    );
    await assert.rejects(
      store.resolveTenant("active"),
      { code: "TENANT_DISABLED" },
      "enterprise resolution cannot reuse an active cache entry after disablement",
    );
    await assert.rejects(store.resolveTenant({ $ne: null } as any), {
      code: "TENANT_NOT_FOUND",
    });
    const disconnected = enterpriseStore(mongo.getUri());
    assert.throws(() => disconnected.db, {
      code: "AUTHORIZATION_CONTEXT_REQUIRED",
    });
  },
);
