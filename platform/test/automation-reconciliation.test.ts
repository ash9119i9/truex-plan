import assert from "node:assert/strict";
import test from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../src/store";
import { AutomationStore } from "../src/automation/store";
import { reconcileAutomations } from "../src/automation/reconciliation";
import { tenantContext } from "../src/tenant";

test(
  "disabled tenant recovery observes orphan evidence without starting new work",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(mongo.getUri(), "recovery_test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await store.tenantRegistry.insertOne({
      _id: "disabled",
      dbName: "disabled_recovery",
      status: "disabled",
      name: "Disabled",
      createdAt: new Date().toISOString(),
    } as any);
    let observed = 0,
      starts = 0;
    await tenantContext.run(
      { id: "disabled", dbName: "disabled_recovery" },
      async () => {
        const db = new AutomationStore(store);
        const d = await db.create("owner", {
          name: "Read report",
          agentId: "agent",
          prompt: "Read report",
          trigger: {
            kind: "interval",
            everyMs: 60000,
            anchorAt: "2026-10-09T00:00:00.000Z",
            timeZone: "UTC",
          },
        });
        await db.control(d.id, "owner", 1, "enable");
        const run = await db.admit({
          automationId: d.id,
          revision: 1,
          source: "manual",
          requestKey: "unknown",
          workflowId: "unknown",
        });
        await db.runs.updateOne(
          { _id: run.id },
          {
            $set: {
              status: "unknown",
              outcome: "unknown",
              stopState: "unknown",
              sessionId: "session",
            },
          },
        );
        await store.sessions.insertOne({
          _id: "session",
          userId: "owner",
        } as any);
      },
    );
    await reconcileAutomations(
      store,
      {
        ingest: async () => {
          observed++;
        },
      } as any,
      {
        sync: async () => {
          throw new Error("Disabled tenants must not sync/start");
        },
        start: async () => {
          starts++;
        },
      } as any,
    );
    assert.equal(observed, 1);
    assert.equal(starts, 0);
    await store.tenantRegistry.updateOne(
      { _id: "disabled" },
      { $set: { status: "active" } },
    );
    const outage = await reconcileAutomations(
      store,
      {
        ingest: async () => {
          observed++;
        },
      } as any,
      {
        sync: async () => {
          throw new Error("Temporal outage");
        },
        start: async () => {
          starts++;
        },
      } as any,
    );
    assert.equal(
      observed,
      2,
      "Temporal outage cannot prevent native evidence recovery",
    );
    assert.equal(outage.failures, 1);
    assert.equal(starts, 0);
  },
);
