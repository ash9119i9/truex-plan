import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { DEFAULT_LIMITS } from "../../src/config";
import { parseGoalSet, parseStartRun } from "../../src/contract";
import { AdapterError } from "../../src/errors";
import {
  COMPLETE,
  GOALS,
  OBJECTIVE,
  context,
  isContinuation,
  until,
} from "../support/goals";
import { Harness, completed, readSse } from "../support/harness";

// The goal endpoint and per-chat goal config (Task 3 of
// tasks/goal-mode-todo.md), on the pin. Codex runs the goal loop; the facts
// these tests rely on are in test/codex/goals-probe.test.ts.

type Body = Record<string, unknown>;

const toolNames = (body: Body): string[] =>
  ((body.tools ?? []) as Array<{ name?: string }>)
    .map((tool) => tool.name ?? "")
    .sort();

describe("goals (real Codex)", () => {
  const h = new Harness();
  before(() => h.start());
  after(() => h.close());
  beforeEach(() => {
    h.model.script.length = 0;
  });

  const putGoal = (chatId: string, body: Body) =>
    h.fetch(`/v1/chats/${chatId}/goal`, {
      method: "PUT",
      body: JSON.stringify({ tenantId: "tenant1", goals: GOALS, ...body }),
    });
  const getGoal = async (chatId: string) => {
    const res = await h.fetch(`/v1/chats/${chatId}/goal?tenantId=tenant1`);
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { goal: Body | null }).goal;
  };
  const clearGoal = async (chatId: string) => {
    const res = await h.fetch(`/v1/chats/${chatId}/goal?tenantId=tenant1`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { cleared: boolean }).cleared;
  };
  const code = async (res: Response) =>
    ((await res.json()) as { error: { code: string } }).error.code;
  const continuationsSince = (from: number) =>
    h.model.requests.slice(from).filter((r) => isContinuation(r.body));
  const goalStatus = async (chatId: string) => (await getGoal(chatId))?.status;

  test("a chat without goals is offered today's tools; a goal chat also gets the goal tools", async () => {
    const plain = await h.run(h.body({ chatId: "tools-off" }));
    assert.equal(completed(plain).status, "completed");
    assert.deepEqual(toolNames(h.model.lastRequest().body), ["update_plan"]);

    const goal = await h.run(h.body({ chatId: "tools-on", goals: GOALS }));
    assert.equal(completed(goal).status, "completed");
    assert.deepEqual(toolNames(h.model.lastRequest().body), [
      "create_goal",
      "get_goal",
      "update_goal",
      "update_plan",
    ]);
  });

  test("an active set on an idle chat answers the goal, and Codex starts a goal turn", async () => {
    const first = await h.run(h.body({ chatId: "idle", goals: GOALS }));
    const threadId = String(first[0]!.data.threadId);
    h.model.script.push(COMPLETE, { kind: "reply", text: "GOAL_DONE" });
    const from = h.model.requests.length;

    const res = await putGoal("idle", {
      status: "active",
      objective: OBJECTIVE,
      tokenBudget: 50_000,
      run: context(h.body({ chatId: "idle", threadId })),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const { goal } = (await res.json()) as { goal: Body };
    assert.equal(goal.objective, OBJECTIVE);
    assert.equal(goal.status, "active");
    assert.equal(goal.tokenBudget, 50_000);
    // The public shape: no Codex thread ID.
    assert.deepEqual(Object.keys(goal).sort(), [
      "createdAt",
      "objective",
      "status",
      "timeUsedSeconds",
      "tokenBudget",
      "tokensUsed",
      "updatedAt",
    ]);

    assert.ok(await until(() => continuationsSince(from).length > 0));
    assert.ok(
      JSON.stringify(continuationsSince(from)[0]!.body.input).includes(
        "GOAL_OBJECTIVE",
      ),
    );
    assert.ok(
      await until(async () => (await goalStatus("idle")) === "complete"),
    );
    assert.ok(await until(() => h.model.requests.length - from === 2));

    // The chat still takes an ordinary message afterwards.
    const next = await h.run(
      h.body({ chatId: "idle", threadId, goals: GOALS }),
    );
    assert.equal(completed(next).status, "completed");
  });

  test("an active set on a new chat starts its thread first and records it", async () => {
    h.model.script.push(COMPLETE, { kind: "reply", text: "GOAL_DONE" });
    const from = h.model.requests.length;
    const res = await putGoal("fresh", {
      status: "active",
      objective: OBJECTIVE,
      tokenBudget: 50_000,
      run: context(h.body({ chatId: "fresh" })),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(await until(() => continuationsSince(from).length > 0));
    assert.ok(
      await until(async () => (await goalStatus("fresh")) === "complete"),
    );
    assert.ok(await until(() => h.model.requests.length - from === 2));

    const record = JSON.parse(
      await readFile(
        join(h.stateDir, "t", "tenant1", "c", "fresh", "chat.json"),
        "utf8",
      ),
    ) as { threadId: string };
    const next = await h.run(
      h.body({ chatId: "fresh", threadId: record.threadId, goals: GOALS }),
    );
    assert.equal(completed(next).status, "completed");
    assert.equal(next[0]!.data.threadId, record.threadId);
  });

  test("a thread loaded without goals is reloaded with them before an active set", async () => {
    const first = await h.run(h.body({ chatId: "reload" }));
    const threadId = String(first[0]!.data.threadId);
    h.model.script.push(COMPLETE, { kind: "reply", text: "GOAL_DONE" });
    const from = h.model.requests.length;

    const res = await putGoal("reload", {
      status: "active",
      objective: OBJECTIVE,
      tokenBudget: 50_000,
      run: context(h.body({ chatId: "reload", threadId })),
    });
    assert.equal(res.status, 200, await res.clone().text());
    // Without the reload, Codex stores the goal and never runs it.
    assert.ok(await until(() => continuationsSince(from).length > 0, 10_000));
    assert.ok(
      toolNames(continuationsSince(from)[0]!.body).includes("update_goal"),
    );
    assert.ok(
      await until(async () => (await goalStatus("reload")) === "complete"),
    );
  });

  test("on an unloaded thread, pause, get and clear work and start nothing", async () => {
    const first = await h.run(h.body({ chatId: "cold", goals: GOALS }));
    assert.equal(completed(first).status, "completed");
    await h.restart();
    const from = h.model.requests.length;

    // GET starts a process that knows no maximum; the pause still gets it.
    assert.equal(await getGoal("cold"), null);
    const paused = await putGoal("cold", {
      status: "paused",
      objective: OBJECTIVE,
    });
    assert.equal(paused.status, 200, await paused.clone().text());
    const { goal } = (await paused.json()) as { goal: Body };
    assert.equal(goal.status, "paused");
    assert.equal(goal.objective, OBJECTIVE);
    assert.equal(goal.tokenBudget, GOALS.maxTokenBudget);
    assert.deepEqual(await getGoal("cold"), goal);

    assert.equal(await clearGoal("cold"), true);
    assert.equal(await getGoal("cold"), null);
    assert.equal(await clearGoal("cold"), false);
    // A pause with nothing to pause.
    const none = await putGoal("cold", { status: "paused" });
    assert.equal(none.status, 404);
    assert.equal(await code(none), "GOAL_NOT_FOUND");

    assert.equal(h.model.requests.length, from, "no turn ran");
  });

  test("an active set is refused while a run is active, and a run while an active set is loading", async () => {
    h.model.script.push({ kind: "hangAfterCreated" });
    const body = h.body({ chatId: "busy", goals: GOALS });
    const from = h.model.requests.length;
    const running = await h.post("/v1/runs", body);
    assert.equal(running.status, 200);
    // The run's turn is waiting on the model.
    assert.ok(await until(() => h.model.requests.length > from));
    const refused = await putGoal("busy", {
      status: "active",
      objective: OBJECTIVE,
      run: context(body),
    });
    assert.equal(refused.status, 409);
    assert.equal(await code(refused), "CHAT_BUSY");
    await h.stop(String(body.runId), { tenantId: "tenant1", chatId: "busy" });
    assert.equal(completed(await readSse(running)).status, "stopped");

    // A new chat: the active set must start the thread, so it is still
    // loading when the run arrives.
    h.model.script.push(COMPLETE, { kind: "reply", text: "GOAL_DONE" });
    const loading = h.manager.setGoal(
      parseGoalSet(
        "busy2",
        {
          tenantId: "tenant1",
          goals: GOALS,
          status: "active",
          objective: OBJECTIVE,
          tokenBudget: 50_000,
          run: context(h.body({ chatId: "busy2" })),
        },
        DEFAULT_LIMITS,
      ),
    );
    assert.throws(
      () =>
        h.manager.startRun(
          parseStartRun(h.body({ chatId: "busy2" }), DEFAULT_LIMITS),
        ),
      (error: unknown) =>
        error instanceof AdapterError && error.code === "CHAT_BUSY",
    );
    assert.equal((await loading).status, "active");
    assert.ok(
      await until(async () => (await goalStatus("busy2")) === "complete"),
    );
  });

  test("the idle sweep leaves a chat alone while a goal request is in flight", async () => {
    const first = await h.run(h.body({ chatId: "sweep", goals: GOALS }));
    assert.equal(completed(first).status, "completed");
    await h.restart();
    const ref = { tenantId: "tenant1", chatId: "sweep" };
    const reading = h.manager.getGoal(ref);
    await h.manager.sweep(Date.now() + 24 * 3600_000);
    const again = h.manager.getGoal(ref);
    assert.deepEqual(await Promise.all([reading, again]), [null, null]);
    // One chat, one Codex process: the sweep did not forget the chat.
    assert.equal(h.manager.stats.processes, 1);
  });

  test("a budget above the chat's maximum is refused before Codex is called", async () => {
    const from = h.model.requests.length;
    const processes = h.manager.stats.processes;
    const res = await putGoal("over", {
      status: "active",
      objective: OBJECTIVE,
      tokenBudget: GOALS.maxTokenBudget + 1,
      run: context(h.body({ chatId: "over" })),
    });
    assert.equal(res.status, 400);
    assert.equal(await code(res), "INVALID_REQUEST");
    assert.equal(h.manager.stats.processes, processes);
    assert.equal(h.model.requests.length, from);
  });
});
