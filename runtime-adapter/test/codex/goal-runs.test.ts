import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { goalRunId } from "../../src/contract";
import {
  Harness,
  completed,
  readSse,
  streamedText,
  type SseEvent,
} from "../support/harness";
import {
  COMPLETE,
  GOALS,
  OBJECTIVE,
  context,
  isContinuation,
  ofType,
  openChatStream,
  reply,
  until,
} from "../support/goals";
import { McpFixture } from "../support/mcp-fixture";
import { sleep } from "../support/model-fixture";

// Codex-started goal turns as adapter runs, and the chat stream (Task 4 of
// tasks/goal-mode-todo.md), on the pin. Codex starts a turn for an active
// goal by itself (goals probe 4); each such turn is a run of its own. The
// facts relied on are in test/codex/goals-probe.test.ts.

type Body = Record<string, unknown>;

const CONNECTOR = "fixture";

function mcpSpec(fixture: McpFixture) {
  return [
    {
      name: CONNECTOR,
      url: fixture.url,
      headers: { Authorization: "Bearer goal-run-token" },
      toolTimeoutSec: 30,
      startupTimeoutSec: 15,
    },
  ];
}

const goalOf = (event: SseEvent) => event.data.goal as Body;
const isComplete = (events: SseEvent[]) =>
  ofType(events, "goal.updated").some(
    (event) => goalOf(event).status === "complete",
  );
const isPaused = (events: SseEvent[]) =>
  ofType(events, "goal.updated").some(
    (event) => goalOf(event).status === "paused",
  );

describe("goal runs (real Codex)", () => {
  const mcp = new McpFixture();
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });
  beforeEach(() => {
    h.model.script.length = 0;
    h.model.router = undefined;
  });

  const ref = (chatId: string) => ({ tenantId: "tenant1", chatId });
  const putGoal = (chatId: string, body: Body) =>
    h.fetch(`/v1/chats/${chatId}/goal`, {
      method: "PUT",
      body: JSON.stringify({ tenantId: "tenant1", goals: GOALS, ...body }),
    });
  const activate = async (chatId: string, run: Body) => {
    const res = await putGoal(chatId, {
      status: "active",
      objective: OBJECTIVE,
      tokenBudget: 50_000,
      run: context(run),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const runEvents = async (chatId: string, runId: string, after = 0) => {
    const res = await h.fetch(
      `/v1/runs/${runId}/events?tenantId=tenant1&chatId=${chatId}&after=${after}`,
    );
    assert.equal(res.status, 200, await res.clone().text());
    return readSse(res);
  };
  const code = async (res: Response) =>
    ((await res.json()) as { error: { code: string } }).error.code;
  // A member turn, so the chat has a loaded thread with goals on.
  const firstTurn = async (chatId: string, extra: Body = {}) => {
    const events = await h.run(h.body({ chatId, goals: GOALS, ...extra }));
    assert.equal(completed(events).status, "completed");
    return String(completed(events).threadId);
  };

  test("each turn Codex starts for a goal is a run of its own, announced on the chat stream", async () => {
    const threadId = await firstTurn("three");
    const stream = await openChatStream(h, "three");
    h.model.script.push(
      reply("STEP_ONE"),
      reply("STEP_TWO"),
      COMPLETE,
      reply("GOAL_DONE"),
    );
    const from = h.model.requests.length;
    await activate("three", h.body({ chatId: "three", threadId }));
    assert.ok(await until(() => isComplete(stream.events)));
    // Nothing starts after the goal is complete.
    await sleep(1000);
    assert.equal(h.model.requests.length - from, 4);

    const started = ofType(stream.events, "run.started");
    assert.equal(started.length, 3);
    const texts: string[] = [];
    for (const event of started) {
      const { runId, turnId, trigger } = event.data;
      assert.equal(trigger, "goal");
      assert.equal(runId, goalRunId(threadId, String(turnId)));
      // Reconnectable from the start, as any run.
      const events = await runEvents("three", String(runId));
      assert.equal(events[0]!.type, "run.accepted");
      assert.deepEqual(events[0]!.data, { threadId, turnId, resumed: false });
      const done = completed(events);
      assert.equal(done.status, "completed");
      assert.equal(done.turnId, turnId);
      texts.push(streamedText(events));
    }
    assert.deepEqual(texts, ["STEP_ONE", "STEP_TWO", "GOAL_DONE"]);

    // The set's own update comes first; the complete one names the turn it
    // happened in, and reached that run's stream too.
    const updates = ofType(stream.events, "goal.updated");
    assert.deepEqual(
      { turnId: updates[0]!.data.turnId, origin: updates[0]!.data.origin },
      { turnId: null, origin: "user" },
    );
    assert.equal(goalOf(updates[0]!).objective, OBJECTIVE);
    const complete = updates.find((u) => goalOf(u).status === "complete")!;
    assert.equal(complete.data.turnId, started[2]!.data.turnId);
    assert.equal(complete.data.origin, "user");
    const last = await runEvents("three", String(started[2]!.data.runId));
    assert.ok(isComplete(last));
    // A first read starts with a snapshot (seq 0), then one numbering for
    // the chat: 1, 2, 3…
    assert.equal(stream.events[0]!.type, "chat.snapshot");
    assert.deepEqual(
      stream.events.map((e) => e.seq),
      stream.events.map((_, i) => i),
    );
    await stream.close();
  });

  test("a goal run is the chat's active run: a member run is CHAT_BUSY, and steer and stop reach the goal run", async () => {
    const threadId = await firstTurn("steer");
    const stream = await openChatStream(h, "steer");
    h.model.script.push(
      { kind: "reply", text: "alpha ".repeat(60), chunk: 6, delayMs: 20 },
      reply("STEERED_ANSWER"),
      { kind: "hangAfterCreated" },
    );
    const from = h.model.requests.length;
    await activate("steer", h.body({ chatId: "steer", threadId }));
    assert.ok(
      await until(() => ofType(stream.events, "run.started").length === 1),
    );
    const runId = String(ofType(stream.events, "run.started")[0]!.data.runId);

    const busy = await h.post(
      "/v1/runs",
      h.body({ chatId: "steer", threadId, goals: GOALS }),
    );
    assert.equal(busy.status, 409);
    assert.equal(await code(busy), "CHAT_BUSY");

    let steerStatus = 0;
    const res = await h.fetch(
      `/v1/runs/${runId}/events?tenantId=tenant1&chatId=steer`,
    );
    const events = await readSse(res, async (event) => {
      if (steerStatus || event.type !== "text.delta") return;
      steerStatus = -1;
      steerStatus = (
        await h.steer(
          runId,
          { text: "STEER_TEXT", clientMessageId: "goal-steer-1" },
          ref("steer"),
        )
      ).status;
    });
    assert.equal(steerStatus, 202);
    const done = completed(events);
    assert.equal(done.status, "completed");
    assert.ok(
      (done.items as Body[]).some(
        (item) =>
          item.type === "input" && item.clientMessageId === "goal-steer-1",
      ),
    );
    assert.ok(streamedText(events).includes("STEERED_ANSWER"));
    assert.ok(
      JSON.stringify(h.model.requests[from + 1]!.body.input).includes(
        "STEER_TEXT",
      ),
    );

    // Codex continues the goal; that turn waits on the model.
    assert.ok(
      await until(() => ofType(stream.events, "run.started").length === 2),
    );
    const second = ofType(stream.events, "run.started")[1]!.data;
    assert.ok(await until(() => h.model.requests.length === from + 3));
    // A reconnect too far behind sees the running goal run.
    const snapshot = await openChatStream(h, "steer", { after: 999_999_999 });
    assert.ok(await until(() => snapshot.events.length === 1));
    assert.equal(snapshot.events[0]!.type, "chat.snapshot");
    assert.deepEqual(snapshot.events[0]!.data.activeRun, {
      runId: second.runId,
      turnId: second.turnId,
      trigger: "goal",
    });
    await snapshot.close();

    // Stopped before any model output: settled at once (200), as any run.
    const stop = await h.stop(String(second.runId), ref("steer"));
    assert.equal(stop.status, 200);
    const stopped = await runEvents("steer", String(second.runId));
    assert.equal(completed(stopped).status, "stopped");
    // An interrupt ends the loop (goals probe 6).
    await sleep(1000);
    assert.equal(ofType(stream.events, "run.started").length, 2);
    assert.equal(h.model.requests.length, from + 3);

    // Clear it, so the chat's next turn does not continue it.
    const clear = await h.fetch("/v1/chats/steer/goal?tenantId=tenant1", {
      method: "DELETE",
    });
    assert.deepEqual(await clear.json(), { cleared: true });
    assert.ok(
      await until(() => ofType(stream.events, "goal.cleared").length > 0),
    );
    await stream.close();
  });

  test("a goal run asks for a connector write's approval like any run", async () => {
    mcp.reset();
    const threadId = await firstTurn("approve", { mcp: mcpSpec(mcp) });
    const stream = await openChatStream(h, "approve");
    h.model.script.push(
      {
        kind: "call",
        name: "create_issue",
        namespace: `mcp__${CONNECTOR}`,
        args: { title: "goal issue" },
      },
      reply("ISSUE_FILED"),
      COMPLETE,
      reply("GOAL_DONE"),
    );
    await activate(
      "approve",
      h.body({ chatId: "approve", threadId, mcp: mcpSpec(mcp) }),
    );
    assert.ok(
      await until(() => ofType(stream.events, "run.started").length === 1),
    );
    const runId = String(ofType(stream.events, "run.started")[0]!.data.runId);
    const answers: Response[] = [];
    const res = await h.fetch(
      `/v1/runs/${runId}/events?tenantId=tenant1&chatId=approve`,
    );
    const events = await readSse(res, async (event) => {
      if (event.type !== "approval.requested") return;
      answers.push(
        await h.post(
          `/v1/runs/${runId}/approvals/${String(event.data.approvalId)}`,
          { ...ref("approve"), decision: "allow" },
        ),
      );
    });
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.status, 200);
    assert.equal(mcp.toolCalls(), 1);
    assert.equal(ofType(events, "tool.completed")[0]!.data.status, "completed");
    assert.equal(completed(events).status, "completed");
    assert.ok(await until(() => isComplete(stream.events)));
    await stream.close();
  });

  test("a member run Codex steers into a goal turn is that turn's only run", async () => {
    const threadId = await firstTurn("race");
    // Leave an active goal on an unloaded thread: its first turn waits on
    // the model, and the adapter restarts. An interrupt alone keeps the goal
    // active (goals probe 6).
    h.model.script.push({ kind: "hangAfterCreated" });
    const before = h.model.requests.length;
    await activate("race", h.body({ chatId: "race", threadId }));
    assert.ok(await until(() => h.model.requests.length > before));
    await h.restart();
    const goal = await h.fetch("/v1/chats/race/goal?tenantId=tenant1");
    assert.equal(((await goal.json()) as { goal: Body }).goal.status, "active");

    // The member's run resumes the thread, which continues the goal by
    // itself (goals probe 9); its turn/start then lands in that goal turn
    // and Codex answers with the goal turn's id (goals probe 8).
    const stream = await openChatStream(h, "race");
    h.model.script.push(
      { kind: "reply", text: "goal work ".repeat(30), chunk: 5, delayMs: 20 },
      reply("NEXT_STEP"),
      COMPLETE,
      reply("GOAL_DONE"),
    );
    const from = h.model.requests.length;
    const events = await h.run(
      h.body({
        chatId: "race",
        threadId,
        goals: GOALS,
        input: { text: "RACE_MEMBER", clientMessageId: "race-member" },
      }),
    );
    const done = completed(events);
    assert.equal(done.status, "completed");
    assert.ok(await until(() => isComplete(stream.events)));
    await sleep(500);

    // The race happened: the first turn after the resume is Codex's goal
    // turn with the member's input in it, and it is the member's run.
    const firstRequest = h.model.requests[from]!.body;
    assert.ok(isContinuation(firstRequest));
    assert.ok(JSON.stringify(firstRequest.input).includes("RACE_MEMBER"));
    assert.ok(streamedText(events).startsWith("goal work"));
    // Every turn has exactly one run: the member's, or a goal run.
    const goalTurns = ofType(stream.events, "run.started").map((e) =>
      String(e.data.turnId),
    );
    assert.ok(!goalTurns.includes(String(done.turnId)));
    assert.equal(new Set(goalTurns).size, goalTurns.length);
    const history = await h.fetch("/v1/chats/race/history?tenantId=tenant1");
    const turns = (
      (await history.json()) as { turns: Array<{ turnId: string }> }
    ).turns.map((turn) => turn.turnId);
    // The first member turn, the interrupted goal turn, then these.
    assert.equal(turns.length, 2 + 1 + goalTurns.length);
    for (const turnId of [String(done.turnId), ...goalTurns])
      assert.ok(turns.includes(turnId), turnId);
    await stream.close();
  });

  test("a goal turn Codex starts while a member's run is starting still gets a run when that run ends without a turn, and the member's Stop pauses the goal", async () => {
    const threadId = await firstTurn("orphan");
    h.model.script.push({ kind: "hangAfterCreated" });
    const before = h.model.requests.length;
    await activate("orphan", h.body({ chatId: "orphan", threadId }));
    assert.ok(await until(() => h.model.requests.length > before));
    await h.restart();

    // The member's run resumes the thread, which starts a goal turn by
    // itself; the member stops before the run sends its own turn/start.
    const stream = await openChatStream(h, "orphan");
    h.model.script.push(reply("GOAL_WORK"), reply("NOT_CONTINUED"));
    const from = h.model.requests.length;
    const body = h.body({ chatId: "orphan", threadId, goals: GOALS });
    const res = await h.post("/v1/runs", body);
    assert.equal(res.status, 200);
    await h.stop(String(body.runId), ref("orphan"));
    const member = completed(await readSse(res));
    assert.equal(member.status, "stopped");
    assert.equal(member.delivery, "none");

    // The goal turn Codex had already started runs as its own run; the
    // Stop paused the goal, so nothing follows it.
    assert.ok(await until(() => isPaused(stream.events)));
    assert.ok(
      await until(() => ofType(stream.events, "run.started").length === 1),
    );
    const started = ofType(stream.events, "run.started");
    const first = await runEvents("orphan", String(started[0]!.data.runId));
    assert.equal(completed(first).status, "completed");
    assert.equal(streamedText(first), "GOAL_WORK");
    await sleep(2000);
    assert.equal(ofType(stream.events, "run.started").length, 1);
    assert.equal(h.model.requests.length, from + 1);
    await stream.close();
  });

  test("Stop during a goal turn pauses the goal first: nothing more starts, also when the stop restarts the process", async () => {
    // Stopped after model output: the turn is interrupted.
    const threadId = await firstTurn("stop");
    const stream = await openChatStream(h, "stop");
    h.model.script.push(
      { kind: "reply", text: "alpha ".repeat(60), chunk: 6, delayMs: 20 },
      reply("NOT_CONTINUED"),
    );
    const from = h.model.requests.length;
    await activate("stop", h.body({ chatId: "stop", threadId }));
    assert.ok(
      await until(() => ofType(stream.events, "run.started").length === 1),
    );
    const runId = String(ofType(stream.events, "run.started")[0]!.data.runId);
    let stops = 0;
    const res = await h.fetch(
      `/v1/runs/${runId}/events?tenantId=tenant1&chatId=stop`,
    );
    const events = await readSse(res, async (event) => {
      if (stops > 0 || event.type !== "text.delta") return;
      stops++;
      await h.stop(runId, ref("stop"));
    });
    assert.equal(completed(events).status, "stopped");
    assert.ok(await until(() => isPaused(stream.events)));
    const pause = ofType(stream.events, "goal.updated").find(
      (u) => goalOf(u).status === "paused",
    )!;
    assert.equal(pause.data.origin, "user");
    await sleep(5000);
    assert.equal(ofType(stream.events, "run.started").length, 1);
    assert.equal(h.model.requests.length, from + 1);
    // The member's next turn is not counted towards it and continues
    // nothing (goals probe 6).
    h.model.script.length = 0;
    h.model.script.push(reply("MEMBER_ANSWER"), reply("NOT_CONTINUED"));
    await firstTurn("stop", { threadId });
    await sleep(2000);
    assert.equal(ofType(stream.events, "run.started").length, 1);
    assert.equal(h.model.requests.length, from + 2);
    await stream.close();

    // Stopped before any model output: the run settles at once and the
    // process is restarted. The pause still reached Codex first, so the
    // next resume does not continue the goal (goals probe 9).
    const early = await firstTurn("early");
    const earlyStream = await openChatStream(h, "early");
    h.model.script.length = 0;
    h.model.script.push({ kind: "hangAfterCreated" });
    const sent = h.model.requests.length;
    await activate("early", h.body({ chatId: "early", threadId: early }));
    assert.ok(
      await until(() => ofType(earlyStream.events, "run.started").length === 1),
    );
    assert.ok(await until(() => h.model.requests.length > sent));
    const earlyRun = String(
      ofType(earlyStream.events, "run.started")[0]!.data.runId,
    );
    assert.equal((await h.stop(earlyRun, ref("early"))).status, 200);
    const goal = await h.fetch("/v1/chats/early/goal?tenantId=tenant1");
    assert.equal(((await goal.json()) as { goal: Body }).goal.status, "paused");
    h.model.script.length = 0;
    h.model.script.push(reply("MEMBER_ANSWER"), reply("NOT_CONTINUED"));
    const next = h.model.requests.length;
    await firstTurn("early", { threadId: early });
    await sleep(2000);
    assert.equal(ofType(earlyStream.events, "run.started").length, 1);
    assert.equal(h.model.requests.length, next + 1);
    await earlyStream.close();
  });

  test("after an adapter restart, a goal set through the endpoint is still the adapter's: reported as the member's and not paused", async () => {
    const threadId = await firstTurn("own");
    h.model.script.push({ kind: "hangAfterCreated" });
    const before = h.model.requests.length;
    await activate("own", h.body({ chatId: "own", threadId }));
    assert.ok(await until(() => h.model.requests.length > before));
    await h.restart();

    // The member's run resumes the thread; Codex reports the goal and
    // continues it (goals probe 9).
    const stream = await openChatStream(h, "own");
    h.model.script.push(reply("GOAL_WORK"), COMPLETE, reply("GOAL_DONE"));
    await firstTurn("own", { threadId });
    assert.ok(await until(() => isComplete(stream.events)));
    const updates = ofType(stream.events, "goal.updated");
    assert.deepEqual([...new Set(updates.map((u) => u.data.origin))], ["user"]);
    assert.ok(!isPaused(stream.events));
    await stream.close();
  });

  test("a goal the model creates in a member's run is paused before that run completes, and runs only once the member starts it", async () => {
    const stream = await openChatStream(h, "model");
    h.model.script.push(
      {
        kind: "call",
        name: "create_goal",
        args: { objective: "MODEL_GOAL: tidy the notes." },
      },
      reply("MEMBER_DONE"),
      reply("NOT_CONTINUED"),
    );
    const from = h.model.requests.length;
    const events = await h.run(h.body({ chatId: "model", goals: GOALS }));
    const done = completed(events);
    assert.equal(done.status, "completed");
    const updates = ofType(events, "goal.updated");
    const created = updates[0]!;
    assert.equal(goalOf(created).objective, "MODEL_GOAL: tidy the notes.");
    assert.equal(goalOf(created).status, "active");
    assert.equal(created.data.turnId, done.turnId);
    // The pause is on the run's own stream, so it landed before the run
    // completed.
    assert.ok(isPaused(updates));
    assert.deepEqual(
      [...new Set(updates.map((u) => u.data.origin))],
      ["model"],
    );

    // Measured: no continuation turn starts.
    await sleep(5000);
    assert.deepEqual(ofType(stream.events, "run.started"), []);
    assert.equal(h.model.requests.length, from + 2);
    const goal = await h.fetch("/v1/chats/model/goal?tenantId=tenant1");
    assert.equal(((await goal.json()) as { goal: Body }).goal.status, "paused");

    // The member starts the proposed goal with a budget: it is the
    // member's now, so it is not paused again, and its turns are runs.
    h.model.script.length = 0;
    h.model.script.push(COMPLETE, reply("GOAL_DONE"));
    const seen = stream.events.length;
    const res = await putGoal("model", {
      status: "active",
      tokenBudget: 50_000,
      run: context(
        h.body({ chatId: "model", threadId: String(done.threadId) }),
      ),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(await until(() => isComplete(stream.events)));
    const later = ofType(stream.events.slice(seen), "goal.updated");
    assert.deepEqual([...new Set(later.map((u) => u.data.origin))], ["user"]);
    assert.ok(!isPaused(stream.events.slice(seen)));
    const started = ofType(stream.events, "run.started");
    assert.equal(started.length, 1);
    const goalRun = await runEvents("model", String(started[0]!.data.runId));
    assert.equal(streamedText(goalRun), "GOAL_DONE");
    assert.equal(completed(goalRun).status, "completed");
    await stream.close();
  });
});

describe("the chat stream (real Codex)", () => {
  const h = new Harness({ limits: { bufferEvents: 4 } });
  before(() => h.start());
  after(() => h.close());

  test("replays after a cursor, sends one snapshot for a cursor outside its buffer, and carries only its own chat", async () => {
    const live = await openChatStream(h, "a");
    const otherChat = await openChatStream(h, "b");
    const otherTenant = await openChatStream(h, "a", { tenantId: "tenant2" });
    const first = await h.run(h.body({ chatId: "a", goals: GOALS }));
    const threadId = String(completed(first).threadId);
    h.model.script.push(
      reply("STEP_ONE"),
      reply("STEP_TWO"),
      COMPLETE,
      reply("GOAL_DONE"),
    );
    const res = await h.fetch("/v1/chats/a/goal", {
      method: "PUT",
      body: JSON.stringify({
        tenantId: "tenant1",
        goals: GOALS,
        status: "active",
        objective: OBJECTIVE,
        tokenBudget: 50_000,
        run: context(h.body({ chatId: "a", threadId })),
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(await until(() => isComplete(live.events)));
    await sleep(500);
    const [opening, ...all] = live.events;
    assert.equal(opening!.type, "chat.snapshot");
    const streamId = String(opening!.data.streamId);
    assert.ok(all.length > 4, "more events than the buffer holds");

    // A cursor inside the buffer: exactly what came after it.
    const replay = await openChatStream(h, "a", {
      after: all.at(-3)!.seq,
      streamId,
    });
    assert.ok(await until(() => replay.events.length === 2));
    await sleep(200);
    assert.deepEqual(replay.events, all.slice(-2));
    await replay.close();

    // Older than the buffer, newer than the stream, or from another stream
    // (another adapter process's cursor): one snapshot, nothing else.
    for (const cursor of [
      { after: 0, streamId },
      { after: 999_999_999, streamId },
      { after: all.at(-3)!.seq, streamId: "earlier" },
    ]) {
      const stream = await openChatStream(h, "a", cursor);
      assert.ok(await until(() => stream.events.length === 1));
      await sleep(200);
      assert.equal(stream.events.length, 1, JSON.stringify(cursor));
      const [snapshot] = stream.events;
      assert.equal(snapshot!.type, "chat.snapshot");
      assert.equal(snapshot!.seq, all.at(-1)!.seq);
      const lastGoal = ofType(all, "goal.updated").at(-1)!;
      assert.deepEqual(snapshot!.data, {
        streamId,
        goal: lastGoal.data.goal,
        origin: "user",
        activeRun: null,
      });
      await stream.close();
    }

    // Each first read got only its own chat's snapshot.
    for (const stream of [otherChat, otherTenant]) {
      assert.deepEqual(
        stream.events.map((e) => [e.seq, e.type, e.data.goal]),
        [[0, "chat.snapshot", null]],
      );
      assert.notEqual(stream.events[0]!.data.streamId, streamId);
    }
    for (const stream of [live, otherChat, otherTenant]) await stream.close();
  });
});
