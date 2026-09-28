import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient, rpcError } from "../src/client";
import { RpcError } from "../src/errors";
import { readItems } from "../src/history";
import { ThreadManager } from "../src/manager";
// A stand-in app-server: answers initialize, then acts on test methods.
const fakeCodex = `#!/usr/bin/env node
process.stderr.write("booting with Bearer sk-secret-123\\n");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return out({ id: m.id, result: { userAgent: "fake" } });
  if (m.method === "test/garbage") { process.stdout.write("not json{\\n"); return out({ id: m.id, result: {} }); }
  if (m.method === "test/rpcError") return out({ id: m.id, error: { code: m.params.code, message: "raw codex detail /home/x", data: { d: 1 } } });
  if (m.method === "test/notify") { out({ method: "turn/started", params: { threadId: "thread_x", turn: { id: "turn_x" } } }); return out({ id: m.id, result: {} }); }
  if (m.method === "test/die") return process.exit(3);
  // test/hang: never answers.
});
`;
function fake(t: any, timeoutMs = 2000) {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const binary = join(dir, "codex");
  writeFileSync(binary, fakeCodex);
  chmodSync(binary, 0o755);
  const client = new CodexClient(binary, dir, timeoutMs);
  t.after(() => {
    client.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return client;
}
function captureLogs(t: any) {
  const lines: any[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    try {
      lines.push(JSON.parse(String(chunk)));
    } catch {
      /* not a log line */
    }
    return write(chunk, ...rest);
  };
  t.after(() => {
    (process.stderr as any).write = write;
  });
  return lines;
}
test("spawn failure is RUNTIME_UNAVAILABLE and keeps the spawn error as cause", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = new CodexClient(join(dir, "missing-codex"), dir, 500);
  await assert.rejects(client.request("thread/start", {}), (e: any) => {
    assert.equal(e.status, 503);
    assert.equal(e.code, "RUNTIME_UNAVAILABLE");
    assert.equal(e.cause?.code, "ENOENT");
    assert.doesNotMatch(e.message, /missing-codex/);
    return true;
  });
});
test("child exit rejects pending requests and logs exit code with a redacted stderr tail", async (t) => {
  const logs = captureLogs(t);
  const client = fake(t);
  await client.start();
  const hanging = client.request("test/hang");
  await assert.rejects(client.request("test/die"), /runtime is unavailable/);
  await assert.rejects(hanging, (e: any) => e.code === "RUNTIME_UNAVAILABLE");
  const entry = logs.find((l) => l.msg === "codex runtime unavailable");
  assert.equal(entry.exitCode, 3);
  assert.equal(entry.event, "exit");
  const tail = entry.stderrTail.join("\n");
  assert.match(tail, /booting/);
  assert.doesNotMatch(tail, /sk-secret-123/);
  // The next request boots a fresh runtime.
  assert.deepEqual(await client.request("test/notify"), {});
});
test("runtime requests time out with RPC_TIMEOUT", async (t) => {
  const client = fake(t);
  await client.start();
  // Boot under the normal timeout; only the hanging call is short.
  (client as any).timeoutMs = 150;
  await assert.rejects(
    client.request("test/hang"),
    (e: any) => e.status === 504 && e.code === "RPC_TIMEOUT",
  );
});
test("a malformed frame is a protocol error and the stream keeps working", async (t) => {
  const client = fake(t);
  const protocol: string[] = [];
  client.on("protocolError", (m) => protocol.push(m));
  assert.deepEqual(await client.request("test/garbage"), {});
  assert.deepEqual(protocol, ["Invalid runtime JSON frame"]);
});
test("a throwing notification handler is ADAPTER_INTERNAL, not a JSON frame error", async (t) => {
  const client = fake(t);
  const protocol: string[] = [];
  const adapter: any[] = [];
  client.on("protocolError", (m) => protocol.push(m));
  client.on("adapterError", (e) => adapter.push(e));
  client.on("notification", () => {
    throw new Error("handler bug");
  });
  assert.deepEqual(await client.request("test/notify"), {});
  assert.deepEqual(protocol, []);
  assert.equal(adapter.length, 1);
  assert.equal(adapter[0].threadId, "thread_x");
  assert.equal(adapter[0].turnId, "turn_x");
  assert.equal(adapter[0].method, "turn/started");
});
test("JSON-RPC errors map to named codes with safe messages; raw text stays internal", async (t) => {
  const expected: [number, number, string][] = [
    [-32600, 400, "RPC_INVALID_REQUEST"],
    [-32601, 400, "RPC_METHOD_NOT_FOUND"],
    [-32602, 400, "RPC_INVALID_PARAMS"],
    [-32603, 502, "RPC_INTERNAL"],
    [-32001, 503, "RUNTIME_OVERLOADED"],
    [-1, 400, "RPC_ERROR"],
  ];
  for (const [rpc, status, code] of expected) {
    const e = rpcError({ code: rpc, message: "raw detail" });
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    assert.equal(e.rpcCode, rpc);
    assert.equal(e.rpcMessage, "raw detail");
    assert.doesNotMatch(e.message, /raw detail/);
  }
  const client = fake(t);
  await assert.rejects(
    client.request("test/rpcError", { code: -32602 }),
    (e: any) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, "RPC_INVALID_PARAMS");
      assert.equal(e.rpcMessage, "raw codex detail /home/x");
      assert.deepEqual(e.rpcData, { d: 1 });
      assert.doesNotMatch(e.message, /raw codex detail/);
      assert.match(String(e.cause?.message), /raw codex detail/);
      return true;
    },
  );
});
test("history falls back to thread/read when items/list is not found", async () => {
  const runtime = new (class extends EventEmitter {
    async request(method: string) {
      if (method === "thread/items/list")
        throw rpcError({ code: -32601, message: "unknown method" });
      return { thread: { turns: [{ id: "t1", items: [{ id: "i1" }] }] } };
    }
    respond() {}
  })();
  const page = await readItems(runtime, "thread_1");
  assert.deepEqual(page.data, [{ turnId: "t1", item: { id: "i1" } }]);
});
// A runtime whose threads are numbered and whose turns start on request.
class Fake extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  threads = 0;
  resumeError?: Error;
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start")
      return { thread: { id: `thread_${++this.threads}` } };
    if (method === "thread/resume" && this.resumeError) throw this.resumeError;
    if (method === "turn/start") {
      const turnId = `turn_${params.threadId}`;
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: params.threadId, turn: { id: turnId } },
      });
      return { turn: { id: turnId } };
    }
    return {};
  }
  respond() {}
}
function managed(t: any, stallMs?: number) {
  const runtime = new Fake(),
    dir = mkdtempSync(join(tmpdir(), "adapter-errors-")),
    manager = new ThreadManager(runtime, dir, 5, 100, 5000, stallMs);
  t.after(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const events = (id: string) => (manager.threads.get(id) as any).events;
  return { runtime, manager, events };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("runtime exit fails the running turn with its turnId and leaves idle threads alone", async (t) => {
  const { runtime, manager, events } = managed(t);
  const { threadId: running } = await manager.create({});
  const { threadId: idle } = await manager.create({});
  await manager.message(running, "hello");
  runtime.emit("exit", new Error("gone"));
  const [error, completed] = events(running);
  assert.equal(error.type, "error");
  assert.equal(error.data.code, "RUNTIME_UNAVAILABLE");
  assert.equal(error.data.turnId, "turn_thread_1");
  assert.equal(error.turnId, "turn_thread_1");
  assert.equal(completed.type, "turn.completed");
  assert.equal(completed.data.turn.status, "failed");
  assert.equal(completed.data.turn.id, "turn_thread_1");
  assert.equal(completed.data.timing.status, "failed");
  assert.equal(completed.data.trace.turnId, "turn_thread_1");
  assert.deepEqual(events(idle), []);
  assert.deepEqual(manager.snapshot(running).state, { kind: "idle" });
});
test("watchdog fails a silent turn with TURN_STALLED and interrupts it", async (t) => {
  const { runtime, manager, events } = managed(t, 40);
  const { threadId } = await manager.create({});
  await manager.message(threadId, "hello");
  await sleep(100);
  const error = events(threadId).find((e: any) => e.type === "error");
  assert.equal(error.data.code, "TURN_STALLED");
  assert.equal(error.data.turnId, "turn_thread_1");
  const completed = events(threadId).find(
    (e: any) => e.type === "turn.completed",
  );
  assert.equal(completed.data.turn.status, "failed");
  assert.deepEqual(manager.snapshot(threadId).state, { kind: "idle" });
  assert.ok(
    runtime.calls.some(
      (c) =>
        c.method === "turn/interrupt" && c.params.turnId === "turn_thread_1",
    ),
  );
  // The runtime's own completion of the stalled turn is not reported again.
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: "turn_thread_1", status: "interrupted" },
    },
  });
  assert.equal(
    events(threadId).filter((e: any) => e.type === "turn.completed").length,
    1,
  );
});
test("watchdog is reset by activity and paused while an approval waits", async (t) => {
  const { runtime, manager, events } = managed(t, 60);
  const { threadId } = await manager.create({});
  await manager.message(threadId, "hello");
  for (let i = 0; i < 3; i++) {
    await sleep(30);
    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId, turnId: "turn_thread_1", itemId: "m", delta: "." },
    });
  }
  runtime.emit("serverRequest", {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId, turnId: "turn_thread_1", itemId: "cmd" },
  });
  await sleep(150);
  const stalled = () =>
    events(threadId).some((e: any) => e.data?.code === "TURN_STALLED");
  assert.equal(stalled(), false);
  assert.equal(manager.snapshot(threadId).state.kind, "running");
  const [request] = manager.snapshot(threadId).pending;
  manager.answer(threadId, request.requestId, { decision: "accept" });
  await sleep(120);
  assert.equal(stalled(), true);
});
test("Codex error notifications pass willRetry and turnId through", async (t) => {
  const { runtime, manager, events } = managed(t);
  const { threadId } = await manager.create({});
  runtime.emit("notification", {
    method: "error",
    params: {
      threadId,
      turnId: "turn_9",
      willRetry: true,
      error: { message: "stream disconnected" },
    },
  });
  const [error] = events(threadId);
  assert.equal(error.type, "error");
  assert.equal(error.data.willRetry, true);
  assert.equal(error.data.turnId, "turn_9");
  assert.equal(error.turnId, "turn_9");
});
test("adapter errors reach the thread as ADAPTER_INTERNAL", async (t) => {
  const { runtime, manager, events } = managed(t);
  const { threadId } = await manager.create({});
  runtime.emit("adapterError", {
    threadId,
    turnId: "turn_1",
    method: "item/completed",
    error: new Error("bug"),
  });
  const [error] = events(threadId);
  assert.equal(error.data.code, "ADAPTER_INTERNAL");
  assert.equal(error.data.turnId, "turn_1");
  assert.doesNotMatch(error.data.message, /bug/);
});
test("a missing thread on resume is THREAD_LOST from the structured runtime error", async (t) => {
  const { runtime, manager } = managed(t);
  runtime.resumeError = rpcError({
    code: -32600,
    message: "thread not found: thread_gone",
  });
  await assert.rejects(
    manager.resume("thread_gone"),
    (e: any) => e.status === 410 && e.code === "THREAD_LOST",
  );
});
test("resume tolerates a runtime response without a thread", async (t) => {
  const { manager } = managed(t);
  // The fake answers thread/resume with {}; this used to throw a TypeError.
  await manager.resume("thread_bare");
  assert.equal(manager.snapshot("thread_bare").state.kind, "idle");
});
