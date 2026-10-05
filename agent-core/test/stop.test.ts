import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
import { BusinessRuntime } from "../src/business-runtime";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class StopRuntime extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  statuses = new Map<string, string>([["root", "idle"]]);
  goal: any = null;
  failInterrupt = false;
  hangInterrupt = false;
  hangRead = false;
  onInterrupt?: (id: string) => void;
  starts = 0;
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "root" } };
    if (method === "thread/resume")
      return { thread: { id: "root", turns: [] } };
    if (method === "thread/goal/get") return { goal: this.goal };
    if (method === "thread/goal/set") {
      this.goal = { ...this.goal, status: params.status };
      return { goal: this.goal };
    }
    if (method === "turn/start") {
      const id = ++this.starts === 1 ? "turn" : `turn_${this.starts}`;
      this.statuses.set("root", "active");
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: "root", turn: { id } },
      });
      return { turn: { id } };
    }
    if (method === "turn/interrupt") {
      this.onInterrupt?.(params.threadId);
      if (this.failInterrupt) throw new Error("interrupt unavailable");
      if (this.hangInterrupt) return new Promise(() => {});
      this.statuses.set(params.threadId, "idle");
      return {};
    }
    if (method === "thread/archive") {
      if (!this.failInterrupt) this.statuses.set(params.threadId, "notLoaded");
      return {};
    }
    if (method === "thread/read") {
      if (this.hangRead) return new Promise(() => {});
      return {
        thread: {
          id: params.threadId,
          status: { type: this.statuses.get(params.threadId) },
          turns: [],
        },
      };
    }
    return {};
  }
  respond() {}
  complete(id = "root", turn = "turn", status = "interrupted") {
    this.statuses.set(id, "idle");
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: id, turn: { id: turn, status } },
    });
  }
}

function fixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), "truex-stop-"));
  const runtime = new StopRuntime();
  const manager = new ThreadManager(
    runtime,
    home,
    5,
    100,
    1000,
    900_000,
    30,
    30,
  );
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, runtime, manager };
}

test("Stop recovers a missing completion, preserves partial text, and terminalizes once", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "investigate");
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: {
      threadId: "root",
      turnId: "turn",
      itemId: "partial",
      delta: "Evidence so far",
    },
  });
  await Promise.all([manager.interrupt("root"), manager.interrupt("root")]);
  assert.equal(manager.snapshot("root").state.kind, "idle");
  assert.equal(manager.snapshot("root").messages[0].text, "Evidence so far");
  assert.ok(
    manager
      .records("root")
      .some(
        (r) =>
          r.event.type === "message.final" &&
          r.event.data.text === "Evidence so far",
      ),
  );
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/interrupt").length,
    1,
  );
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/start").length,
    1,
  );
  runtime.complete();
  assert.equal(
    manager.records("root").filter((r) => r.event.type === "turn.completed")
      .length,
    1,
  );
  await manager.message("root", "continue");
  runtime.complete("root", "turn");
  assert.equal(manager.snapshot("root").state.kind, "running");
});

test("Stop pauses an active goal on the server before interruption", async (t) => {
  const { manager, runtime } = fixture(t);
  runtime.goal = {
    objective: "Reconcile orders",
    status: "active",
    createdAt: 1,
    tokenBudget: 1000,
  };
  await manager.create({});
  await manager.message("root", "work");
  await manager.interrupt("root");
  assert.equal(runtime.goal.status, "paused");
  assert.equal(runtime.goal.tokenBudget, 1000);
  const methods = runtime.calls.map((c) => c.method);
  assert.ok(
    methods.indexOf("thread/goal/set") < methods.indexOf("turn/interrupt"),
  );
  assert.equal((manager.snapshot("root").goal as any).status, "paused");
});

test("A natural completion racing Stop keeps its native outcome", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.onInterrupt = () => runtime.complete("root", "turn", "completed");
  await manager.interrupt("root");
  assert.equal(
    manager.records("root").find((r) => r.event.type === "turn.completed")
      ?.event.data.turn.status,
    "completed",
  );
});

test("Stop during a missing start ACK is bounded, coalesced, and attaches the late native ID", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  const ack = deferred<any>();
  const request = runtime.request.bind(runtime);
  runtime.request = (method, params) => {
    if (method === "turn/start") {
      runtime.calls.push({ method, params });
      runtime.statuses.set("root", "active");
      return ack.promise;
    }
    return request(method, params);
  };
  const message = manager.message("root", "work");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal(
    (manager.snapshot("root").state as any).stopStatus,
    "unconfirmed",
  );
  const intent = JSON.parse(
    readFileSync(join(home, "stop-intents", "root.json"), "utf8"),
  );
  assert.equal(intent.targets[0].turnId, "");
  await assert.rejects(
    manager.message("root", "unsafe"),
    (e: any) => e.code === "INTERRUPTING",
  );
  await assert.rejects(
    manager.capability("root", "thread/goal/set", { status: "active" }),
    (e: any) => e.code === "INTERRUPTING",
  );
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal((manager as any).stopAttempts.size, 1);
  ack.resolve({ turn: { id: "native_start" } });
  await message;
  await manager.interrupt("root");
  assert.equal(manager.snapshot("root").state.kind, "idle");
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/start").length,
    1,
  );
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/interrupt").length,
    1,
  );
  assert.equal(
    manager.records("root").find((r) => r.event.type === "turn.completed")
      ?.event.turnId,
    "native_start",
  );
  runtime.complete("root", "native_start");
  assert.equal(
    manager.records("root").filter((r) => r.event.type === "turn.completed")
      .length,
    1,
  );
});

test("Stop fences a queued message before startup preparation can submit a turn", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  const prepare = deferred();
  (manager as any).applyPending = () => prepare.promise;
  const message = manager.message("root", "work");
  const rejected = assert.rejects(
    message,
    (e: any) => e.code === "INTERRUPTING",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const stop = manager.interrupt("root");
  prepare.resolve();
  await rejected;
  await stop;
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/start").length,
    0,
  );
  assert.ok(
    runtime.calls.some(
      (c) => c.method === "turn/interrupt" && c.params.turnId === "",
    ),
  );
});

test("Failed or timed-out Stop remains blocked, then retry checks without replaying work", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.failInterrupt = true;
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal(
    (manager.snapshot("root").state as any).stopStatus,
    "unconfirmed",
  );
  await assert.rejects(
    manager.message("root", "unsafe"),
    (e: any) => e.code === "INTERRUPTING",
  );
  await assert.rejects(
    manager.capability("root", "thread/goal/set", { status: "active" }),
    (e: any) => e.code === "INTERRUPTING",
  );
  runtime.failInterrupt = false;
  runtime.hangInterrupt = true;
  runtime.statuses.set("root", "idle");
  await manager.interrupt("root");
  assert.equal(manager.snapshot("root").state.kind, "idle");
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/start").length,
    1,
  );
});

test("A hung interrupt and metadata read have bounded failure", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.hangInterrupt = true;
  runtime.hangRead = true;
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal(manager.snapshot("root").state.kind, "interrupting");
});

test("Root completion cannot unlock while a helper or initializing helper remains active", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.emit("notification", {
    method: "thread/started",
    params: {
      thread: {
        id: "helper",
        source: {
          subagent: { thread_spawn: { parent_thread_id: "root", depth: 1 } },
        },
      },
    },
  });
  runtime.statuses.set("helper", "active");
  runtime.failInterrupt = true;
  runtime.onInterrupt = (id) => {
    if (id === "root") runtime.complete();
  };
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal(manager.snapshot("root").state.kind, "interrupting");
  assert.ok(
    runtime.calls.some(
      (c) =>
        c.method === "turn/interrupt" &&
        c.params.threadId === "helper" &&
        c.params.turnId === "",
    ),
  );
  runtime.failInterrupt = false;
  await manager.interrupt("root");
  assert.equal(manager.snapshot("root").state.kind, "idle");
});

test("Stop ignores helpers that already completed in earlier work", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.emit("notification", {
    method: "thread/started",
    params: {
      thread: {
        id: "finished_helper",
        source: { subagent: { thread_spawn: { parent_thread_id: "root" } } },
      },
    },
  });
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "finished_helper", turn: { id: "helper_turn" } },
  });
  runtime.complete("finished_helper", "helper_turn", "completed");
  await manager.interrupt("root");
  assert.equal(manager.agents("root")[0].status, "completed");
  assert.equal(
    runtime.calls.filter(
      (c) =>
        ["turn/interrupt", "thread/archive"].includes(c.method) &&
        c.params.threadId === "finished_helper",
    ).length,
    0,
  );
});

test("Stop intent survives manager recreation and corrupt intent fails closed", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.failInterrupt = true;
  await assert.rejects(manager.interrupt("root"));
  manager.close();
  const nextRuntime = new StopRuntime();
  const next = new ThreadManager(
    nextRuntime,
    home,
    5,
    100,
    1000,
    900_000,
    30,
    30,
  );
  t.after(() => next.close());
  assert.equal(next.snapshot("root").state.kind, "interrupting");
  await next.interrupt("root");
  assert.equal(next.snapshot("root").state.kind, "idle");
  const file = join(home, "stop-intents", "root.json");
  writeFileSync(file, "{corrupt");
  const corrupted = new ThreadManager(new StopRuntime(), home);
  t.after(() => corrupted.close());
  assert.throws(
    () => corrupted.snapshot("root"),
    (e: any) => e.code === "STOP_STORAGE_INVALID",
  );
});

test("Runtime exit fences late interruption results and preserves recovery intent", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.onInterrupt = () => runtime.emit("exit");
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  assert.equal(
    (manager.snapshot("root").state as any).stopStatus,
    "unconfirmed",
  );
  assert.equal(
    JSON.parse(readFileSync(join(home, "stop-intents", "root.json"), "utf8"))
      .turnId,
    "turn",
  );
});

test("Stop waits for detached document work and never executes another tool while pending", async (t) => {
  const { manager: unused, runtime: fake, home } = fixture(t);
  unused.close();
  const work = deferred<any>();
  const business = new BusinessRuntime("unused", home);
  business.request = fake.request.bind(fake);
  business.respond = () => {};
  let executions = 0;
  business.executeTool = async () => {
    executions++;
    return work.promise;
  };
  fake.on("notification", (msg) => business.emit("notification", msg));
  const manager = new ThreadManager(
    business,
    home,
    5,
    100,
    1000,
    900_000,
    30,
    30,
  );
  t.after(() => manager.close());
  await manager.create({});
  await manager.message("root", "prepare a document");
  business.emit("serverRequest", {
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "root",
      turnId: "turn",
      tool: "create_docx",
      arguments: {},
    },
  });
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_UNCONFIRMED",
  );
  business.emit("serverRequest", {
    id: 2,
    method: "item/tool/call",
    params: {
      threadId: "root",
      turnId: "turn",
      tool: "create_docx",
      arguments: {},
    },
  });
  assert.equal(executions, 1);
  work.resolve({ success: true, contentItems: [] });
  await manager.interrupt("root");
  assert.equal(manager.snapshot("root").state.kind, "idle");
});

test("A helper discovered during Stop is persisted and stopped before admission", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.onInterrupt = (id) => {
    if (id !== "root") return;
    runtime.statuses.set("late_helper", "active");
    runtime.emit("notification", {
      method: "thread/started",
      params: {
        thread: {
          id: "late_helper",
          source: { subagent: { thread_spawn: { parent_thread_id: "root" } } },
        },
      },
    });
  };
  await manager.interrupt("root");
  assert.ok(
    runtime.calls.some(
      (c) =>
        c.method === "thread/archive" && c.params.threadId === "late_helper",
    ),
  );
  assert.equal(manager.snapshot("root").state.kind, "idle");
});

test("Cold recovery pauses the persisted goal before thread/resume", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.failInterrupt = true;
  await assert.rejects(manager.interrupt("root"));
  manager.close();
  const nextRuntime = new StopRuntime();
  nextRuntime.goal = {
    objective: "Recover",
    status: "active",
    tokenBudget: 1000,
  };
  const next = new ThreadManager(
    nextRuntime,
    home,
    5,
    100,
    1000,
    900_000,
    30,
    30,
  );
  t.after(() => next.close());
  await next.resume("root", {});
  const methods = nextRuntime.calls.map((c) => c.method);
  assert.ok(
    methods.indexOf("thread/goal/set") < methods.indexOf("thread/resume"),
  );
  assert.equal(nextRuntime.goal.status, "paused");
  assert.equal(
    nextRuntime.calls.filter((c) => c.method === "turn/start").length,
    0,
  );
});

test("Failed marker write blocks admission before interruption or goal mutation", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  mkdirSync(join(home, "stop-intents", "root.json"));
  await assert.rejects(
    manager.interrupt("root"),
    (e: any) => e.code === "STOP_STORAGE_INVALID",
  );
  assert.equal(
    runtime.calls.filter(
      (c) => c.method === "turn/interrupt" || c.method === "thread/goal/set",
    ).length,
    0,
  );
  await assert.rejects(
    manager.message("root", "new"),
    (e: any) => e.code === "INTERRUPTING",
  );
});

test("Stop declines approvals and ignores an Allow decision that resolves later", async (t) => {
  const { manager, runtime } = fixture(t);
  const allow = deferred<any>();
  const replies: any[] = [];
  runtime.respond = (...args: any[]) => {
    replies.push(args);
  };
  await manager.create({ approvalMode: "auto" });
  await manager.message("root", "work");
  // Force the asynchronous approval decision to finish only after Stop starts.
  (manager as any).decide = () => allow.promise;
  runtime.emit("serverRequest", {
    id: 9,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "root",
      turnId: "turn",
      questions: [
        {
          id: "permission",
          header: "Tool",
          question: "Allow tool?",
          options: [{ label: "Allow", description: "Execute" }],
        },
      ],
    },
  });
  runtime.failInterrupt = true;
  const stop = manager.interrupt("root");
  await new Promise((resolve) => setTimeout(resolve, 5));
  allow.resolve({
    result: { answers: { permission: { answers: ["Allow"] } } },
    reason: "auto",
  });
  await assert.rejects(stop);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0][1], { answers: {} });
});

test("Watchdog uses the same unconfirmed state and cannot unlock a still-active runtime", async (t) => {
  const { runtime, home, manager: unused } = fixture(t);
  unused.close();
  const manager = new ThreadManager(runtime, home, 5, 100, 1000, 10, 30, 30);
  t.after(() => manager.close());
  await manager.create({});
  await manager.message("root", "silent work");
  runtime.failInterrupt = true;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    (manager.snapshot("root").state as any).stopStatus,
    "unconfirmed",
  );
  assert.equal(
    manager.records("root").filter((r) => r.event.type === "turn.completed")
      .length,
    0,
  );
  runtime.failInterrupt = false;
  await manager.interrupt("root");
  assert.equal(
    manager.records("root").find((r) => r.event.type === "turn.completed")
      ?.event.data.turn.status,
    "failed",
  );
});

test("A start notification during Stop attaches its ID without reopening the public turn", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  const ack = deferred<any>();
  const request = runtime.request.bind(runtime);
  runtime.request = (method, params) =>
    method === "turn/start" ? ack.promise : request(method, params);
  const message = manager.message("root", "work");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.interrupt("root"));
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "root", turn: { id: "native_notification" } },
  });
  assert.deepEqual(manager.snapshot("root").state, {
    kind: "interrupting",
    turnId: "native_notification",
    stopStatus: "unconfirmed",
  });
  assert.equal(
    manager.threads.get("root")?.events.filter((e) => e.type === "turn.started")
      .length,
    0,
  );
  ack.resolve({ turn: { id: "native_notification" } });
  await message;
  await manager.interrupt("root");
  assert.equal(manager.snapshot("root").state.kind, "idle");
});

test("A start ACK from an exited runtime cannot attach to the retained Stop", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  const ack = deferred<any>();
  const request = runtime.request.bind(runtime);
  runtime.request = (method, params) =>
    method === "turn/start" ? ack.promise : request(method, params);
  const message = manager.message("root", "work");
  const rejected = assert.rejects(
    message,
    (e: any) => e.code === "RUNTIME_UNAVAILABLE",
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.interrupt("root"));
  const stopped = (manager.snapshot("root").state as any).turnId;
  runtime.emit("exit");
  ack.resolve({ turn: { id: "old_runtime_turn" } });
  await rejected;
  await manager.interrupt("root");
  assert.equal(
    manager.records("root").find((r) => r.event.type === "turn.completed")
      ?.event.turnId,
    stopped,
  );
});

test("Metadata sampled before a newer native turn cannot confirm Stop", async (t) => {
  const { manager, runtime } = fixture(t);
  await manager.create({});
  await manager.message("root", "work");
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: {
      threadId: "root",
      turnId: "turn",
      itemId: "old_partial",
      delta: "Older evidence",
    },
  });
  const request = runtime.request.bind(runtime);
  let changed = false;
  runtime.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "thread/read" && !changed) {
      changed = true;
      runtime.statuses.set("root", "active");
      runtime.emit("notification", {
        method: "turn/started",
        params: { threadId: "root", turn: { id: "new_native_turn" } },
      });
      // This response was sampled before the newer turn became active.
      return { thread: { id: "root", status: { type: "idle" } } };
    }
    return result;
  };
  await manager.interrupt("root");
  assert.equal(
    runtime.calls.filter((c) => c.method === "turn/interrupt").length,
    2,
  );
  assert.ok(
    runtime.calls.some(
      (c) =>
        c.method === "turn/interrupt" && c.params.turnId === "new_native_turn",
    ),
  );
  assert.equal(runtime.statuses.get("root"), "idle");
  assert.equal(manager.snapshot("root").state.kind, "idle");
  assert.ok(
    manager
      .records("root")
      .some(
        (r) =>
          r.event.type === "message.final" &&
          r.event.turnId === "turn" &&
          r.event.data.text === "Older evidence",
      ),
  );
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: {
      threadId: "root",
      turnId: "turn",
      itemId: "old_partial",
      delta: "stale",
    },
  });
  assert.equal(
    manager.snapshot("root").messages.find((m) => m.id === "old_partial")?.text,
    "Older evidence",
  );
});
