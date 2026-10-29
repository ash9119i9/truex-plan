import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DEFAULT_LIMITS } from "../../src/config";
import { goalRunId, parseStartRun } from "../../src/contract";
import { AdapterError } from "../../src/errors";
import { RuntimeManager } from "../../src/runtime/manager";
import type { Run, RunEvent } from "../../src/runtime/run";
import {
  replyText,
  turnCompleted,
  turnStarted,
  writeFakeCodex,
  type FakeScript,
  type Step,
} from "../support/fake-codex";
import { sleep } from "../support/model-fixture";

// Which run owns a lead turn (Task 4 of tasks/goal-mode-todo.md), for the
// orderings the real pin cannot be made to produce on demand. A scripted
// fake app-server stands in for Codex; test/codex/goal-runs.test.ts covers
// the same paths on the pin where its timing allows.

const TH = "01a18344-0000-7000-8000-000000000001";
const REF = { tenantId: "tenant1", chatId: "chat1" };
const GOALS = { maxTokenBudget: 200_000 };
const GOAL_AT = 1_700_000_000;

// Codex's goal, and its update notification (turnId null: not from a turn).
const goal = (status: string) => ({
  threadId: TH,
  objective: "GOAL",
  status,
  tokenBudget: 50_000,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: GOAL_AT,
  updatedAt: GOAL_AT,
});
const goalUpdated = (status: string): Step => ({
  notify: "thread/goal/updated",
  params: { threadId: TH, turnId: null, goal: goal(status) },
});

describe("lead turn ownership (scripted Codex)", () => {
  let root = "";
  let manager: RuntimeManager | undefined;
  const logs: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "runtime-adapter-turns-"));
    logs.length = 0;
  });
  afterEach(async () => {
    await manager?.drain(0);
    manager = undefined;
    await rm(root, { recursive: true, force: true });
  });

  // A manager on the fake, for a chat whose thread already exists (so a run
  // resumes it). `record` adds to the chat's chat.json.
  async function start(
    script: FakeScript,
    record: Record<string, unknown> = {},
  ): Promise<RuntimeManager> {
    const chatDir = join(root, "state", "t", REF.tenantId, "c", REF.chatId);
    await mkdir(chatDir, { recursive: true });
    await writeFile(
      join(chatDir, "chat.json"),
      JSON.stringify({ threadId: TH, ...record }),
    );
    manager = new RuntimeManager(
      {
        stateDir: join(root, "state"),
        codexBinary: await writeFakeCodex(root, script, join(root, "rpc.log")),
        maxProcesses: 2,
        idleMs: 60_000,
        limits: DEFAULT_LIMITS,
      },
      (event) => logs.push(event),
    );
    return manager;
  }

  const member = (goals = true) =>
    parseStartRun(
      {
        runId: "run-member",
        ...REF,
        threadId: TH,
        input: { text: "hello", clientMessageId: "msg-1" },
        agentPrompt: "You are a helpful assistant.",
        model: {
          modelName: "fixture-model",
          gatewayUrl: "http://127.0.0.1:9/v1",
          gatewayToken: "fixture-gateway-token-0123456789abcdef",
          contextWindow: 100_000,
          autoCompactTokenLimit: 80_000,
        },
        ...(goals ? { goals: GOALS } : {}),
      },
      DEFAULT_LIMITS,
    );

  const outcome = (run: Run) =>
    new Promise<RunEvent[]>((resolve) => {
      const events: RunEvent[] = [];
      run.subscribe(0, {
        send: (event) => events.push(event),
        end: () => resolve(events),
      });
    });
  const completedOf = (events: RunEvent[]) => events.at(-1)!.data;
  // The requests the fake read, in order.
  const rpcLog = async () =>
    (await readFile(join(root, "rpc.log"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: Record<string, unknown>;
            answering?: string;
          },
      );
  const texts = (events: RunEvent[]) =>
    (completedOf(events).items as Array<{ text?: string }>).map((i) => i.text);
  const chatEvents = (m: RuntimeManager) => {
    const events: RunEvent[] = [];
    const stream = m.chatEvents(REF);
    // Reads from this stream's start, so no snapshot comes first.
    stream.subscribe(
      { streamId: stream.id, after: 0 },
      {
        send: (event) => events.push(event),
        end: () => undefined,
      },
    );
    return events;
  };
  const goalRun = async (m: RuntimeManager, turnId: string) => {
    for (let i = 0; i < 100; i++) {
      try {
        return m.getRun(goalRunId(TH, turnId), REF);
      } catch {
        await sleep(20);
      }
    }
    return m.getRun(goalRunId(TH, turnId), REF);
  };

  test("a goal turn Codex starts while a member's run is starting gets its own run when that run stops first", async () => {
    const m = await start({
      "thread/resume": [
        [
          turnStarted(TH, "g1"),
          { waitMs: 300 },
          { respond: { thread: {} } },
          { waitMs: 50 },
          replyText(TH, "g1", "GOAL_WORK"),
          turnCompleted(TH, "g1"),
        ],
      ],
    });
    const stream = chatEvents(m);
    const run = m.startRun(member());
    await sleep(150);
    m.stopRun(run.runId, REF);
    const own = completedOf(await outcome(run));
    assert.equal(own.status, "stopped");
    assert.equal(own.delivery, "none");

    const goal = await outcome(await goalRun(m, "g1"));
    assert.equal(completedOf(goal).status, "completed");
    assert.deepEqual(texts(goal), ["GOAL_WORK"]);
    assert.deepEqual(
      stream.map((e) => [e.type, e.data.turnId]),
      [["run.started", "g1"]],
    );
  });

  test("a goal turn that ran before the member's own turn was accepted still gets a run", async () => {
    const m = await start({
      "thread/resume": [
        [
          { respond: { thread: {} } },
          turnStarted(TH, "g1"),
          replyText(TH, "g1", "GOAL_WORK"),
          turnCompleted(TH, "g1"),
        ],
      ],
      "turn/start": [
        [
          { respond: { turn: { id: "t2" } } },
          turnStarted(TH, "t2"),
          replyText(TH, "t2", "MEMBER_REPLY"),
          turnCompleted(TH, "t2"),
        ],
      ],
    });
    const stream = chatEvents(m);
    const run = m.startRun(member());
    const own = await outcome(run);
    assert.equal(completedOf(own).turnId, "t2");
    assert.deepEqual(texts(own), ["MEMBER_REPLY"]);
    const goal = await outcome(await goalRun(m, "g1"));
    assert.deepEqual(texts(goal), ["GOAL_WORK"]);
    assert.equal(completedOf(goal).status, "completed");
    assert.deepEqual(
      stream.map((e) => e.data.turnId),
      ["g1"],
    );
  });

  test("a lead turn that starts while the active run is still live waits for it, then gets its own run", async () => {
    const m = await start({
      "turn/start": [
        [
          { respond: { turn: { id: "t1" } } },
          turnStarted(TH, "t1"),
          replyText(TH, "t1", "MEMBER_REPLY"),
          turnStarted(TH, "g2"),
          replyText(TH, "g2", "GOAL_WORK"),
          turnCompleted(TH, "t1"),
          turnCompleted(TH, "g2"),
        ],
      ],
    });
    const run = m.startRun(member());
    const own = await outcome(run);
    assert.deepEqual(texts(own), ["MEMBER_REPLY"]);
    const goal = await outcome(await goalRun(m, "g2"));
    assert.deepEqual(texts(goal), ["GOAL_WORK"]);
    assert.equal(completedOf(goal).status, "completed");
  });

  test("a turn/start answered with a turn that had already started is that run's, never a second run", async () => {
    const m = await start({
      "turn/start": [
        [
          turnStarted(TH, "g1"),
          { respond: { turn: { id: "g1" } } },
          replyText(TH, "g1", "BOTH"),
          turnCompleted(TH, "g1"),
        ],
      ],
    });
    const stream = chatEvents(m);
    const own = await outcome(m.startRun(member()));
    assert.equal(completedOf(own).turnId, "g1");
    assert.deepEqual(texts(own), ["BOTH"]);
    await sleep(100);
    assert.deepEqual(stream, []);
    assert.throws(
      () => m.getRun(goalRunId(TH, "g1"), REF),
      (error: unknown) =>
        error instanceof AdapterError && error.code === "RUN_NOT_FOUND",
    );
  });

  test("the idle sweep keeps a chat whose stream is being read, so its numbering continues", async () => {
    const m = await start({});
    const stream = m.chatEvents(REF);
    const stop = stream.subscribe(
      { after: 0 },
      {
        send: () => undefined,
        end: () => undefined,
      },
    );
    await m.sweep(Date.now() + 24 * 3600_000);
    assert.equal(m.chatEvents(REF), stream);
    stop();
    await m.sweep(Date.now() + 24 * 3600_000);
    assert.notEqual(m.chatEvents(REF), stream);
  });

  test("a chat without goals never turns a stray lead turn into a run", async () => {
    const m = await start({
      "turn/start": [
        [
          { respond: { turn: { id: "t1" } } },
          turnStarted(TH, "t1"),
          replyText(TH, "t1", "MEMBER_REPLY"),
          turnCompleted(TH, "t1"),
          { waitMs: 50 },
          turnStarted(TH, "x9"),
        ],
      ],
    });
    const stream = chatEvents(m);
    const own = await outcome(m.startRun(member(false)));
    assert.equal(completedOf(own).status, "completed");
    await sleep(200);
    assert.deepEqual(stream, []);
    assert.ok(logs.includes("turn_unowned"));
    assert.equal(m.stats.activeRuns, 0);
  });

  test("a Stop while the goal is active pauses it before the interrupt, and a repeated Stop sends nothing more", async () => {
    const m = await start(
      {
        "thread/resume": [[{ respond: { thread: {} } }, goalUpdated("active")]],
        "turn/start": [
          [
            { respond: { turn: { id: "t1" } } },
            turnStarted(TH, "t1"),
            {
              notify: "item/agentMessage/delta",
              params: { threadId: TH, turnId: "t1", itemId: "m1", delta: "w" },
            },
          ],
        ],
        "thread/goal/set": [
          [
            // Codex's progress update for the turn, still active.
            goalUpdated("active"),
            { respond: { goal: goal("paused") } },
            goalUpdated("paused"),
          ],
        ],
        "turn/interrupt": [
          [{ respond: {} }, turnCompleted(TH, "t1", "interrupted")],
        ],
      },
      // The adapter set this goal (as a PUT would have recorded it).
      { ownGoal: { createdAt: GOAL_AT, objective: "GOAL" } },
    );
    const run = m.startRun(member());
    await new Promise<void>((resolve) =>
      run.subscribe(0, {
        send: (event) => event.type === "text.delta" && resolve(),
        end: () => resolve(),
      }),
    );
    m.stopRun(run.runId, REF);
    m.stopRun(run.runId, REF);
    assert.equal(completedOf(await outcome(run)).status, "stopped");
    m.stopRun(run.runId, REF);
    await sleep(200);
    const sent = (await rpcLog()).filter((r) =>
      ["thread/goal/set", "turn/interrupt"].includes(r.method ?? ""),
    );
    assert.deepEqual(
      sent.map((r) => r.method),
      ["thread/goal/set", "turn/interrupt"],
    );
    assert.deepEqual(sent[0]!.params, {
      threadId: TH,
      origin: "user",
      status: "paused",
    });
  });

  test("a watchdog stop pauses the goal too, not as the member's instruction; a shutdown does not pause", async () => {
    const script: FakeScript = {
      "thread/resume": [[{ respond: { thread: {} } }, goalUpdated("active")]],
      // Some output, then silent: the watchdog stops it with an interrupt.
      "turn/start": [
        [
          { respond: { turn: { id: "t1" } } },
          turnStarted(TH, "t1"),
          {
            notify: "item/agentMessage/delta",
            params: { threadId: TH, turnId: "t1", itemId: "m1", delta: "w" },
          },
        ],
      ],
      "thread/goal/set": [
        [{ respond: { goal: goal("paused") } }, goalUpdated("paused")],
      ],
      "turn/interrupt": [
        [{ respond: {} }, turnCompleted(TH, "t1", "interrupted")],
      ],
    };
    const own = { ownGoal: { createdAt: GOAL_AT, objective: "GOAL" } };
    const sent = async () =>
      (await rpcLog()).filter((r) =>
        ["thread/goal/set", "turn/interrupt"].includes(r.method ?? ""),
      );

    let m = await start(script, own);
    const timed = m.startRun({
      ...member(),
      limits: { ...member().limits, silenceMs: 1000 },
    });
    const done = completedOf(await outcome(timed));
    assert.equal(done.status, "failed");
    assert.equal((done.error as { code?: string }).code, "MODEL_TIMEOUT");
    await sleep(200);
    const timeout = await sent();
    assert.deepEqual(
      timeout.map((r) => r.method),
      ["thread/goal/set", "turn/interrupt"],
    );
    assert.deepEqual(timeout[0]!.params, { threadId: TH, status: "paused" });

    // A shutdown leaves the goal active, so it continues when the chat is
    // resumed after the restart (goals probe 9).
    await m.drain(0);
    await rm(root, { recursive: true, force: true });
    m = await start(script, own);
    const shut = m.startRun(member());
    await new Promise<void>((resolve) =>
      shut.subscribe(0, {
        send: (event) => event.type === "text.delta" && resolve(),
        end: () => resolve(),
      }),
    );
    await m.drain(0);
    assert.equal(completedOf(await outcome(shut)).status, "failed");
    assert.deepEqual(
      (await sent()).map((r) => r.method),
      ["turn/interrupt"],
    );
  });

  test("a Stop that restarts the process lets the pause be answered first", async () => {
    const m = await start(
      {
        "thread/resume": [[{ respond: { thread: {} } }, goalUpdated("active")]],
        // No model output yet: the stop settles at once and restarts the
        // process.
        "turn/start": [
          [{ respond: { turn: { id: "t1" } } }, turnStarted(TH, "t1")],
        ],
        "thread/goal/set": [
          [{ waitMs: 300 }, { respond: { goal: goal("paused") } }],
        ],
      },
      { ownGoal: { createdAt: GOAL_AT, objective: "GOAL" } },
    );
    const run = m.startRun(member());
    await new Promise<void>((resolve) =>
      run.subscribe(0, {
        send: (event) => event.type === "run.accepted" && resolve(),
        end: () => resolve(),
      }),
    );
    m.stopRun(run.runId, REF);
    assert.equal(completedOf(await outcome(run)).status, "stopped");
    for (let i = 0; i < 100 && m.stats.processes > 0; i++) await sleep(20);
    assert.equal(m.stats.processes, 0);
    const log = await rpcLog();
    assert.ok(log.some((r) => r.answering === "thread/goal/set"));
    assert.ok(!log.some((r) => r.method === "turn/interrupt"));
  });
});
