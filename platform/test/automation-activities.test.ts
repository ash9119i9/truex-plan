import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { AutomationStore } from "../src/automation/store";
import { createAutomationActivities } from "../src/automation/activities";

test(
  "native Activity attempts are idempotent, separate retries from polls, and exclude input payloads",
  { timeout: 30000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(
      mongo.getUri(),
      "automation_attempts",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    const definition = await db.create("owner", {
      name: "Attempt audit",
      agentId: "agent",
      prompt: "private recipe text",
      trigger: {
        kind: "interval",
        everyMs: 60000,
        anchorAt: "2026-10-09T00:00:00.000Z",
        timeZone: "UTC",
      },
    });
    await db.control(definition.id, "owner", 1, "enable");
    const platform = new PlatformService(store);
    let info = {
      activityId: "1",
      attempt: 1,
      workflowExecution: { workflowId: "workflow", runId: "native_run" },
      privatePayload: "private activity text",
    };
    const activities = createAutomationActivities(store, platform, () => info);
    const input = {
      tenantId: "default",
      automationId: definition.id,
      revision: 1,
      controlVersion: 2,
      trigger: "manual" as const,
      requestId: "request",
      workflowId: "workflow",
      workflowRunId: "native_run",
    };
    const first = await activities.admitOccurrence(input);
    assert.ok(first);
    await activities.admitOccurrence(input);
    info = { ...info, attempt: 2 };
    await activities.admitOccurrence(input);
    info = { ...info, activityId: "2", attempt: 1 };
    const reference = {
      tenantId: "default",
      automationId: definition.id,
      runId: first.runId,
    };
    await activities.observeRun(reference);
    info = { ...info, activityId: "3" };
    await activities.observeRun(reference);
    const events = await db.ledger
      .find({ runId: first.runId, type: "activity.attempt" })
      .sort({ "detail.activityId": 1, "detail.attempt": 1 })
      .toArray();
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((event) => [
        event.detail?.operation,
        event.detail?.activityId,
        event.detail?.attempt,
      ]),
      [
        ["admitOccurrence", "1", 1],
        ["admitOccurrence", "1", 2],
        ["observeRun", "2", 1],
        ["observeRun", "3", 1],
      ],
    );
    assert.ok(
      events.every(
        (event) =>
          event.detail?.workflowRunId === "native_run" &&
          event.detail?.phase === "started",
      ),
    );
    assert.equal(JSON.stringify(events).includes("private"), false);
    await t.test(
      "stop still proceeds when its attempt audit fails, retaining incomplete evidence",
      async () => {
        const original = AutomationStore.prototype.append;
        AutomationStore.prototype.append = async function (event, session) {
          if (event.type === "activity.attempt")
            throw new Error("attempt audit unavailable");
          return original.call(this, event, session);
        };
        info = { ...info, activityId: "4" };
        try {
          await assert.rejects(
            activities.stopRun({ ...reference, reason: "cancelled" }),
            /attempt audit unavailable/,
          );
        } finally {
          AutomationStore.prototype.append = original;
        }
        const stopped = await db.run(first.runId);
        assert.equal(stopped?.outcome, "cancelled");
        assert.equal(stopped?.stopState, "not_started");
        assert.equal(stopped?.auditComplete, false);
        assert.equal(stopped?.auditLost, true);
        assert.equal(
          (await db.get(definition.id, "owner"))?.auditBlocked,
          true,
        );
      },
    );
  },
);
