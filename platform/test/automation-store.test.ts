import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../src/store";
import { AutomationStore } from "../src/automation/store";
import { tenantContext } from "../src/tenant";

const recipe = {
  name: "Daily report",
  agentId: "assistant",
  prompt: "Summarize the permitted report",
  trigger: {
    kind: "interval",
    everyMs: 60000,
    anchorAt: "2026-10-09T00:00:00.000Z",
    timeZone: "UTC",
  },
  limits: { executionTimeoutMs: 1800000, latenessGraceMs: 600000 },
} as const;
test(
  "automation persistence: immutable revisions, atomic all-source fence, deduplicated audit and tenant boundaries",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(mongo.getUri(), "automation_test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    const definition = await db.create("owner", recipe);
    await db.control(definition.id, "owner", 1, "enable");
    const inputs = ["manual", "scheduled"].map((source, i) => ({
      automationId: definition.id,
      revision: 1,
      source,
      requestKey: `request-${i}`,
      workflowId: `workflow-${i}`,
      scheduledAt: new Date().toISOString(),
    }));
    const admitted = await Promise.all(
      inputs.map((input) => db.admit(input as any)),
    );
    assert.equal(admitted.filter((run) => run.status === "accepted").length, 1);
    assert.equal(
      admitted.filter((run) => run.reason === "previous_run_active").length,
      1,
    );
    const active = admitted.find((run) => run.status === "accepted")!;
    assert.equal(
      (
        await db.admit(
          inputs.find((x) => x.workflowId === active.workflowId) as any,
        )
      ).id,
      active.id,
    );
    await db.finish(active.id, {
      status: "unknown",
      outcome: "unknown",
      reason: "receipt_lost",
      stopState: "unknown",
    });
    const fenced = await db.admit({
      ...inputs[0],
      requestKey: "third",
      workflowId: "third",
    } as any);
    assert.equal(fenced.reason, "previous_run_active");
    assert.equal((await db.get(definition.id, "owner"))?.status, "enabled");
    await db.append({
      id: "safe-event",
      automationId: definition.id,
      runId: active.id,
      tenantId: "default",
      ownerId: "owner",
      type: "run.observed",
      at: new Date().toISOString(),
      detail: { attempt: 1 },
    } as any);
    await db.append({
      id: "safe-event",
      automationId: definition.id,
      runId: active.id,
      tenantId: "default",
      ownerId: "owner",
      type: "run.observed",
      at: new Date().toISOString(),
      detail: { attempt: 1 },
    } as any);
    assert.equal(
      (await db.events(definition.id, "owner", active.id)).filter(
        (e) => e.id === "safe-event",
      ).length,
      1,
    );
    await assert.rejects(
      db.append({
        id: "unsafe-event",
        automationId: definition.id,
        runId: active.id,
        tenantId: "default",
        ownerId: "owner",
        type: "run.observed",
        at: new Date().toISOString(),
        detail: { token: "secret" },
      } as any),
    );
    assert.equal(await db.get(definition.id, "other"), null);
    await tenantContext.run(
      { id: "other", dbName: "automation_other" },
      async () => {
        await store.indexesReady();
        assert.equal(await db.get(definition.id, "owner"), null);
      },
    );
    await db.control(definition.id, "owner", 2, "pause");
    const stale = await db.admit({
      ...inputs[0],
      requestKey: "stale",
      workflowId: "stale",
    } as any);
    assert.equal(stale.reason, "stale_revision");
  },
);
test(
  "dispatch and cancellation claims serialize with controls and never release a live fence",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(
      mongo.getUri(),
      "automation_claims",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    const d = await db.create("owner", recipe);
    await db.control(d.id, "owner", 1, "enable");
    const run = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "manual",
      requestKey: "claim",
      workflowId: "claim",
      controlVersion: 2,
    });
    await db.runs.updateOne(
      { _id: run.id },
      { $set: { provisionState: "accepted", sessionId: "session" } },
    );
    assert.equal(await db.claimDispatch(run.id), true);
    const stopped = await db.requestStop(run.id, "user_cancelled");
    assert.equal(stopped?.dispatched, true);
    assert.equal((await db.get(d.id, "owner"))?.activeRunId, run.id);
    assert.equal((await db.run(run.id))?.stopState, "stop_requested");
    await db.finish(run.id, {
      status: "cancelled",
      outcome: "cancelled",
      reason: "user_cancelled",
      stopState: "stopped",
    });
    const stale = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "manual",
      requestKey: "stale",
      workflowId: "stale",
      controlVersion: 2,
    });
    await db.control(d.id, "owner", 2, "pause");
    assert.equal(await db.claimDispatch(stale.id), false);
    const before = await db.requestStop(stale.id, "user_cancelled");
    assert.equal(before?.dispatched, false);
    assert.equal(await db.claimDispatch(stale.id), false);
  },
);
test(
  "late dispatch cannot bypass schedule grace after activity queue or provision delay",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(mongo.getUri(), "automation_late").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    const d = await db.create("owner", recipe);
    await db.control(d.id, "owner", 1, "enable");
    const run = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "scheduled",
      requestKey: "late",
      workflowId: "late",
      controlVersion: 2,
      scheduledAt: new Date().toISOString(),
    });
    await db.runs.updateOne(
      { _id: run.id },
      { $set: { scheduledAt: new Date(Date.now() - 700000).toISOString() } },
    );
    assert.equal(await db.claimDispatch(run.id), false);
    assert.equal((await db.run(run.id))?.reason, "schedule_window_elapsed");
    assert.equal((await db.get(d.id, "owner"))?.activeRunId, undefined);
  },
);

test(
  "confirmed termination releases a failed fence without replacing its business outcome",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(
      mongo.getUri(),
      "automation_failed_stop",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    const d = await db.create("owner", recipe);
    await db.control(d.id, "owner", 1, "enable");
    const run = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "manual",
      requestKey: "failed",
      workflowId: "failed",
    });
    assert.equal(await db.claimDispatch(run.id), true);
    await db.finish(run.id, {
      status: "failed",
      outcome: "failed",
      reason: "approval_required",
      stopState: "unknown",
    });
    assert.equal(
      (await db.events(d.id, "owner", run.id)).some((e) => e.expiresAt),
      false,
    );
    await db.requestStop(run.id, "user_cancelled");
    // Native evidence arrives before the outcome observer's cleanup transaction.
    await db.runs.updateOne(
      { _id: run.id },
      { $set: { stopState: "stopped" } },
    );
    await db.finish(run.id, {
      status: "cancelled",
      outcome: "cancelled",
      reason: "user_cancelled",
      stopState: "stopped",
    });
    const final = await db.run(run.id);
    assert.equal(final?.outcome, "failed");
    assert.equal(final?.status, "failed");
    assert.equal(final?.reason, "approval_required");
    assert.equal(final?.stopState, "stopped");
    assert.equal((await db.get(d.id, "owner"))?.activeRunId, undefined);
    assert.ok(final?.auditRetainedUntil);
  },
);
