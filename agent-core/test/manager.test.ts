import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
import { AUTO_NOTE, defaults, validateResponse } from "../src/requests";
class Fake extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  replies: any[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread_1" } };
    if (method === "turn/start") {
      await new Promise((r) => setTimeout(r, 10));
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread_1", turn: { id: "turn_1" } },
      });
      return { turn: { id: "turn_1" } };
    }
    return {};
  }
  respond(id: any, result: any, error: any) {
    this.replies.push({ id, result, error });
  }
}
function fixture(t: any, timeout = 1000) {
  const runtime = new Fake(),
    dir = mkdtempSync(join(tmpdir(), "adapter-test-")),
    manager = new ThreadManager(runtime, dir, 2, 3, timeout);
  t.after(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, manager };
}
test("overlapping POSTs start once and steer the same turn; stale completion cannot clear it", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  const result = await Promise.all([
    manager.message("thread_1", "first"),
    manager.message("thread_1", "second"),
  ]);
  assert.deepEqual(result, [
    { turnId: "turn_1", steer: false },
    { turnId: "turn_1", steer: true },
  ]);
  assert.deepEqual(
    runtime.calls.map((x) => x.method),
    ["thread/start", "turn/start", "turn/steer"],
  );
  assert.equal(runtime.calls[2].params.expectedTurnId, "turn_1");
  runtime.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread_1", turn: { id: "old", status: "completed" } },
  });
  assert.deepEqual(manager.snapshot("thread_1").state, {
    kind: "running",
    turnId: "turn_1",
  });
  await manager.interrupt("thread_1");
  await assert.rejects(manager.message("thread_1", "late"), /interrupting/);
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread_1",
      turn: { id: "turn_1", status: "interrupted" },
    },
  });
  assert.deepEqual(manager.snapshot("thread_1").state, { kind: "idle" });
});
test("final messages persist with no subscribers and survive manager recreation", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  runtime.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      item: { id: "item_1", type: "agentMessage", text: "Saved" },
    },
  });
  const second = new ThreadManager(new Fake(), manager.home);
  assert.equal(second.records("thread_1")[0].event.data.text, "Saved");
  const records = second.records("thread_1");
  second.ack(
    "thread_1",
    records.map((x) => x.key),
  );
  second.ack(
    "thread_1",
    records.map((x) => x.key),
  );
  assert.deepEqual(second.records("thread_1"), []);
  second.close();
});
test("approval answer validation, single resolution, expiry and snapshot survive replay eviction", async (t) => {
  const { runtime, manager } = fixture(t, 30);
  await manager.create({});
  runtime.emit("serverRequest", {
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_1", turnId: "turn_1", itemId: "item" },
  });
  const request = manager.snapshot("thread_1").pending[0];
  assert.throws(
    () => manager.answer("thread_1", request.requestId, { decision: "yes" }),
    /Invalid/,
  );
  manager.answer("thread_1", request.requestId, { decision: "accept" });
  const resolved = manager
    .records("thread_1")
    .find((r) => r.event.type === "approval.resolved")!.event;
  // The question is kept with its answer for the chat's audit trail.
  assert.equal(resolved.data.detail.itemId, "item");
  assert.equal(resolved.turnId, "turn_1");
  assert.throws(
    () => manager.answer("thread_1", request.requestId, { decision: "accept" }),
    /already resolved/,
  );
  runtime.emit("serverRequest", {
    id: 8,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread_1" },
  });
  for (let i = 0; i < 5; i++)
    runtime.emit("notification", {
      method: "turn/plan/updated",
      params: { threadId: "thread_1", plan: [] },
    });
  assert.equal(manager.snapshot("thread_1").pending.length, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(manager.snapshot("thread_1").pending.length, 0);
  assert.equal(runtime.replies.length, 2);
  assert.deepEqual(runtime.replies[1].result, { decision: "decline" });
  assert.equal(
    manager.records("thread_1").filter((r) => r.event.data.reason === "expired")
      .length,
    1,
  );
});
test("all automatic denial payloads satisfy generated response schemas", () => {
  for (const [method, result] of Object.entries(defaults))
    if (result !== null)
      assert.doesNotThrow(() => validateResponse(method, result), method);
});
test("full subscriber buffers disconnect without blocking other threads", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  const res = Object.assign(new EventEmitter(), {
    set() {},
    flushHeaders() {},
    write() {
      return false;
    },
    destroyed: false,
    destroy() {
      this.destroyed = true;
      this.emit("close");
    },
  });
  manager.subscribe("thread_1", res as any);
  assert.equal(res.destroyed, true);
  await manager.message("thread_1", "still works");
  assert.equal(manager.snapshot("thread_1").state.kind, "running");
});
test("goal notifications keep the snapshot goal current and reach subscribers", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  const goal = {
    threadId: "thread_1",
    objective: "Ship the report",
    status: "active",
    tokenBudget: null,
    tokensUsed: 120,
    timeUsedSeconds: 30,
    createdAt: 1,
    updatedAt: 2,
  };
  runtime.emit("notification", {
    method: "thread/goal/updated",
    params: { threadId: "thread_1", turnId: null, goal },
  });
  assert.equal(
    (manager.snapshot("thread_1").goal as any).objective,
    "Ship the report",
  );
  assert.equal(
    manager.threads.get("thread_1")!.events.at(-1)!.type,
    "goal.updated",
  );
  runtime.emit("notification", {
    method: "thread/goal/cleared",
    params: { threadId: "thread_1" },
  });
  assert.equal(manager.snapshot("thread_1").goal, null);
  assert.equal(
    manager.threads.get("thread_1")!.events.at(-1)!.type,
    "goal.cleared",
  );
});
test("goal token tally counts usage reported after the goal completes and resets for a new goal", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  const goal = {
    threadId: "thread_1",
    objective: "Ship the report",
    status: "active",
    tokenBudget: 25000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const usage = (
    turnId: string,
    input: number,
    cached: number,
    output: number,
  ) =>
    runtime.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_1",
        turnId,
        tokenUsage: {
          total: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
          last: {
            inputTokens: input,
            cachedInputTokens: cached,
            outputTokens: output,
          },
        },
      },
    });
  runtime.emit("notification", {
    method: "thread/goal/updated",
    params: { threadId: "thread_1", turnId: null, goal },
  });
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread_1", turn: { id: "turn_1" } },
  });
  // The agent completes the goal before the turn's usage arrives.
  runtime.emit("notification", {
    method: "thread/goal/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      goal: { ...goal, status: "complete" },
    },
  });
  // The fixture keeps only a few events, so compare by sequence number.
  const thread = manager.threads.get("thread_1")!;
  const before = thread.seq;
  usage("turn_1", 10335, 335, 257);
  usage("turn_1", 9466, 0, 40);
  const events = thread.events.filter(
    (e) => e.seq > before && e.type === "goal.updated",
  );
  // Each call publishes the tally and the turn's usage.
  assert.equal(thread.seq - before, 4);
  assert.deepEqual(
    thread.events.slice(-3).map((e) => e.type),
    ["usage.updated", "goal.updated", "usage.updated"],
  );
  assert.equal((events.at(-1)!.data as any).goal.tokensObserved, 10257 + 9506);
  assert.equal(
    (manager.snapshot("thread_1").goal as any).tokensObserved,
    19763,
  );
  // Codex's own count is left untouched.
  assert.equal((manager.snapshot("thread_1").goal as any).tokensUsed, 0);
  // Usage from a turn that never ran for this goal is ignored and not published.
  const quiet = thread.seq;
  usage("turn_other", 500, 0, 5);
  assert.equal(thread.seq, quiet);
  // Editing the objective keeps the goal, so the tally carries over.
  runtime.emit("notification", {
    method: "thread/goal/updated",
    params: {
      threadId: "thread_1",
      turnId: null,
      goal: { ...goal, objective: "Ship the edited report" },
    },
  });
  assert.equal(
    (manager.snapshot("thread_1").goal as any).tokensObserved,
    19763,
  );
  // A new goal starts a fresh tally.
  runtime.emit("notification", {
    method: "thread/goal/updated",
    params: {
      threadId: "thread_1",
      turnId: null,
      goal: { ...goal, objective: "Next goal", createdAt: 2 },
    },
  });
  assert.equal((manager.snapshot("thread_1").goal as any).tokensObserved, 0);
  usage("turn_1", 100, 0, 1);
  assert.equal((manager.snapshot("thread_1").goal as any).tokensObserved, 0);
});
// A healthy client must not be dropped just because one frame exceeds the
// socket's high-water mark; large MCP tool results routinely do.
async function sse(t: any, manager: ThreadManager) {
  const express = (await import("express")).default;
  const app = express();
  app.get("/threads/:id/events", (req, res) =>
    manager.subscribe(
      req.params.id,
      res,
      req.get("Last-Event-ID") || undefined,
    ),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}/threads/thread_1/events`;
  return async (
    cursor: string | undefined,
    until: (events: any[]) => boolean,
  ) => {
    const ac = new AbortController();
    const response = await fetch(url, {
      signal: ac.signal,
      headers: cursor ? { "Last-Event-ID": cursor } : {},
    });
    const events: any[] = [];
    let buffer = "",
      ended = true;
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      for await (const chunk of response.body as any) {
        buffer += Buffer.from(chunk).toString();
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const data = buffer
            .slice(0, i)
            .split("\n")
            .find((l) => l.startsWith("data:"));
          buffer = buffer.slice(i + 2);
          if (data) events.push(JSON.parse(data.slice(5)));
        }
        if (until(events)) {
          ended = false;
          break;
        }
      }
    } catch {}
    clearTimeout(timer);
    ac.abort();
    return { events, ended };
  };
}
const bigToolResult = (id: string) => ({
  method: "item/completed",
  params: {
    threadId: "thread_1",
    turnId: "turn_1",
    item: {
      id,
      type: "mcpToolCall",
      server: "btp",
      tool: "list_tenants",
      result: { content: [{ type: "text", text: "x".repeat(64 * 1024) }] },
    },
  },
});
test("a large MCP tool result streams live without disconnecting the subscriber", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  const read = await sse(t, manager);
  const reading = read(undefined, (events) =>
    events.some((e) => e.type === "message.delta"),
  );
  await new Promise((r) => setTimeout(r, 100));
  runtime.emit("notification", bigToolResult("mcp_1"));
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "answer",
      delta: "Hi",
    },
  });
  const { events, ended } = await reading;
  assert.equal(ended, false, "server closed the stream");
  assert.deepEqual(
    events.map((e) => e.type),
    ["snapshot", "item.completed", "message.delta"],
  );
});
test("reconnecting behind a large backlog replays it instead of closing", async (t) => {
  const runtime = new Fake(),
    dir = mkdtempSync(join(tmpdir(), "adapter-test-")),
    manager = new ThreadManager(runtime, dir, 2, 50, 1000);
  t.after(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await manager.create({});
  const cursor = manager.snapshot("thread_1").cursor;
  for (const id of ["mcp_1", "mcp_2", "mcp_3"])
    runtime.emit("notification", bigToolResult(id));
  const read = await sse(t, manager);
  const { events, ended } = await read(cursor, (events) =>
    events.some((e) => e.type === "snapshot"),
  );
  assert.equal(ended, false, "server closed the stream during replay");
  assert.deepEqual(
    events.map((e) => e.itemId ?? e.type),
    ["mcp_1", "mcp_2", "mcp_3", "snapshot"],
  );
});

test("goal changes are durable records with their turn; token-only updates are not", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  const goal = {
    threadId: "thread_1",
    objective: "Ship the report",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const update = (g: any, turnId: string | null = "turn_1") =>
    runtime.emit("notification", {
      method: "thread/goal/updated",
      params: { threadId: "thread_1", turnId, goal: g },
    });
  const goalRecords = () =>
    manager
      .records("thread_1")
      .map((r) => r.event)
      .filter((e) => e.type.startsWith("goal."));
  update(goal);
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread_1", turn: { id: "turn_1" } },
  });
  // Codex's count moves and Truex's tally moves: neither is a goal change.
  update({ ...goal, tokensUsed: 500, updatedAt: 2 });
  runtime.emit("notification", {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      tokenUsage: {
        last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
      },
    },
  });
  update({ ...goal, status: "complete", tokensUsed: 700, updatedAt: 3 });
  runtime.emit("notification", {
    method: "thread/goal/cleared",
    params: { threadId: "thread_1" },
  });
  const records = goalRecords();
  assert.deepEqual(
    records.map((e) => [e.type, e.data.goal?.status ?? null, e.turnId]),
    [
      ["goal.updated", "active", "turn_1"],
      ["goal.updated", "complete", "turn_1"],
      ["goal.cleared", null, undefined],
    ],
  );
  assert.equal(records[1].data.goal.tokensUsed, 700);
  assert.equal(records[2].data.goalCreatedAt, 1);
  // The same goal set again after a clear is a change.
  update(goal, null);
  assert.equal(goalRecords().length, 4);
});
// Emits a root collab spawn call naming helper `child_1`.
function spawn(
  runtime: Fake,
  status = "running",
  message: string | null = null,
) {
  runtime.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      item: {
        type: "collabAgentToolCall",
        id: "call_1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread_1",
        receiverThreadIds: ["child_1"],
        prompt: "Research competitor pricing",
        model: null,
        reasoningEffort: null,
        agentsStates: { child_1: { status, message } },
      },
    },
  });
}
test("helper agents link to the root conversation and publish lifecycle events", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "go");
  spawn(runtime);
  runtime.emit("notification", {
    method: "item/started",
    params: {
      threadId: "thread_1",
      item: {
        type: "subAgentActivity",
        id: "act_1",
        kind: "started",
        agentThreadId: "child_1",
        agentPath: "/root/researcher",
      },
    },
  });
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "child_1", turn: { id: "child_turn" } },
  });
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "child_1", itemId: "m1", delta: "Found " },
  });
  runtime.emit("notification", {
    method: "item/started",
    params: {
      threadId: "child_1",
      item: { type: "mcpToolCall", id: "tool", arguments: { secret: "x" } },
    },
  });
  runtime.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "child_1",
      item: { type: "agentMessage", id: "m1", text: "Found three plans" },
    },
  });
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "child_1",
      turn: { id: "child_turn", status: "completed" },
    },
  });
  // No session record is created for the helper.
  assert.equal(manager.threads.has("child_1"), false);
  const snapshot = manager.snapshot("thread_1");
  assert.equal(snapshot.subAgents?.length, 1);
  const agent = snapshot.subAgents![0];
  assert.equal(agent.threadId, "child_1");
  assert.equal(agent.depth, 1);
  assert.equal(agent.path, "/root/researcher");
  assert.equal(agent.task, "Research competitor pricing");
  assert.equal(agent.status, "completed");
  assert.equal(agent.lastMessage, "Found three plans");
  assert.ok(agent.endedAt);
  assert.deepEqual(manager.agent("thread_1", "child_1").messages, [
    { id: "m1", text: "Found three plans", final: true },
  ]);
  assert.deepEqual(manager.agents("thread_1"), snapshot.subAgents);
});
test("helper events stream on the root with no raw tool data", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  const frames: any[] = [];
  const res: any = new EventEmitter();
  Object.assign(res, {
    set() {},
    flushHeaders() {},
    writableLength: 0,
    write(chunk: string) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) frames.push(JSON.parse(line.slice(6)));
      return true;
    },
    destroy() {},
    end() {},
  });
  manager.subscribe("thread_1", res);
  t.after(() => res.emit("close"));
  spawn(runtime, "pendingInit");
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "child_1", itemId: "m1", delta: "Hello" },
  });
  runtime.emit("notification", {
    method: "item/started",
    params: {
      threadId: "child_1",
      item: { type: "mcpToolCall", id: "t", arguments: { q: "raw-args" } },
    },
  });
  spawn(runtime, "completed", "Done");
  const types = frames.map((f) => f.type);
  assert.ok(types.includes("subagent.spawned"));
  assert.ok(types.includes("subagent.completed"));
  const delta = frames.find((f) => f.type === "subagent.event");
  assert.equal(delta.threadId, "thread_1");
  assert.deepEqual(
    {
      kind: delta.data.kind,
      delta: delta.data.delta,
      id: delta.data.agentThreadId,
    },
    { kind: "message.delta", delta: "Hello", id: "child_1" },
  );
  assert.equal(JSON.stringify(frames).includes("raw-args"), false);
  const done = frames.find((f) => f.type === "subagent.completed");
  assert.equal(done.data.agent.lastMessage, "Done");
  assert.equal(done.data.tool, "spawnAgent");
  // Root collab items still flow for the fallback activity label.
  assert.ok(
    frames.some(
      (f) =>
        f.type === "item.completed" &&
        f.data.item?.type === "collabAgentToolCall",
    ),
  );
});
test("helper server requests are declined and never reach the root queue", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  spawn(runtime);
  runtime.emit("serverRequest", {
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "child_1",
      turnId: "ct",
      itemId: "i",
      questions: [
        {
          id: "q1",
          header: "Scope",
          question: "Which region?",
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      autoResolutionMs: null,
    },
  });
  runtime.emit("serverRequest", {
    id: 8,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "child_1", turnId: "ct", itemId: "i" },
  });
  // A helper not yet identified is declined too.
  runtime.emit("serverRequest", {
    id: 9,
    method: "item/tool/requestUserInput",
    params: { threadId: "child_unknown", questions: [] },
  });
  assert.equal(manager.snapshot("thread_1").pending.length, 0);
  const [question, approval, unknown] = runtime.replies;
  assert.equal(question.id, 7);
  assert.match(question.result.answers.q1.answers[0], /main agent/);
  validateResponse("item/tool/requestUserInput", question.result);
  assert.deepEqual(approval.result, { decision: "decline" });
  assert.deepEqual(unknown.result, { answers: {} });
  // Root requests still queue for the user.
  runtime.emit("serverRequest", {
    id: 10,
    method: "item/tool/requestUserInput",
    params: { threadId: "thread_1", questions: [] },
  });
  assert.equal(manager.snapshot("thread_1").pending.length, 1);
});
test("interrupting the root interrupts running helpers; helper routes check ownership", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "go");
  spawn(runtime);
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "child_1", turn: { id: "child_turn" } },
  });
  await manager.interruptAgent("thread_1", "child_1");
  // Name lookups may run in between, so find the stop request itself.
  assert.deepEqual(
    runtime.calls.filter((c) => c.method === "turn/interrupt").at(-1),
    {
      method: "turn/interrupt",
      params: { threadId: "child_1", turnId: "child_turn" },
    },
  );
  // The helper is then shut down so the main agent's wait ends.
  assert.deepEqual(runtime.calls.at(-1), {
    method: "thread/archive",
    params: { threadId: "child_1" },
  });
  await manager.interrupt("thread_1");
  const interrupts = runtime.calls
    .filter((c) => c.method === "turn/interrupt")
    .map((c) => c.params.threadId);
  assert.deepEqual(interrupts, ["child_1", "thread_1", "child_1"]);
  assert.throws(() => manager.agent("thread_1", "nope"), /not found/);
  assert.throws(() => manager.agent("other", "child_1"), /not found/);
  await assert.rejects(
    manager.interruptAgent("thread_1", "missing"),
    (e: any) => e.status === 404,
  );
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "child_1",
      turn: { id: "child_turn", status: "interrupted" },
    },
  });
  assert.equal(manager.agents("thread_1")[0].status, "interrupted");
  await assert.rejects(
    manager.interruptAgent("thread_1", "child_1"),
    (e: any) => e.status === 409,
  );
});
test("thread/started with a spawn source registers nested helpers under the root", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  spawn(runtime);
  runtime.emit("notification", {
    method: "thread/started",
    params: {
      thread: {
        id: "grandchild",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "child_1",
              depth: 2,
              agent_path: "/root/researcher/checker",
              agent_nickname: "Checker",
              agent_role: "reviewer",
            },
          },
        },
      },
    },
  });
  const nested = manager
    .agents("thread_1")
    .find((a) => a.threadId === "grandchild");
  assert.deepEqual(
    [nested?.depth, nested?.nickname, nested?.role, nested?.path],
    [2, "Checker", "reviewer", "/root/researcher/checker"],
  );
  assert.equal(manager.threads.has("grandchild"), false);
  await manager.capability("thread_1", "thread/delete", {});
  assert.throws(() => manager.agent("thread_1", "grandchild"), /not found/);
  // Codex reports each deleted helper afterwards; none becomes a thread.
  for (const id of ["child_1", "grandchild"])
    runtime.emit("notification", {
      method: "thread/deleted",
      params: { threadId: id },
    });
  assert.equal(manager.threads.has("child_1"), false);
  assert.equal(manager.threads.has("grandchild"), false);
});
test("helper transcripts are bounded", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  spawn(runtime);
  for (let i = 0; i < 250; i++)
    runtime.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child_1",
        item: { type: "agentMessage", id: `m${i}`, text: `n${i}` },
      },
    });
  const messages = manager.agent("thread_1", "child_1").messages;
  assert.equal(messages.length, 200);
  assert.equal(messages[0].id, "m50");
});
test("thread create accepts helper settings without sending them as protocol params", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({
    subAgents: { mode: "explicitRequestOnly", maxConcurrent: 9 },
  });
  assert.deepEqual(runtime.calls[0].params.subAgents, {
    mode: "explicitRequestOnly",
    maxConcurrent: 9,
  });
});
test("helper output that arrives before its spawn call is replayed on the root", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "go");
  // The fixture keeps only 3 replay events, so read the live stream.
  const frames: any[] = [];
  const res: any = new EventEmitter();
  Object.assign(res, {
    set() {},
    flushHeaders() {},
    writableLength: 0,
    write(chunk: string) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) frames.push(JSON.parse(line.slice(6)));
      return true;
    },
    destroy() {},
    end() {},
  });
  manager.subscribe("thread_1", res);
  t.after(() => res.emit("close"));
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "child_1", itemId: "m1", delta: "Early" },
  });
  runtime.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "child_1",
      item: { type: "agentMessage", id: "m1", text: "Early words" },
    },
  });
  // Nothing observable exists for the helper until it is identified.
  assert.equal(manager.threads.has("child_1"), false);
  spawn(runtime);
  const sub = frames.filter((e: any) => e.type === "subagent.event");
  assert.deepEqual(
    sub.map((e: any) => e.data.kind),
    ["message.delta", "message.final"],
  );
  assert.equal(sub[0].data.delta, "Early");
  assert.equal(manager.threads.has("child_1"), false);
  assert.equal(
    existsSync(join(manager.home, "adapter-records", "child_1")),
    false,
  );
});
test("a helper runs through spawn, wait and close on the root stream", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "go");
  const frames: any[] = [];
  const res: any = new EventEmitter();
  Object.assign(res, {
    set() {},
    flushHeaders() {},
    writableLength: 0,
    write(chunk: string) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) frames.push(JSON.parse(line.slice(6)));
      return true;
    },
    destroy() {},
    end() {},
  });
  manager.subscribe("thread_1", res);
  t.after(() => res.emit("close"));
  const collab = (
    method: string,
    tool: string,
    status: string,
    states: Record<string, any>,
  ) =>
    runtime.emit("notification", {
      method,
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: {
          type: "collabAgentToolCall",
          id: `call_${tool}`,
          tool,
          status,
          senderThreadId: "thread_1",
          receiverThreadIds: ["child_1"],
          prompt: tool === "spawnAgent" ? "Summarise the pricing page" : null,
          model: null,
          reasoningEffort: null,
          agentsStates: states,
        },
      },
    });
  const child = (method: string, params: any) =>
    runtime.emit("notification", {
      method,
      params: { threadId: "child_1", ...params },
    });
  collab("item/started", "spawnAgent", "inProgress", {});
  collab("item/completed", "spawnAgent", "completed", {
    child_1: { status: "pendingInit", message: null },
  });
  child("turn/started", { turn: { id: "ct1" } });
  child("item/agentMessage/delta", { itemId: "cm1", delta: "Plans start" });
  collab("item/started", "wait", "inProgress", {
    child_1: { status: "running", message: null },
  });
  child("item/completed", {
    item: { type: "agentMessage", id: "cm1", text: "Plans start at $10" },
  });
  child("turn/completed", { turn: { id: "ct1", status: "completed" } });
  collab("item/completed", "wait", "completed", {
    child_1: { status: "completed", message: "Plans start at $10" },
  });
  collab("item/completed", "closeAgent", "completed", {
    child_1: { status: "shutdown", message: null },
  });

  const lifecycle = frames
    .filter(
      (f) => f.type.startsWith("subagent.") && f.type !== "subagent.event",
    )
    .map((f) => [f.type, f.data.agent.status]);
  assert.deepEqual(lifecycle[0], ["subagent.spawned", "pendingInit"]);
  assert.ok(
    lifecycle.some(
      ([type, s]) => type === "subagent.status" && s === "running",
    ),
  );
  assert.equal(
    lifecycle.filter(([type]) => type === "subagent.completed").length,
    1,
  );
  const kinds = frames
    .filter((f) => f.type === "subagent.event")
    .map((f) => f.data.kind);
  assert.deepEqual(kinds, [
    "turn.started",
    "message.delta",
    "message.final",
    "turn.completed",
  ]);
  const [agent] = manager.snapshot("thread_1").subAgents;
  assert.equal(agent.task, "Summarise the pricing page");
  assert.equal(agent.lastMessage, "Plans start at $10");
  assert.ok(agent.endedAt);
  assert.equal(JSON.stringify(frames).includes('"arguments"'), false);
});
test("helpers take the nickname Codex gave their thread", async (t) => {
  const { runtime, manager } = fixture(t);
  const request = runtime.request.bind(runtime);
  runtime.request = async (method: string, params: any) => {
    if (method !== "thread/read") return request(method, params);
    runtime.calls.push({ method, params });
    return {
      thread: {
        id: params.threadId,
        agentNickname: "Hypatia",
        agentRole: null,
      },
    };
  };
  await manager.create({});
  spawn(runtime);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(manager.agents("thread_1")[0].nickname, "Hypatia");
  assert.deepEqual(
    runtime.calls
      .filter((c) => c.method === "thread/read")
      .map((c) => c.params),
    [{ threadId: "child_1", includeTurns: false }],
  );
  const events = (manager.threads.get("thread_1") as any).events;
  assert.equal(events.at(-1).type, "subagent.status");
  assert.equal(events.at(-1).data.agent.nickname, "Hypatia");
});
test("a stopped helper stays stopped after it is shut down", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "go");
  spawn(runtime);
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "child_1", turn: { id: "ct" } },
  });
  await manager.interruptAgent("thread_1", "child_1");
  runtime.emit("notification", {
    method: "turn/completed",
    params: { threadId: "child_1", turn: { id: "ct", status: "interrupted" } },
  });
  // Codex then reports the shut-down helper as closed and missing.
  runtime.emit("notification", {
    method: "thread/archived",
    params: { threadId: "child_1" },
  });
  spawn(runtime, "notFound");
  assert.equal(manager.agents("thread_1")[0].status, "interrupted");
});

test("token usage is published as turn usage and turn.completed carries a trace", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "reach me at jane.doe@example.com");
  const thread = manager.threads.get("thread_1")!;
  const types: string[] = [];
  const at = Date.now();
  runtime.emit("notification", {
    method: "item/started",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      startedAtMs: at,
      item: {
        type: "commandExecution",
        id: "c1",
        command: "ls -la /secret",
        status: "inProgress",
      },
    },
  });
  runtime.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      completedAtMs: at + 50,
      item: {
        type: "commandExecution",
        id: "c1",
        command: "ls -la /secret",
        aggregatedOutput: "card 4111 1111 1111 1111",
        status: "completed",
      },
    },
  });
  const breakdown = {
    totalTokens: 130,
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 0,
    outputTokens: 30,
    reasoningOutputTokens: 10,
  };
  runtime.emit("notification", {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      tokenUsage: {
        total: breakdown,
        last: breakdown,
        modelContextWindow: 200000,
      },
    },
  });
  types.push(thread.events.at(-1)!.type);
  assert.deepEqual(types, ["usage.updated"]);
  assert.deepEqual(thread.events.at(-1)!.data, {
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 130,
      contextWindow: 200000,
      contextUsedTokens: 100,
    },
  });
  runtime.emit("notification", {
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitName: "codex",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 },
        secondary: null,
        rateLimitReachedType: null,
      },
    },
  });
  assert.deepEqual(
    thread.events.slice(-2).map((e) => e.type),
    ["runtime.event", "limits.updated"],
  );
  assert.equal(manager.snapshot("thread_1").rateLimits?.primaryUsedPercent, 12);
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread_1",
      turn: { id: "turn_1", status: "completed" },
    },
  });
  const done = thread.events.at(-1)!;
  assert.equal(done.type, "turn.completed");
  const trace = done.data.trace;
  assert.equal(trace.turnId, "turn_1");
  assert.equal(trace.totalMs, done.data.timing.totalMs);
  assert.deepEqual(
    trace.steps.map((s: any) => [s.label, s.durationMs, s.status]),
    [["Ran a command", 50, "completed"]],
  );
  assert.equal(trace.usage.totalTokens, 130);
  assert.equal(trace.rateLimits.primaryUsedPercent, 12);
  assert.deepEqual(
    trace.privacy.findings.map((f: any) => `${f.kind}:${f.source}`).sort(),
    ["card:toolOutput", "email:userMessage"],
  );
  // The durable record carries the trace, without raw values or commands.
  const record = manager
    .records("thread_1")
    .map((r) => r.event)
    .find((e) => e.type === "turn.completed")!;
  assert.deepEqual(record.data.trace, trace);
  const json = JSON.stringify(record.data.trace);
  assert.ok(!/jane|4111|secret/.test(json));
  assert.deepEqual(manager.snapshot("thread_1").traces, [trace]);
  // The masked context is live only.
  const context = manager.turnContext("thread_1", "turn_1");
  assert.equal(context.reconstructed, true);
  assert.ok(!JSON.stringify(context).includes("jane.doe@example.com"));
  assert.ok(
    !JSON.stringify(manager.records("thread_1")).includes("reconstructed"),
  );
  assert.throws(
    () => manager.turnContext("thread_1", "turn_unknown"),
    /not available/,
  );
});
test("helper items and usage join the parent turn's trace", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "go");
  runtime.emit("notification", {
    method: "thread/started",
    params: {
      thread: {
        id: "child_1",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "thread_1",
              depth: 1,
              agent_path: "/root/scout",
              agent_nickname: "Scout",
              agent_role: "explorer",
            },
          },
        },
      },
    },
  });
  const thread = manager.threads.get("thread_1")!;
  const before = thread.seq;
  const at = Date.now();
  runtime.emit("notification", {
    method: "item/started",
    params: {
      threadId: "child_1",
      turnId: "ct",
      startedAtMs: at,
      item: { type: "webSearch", id: "w1", query: "private" },
    },
  });
  runtime.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "child_1",
      turnId: "ct",
      completedAtMs: at + 20,
      item: { type: "webSearch", id: "w1", query: "private" },
    },
  });
  for (const n of [10, 15])
    runtime.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "child_1",
        turnId: "ct",
        tokenUsage: {
          last: { inputTokens: n, outputTokens: 1, totalTokens: n + 1 },
        },
      },
    });
  // Nothing extra reaches the UI for helper items or usage.
  assert.equal(thread.seq, before);
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread_1",
      turn: { id: "turn_1", status: "completed" },
    },
  });
  const trace = thread.events.at(-1)!.data.trace;
  assert.deepEqual(
    trace.steps.map((s: any) => [
      s.label,
      s.agent,
      s.agentThreadId,
      s.durationMs,
    ]),
    [["Searched the web", "Scout", "child_1", 20]],
  );
  assert.equal(trace.helperUsage.inputTokens, 25);
  assert.equal(trace.helperUsage.totalTokens, 27);
  assert.equal(trace.usage, null);
});
test("the plan survives new turns and ignores stale updates from older turns", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  await manager.message("thread_1", "long task");
  const first = [{ step: "Draft outline", status: "pending" }];
  runtime.emit("notification", {
    method: "turn/plan/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      explanation: "Proposed plan",
      plan: first,
    },
  });
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread_1",
      turn: { id: "turn_1", status: "completed" },
    },
  });
  // The next turn starts with the previous plan still in place.
  const request = runtime.request.bind(runtime);
  runtime.request = async (method: string, params: any) => {
    if (method !== "turn/start") return request(method, params);
    runtime.calls.push({ method, params });
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread_1", turn: { id: "turn_2" } },
    });
    return { turn: { id: "turn_2" } };
  };
  await manager.message("thread_1", "Approve");
  assert.deepEqual(manager.snapshot("thread_1").plan, first);
  const second = [{ step: "Draft outline", status: "in_progress" }];
  runtime.emit("notification", {
    method: "turn/plan/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_2",
      explanation: null,
      plan: second,
    },
  });
  assert.deepEqual(manager.snapshot("thread_1").plan, second);
  const before = manager.records("thread_1").length;
  runtime.emit("notification", {
    method: "turn/plan/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      explanation: null,
      plan: [{ step: "Old", status: "pending" }],
    },
  });
  assert.deepEqual(manager.snapshot("thread_1").plan, second);
  assert.equal(manager.records("thread_1").length, before);
});
test("an unanswered question proceeds with its recommended option; tool approvals still decline", async (t) => {
  const { runtime, manager } = fixture(t, 30);
  await manager.create({});
  const question = (id: string, labels: string[]) => ({
    id,
    header: "Plan",
    question: "Approve?",
    isOther: true,
    isSecret: false,
    options: labels.map((label) => ({ label, description: "" })),
  });
  runtime.emit("serverRequest", {
    id: 21,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_1",
      questions: [question("plan_approval", ["Revise", "Approve"])],
    },
  });
  runtime.emit("serverRequest", {
    id: 22,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_1",
      questions: [question("scope", ["Narrow", "Broad (Recommended)"])],
    },
  });
  runtime.emit("serverRequest", {
    id: 23,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_1",
      questions: [question("mcp_tool_call_approval_x", ["Allow", "Cancel"])],
    },
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(manager.snapshot("thread_1").pending.length, 0);
  const reply = (id: number) => runtime.replies.find((r) => r.id === id);
  assert.deepEqual(reply(21).result.answers.plan_approval.answers, [
    "Approve",
    AUTO_NOTE,
  ]);
  assert.equal(
    reply(22).result.answers.scope.answers[0],
    "Broad (Recommended)",
  );
  assert.deepEqual(reply(23).result, { answers: {} });
  for (const id of [21, 22])
    validateResponse("item/tool/requestUserInput", reply(id).result);
  const reasons = manager
    .records("thread_1")
    .map((r) => r.event.data.reason)
    .filter(Boolean);
  assert.deepEqual(reasons.sort(), [
    "auto-recommended",
    "auto-recommended",
    "expired",
  ]);
});
