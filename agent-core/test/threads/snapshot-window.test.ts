import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../../src/manager";
import type { Snapshot } from "../../../shared/contracts";

class FakeRuntime extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    return method === "thread/start" ? { thread: { id: "thread" } } : {};
  }
  respond() {}
}

function fixture(t: any) {
  const runtime = new FakeRuntime();
  const home = mkdtempSync(join(tmpdir(), "snapshot-window-"));
  const manager = new ThreadManager(runtime, home, 20, 500);
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { manager, runtime };
}

const windowed = (manager: ThreadManager) =>
  (manager.snapshot as (...args: any[]) => Snapshot)("thread", {
    window: true,
  });

function seed(manager: ThreadManager, runtime: FakeRuntime, count = 100) {
  for (let i = 0; i < count; i++)
    runtime.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: `turn-${i}`,
        item: { id: `item-${i}`, type: "agentMessage", text: `answer-${i}` },
      },
    });
  const thread = manager.threads.get("thread")!;
  thread.thinking = Array.from({ length: count }, (_, i) => ({
    id: `reason-${i}`,
    turnId: `turn-${i}`,
    summary: `summary-${i}`,
    raw: `raw-${i}`,
    done: true,
  }));
  return thread;
}

test("source window selects complete recent turn groups before encoding, default remains full", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  const thread = seed(manager, runtime);
  thread.messages.splice(91, 0, {
    id: "second-answer",
    turnId: "turn-90",
    text: "second",
    final: true,
  });
  const full = manager.snapshot("thread");
  assert.equal(full.messages.length, 101);
  assert.equal(full.thinking?.length, 100);
  const recent = windowed(manager);
  assert.deepEqual(
    recent.messages,
    full.messages.filter((m) => Number(m.turnId?.slice(5)) >= 90),
  );
  assert.deepEqual(recent.thinking, full.thinking?.slice(-10));
  assert.equal(recent.cursor, full.cursor);
  assert.equal(recent.state, full.state);
  Object.defineProperty(thread.messages[0], "text", {
    get() {
      throw new Error("Historical body must not be encoded");
    },
  });
  assert.doesNotThrow(() => JSON.stringify(windowed(manager)));
  assert.throws(
    () => JSON.stringify(manager.snapshot("thread")),
    /Historical body/,
  );
});

test("source window retains active, pending and unfinished old groups with full authoritative operational state", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  const thread = seed(manager, runtime);
  thread.state = { kind: "running", turnId: "turn-0" };
  thread.messages[2].final = false;
  thread.thinking[3].done = false;
  runtime.emit("serverRequest", {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn-1", itemId: "item-1" },
  });
  const full = manager.snapshot("thread");
  const recent = windowed(manager);
  for (const turnId of ["turn-0", "turn-1", "turn-2", "turn-3"])
    assert.ok(
      recent.messages.some((m) => m.turnId === turnId),
      turnId,
    );
  assert.deepEqual(recent.pending, full.pending);
  assert.deepEqual(recent.state, { kind: "running", turnId: "turn-0" });
  assert.equal(recent.pending.length, 1);
  assert.deepEqual(recent.goal, full.goal);
  assert.deepEqual(recent.plan, full.plan);
  assert.deepEqual(recent.subAgents, full.subAgents);
  assert.equal(thread.messages.length, 100, "source storage is unchanged");
});

test("source window retains unknown unfinished identities and bounds finalized legacy records", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  const thread = seed(manager, runtime);
  thread.messages.push(
    ...Array.from({ length: 50 }, (_, i) => ({
      id: `legacy-${i}`,
      text: `${i}`,
      final: true,
    })),
  );
  thread.messages.unshift({ id: "unfinished", text: "draft", final: false });
  thread.thinking.unshift({
    id: "unfinished-reason",
    summary: "working",
    raw: "raw",
    done: false,
  });
  const recent = windowed(manager);
  assert.ok(recent.messages.some((m) => m.id === "unfinished"));
  assert.ok(recent.thinking?.some((r) => r.id === "unfinished-reason"));
  assert.equal(
    recent.messages.filter((m) => m.id.startsWith("legacy-")).length,
    20,
  );
  assert.equal(thread.messages.length, 151);
});

test("create acknowledges only validated applied selected approval mode", async (t) => {
  const { manager, runtime } = fixture(t);
  const normal = await manager.create({});
  assert.equal(Object.hasOwn(normal, "approvalMode"), false);
  for (const approvalMode of ["ask", "readOnly", "auto"])
    assert.equal(
      ((await manager.create({ approvalMode })) as any).approvalMode,
      approvalMode,
    );
  const calls = runtime.calls.length;
  await assert.rejects(
    manager.create({ approvalMode: "invalid" }),
    /Approval mode/,
  );
  assert.equal(runtime.calls.length, calls);
});

test("loaded resume acknowledges an explicitly applied approval mode, omitted mode keeps response compatible", async (t) => {
  const { manager } = fixture(t);
  await manager.create({});
  assert.equal(
    Object.hasOwn(await manager.resume("thread"), "approvalMode"),
    false,
  );
  for (const approvalMode of ["ask", "readOnly", "auto"])
    assert.equal(
      ((await manager.resume("thread", { approvalMode })) as any).approvalMode,
      approvalMode,
    );
  await assert.rejects(
    manager.resume("thread", { approvalMode: "invalid" }),
    /Approval mode/,
  );
});
