import assert from "node:assert/strict";
import test from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../../src/store";
import { IdentityStore } from "../../src/identity";
test(
  "identity mutations fail closed on standalone Mongo without partial identity or audit writes",
  { timeout: 60_000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    t.after(() => mongo.stop());
    const store = new Store(mongo.getUri(), "identity_standalone");
    t.after(() => store.client.close());
    await store.connect();
    const s = new IdentityStore(store);
    await s.ensureIndexes();
    const actor = { kind: "human", id: "operator", generation: "g1" } as const;
    await assert.rejects(s.createPrincipal("service", actor), {
      status: 503,
      code: "TRANSACTIONS_UNAVAILABLE",
    });
    await assert.rejects(
      s.registerConnection(
        { _id: "broker", kind: "oidc", issuer: "https://broker.example" },
        actor,
      ),
      { status: 503, code: "TRANSACTIONS_UNAVAILABLE" },
    );
    assert.equal(await s.principals.countDocuments({}), 0);
    assert.equal(await s.connections.countDocuments({}), 0);
    assert.equal(await s.audit.countDocuments({}), 0);
  },
);
