import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { AutomationTemporalClient } from "../src/automation/temporal";
import type {
  AutomationActivities,
  AutomationOccurrenceInput,
} from "../src/automation/workflows";

Runtime.install({ logger: new DefaultLogger("ERROR") });
let environment: TestWorkflowEnvironment;
let adapter: AutomationTemporalClient;
const taskQueue = `automation-test-${randomUUID()}`;
before(async () => {
  environment = await TestWorkflowEnvironment.createLocal({
    server: { executable: { type: "cached-download", version: "v1.9.1" } },
  });
  adapter = new AutomationTemporalClient(environment.client, taskQueue);
});
after(async () => {
  await environment?.teardown();
});
const interval = {
  kind: "interval" as const,
  everyMs: 60_000,
  anchorAt: "2026-10-09T08:07:12.000Z",
  timeZone: "Asia/Kolkata",
};
const calendar = {
  kind: "calendar" as const,
  weekdays: [0],
  localTime: "02:30",
  timeZone: "America/New_York",
};
const input: AutomationOccurrenceInput = {
  tenantId: "isolated-test",
  automationId: "synthetic-only",
  revision: 1,
  controlVersion: 1,
  trigger: "manual",
};
async function worker(activities: AutomationActivities) {
  return Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("../src/automation/workflows"),
    activities,
  });
}

test("native matching-times preview preserves interval anchor and DST gap/repeated instants", async () => {
  const preview = await adapter.preview(interval, "2026-10-09T08:08:00Z");
  assert.equal(preview.length, 5);
  assert.equal(preview[0], "2026-10-09T08:08:12.000Z");
  assert.ok(
    preview.every(
      (time) =>
        (new Date(time).getTime() - new Date(interval.anchorAt).getTime()) %
          interval.everyMs ===
        0,
    ),
  );
  const gap = await adapter.preview(calendar, "2027-03-13T00:00:00Z");
  assert.equal(gap[0], "2027-03-21T06:30:00.000Z");
  const repeated = await adapter.preview(
    { ...calendar, localTime: "01:30" },
    "2027-11-06T00:00:00Z",
  );
  assert.deepEqual(repeated.slice(0, 2), [
    "2027-11-07T05:30:00.000Z",
    "2027-11-07T06:30:00.000Z",
  ]);
});

test("native control CAS converges across clients and ignores delayed stale edits", async () => {
  const control = {
    tenantId: "isolated-test",
    automationId: randomUUID(),
    revision: 1,
    controlVersion: 1,
    enabled: false,
    trigger: interval,
  };
  await adapter.sync(control);
  const other = new AutomationTemporalClient(environment.client, taskQueue);
  await Promise.all([
    adapter.sync({ ...control, controlVersion: 2, enabled: true }),
    other.sync({
      ...control,
      controlVersion: 3,
      enabled: false,
      trigger: calendar,
    }),
  ]);
  const stale = await adapter.sync({
    ...control,
    controlVersion: 2,
    enabled: true,
  });
  assert.equal(stale.appliedVersion, 3);
  const handle = environment.client.schedule.getHandle(
    adapter.scheduleId(control.tenantId, control.automationId),
  );
  const description = await handle.describe();
  assert.equal(description.state.paused, true);
  assert.equal(description.spec.timezone, calendar.timeZone);
  assert.equal(description.policies.pauseOnFailure, false);
  assert.equal(description.policies.catchupWindow, 600_000);
  assert.equal(description.policies.overlap, "ALLOW_ALL");
  await handle.delete();
});

test("a real native Schedule starts a finite Workflow with exact nominal-time metadata and replayable history", async () => {
  let nominalTime: string | undefined;
  let dispatches = 0;
  const control = {
    tenantId: "isolated-test",
    automationId: randomUUID(),
    revision: 1,
    controlVersion: 1,
    enabled: false,
    trigger: interval,
  };
  await adapter.sync(control);
  const schedule = environment.client.schedule.getHandle(
    adapter.scheduleId(control.tenantId, control.automationId),
  );
  const w = await worker({
    async admitOccurrence(args) {
      nominalTime = args.scheduledAt;
      return { runId: args.workflowId, executionTimeoutMs: 10_000 };
    },
    async dispatchRun() {
      dispatches++;
    },
    async observeRun() {
      return { terminal: true };
    },
    async stopRun() {
      assert.fail("unexpected stop");
    },
  });
  await w.runUntil(async () => {
    await schedule.backfill({
      start: new Date("2026-10-09T08:08:00Z"),
      end: new Date("2026-10-09T08:08:30Z"),
    });
    let workflowId: string | undefined;
    for (let count = 0; count < 100; count++) {
      workflowId = (await schedule.describe()).info.recentActions[0]?.action
        .workflow?.workflowId;
      if (workflowId) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(workflowId, "native Schedule must emit the Workflow");
    const handle = environment.client.workflow.getHandle(workflowId);
    assert.deepEqual(await handle.result(), { runId: workflowId });
    assert.equal(nominalTime, "2026-10-09T08:08:12.000Z");
    assert.equal(dispatches, 1);
    await Worker.runReplayHistory(
      { workflowsPath: require.resolve("../src/automation/workflows") },
      await handle.fetchHistory(),
    );
  });
  assert.equal((await schedule.describe()).state.paused, true);
  await schedule.delete();
});

test("deadline, cancellation and dispatch ambiguity invoke safe termination once", async () => {
  const stopped: string[] = [];
  let mode: "timeout" | "cancel" | "error" = "timeout";
  const w = await worker({
    async admitOccurrence(args) {
      return {
        runId: args.workflowId,
        executionTimeoutMs: mode === "timeout" ? 20 : 10_000,
      };
    },
    async dispatchRun() {
      if (mode === "error") throw new Error("synthetic lost receipt");
    },
    async observeRun() {
      return { terminal: false };
    },
    async stopRun(args) {
      stopped.push(args.reason);
    },
  });
  await w.runUntil(async () => {
    for (const next of ["timeout", "cancel", "error"] as const) {
      mode = next;
      const workflowId = `synthetic-${randomUUID()}`;
      await adapter.start(input, workflowId);
      if (next === "cancel") await adapter.cancel(workflowId);
      await environment.client.workflow.getHandle(workflowId).result();
    }
  });
  assert.deepEqual(stopped, [
    "execution_timeout",
    "cancelled",
    "infrastructure_error",
  ]);
});

test("worker restart resumes observation of the same run without repeating admission or dispatch", async () => {
  const workflowId = `synthetic-restart-${randomUUID()}`;
  let admissions = 0;
  let dispatches = 0;
  let sawObservation!: () => void;
  const observed = new Promise<void>((resolve) => {
    sawObservation = resolve;
  });
  let canComplete = false;
  const activities: AutomationActivities = {
    async admitOccurrence(args) {
      admissions++;
      return { runId: args.workflowId, executionTimeoutMs: 20_000 };
    },
    async dispatchRun() {
      dispatches++;
    },
    async observeRun() {
      sawObservation();
      return { terminal: canComplete };
    },
    async stopRun() {
      assert.fail("restart must preserve the observing workflow");
    },
  };
  const first = await worker(activities);
  const running = first.run();
  await adapter.start(input, workflowId);
  await adapter.start(input, workflowId);
  await observed;
  first.shutdown();
  await running;
  canComplete = true;
  const second = await worker(activities);
  await second.runUntil(() =>
    environment.client.workflow.getHandle(workflowId).result(),
  );
  assert.equal(admissions, 1);
  assert.equal(dispatches, 1);
});

test("failed business occurrences keep recurrence enabled and the next occurrence has a distinct identity", async () => {
  const identities = new Set<string>();
  const outcomes: string[] = [];
  const control = {
    tenantId: "isolated-test",
    automationId: randomUUID(),
    revision: 1,
    controlVersion: 1,
    enabled: true,
    trigger: { ...interval, everyMs: 86_400_000 },
  };
  await adapter.sync(control);
  const schedule = environment.client.schedule.getHandle(
    adapter.scheduleId(control.tenantId, control.automationId),
  );
  const w = await worker({
    async admitOccurrence(args) {
      identities.add(args.workflowId);
      return { runId: args.workflowId, executionTimeoutMs: 10_000 };
    },
    async dispatchRun() {
      outcomes.push(
        outcomes.length === 0 ? "approval_required" : "dependency_unavailable",
      );
    },
    async observeRun() {
      return { terminal: true };
    },
    async stopRun() {
      assert.fail("already confirmed stop");
    },
  });
  await w.runUntil(async () => {
    for (const date of ["2026-10-09", "2026-10-10"]) {
      await schedule.backfill({
        start: new Date(`${date}T08:07:00Z`),
        end: new Date(`${date}T08:07:30Z`),
      });
      for (let count = 0; count < 100; count++) {
        if (identities.size === (date.endsWith("09") ? 1 : 2)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const workflowId = [...identities].at(-1)!;
      await environment.client.workflow.getHandle(workflowId).result();
      assert.equal((await schedule.describe()).state.paused, false);
    }
  });
  assert.equal(identities.size, 2);
  assert.deepEqual(outcomes, ["approval_required", "dependency_unavailable"]);
  await schedule.delete();
});

test("run deadline requests stop while dispatch or observation is still in flight", async () => {
  let stage: "dispatch" | "observe" = "dispatch";
  let stageCompleted = false;
  const stoppedBeforeCompletion: boolean[] = [];
  const w = await worker({
    async admitOccurrence(args) {
      return { runId: args.workflowId, executionTimeoutMs: 80 };
    },
    async dispatchRun() {
      if (stage === "dispatch") {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        stageCompleted = true;
      }
    },
    async observeRun() {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      stageCompleted = true;
      return { terminal: false };
    },
    async stopRun(args) {
      assert.equal(args.reason, "execution_timeout");
      stoppedBeforeCompletion.push(!stageCompleted);
    },
  });
  await w.runUntil(async () => {
    for (const next of ["dispatch", "observe"] as const) {
      stage = next;
      stageCompleted = false;
      const workflowId = `synthetic-inflight-${randomUUID()}`;
      await adapter.start(input, workflowId);
      await environment.client.workflow.getHandle(workflowId).result();
      // Let the synthetic native operation settle before switching the shared test stage.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    }
  });
  assert.deepEqual(stoppedBeforeCompletion, [true, true]);
});

test("a repeated manual start after completion retains the original Workflow execution", async () => {
  const workflowId = `synthetic-completed-${randomUUID()}`;
  const w = await worker({
    async admitOccurrence(args) {
      return { runId: args.workflowId, executionTimeoutMs: 10_000 };
    },
    async dispatchRun() {},
    async observeRun() {
      return { terminal: true };
    },
    async stopRun() {
      assert.fail("unexpected stop");
    },
  });
  await w.runUntil(async () => {
    await adapter.start(input, workflowId);
    await environment.client.workflow.getHandle(workflowId).result();
    const original = await environment.client.workflow
      .getHandle(workflowId)
      .describe();
    await adapter.start(input, workflowId);
    assert.equal(
      (await environment.client.workflow.getHandle(workflowId).describe())
        .runId,
      original.runId,
    );
  });
});

test("native resume skips paused slots instead of backfilling them", async () => {
  // Sub-minute cadence is isolated synthetic probing only; product validation requires >= one minute.
  const anchorAt = new Date(
    Math.floor(Date.now() / 1_000) * 1_000,
  ).toISOString();
  const control = {
    tenantId: "isolated-test",
    automationId: randomUUID(),
    revision: 1,
    controlVersion: 1,
    enabled: false,
    trigger: { ...interval, anchorAt, everyMs: 1_000 },
  };
  await adapter.sync(control);
  const handle = environment.client.schedule.getHandle(
    adapter.scheduleId(control.tenantId, control.automationId),
  );
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal((await handle.describe()).info.numActionsTaken, 0);
  const resumedAfter = Math.floor(Date.now() / 1_000) * 1_000;
  await adapter.sync({ ...control, controlVersion: 2, enabled: true });
  for (let count = 0; count < 50; count++) {
    if ((await handle.describe()).info.numActionsTaken > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await adapter.sync({ ...control, controlVersion: 3, enabled: false });
  const description = await handle.describe();
  assert.ok(description.info.recentActions.length > 0);
  assert.ok(
    description.info.recentActions.every(
      (action) => action.scheduledAt.getTime() >= resumedAfter,
    ),
  );
  assert.equal(description.info.numActionsMissedCatchupWindow, 0);
  await handle.delete();
});

test("disk-backed native server restart preserves Schedule and resumes the same Workflow execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "truex-temporal-durable-"));
  const dbFilename = join(directory, "temporal.sqlite");
  let local: TestWorkflowEnvironment | undefined;
  let activeWorker: Worker | undefined;
  let activeRun: Promise<void> | undefined;
  const queue = `durable-synthetic-${randomUUID()}`;
  const workflowId = `synthetic-durable-${randomUUID()}`;
  let admissions = 0;
  let dispatches = 0;
  let observed!: () => void;
  const firstObservation = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let complete = false;
  const activities: AutomationActivities = {
    async admitOccurrence(args) {
      admissions++;
      return { runId: args.workflowId, executionTimeoutMs: 60_000 };
    },
    async dispatchRun() {
      dispatches++;
    },
    async observeRun() {
      observed();
      return { terminal: complete };
    },
    async stopRun() {
      assert.fail("restart must retain the observing execution");
    },
  };
  const server = {
    dbFilename,
    executable: { type: "cached-download" as const, version: "v1.9.1" },
  };
  try {
    local = await TestWorkflowEnvironment.createLocal({ server });
    const firstAdapter = new AutomationTemporalClient(local.client, queue);
    const control = {
      tenantId: "isolated-test",
      automationId: randomUUID(),
      revision: 1,
      controlVersion: 1,
      enabled: false,
      trigger: interval,
    };
    await firstAdapter.sync(control);
    activeWorker = await Worker.create({
      connection: local.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve("../src/automation/workflows"),
      activities,
    });
    activeRun = activeWorker.run();
    await firstAdapter.start(input, workflowId);
    await Promise.race([
      firstObservation,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("durable Workflow did not reach observation")),
          20_000,
        );
        timer.unref();
      }),
    ]);
    activeWorker.shutdown();
    await activeRun;
    activeWorker = undefined;
    activeRun = undefined;
    const before = await local.client.workflow.getHandle(workflowId).describe();
    assert.equal(before.status.name, "RUNNING");
    assert.ok(
      (await stat(dbFilename)).size > 0,
      "native server must write actual persistent storage",
    );
    await local.teardown();
    local = undefined;
    // New process and connections, same durable database; no replayed native dispatch.
    local = await TestWorkflowEnvironment.createLocal({ server });
    const restoredAdapter = new AutomationTemporalClient(local.client, queue);
    const after = await local.client.workflow.getHandle(workflowId).describe();
    assert.equal(after.runId, before.runId);
    assert.equal(after.status.name, "RUNNING");
    const persistedSchedule = await local.client.schedule
      .getHandle(
        restoredAdapter.scheduleId(control.tenantId, control.automationId),
      )
      .describe();
    assert.equal(persistedSchedule.state.paused, true);
    assert.equal(persistedSchedule.state.note, "truex-control-version:1");
    complete = true;
    activeWorker = await Worker.create({
      connection: local.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve("../src/automation/workflows"),
      activities,
    });
    await activeWorker.runUntil(() =>
      local!.client.workflow.getHandle(workflowId).result(),
    );
    activeWorker = undefined;
    assert.equal(admissions, 1);
    assert.equal(dispatches, 1);
    await Worker.runReplayHistory(
      { workflowsPath: require.resolve("../src/automation/workflows") },
      await local.client.workflow.getHandle(workflowId).fetchHistory(),
    );
  } finally {
    if (activeWorker) {
      activeWorker.shutdown();
      await activeRun;
    }
    await local?.teardown();
    await rm(directory, { recursive: true, force: true });
  }
});
