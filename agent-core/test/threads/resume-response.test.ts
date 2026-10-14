import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../../src/threads/manager";

class Runtime extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread" } };
    if (method === "thread/resume")
      return { thread: { id: "thread", turns: [] } };
    if (method === "turn/start") return { turn: { id: "next" } };
    return {};
  }
  respond() {}
}
async function fixture(t: any, create = true) {
  const runtime = new Runtime();
  const home = mkdtempSync(join(tmpdir(), "resume-response-"));
  const manager = new ThreadManager(runtime, home);
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  if (create)
    await manager.create({ tenantId: "tenant-a", mcpFingerprint: "a" });
  return { runtime, manager };
}
function retained(manager: ThreadManager) {
  const thread = manager.threads.get("thread")!;
  thread.messages = [
    { id: "retained", turnId: "old", text: "body", final: true },
  ];
  thread.thinking = [
    {
      id: "thinking",
      turnId: "old",
      summary: "summary",
      raw: "raw",
      done: true,
    },
  ];
  thread.diff = "retained diff";
  return thread;
}
function noTranscript(t: any, manager: ThreadManager) {
  t.mock.method(manager, "snapshot", () => {
    throw new Error("full transcript materialized");
  });
}

test("warm operational resume acknowledges mode and preserves pending/running authority without transcript materialization", async (t) => {
  const { manager, runtime } = await fixture(t);
  const thread = retained(manager);
  thread.state = { kind: "running", turnId: "running" };
  thread.plan = [{ step: "Check", status: "inProgress" }];
  runtime.emit("serverRequest", {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "running", itemId: "command" },
  });
  const expected = manager.snapshot("thread");
  runtime.calls.length = 0;
  noTranscript(t, manager);
  const response = await manager.resume("thread", {
    response: "operational",
    tenantId: "tenant-a",
    mcpFingerprint: "a",
    approvalMode: "ask",
  });
  assert.deepEqual(response.state, expected.state);
  assert.deepEqual(response.pending, expected.pending);
  assert.deepEqual(response.plan, expected.plan);
  assert.equal(response.approvalMode, "ask");
  assert.deepEqual(response.messages, []);
  assert.deepEqual(response.thinking, []);
  assert.equal(response.diff, "");
  assert.deepEqual(runtime.calls, []);
  assert.equal(thread.sourceCovered, true);
  assert.equal(thread.messages[0].text, "body");
});

test("default resume retains the entire existing snapshot and no unsolicited approval acknowledgment", async (t) => {
  const { manager } = await fixture(t);
  retained(manager);
  const expected = manager.snapshot("thread");
  assert.deepEqual(await manager.resume("thread", {}), expected);
  assert.deepEqual(
    await manager.resume("thread", { mcpFingerprint: "a" }),
    expected,
  );
});

test("invalid response modes reject before runtime, mode or configuration side effects; tenant checks remain enforced", async (t) => {
  const { manager, runtime } = await fixture(t);
  const thread = retained(manager);
  runtime.calls.length = 0;
  for (const response of [null, false, true, "full", "v2", [], {}])
    await assert.rejects(
      manager.resume("thread", {
        response,
        approvalMode: "auto",
        mcpFingerprint: "b",
      }),
      /Invalid runtime resume response/,
    );
  await assert.rejects(
    manager.resume("thread", {
      response: "operational",
      tenantId: "tenant-b",
      approvalMode: "auto",
      mcpFingerprint: "b",
    }),
    /Conversation not found/,
  );
  assert.deepEqual(runtime.calls, []);
  assert.equal(thread.mcpFingerprint, "a");
  assert.equal(thread.pendingResume, undefined);
  assert.equal((manager as any).modes.has("thread"), false);
});

test("cold operational resume performs normal load and goal recovery without a discarded full snapshot", async (t) => {
  const { manager, runtime } = await fixture(t, false);
  noTranscript(t, manager);
  const result = await manager.resume("thread", {
    response: "operational",
    approvalMode: "readOnly",
    config: { "mcp_servers.sap": { url: "https://example.test/mcp" } },
    mcpFingerprint: "b",
  });
  assert.deepEqual(
    runtime.calls.map((call) => call.method),
    ["thread/resume", "thread/goal/get"],
  );
  assert.equal("response" in runtime.calls[0].params, false);
  assert.equal("approvalMode" in runtime.calls[0].params, false);
  assert.equal("mcpFingerprint" in runtime.calls[0].params, false);
  assert.equal(result.approvalMode, "readOnly");
  assert.equal(result.state.kind, "idle");
  assert.equal(manager.threads.get("thread")!.sourceCovered, false);
});

test("operational changed configuration stays pending while running and applies before the next turn", async (t) => {
  const { manager, runtime } = await fixture(t);
  const thread = retained(manager);
  thread.state = { kind: "running", turnId: "running" };
  runtime.calls.length = 0;
  const original = manager.snapshot.bind(manager);
  noTranscript(t, manager);
  await manager.resume("thread", {
    response: "operational",
    mcpFingerprint: "b",
    config: { "mcp_servers.sap": { url: "https://example.test/mcp" } },
  });
  assert.deepEqual(runtime.calls, []);
  assert.equal(thread.pendingResume?.mcpFingerprint, "b");
  assert.equal("response" in thread.pendingResume!.params, false);
  t.mock.method(manager, "snapshot", original);
  runtime.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: { id: "running", status: "completed" },
    },
  });
  await manager.message("thread", "next");
  assert.deepEqual(
    runtime.calls.map((call) => call.method),
    ["thread/unsubscribe", "thread/resume", "thread/goal/get", "turn/start"],
  );
  assert.equal("response" in runtime.calls[1].params, false);
  assert.equal(thread.pendingResume, undefined);
  assert.equal(thread.mcpFingerprint, "b");
});

test("operational idle configuration reload strips response option and preserves legacy cold-source coverage", async (t) => {
  const { manager, runtime } = await fixture(t);
  const thread = retained(manager);
  runtime.calls.length = 0;
  noTranscript(t, manager);
  const result = await manager.resume("thread", {
    response: "operational",
    mcpFingerprint: "b",
  });
  assert.deepEqual(
    runtime.calls.map((call) => call.method),
    ["thread/unsubscribe", "thread/resume", "thread/goal/get"],
  );
  assert.equal("response" in runtime.calls[1].params, false);
  assert.equal(thread.sourceCovered, false);
  assert.equal(result.state.kind, "idle");
});

test("operational resume keeps bounded diagnostics and canceling a pending configuration requires the loaded fingerprint", async (t) => {
  const { manager } = await fixture(t);
  const thread = retained(manager);
  thread.state = { kind: "running", turnId: "running" };
  thread.timings = Array.from({ length: 25 }, (_, i) => ({
    turnId: `turn-${i}`,
  })) as any;
  thread.traces = Array.from({ length: 25 }, (_, i) => ({
    turnId: `turn-${i}`,
  })) as any;
  noTranscript(t, manager);
  await manager.resume("thread", {
    response: "operational",
    mcpFingerprint: "b",
  });
  await manager.resume("thread", { response: "operational" });
  assert.equal(thread.pendingResume?.mcpFingerprint, "b");
  const result = await manager.resume("thread", {
    response: "operational",
    mcpFingerprint: "a",
  });
  assert.equal(thread.pendingResume, undefined);
  assert.deepEqual(result.timings, thread.timings.slice(-10));
  assert.deepEqual(result.traces, thread.traces.slice(-10));
});

test("a draining runtime retains its loaded thread and defers new configuration for operational resume", async (t) => {
  const { manager, runtime } = await fixture(t);
  manager.draining = true;
  runtime.calls.length = 0;
  noTranscript(t, manager);
  const result = await manager.resume("thread", {
    response: "operational",
    mcpFingerprint: "b",
  });
  assert.equal(result.state.kind, "idle");
  assert.deepEqual(runtime.calls, []);
  assert.equal(
    manager.threads.get("thread")!.pendingResume?.mcpFingerprint,
    "b",
  );
});

test("operational reload errors propagate without a successful acknowledgment and a retry loads normally", async (t) => {
  const { manager, runtime } = await fixture(t);
  let attempts = 0;
  const request = runtime.request.bind(runtime);
  t.mock.method(runtime, "request", async (method, params) => {
    if (method === "thread/resume" && attempts++ === 0)
      throw new Error("runtime unavailable");
    return request(method, params);
  });
  noTranscript(t, manager);
  await assert.rejects(
    manager.resume("thread", {
      response: "operational",
      mcpFingerprint: "b",
      approvalMode: "ask",
    }),
    /runtime unavailable/,
  );
  assert.equal(manager.threads.get("thread")!.loaded, false);
  const result = await manager.resume("thread", {
    response: "operational",
    mcpFingerprint: "b",
    approvalMode: "ask",
  });
  assert.equal(result.approvalMode, "ask");
  assert.equal(manager.threads.get("thread")!.loaded, true);
  assert.equal(manager.threads.get("thread")!.mcpFingerprint, "b");
});
