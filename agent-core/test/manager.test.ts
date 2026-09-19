import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
import { defaults, validateResponse } from "../src/requests";
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
