import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../src/store";
import { AutomationStore } from "../src/automation/store";
import { AutomationExecution } from "../src/automation/execution";
import { userContext } from "../src/user";
import { ApiError } from "../src/errors";
const recipe = {
  name: "Report",
  agentId: "agent",
  prompt: "Read report",
  trigger: {
    kind: "interval",
    everyMs: 60000,
    anchorAt: "2026-10-09T00:00:00.000Z",
    timeZone: "UTC",
  },
};
test(
  "execution: receipt uncertainty fenced; exact result succeeds; per-run blocker leaves recurrence enabled",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(mongo.getUri(), "execution_test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    const d = await db.create("owner", recipe);
    await db.control(d.id, "owner", 1, "enable");
    let submitted = 0,
      lost = true;
    const platform = {
      hosts: ["http://localhost:4100"],
      configuration: async () => ({ cwd: "/tmp", config: {}, model: "test" }),
      call: async (
        _host: string,
        _path: string,
        _method: string,
        config: any,
      ) => {
        assert.equal(config.automationPolicy.automationId, d.id);
        return {
          threadId: "thread",
          automationPolicyVersion: 1,
          automationPolicy: config.automationPolicy,
        };
      },
      owned: async (_session: any, path: string) => {
        if (path === "/turns") {
          submitted++;
          if (lost) throw new ApiError(503, "lost", "OWNER_UNAVAILABLE");
          return { turnId: "root" };
        }
        return {};
      },
      ingest: async () => {},
      project: async () => {},
    };
    const execution = new AutomationExecution(db, platform as any);
    const first = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "manual",
      requestKey: "one",
      workflowId: "one",
    });
    await userContext.run(
      { id: "owner", email: "owner@dev.local", role: "user" },
      () => execution.dispatch(first.id),
    );
    assert.equal((await db.run(first.id))?.outcome, "unknown");
    await execution.dispatch(first.id);
    assert.equal(submitted, 1);
    const second = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "scheduled",
      scheduledAt: new Date().toISOString(),
      requestKey: "two",
      workflowId: "two",
    });
    assert.equal(second.reason, "previous_run_active");
    await db.runs.updateOne(
      { _id: first.id },
      {
        $set: {
          turnId: "root",
          runtimeTerminal: "completed",
          stopState: "stopped",
          resultSeen: true,
          resultRef: {
            id: "result",
            kind: "result",
            ownerId: "owner",
            tenantId: "default",
          },
        },
      },
    );
    await store.messages.insertOne({
      _id: "result",
      sessionId: `sess_auto_${first.id}`,
      role: "assistant",
      text: "Report",
      at: new Date().toISOString(),
    });
    assert.equal((await execution.observe(first.id)).terminal, true);
    assert.equal((await db.run(first.id))?.outcome, "succeeded");
    lost = false;
    const third = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "scheduled",
      scheduledAt: new Date().toISOString(),
      requestKey: "three",
      workflowId: "three",
    });
    await execution.dispatch(third.id);
    await db.runs.updateOne(
      { _id: third.id },
      {
        $set: {
          blocker: "approval_required",
          runtimeTerminal: "interrupted",
          stopState: "stopped",
        },
      },
    );
    await execution.observe(third.id);
    assert.equal((await db.run(third.id))?.outcome, "failed");
    assert.equal((await db.get(d.id, "owner"))?.status, "enabled");
    const fourth = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "scheduled",
      scheduledAt: new Date().toISOString(),
      requestKey: "four",
      workflowId: "four",
    });
    assert.equal(fourth.status, "accepted");
    assert.notEqual(fourth.id, third.id);
  },
);

test(
  "execution rechecks project access after provision and preserves cancellation across late receipt",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(mongo.getUri(), "execution_races").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    let projectChecks = 0,
      submitted = 0,
      revoke = true;
    let accepted: (() => void) | undefined;
    let receipt: Promise<void> | undefined;
    const platform = {
      hosts: ["http://localhost:4100"],
      configuration: async () => ({ cwd: "/tmp", config: {}, model: "test" }),
      project: async () => {
        if (++projectChecks > 1 && revoke)
          throw new ApiError(403, "Project access revoked", "ACCESS_REVOKED");
      },
      call: async (
        _host: string,
        _path: string,
        _method: string,
        config: any,
      ) => ({
        threadId: "thread",
        automationPolicyVersion: 1,
        automationPolicy: config.automationPolicy,
      }),
      owned: async (_session: any, path: string) => {
        if (path === "/turns") {
          submitted++;
          accepted?.();
          await receipt;
          return { turnId: "root" };
        }
        return {};
      },
      ingest: async () => {},
    };
    const execution = new AutomationExecution(db, platform as any);
    const d = await db.create("owner", { ...recipe, projectId: "project" });
    await db.control(d.id, "owner", 1, "enable");
    const first = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "manual",
      requestKey: "revoked",
      workflowId: "revoked",
    });
    await execution.dispatch(first.id);
    assert.equal(
      submitted,
      0,
      "revoked project cannot receive a turn after provisioning",
    );
    assert.equal((await db.run(first.id))?.reason, "access_revoked");
    assert.equal((await db.run(first.id))?.stopState, "not_started");
    revoke = false;
    const second = await db.admit({
      automationId: d.id,
      revision: 1,
      source: "manual",
      requestKey: "late",
      workflowId: "late",
    });
    let release!: () => void;
    receipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nativeAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const dispatch = execution.dispatch(second.id);
    await nativeAccepted;
    await db.requestStop(second.id, "user_cancelled");
    release();
    await dispatch;
    const late = await db.run(second.id);
    assert.equal(late?.status, "cancellation_requested");
    assert.equal(late?.stopState, "stop_requested");
    assert.equal(late?.turnId, "root");
    assert.equal(late?.dispatchState, "accepted");
    assert.equal((await db.get(d.id, "owner"))?.activeRunId, second.id);
  },
);
