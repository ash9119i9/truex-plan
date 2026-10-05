import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
import type { DomainEvent } from "../../shared/contracts";

class FakeRuntime extends EventEmitter {
  async request(method: string) {
    return method === "thread/start" ? { thread: { id: "thread" } } : {};
  }
  respond() {}
}
async function fixture(t: any, replayLimit = 500) {
  const runtime = new FakeRuntime();
  const home = mkdtempSync(join(tmpdir(), "sync-protocol-"));
  const manager = new ThreadManager(runtime, home, 20, replayLimit);
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  await manager.create({});
  return { runtime, manager };
}
function delta(runtime: FakeRuntime, text = "x") {
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "thread", turnId: "turn", itemId: "item", delta: text },
  });
}
function subscribe(
  manager: ThreadManager,
  cursor?: string,
  sync = true,
  initialBufferedBytes = 0,
) {
  const chunks: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writableLength: initialBufferedBytes,
    destroyed: false,
    set() {},
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    destroy() {
      this.destroyed = true;
      this.emit("close");
    },
    end() {
      this.emit("close");
    },
  });
  manager.subscribe(
    "thread",
    res as any,
    cursor,
    sync ? { sync: "v1", window: true } : {},
  );
  return {
    res,
    events: () =>
      chunks
        .join("")
        .split("\n\n")
        .flatMap((frame) => {
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          return data ? [JSON.parse(data.slice(6)) as DomainEvent] : [];
        }),
    bytes: () => Buffer.byteLength(chunks.join("")),
  };
}

test("zero-gap replay returns authoritative running/pending operational state with no transcript snapshot call", async (t) => {
  const { manager, runtime } = await fixture(t);
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "turn" } },
  });
  runtime.emit("serverRequest", {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "item" },
  });
  delta(runtime, "already applied");
  const snapshot = manager.snapshot("thread");
  let calls = 0;
  const original = manager.snapshot.bind(manager);
  t.mock.method(manager, "snapshot", (...args) => {
    calls++;
    return original(...args);
  });
  const stream = subscribe(manager, snapshot.cursor);
  const [marker] = stream.events();
  assert.equal(stream.events().length, 1);
  assert.equal(marker.type, "sync.completed");
  assert.equal(marker.cursor, snapshot.cursor);
  assert.equal(marker.data.highWaterCursor, snapshot.cursor);
  assert.equal(marker.data.fromCursor, snapshot.cursor);
  assert.equal(marker.data.mode, "replay");
  assert.equal(marker.data.protocol, 1);
  assert.deepEqual(marker.data.snapshot.state, snapshot.state);
  assert.deepEqual(marker.data.snapshot.pending, snapshot.pending);
  assert.deepEqual(marker.data.snapshot.messages, []);
  assert.deepEqual(marker.data.snapshot.thinking, []);
  assert.equal(calls, 0);
  assert.equal(marker.data.snapshot.pending.length, 1);
});

test("replay reaches one captured high-water before marker and later live delivery", async (t) => {
  const { manager, runtime } = await fixture(t);
  const cursor = manager.snapshot("thread").cursor;
  for (const text of ["a", "😀", "\n"]) delta(runtime, text);
  const captured = manager.snapshot("thread").cursor;
  const stream = subscribe(manager, cursor);
  const first = stream.events();
  assert.deepEqual(
    first.map((event) => event.type),
    ["message.delta", "message.delta", "message.delta", "sync.completed"],
  );
  assert.equal(first.at(-1)?.cursor, captured);
  assert.equal(first.at(-1)?.data.snapshot.cursor, captured);
  assert.equal(
    first
      .slice(0, -1)
      .map((event) => event.data.delta)
      .join(""),
    "a😀\n",
  );
  delta(runtime, "live");
  const later = stream.events();
  assert.equal(later.at(-1)?.data.delta, "live");
  assert.equal(later.at(-1)?.seq, first.at(-1)!.seq + 1);
});

test("cold sync has one bounded source snapshot and matching marker; default remains full snapshot", async (t) => {
  const { manager } = await fixture(t);
  manager.threads.get("thread")!.messages = Array.from(
    { length: 100 },
    (_, i) => ({
      id: `item-${i}`,
      turnId: `turn-${i}`,
      text: `answer-${i}`,
      final: true,
    }),
  );
  const cold = subscribe(manager);
  assert.deepEqual(
    cold.events().map((event) => event.type),
    ["snapshot", "sync.completed"],
  );
  assert.equal(cold.events()[0].data.messages.length, 10);
  assert.equal(cold.events()[1].data.mode, "snapshot");
  assert.equal(cold.events()[1].data.reason, "missing_cursor");
  assert.equal(cold.events()[0].cursor, cold.events()[1].cursor);
  assert.equal(cold.events()[1].data.fromCursor, null);
  const legacy = subscribe(manager, undefined, false);
  assert.deepEqual(
    legacy.events().map((event) => event.type),
    ["snapshot"],
  );
  assert.equal(legacy.events()[0].data.messages.length, 100);
});

test("cold-resumed source without a restored prefix cannot authorize a pair, while legacy output stays compatible", async (t) => {
  class ResumedRuntime extends FakeRuntime {
    async request(method: string) {
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread",
            turns: [
              {
                id: "turn",
                status: "inProgress",
                items: [{ id: "item", type: "agentMessage", text: "prefix" }],
              },
            ],
          },
        };
      return super.request(method);
    }
  }
  const runtime = new ResumedRuntime();
  const home = mkdtempSync(join(tmpdir(), "sync-resume-coverage-"));
  const manager = new ThreadManager(runtime, home, 20, 500);
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  await manager.resume("thread");
  assert.equal(manager.snapshot("thread").messages.length, 0);
  delta(runtime, "suffix");
  const snapshot = manager.snapshot("thread", { window: true });
  assert.equal(snapshot.messages[0].text, "suffix");
  assert.deepEqual(snapshot.state, { kind: "running", turnId: "turn" });
  const streams = [];
  for (const cursor of [undefined, snapshot.cursor]) {
    const optedIn = subscribe(manager, cursor);
    assert.deepEqual(
      optedIn.events().map((event) => event.type),
      ["snapshot"],
    );
    assert.deepEqual(optedIn.events()[0].data, snapshot);
    assert.deepEqual(
      optedIn.events(),
      subscribe(manager, cursor, false).events(),
    );
    streams.push(optedIn);
  }
  delta(runtime, "next");
  for (const stream of streams)
    assert.equal(stream.events().at(-1)?.data.delta, "next");
});

test("invalid, expired, changed-generation and future cursors fall back before any replay", async (t) => {
  const { manager, runtime } = await fixture(t, 2);
  for (let i = 0; i < 4; i++) delta(runtime);
  for (const [cursor, reason] of [
    ["junk", "invalid_cursor"],
    [`${manager.generation}:`, "invalid_cursor"],
    [`${manager.generation}:01`, "invalid_cursor"],
    [`${manager.generation}:-1`, "invalid_cursor"],
    [`${manager.generation}:9007199254740992`, "invalid_cursor"],
    [`${manager.generation}:1:extra`, "invalid_cursor"],
    ["previous-generation:4", "generation_changed"],
    [`${manager.generation}:0`, "cursor_expired"],
    [`${manager.generation}:5`, "cursor_ahead"],
  ]) {
    const events = subscribe(manager, cursor).events();
    assert.deepEqual(
      events.map((event) => event.type),
      ["resync.required", "snapshot", "sync.completed"],
    );
    assert.equal(events.at(-1)?.data.mode, "snapshot");
    assert.equal(events.at(-1)?.data.reason, reason);
    assert.equal(events.at(-1)?.data.fromCursor, cursor);
  }
});

test("replay count overflow falls back as a whole, with no partial text frames", async (t) => {
  const { manager, runtime } = await fixture(t, 1000);
  const cursor = manager.snapshot("thread").cursor;
  for (let i = 0; i < 501; i++) delta(runtime);
  const events = subscribe(manager, cursor).events();
  assert.deepEqual(
    events.map((event) => event.type),
    ["resync.required", "snapshot", "sync.completed"],
  );
  assert.equal(events.at(-1)?.data.reason, "replay_event_limit");
});

test("multibyte and escaped raw/SSE replay byte overflow falls back before publishing partial frames", async (t) => {
  for (const text of ["😀".repeat(600_000), "\u0000".repeat(400_000)]) {
    const { manager, runtime } = await fixture(t);
    const cursor = manager.snapshot("thread").cursor;
    delta(runtime, text);
    const thread = manager.threads.get("thread")!;
    assert.ok(thread.replayBytes <= 8 * 1024 * 1024);
    const events = subscribe(manager, cursor).events();
    assert.deepEqual(
      events.map((event) => event.type),
      ["resync.required", "snapshot", "sync.completed"],
    );
    assert.equal(events.at(-1)?.data.reason, "replay_byte_limit");
    assert.equal(
      events[1].data.messages[0].text,
      text,
      "oversized current answer stays intact",
    );
  }
});

test("oversized retained event evicts the queue and old cursor cannot replay past it", async (t) => {
  const { manager, runtime } = await fixture(t);
  const cursor = manager.snapshot("thread").cursor;
  delta(runtime, "\u0000".repeat(1_500_000));
  const thread = manager.threads.get("thread")!;
  assert.equal(thread.events.length, 0);
  assert.equal(thread.replayBytes, 0);
  const events = subscribe(manager, cursor).events();
  assert.equal(events.at(-1)?.data.reason, "cursor_expired");
  const current = subscribe(
    manager,
    manager.snapshot("thread").cursor,
  ).events();
  assert.deepEqual(
    current.map((event) => event.type),
    ["sync.completed"],
  );
  assert.equal(current[0].data.mode, "replay");
});

test("SSE framing overhead can exceed the replay cap even when raw JSON alone fits", async (t) => {
  const { manager, runtime } = await fixture(t);
  delta(runtime, "");
  const thread = manager.threads.get("thread")!;
  const cursor = manager.snapshot("thread").cursor;
  const overhead = Buffer.byteLength(JSON.stringify(thread.events.at(-1)));
  delta(runtime, "x".repeat(2 * 1024 * 1024 - overhead));
  const last = thread.events.at(-1)!;
  assert.equal(Buffer.byteLength(JSON.stringify(last)), 2 * 1024 * 1024);
  const events = subscribe(manager, cursor).events();
  assert.deepEqual(
    events.map((event) => event.type),
    ["resync.required", "snapshot", "sync.completed"],
  );
  assert.equal(events.at(-1)?.data.reason, "replay_byte_limit");
});

test("restart invalidates old generation and zero-gap operational state does not revive a turn", async (t) => {
  const { manager, runtime } = await fixture(t);
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "turn" } },
  });
  const cursor = manager.snapshot("thread").cursor;
  runtime.emit("exit", { code: 1 });
  const events = subscribe(manager, cursor).events();
  assert.equal(events.at(-1)?.data.reason, "generation_changed");
  assert.deepEqual(events.at(-1)?.data.snapshot.state, { kind: "idle" });
  assert.deepEqual(events.at(-1)?.data.snapshot.pending, []);
});

test("slow consumer failure emits no synchronization marker and attaches no live subscriber", async (t) => {
  const { manager } = await fixture(t);
  const stream = subscribe(manager, undefined, true, 9 * 1024 * 1024);
  assert.equal(stream.res.destroyed, true);
  assert.equal(
    stream.events().some((event) => event.type === "sync.completed"),
    false,
  );
  assert.equal(manager.threads.get("thread")!.subscribers.size, 0);
});
