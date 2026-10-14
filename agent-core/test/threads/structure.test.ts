import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import { ThreadManager } from "../../src/threads/manager";
import * as managerExports from "../../src/threads/manager";
import * as legacyManagerExports from "../../src/manager";
import * as approvalExports from "../../src/threads/approval-policy";
import * as legacyApprovalExports from "../../src/approval-modes";

class Fake extends EventEmitter {
  calls: string[] = [];
  completeBeforeResponse = false;
  async request(method: string) {
    this.calls.push(method);
    if (method === "thread/start") return { thread: { id: "thread_1" } };
    if (method === "turn/start") {
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread_1", turn: { id: "turn_1" } },
      });
      if (this.completeBeforeResponse)
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread_1",
            turn: { id: "turn_1", status: "completed" },
          },
        });
      return { turn: { id: "turn_1" } };
    }
    return {};
  }
  respond() {}
}

class Subscriber extends EventEmitter {
  chunks: string[] = [];
  writableLength = 0;
  destroyed = false;
  set() {}
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
  end() {
    this.destroy();
  }
  events() {
    return [...this.chunks.join("").matchAll(/^data: (.+)$/gm)].map((m) =>
      JSON.parse(m[1]),
    );
  }
}

function fixture(t: { after(fn: () => void): void }, stallMs = 1000) {
  const runtime = new Fake();
  const home = mkdtempSync(join(tmpdir(), "thread-structure-"));
  const manager = new ThreadManager(runtime, home, 2, 100, 1000, stallMs);
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { runtime, home, manager };
}

test("durable storage failure reports the update and error before disconnecting and draining", async (t) => {
  const { runtime, home, manager } = fixture(t);
  await manager.create({});
  const subscriber = new Subscriber();
  manager.subscribe("thread_1", subscriber as unknown as Response);
  subscriber.chunks = [];
  writeFileSync(join(home, "adapter-records", "thread_1"), "blocked");

  runtime.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      item: { id: "message_1", type: "agentMessage", text: "Final answer" },
    },
  });

  const events = subscriber.events();
  assert.deepEqual(
    events.map((event) => event.type),
    ["message.final", "error"],
  );
  assert.equal(events[0].data.text, "Final answer");
  assert.equal(events[1].data.code, "STORAGE_UNAVAILABLE");
  assert.equal(events[1].data.willRetry, false);
  assert.equal(subscriber.destroyed, true);
  assert.equal(manager.draining, true);
  await assert.rejects(manager.create({}), { status: 503, code: "DRAINING" });
});

test("completion before the start response keeps the thread idle without a later watchdog failure", async (t) => {
  const { runtime, manager } = fixture(t, 25);
  runtime.completeBeforeResponse = true;
  await manager.create({});
  const subscriber = new Subscriber();
  manager.subscribe("thread_1", subscriber as unknown as Response);
  subscriber.chunks = [];

  assert.deepEqual(await manager.message("thread_1", "Hello"), {
    turnId: "turn_1",
    steer: false,
  });
  assert.deepEqual(manager.snapshot("thread_1").state, { kind: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(manager.snapshot("thread_1").state, { kind: "idle" });
  assert.equal(runtime.calls.includes("turn/interrupt"), false);
  const events = subscriber.events();
  assert.equal(
    events.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.equal(
    events.some((event) => event.data?.code === "TURN_STALLED"),
    false,
  );
});

test("manager and approval policy legacy imports preserve exact export identity", () => {
  for (const [legacy, current] of [
    [legacyManagerExports, managerExports],
    [legacyApprovalExports, approvalExports],
  ]) {
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(current).sort());
    for (const key of Object.keys(legacy))
      assert.equal(
        (legacy as Record<string, unknown>)[key],
        (current as Record<string, unknown>)[key],
      );
  }
});
