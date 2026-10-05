import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexClient } from "../src/client";

// Keep stdout open after exit, as Node permits, so buffered protocol frames
// exercise the actual readline listener rather than dispatching directly.
class BufferedChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: any[] = [];
  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      const request = JSON.parse(String(chunk));
      this.requests.push(request);
      if (request.method === "initialize")
        this.frame({ id: request.id, result: { userAgent: "fixture" } });
      if (request.method === "test/notify") {
        this.frame({
          method: "turn/started",
          params: { threadId: "root", turn: { id: "current_turn" } },
        });
        this.frame({ id: request.id, result: { current: true } });
      }
    });
    queueMicrotask(() => this.emit("spawn"));
  }
  frame(message: any) {
    this.stdout.write(JSON.stringify(message) + "\n");
  }
  kill() {
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

test("failed-child stdout is fenced before and after replacement without losing current RPC responses", async (t) => {
  const children: BufferedChild[] = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = new BufferedChild();
    children.push(child);
    return child;
  });
  t.after(() => {
    for (const child of children)
      for (const stream of [child.stdin, child.stdout, child.stderr])
        stream.destroy();
  });
  const client = new CodexClient("fixture", "/tmp", 2000);
  const notifications: any[] = [];
  const serverRequests: any[] = [];
  const protocolErrors: any[] = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("serverRequest", (message) => serverRequests.push(message));
  client.on("protocolError", (message) => protocolErrors.push(message));
  await client.start();
  const original = children[0];
  const pending = client.request("test/pending");
  const rejected = assert.rejects(
    pending,
    (e: any) => e.code === "RUNTIME_UNAVAILABLE",
  );
  await new Promise((resolve) => setImmediate(resolve));
  original.emit("exit", 1, null);
  await rejected;
  original.frame({
    method: "turn/started",
    params: { threadId: "root", turn: { id: "old_before_restart" } },
  });
  assert.equal(notifications.length, 0);

  await client.start();
  const current = children[1];
  original.frame({
    method: "turn/started",
    params: { threadId: "root", turn: { id: "old_after_restart" } },
  });
  original.frame({ id: 777, method: "item/tool/call", params: {} });
  original.stdout.write("obsolete malformed frame\n");
  assert.equal(notifications.length, 0);
  assert.equal(serverRequests.length, 0);
  assert.equal(protocolErrors.length, 0);
  assert.deepEqual(await client.request("test/notify"), { current: true });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.turn.id, "current_turn");

  const next = client.request("test/pending");
  await new Promise((resolve) => setImmediate(resolve));
  const requestId = current.requests.at(-1).id;
  original.frame({ id: requestId, result: { source: "old" } });
  current.frame({ id: requestId, result: { source: "current" } });
  assert.deepEqual(await next, { source: "current" });
});
