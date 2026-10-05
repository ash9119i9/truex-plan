import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
class Fake extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  failArchive = false;
  failInterrupt = false;
  hangArchive = false;
  active = false;
  onRead?: (id: string) => void;
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: "root", turns: [] } };
    if (method === "turn/start") return { turn: { id: "root_turn" } };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "turn/interrupt" && this.failInterrupt)
      throw new Error("unavailable");
    if (method === "thread/archive") {
      if (this.hangArchive) return new Promise(() => {});
      if (this.failArchive) throw new Error("unavailable");
    }
    if (method === "thread/read") {
      this.onRead?.(params.threadId);
      return {
        thread: {
          id: params.threadId,
          status: { type: this.active ? "active" : "idle" },
        },
      };
    }
    return {};
  }
  respond() {}
  spawn(id = "helper", parent = "root", turn = "helper_turn") {
    this.emit("notification", {
      method: "thread/started",
      params: {
        thread: {
          id,
          source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
        },
      },
    });
    if (turn)
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: id, turn: { id: turn } },
      });
  }
}
function fixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), "helper-stop-"));
  const runtime = new Fake();
  const manager = new ThreadManager(
    runtime,
    home,
    5,
    100,
    1000,
    900000,
    25,
    25,
  );
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, runtime, manager };
}
test("helper Stop confirms shutdown and keeps root, goal and siblings untouched", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.spawn();
  runtime.spawn("sibling");
  const result = await manager.interruptAgent("root", "helper");
  assert.equal(result.agent.status, "interrupted");
  assert.equal(result.agent.stopStatus, undefined);
  assert.equal(manager.snapshot("root").state.kind, "running");
  assert.equal(
    manager.agents("root").find((a) => a.threadId === "sibling")?.status,
    "running",
  );
  assert.ok(
    runtime.calls.some(
      (c) => c.method === "thread/read" && c.params.threadId === "helper",
    ),
  );
  assert.ok(!runtime.calls.some((c) => c.method === "thread/goal/set"));
  assert.deepEqual(
    runtime.calls
      .filter((c) => c.method === "turn/interrupt")
      .map((c) => c.params.threadId),
    ["helper"],
  );
});
test("archive failure is retryable and durable; ACK alone cannot report success", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  runtime.spawn();
  runtime.failArchive = true;
  await assert.rejects(
    manager.interruptAgent("root", "helper"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal(manager.agents("root")[0].stopStatus, "unconfirmed");
  assert.ok(
    existsSync(join(home, "helper-stop-intents", "root", "helper.json")),
  );
  runtime.failArchive = false;
  await manager.interruptAgent("root", "helper");
  assert.equal(manager.agents("root")[0].stopStatus, undefined);
  assert.ok(
    !existsSync(join(home, "helper-stop-intents", "root", "helper.json")),
  );
});
test("active metadata refuses confirmation and concurrent clicks coalesce", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn();
  runtime.active = true;
  const result = await Promise.allSettled([
    manager.interruptAgent("root", "helper"),
    manager.interruptAgent("root", "helper"),
  ]);
  assert.ok(result.every((r) => r.status === "rejected"));
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/interrupt").length,
    1,
  );
  assert.equal(manager.agents("root")[0].stopStatus, "unconfirmed");
});
test("pending initialization can be stopped and repeated confirmed Stop is idempotent", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn("helper", "root", "");
  await manager.interruptAgent("root", "helper");
  assert.equal(
    runtime.calls.find((c) => c.method === "turn/interrupt")?.params.turnId,
    "",
  );
  const before = runtime.calls.length;
  assert.equal((await manager.interruptAgent("root", "helper")).ok, true);
  assert.equal(runtime.calls.length, before);
});
test("restart restores helper recovery without blocking or stopping parent", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  runtime.spawn();
  runtime.failArchive = true;
  await assert.rejects(manager.interruptAgent("root", "helper"));
  manager.close();
  const nextRuntime = new Fake();
  const next = new ThreadManager(
    nextRuntime,
    home,
    5,
    100,
    1000,
    900000,
    25,
    25,
  );
  t.after(() => next.close());
  assert.equal(next.snapshot("root").state.kind, "idle");
  assert.equal(next.agents("root")[0].stopStatus, "unconfirmed");
  await next.interruptAgent("root", "helper");
  assert.equal(next.agents("root")[0].status, "interrupted");
});
test("helper shutdown hangs are bounded and main Stop absorbs the pending intent", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.spawn();
  runtime.hangArchive = true;
  const start = performance.now();
  await assert.rejects(manager.interruptAgent("root", "helper"));
  assert.ok(performance.now() - start < 500);
  runtime.hangArchive = false;
  await manager.interrupt("root");
  assert.equal(manager.agents("root")[0].stopStatus, undefined);
  assert.ok(
    !existsSync(join(home, "helper-stop-intents", "root", "helper.json")),
  );
});

test("helper Stop includes nested helpers and discovers a descendant during reconciliation", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn();
  runtime.spawn("nested", "helper", "nested_turn");
  runtime.spawn("sibling");
  let added = false;
  runtime.onRead = (id) => {
    if (id === "helper" && !added) {
      added = true;
      runtime.spawn("late_nested", "helper", "late_turn");
    }
  };
  await manager.interruptAgent("root", "helper");
  assert.deepEqual(
    runtime.calls
      .filter((c) => c.method === "turn/interrupt")
      .map((c) => c.params.threadId)
      .sort(),
    ["helper", "late_nested", "nested"],
  );
  assert.equal(
    manager.agents("root").find((a) => a.threadId === "late_nested")?.status,
    "interrupted",
  );
  assert.equal(
    manager.agents("root").find((a) => a.threadId === "sibling")?.status,
    "running",
  );
});
test("a new helper turn discovered during metadata reads is interrupted before confirmation", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn();
  let changed = false;
  runtime.onRead = (id) => {
    if (id === "helper" && !changed) {
      changed = true;
      runtime.emit("notification", {
        method: "turn/started",
        params: { threadId: "helper", turn: { id: "new_turn" } },
      });
    }
  };
  await manager.interruptAgent("root", "helper");
  assert.deepEqual(
    runtime.calls
      .filter((c) => c.method === "turn/interrupt")
      .map((c) => c.params.turnId),
    ["helper_turn", "new_turn"],
  );
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "helper", turn: { id: "helper_turn" } },
  });
  assert.equal(manager.agents("root")[0].status, "interrupted");
});
test("natural helper completion remains completed after confirmed Stop", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn();
  runtime.onRead = (id) => {
    if (id === "helper")
      runtime.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: "helper",
          turn: { id: "helper_turn", status: "completed" },
        },
      });
  };
  const result = await manager.interruptAgent("root", "helper");
  assert.equal(result.agent.status, "completed");
  assert.equal(result.agent.stopStatus, undefined);
});
test("runtime exit cannot confirm Stop in an old generation; retry recovers", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn();
  let exited = false;
  runtime.onRead = (id) => {
    if (id === "helper" && !exited) {
      exited = true;
      runtime.emit("exit");
    }
  };
  await assert.rejects(
    manager.interruptAgent("root", "helper"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal(manager.agents("root")[0].stopStatus, "unconfirmed");
  await manager.interruptAgent("root", "helper");
  assert.equal(manager.agents("root")[0].stopStatus, undefined);
});
test("corrupt recovery storage stays rejected across repeated snapshots", async (t) => {
  const { manager, home } = fixture(t);
  mkdirSync(join(home, "helper-stop-intents", "root"), { recursive: true });
  writeFileSync(join(home, "helper-stop-intents", "root", "helper.json"), "{");
  for (let i = 0; i < 2; i++)
    assert.throws(
      () => manager.snapshot("root"),
      (e: any) => e.code === "STOP_STORAGE_INVALID",
    );
});
test("helper ownership is checked before cancellation", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn();
  await assert.rejects(
    manager.interruptAgent("other", "helper"),
    (e: any) => e.code === "AGENT_NOT_FOUND",
  );
  await assert.rejects(
    manager.interruptAgent("root", "../helper"),
    (e: any) => e.code === "AGENT_NOT_FOUND",
  );
  assert.equal(
    runtime.calls.filter(
      (c) => c.method === "turn/interrupt" || c.method === "thread/archive",
    ).length,
    0,
  );
});

test("failed durable intent write cancels no work and remains retryable", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  runtime.spawn();
  const dir = join(home, "helper-stop-intents", "root");
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "blocked");
  await assert.rejects(
    manager.interruptAgent("root", "helper"),
    (e: any) => e.code === "STOP_STORAGE_INVALID",
  );
  assert.equal(
    runtime.calls.filter(
      (c) => c.method === "turn/interrupt" || c.method === "thread/archive",
    ).length,
    0,
  );
  assert.equal(manager.agents("root")[0].stopStatus, "unconfirmed");
  rmSync(dir);
  mkdirSync(dir);
  await manager.interruptAgent("root", "helper");
  assert.equal(manager.agents("root")[0].stopStatus, undefined);
});

test("conversation deletion cannot discard an unresolved helper intent", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  runtime.spawn();
  runtime.failArchive = true;
  await assert.rejects(manager.interruptAgent("root", "helper"));
  await assert.rejects(
    manager.capability("root", "thread/delete", {}),
    (e: any) => e.status === 409,
  );
  assert.equal(
    runtime.calls.filter((c) => c.method === "thread/delete").length,
    0,
  );
});

test("main Stop absorbs unresolved helper recovery even after the parent becomes idle", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  runtime.spawn();
  runtime.failArchive = true;
  await assert.rejects(manager.interruptAgent("root", "helper"));
  assert.equal(manager.snapshot("root").state.kind, "idle");
  runtime.failArchive = false;
  await manager.interrupt("root");
  assert.equal(manager.agents("root")[0].stopStatus, undefined);
  assert.ok(
    !existsSync(join(home, "helper-stop-intents", "root", "helper.json")),
  );
});
