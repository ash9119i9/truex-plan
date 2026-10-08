import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../src/store";
import { AutomationService } from "../src/automation/service";
import { AutomationExecution } from "../src/automation/execution";
import { userContext } from "../src/user";
import { automationRunsCsv } from "../src/automation/export";
const recipe = {
  name: "Report",
  agentId: "agent",
  prompt: "private prompt",
  trigger: {
    kind: "interval",
    everyMs: 60000,
    anchorAt: "2026-10-09T00:00:00.000Z",
    timeZone: "UTC",
  },
};
test(
  "automation API domain: explicit enable, version conflicts, manual idempotency, restricted ownership and CSV",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(
      mongo.getUri(),
      "automation_service",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const platform = {
      configuration: async () => ({ config: {}, cwd: "/tmp" }),
      project: async () => {},
    };
    const temporal = {
      sync: async (input: any) => ({
        appliedVersion: input.controlVersion,
        nextActionTimes: [],
        missedCatchupWindow: 0,
      }),
      start: async () => {},
      preview: async () => ["2026-10-09T01:00:00.000Z"],
      cancel: async () => {},
    };
    const service = new AutomationService(
      store,
      platform as any,
      temporal as any,
    );
    await userContext.run(
      { id: "owner", email: "owner@dev.local", role: "user" },
      async () => {
        const created = await service.create(recipe);
        assert.equal(created.status, "draft");
        await assert.rejects(
          service.runNow(created.id, { requestKey: "one", revision: 1 }),
        );
        const enabled = await service.control(created.id, {
          version: 1,
          action: "enable",
        });
        assert.equal(enabled.status, "enabled");
        const first = await service.runNow(created.id, {
          requestKey: "one",
          revision: 1,
        });
        const again = await service.runNow(created.id, {
          requestKey: "one",
          revision: 1,
        });
        assert.equal(first.id, again.id);
        await assert.rejects(
          service.runNow(created.id, { requestKey: "one", revision: 2 }),
        );
        await assert.rejects(service.edit(created.id, { version: 1, recipe }));
        const edited = await service.edit(created.id, {
          version: 2,
          recipe: { ...recipe, name: "New report" },
        });
        assert.equal(edited.status, "draft");
        const detail = await service.runDetails(created.id, first.id);
        assert.equal(detail.recipe.prompt, recipe.prompt);
        assert.equal(detail.run.revision, 1);
        const csv = await service.export(created.id, {});
        assert.equal(csv.includes("private prompt"), false);
      },
    );
    await userContext.run(
      { id: "other", email: "other@dev.local", role: "admin" },
      async () => {
        assert.equal((await service.list()).items.length, 0);
      },
    );
    assert.equal(
      automationRunsCsv([{ id: "=DANGEROUS()" } as any]).includes("'="),
      true,
    );
  },
);

test(
  "an explicit cancellation of a fenced failure survives a closed workflow and retries only native stop",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(
      mongo.getUri(),
      "automation_cancel_recovery",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    let interrupts = 0,
      signals = 0;
    const platform = {
      configuration: async () => ({ cwd: "/tmp" }),
      ingest: async () => {},
      owned: async (_session: unknown, path: string) => {
        assert.equal(
          path,
          "/interrupt",
          "stop recovery must never submit another prompt",
        );
        interrupts++;
        return {};
      },
    };
    const temporal = {
      sync: async (input: any) => ({
        appliedVersion: input.controlVersion,
        nextActionTimes: [],
      }),
      start: async () => {},
      cancel: async () => {
        signals++;
        throw new Error("Workflow execution already completed");
      },
    };
    const service = new AutomationService(
      store,
      platform as any,
      temporal as any,
    );
    await userContext.run(
      { id: "owner", email: "owner@dev.local", role: "user" },
      async () => {
        const definition = await service.create(recipe);
        await service.control(definition.id, { version: 1, action: "enable" });
        const run = await service.runNow(definition.id, {
          requestKey: "timeout",
          revision: 1,
        });
        await service.db.runs.updateOne(
          { _id: run.id },
          {
            $set: {
              sessionId: "session",
              dispatchState: "accepted",
              stopAttemptedAt: new Date().toISOString(),
            },
          },
        );
        await store.sessions.insertOne({
          _id: "session",
          userId: "owner",
        } as any);
        await service.db.finish(run.id, {
          status: "failed",
          outcome: "failed",
          reason: "execution_timeout",
          stopState: "unknown",
        });
        const cancelled = await service.cancel(definition.id, run.id);
        assert.equal(cancelled?.outcome, "failed");
        assert.equal(cancelled?.status, "failed");
        assert.equal(cancelled?.reason, "execution_timeout");
        assert.ok(cancelled?.cancellationRequestedAt);
        assert.equal(cancelled?.stopAttemptedAt, undefined);
        assert.equal(
          (await service.db.get(definition.id, "owner"))?.activeRunId,
          run.id,
        );
        const execution = new AutomationExecution(service.db, platform as any);
        await execution.observe(run.id);
        assert.equal(
          interrupts,
          1,
          "evidence recovery drives one renewed interrupt despite closed workflow",
        );
        await execution.observe(run.id);
        assert.equal(
          interrupts,
          1,
          "background polling does not repeatedly interrupt",
        );
        assert.equal(
          (await service.db.run(run.id))?.reason,
          "execution_timeout",
        );
        await service.db.finish(run.id, {
          status: "failed",
          outcome: "failed",
          reason: "execution_timeout",
          stopState: "stopped",
        });
        await service.cancel(definition.id, run.id);
        assert.equal(
          signals,
          1,
          "confirmed stop makes repeated cancellation idempotent",
        );
        assert.equal(interrupts, 1);
      },
    );
  },
);
