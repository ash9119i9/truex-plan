import { test } from "node:test";
import assert from "node:assert/strict";
import { transport } from "../lib/transport.ts";
import type { DomainEvent } from "../../shared/contracts.ts";

// A minimal EventSource stand-in that lets tests drive the stream by hand.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null;
  listeners: Record<string, ((m: { data: string }) => void)[]> = {};
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (m: { data: string }) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners[type] || []) fn({ data });
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function setup(
  t: any,
  onBatch?: (events: DomainEvent[]) => boolean | void,
  onEvent?: (event: DomainEvent) => unknown,
) {
  FakeEventSource.instances = [];
  const store = new Map<string, string>();
  let cursorWrites = 0;
  (globalThis as any).EventSource = FakeEventSource;
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        cursorWrites++;
        store.set(k, v);
      },
    },
  });
  const events: any[] = [],
    statuses: string[] = [],
    failures: any[] = [];
  let resyncs = 0;
  const stop = transport.subscribe(
    "a b/c",
    onEvent ?? ((e) => events.push(e)),
    (s) => statuses.push(s),
    { onBatch, onResync: () => resyncs++, onFailure: (f) => failures.push(f) },
  );
  const source = FakeEventSource.instances[0];
  return {
    store,
    cursorWrites: () => cursorWrites,
    events,
    statuses,
    failures,
    resyncs: () => resyncs,
    stop,
    source,
  };
}

function animationFrames(t: any) {
  let nextId = 0;
  const jobs = new Map<number, () => void>();
  const previousRequest = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const previousCancel = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (run: () => void) => {
      jobs.set(++nextId, run);
      return nextId;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => jobs.delete(id),
  });
  t.after(() => {
    if (previousRequest)
      Object.defineProperty(
        globalThis,
        "requestAnimationFrame",
        previousRequest,
      );
    else delete (globalThis as any).requestAnimationFrame;
    if (previousCancel)
      Object.defineProperty(globalThis, "cancelAnimationFrame", previousCancel);
    else delete (globalThis as any).cancelAnimationFrame;
  });
  return () => {
    for (const [id, run] of [...jobs]) {
      jobs.delete(id);
      run();
    }
  };
}

function frame(
  source: FakeEventSource,
  type: string,
  seq: number,
  data?: unknown,
) {
  data ??=
    type === "snapshot"
      ? { state: { kind: "idle" }, pending: [], messages: [] }
      : type === "message.delta" || type === "reasoning.delta"
        ? { delta: "text" }
        : {};
  source.onmessage!({
    data: JSON.stringify({
      type,
      seq,
      cursor: `c${seq}`,
      threadId: "thread",
      at: "",
      data,
    }),
    lastEventId: `c${seq}`,
  });
}

test("the session id is encoded in the stream URL", (t) => {
  const { source } = setup(t);
  assert.match(source.url, /\/api\/sessions\/a%20b%2Fc\/events\?window=1$/);
});

test("an unreadable frame resyncs without advancing the cursor", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { store, events, resyncs, source } = setup(t);
  source.onmessage!({
    data: '{"type":"turn.started","data":{}}',
    lastEventId: "c1",
  });
  source.onmessage!({ data: "{not json", lastEventId: "c2" });
  assert.equal(events.length, 1);
  assert.equal(store.get("cursor:a b/c"), "c1");
  assert.equal(resyncs(), 1);
  assert.equal(source.closed, true);
  frame(source, "turn.completed", 3);
  assert.equal(store.get("cursor:a b/c"), "c1");
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(
    { ...logged.mock.calls[0].arguments[1], error: undefined },
    { sessionId: "a b/c", lastEventId: "c2", error: undefined },
  );
});

test("errors report Reconnecting while retrying and Disconnected once closed", (t) => {
  const { statuses, source } = setup(t);
  source.onopen!();
  source.readyState = 0;
  source.onerror!();
  source.readyState = 2;
  source.onerror!();
  assert.deepEqual(statuses, ["Connected", "Reconnecting", "Disconnected"]);
});

test("stream.error passes the platform's reason on and closes the stream", (t) => {
  t.mock.method(console, "error", () => {});
  const { statuses, failures, source } = setup(t);
  source.emit(
    "stream.error",
    JSON.stringify({
      code: "STREAM_FAILED",
      error: "The stream broke.",
      requestId: "r9",
    }),
  );
  source.onerror!();
  assert.equal(source.closed, true);
  assert.deepEqual(statuses, ["Disconnected"]);
  assert.deepEqual(failures, [
    { message: "The stream broke.", code: "STREAM_FAILED", requestId: "r9" },
  ]);
  source.emit("stream.error", "garbage");
  assert.equal(failures.length, 1);
  const malformedFailure = setup(t);
  malformedFailure.source.emit("stream.error", "garbage");
  assert.equal(
    malformedFailure.failures[0].message,
    "The live connection to this conversation stopped.",
  );
});

test("1000 ordered deltas publish once per frame and checkpoint after publication", (t) => {
  const paint = animationFrames(t);
  const batches: DomainEvent[][] = [];
  const stream = setup(t, (events) => {
    assert.equal(stream.store.has("cursor:a b/c"), false);
    batches.push(events);
  });
  for (let i = 1; i <= 1000; i++)
    frame(stream.source, "message.delta", i, { delta: `${i},` });
  assert.equal(batches.length, 0);
  assert.equal(stream.store.size, 0);
  paint();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1000);
  assert.equal(
    batches[0].map((event) => event.data.delta).join(""),
    Array.from({ length: 1000 }, (_, i) => `${i + 1},`).join(""),
  );
  assert.equal(stream.store.get("cursor:a b/c"), "c1000");
  assert.equal(stream.cursorWrites(), 1);
  assert.equal(stream.events.length, 0);
  stream.stop();
});

test("the same 1000 delta fixture keeps legacy immediate delivery compatible", (t) => {
  const stream = setup(t);
  for (let i = 1; i <= 1000; i++)
    frame(stream.source, "message.delta", i, { delta: `${i},` });
  assert.equal(stream.events.length, 1000);
  assert.equal(stream.cursorWrites(), 1000);
  assert.equal(
    stream.events.map((event) => event.data.delta).join(""),
    Array.from({ length: 1000 }, (_, i) => `${i + 1},`).join(""),
  );
  stream.stop();
});

test("snapshots, finals, approvals and completion flush prior text in order", (t) => {
  const paint = animationFrames(t);
  const batches: DomainEvent[][] = [];
  const stream = setup(t, (events) => void batches.push(events));
  let seq = 0;
  for (const barrier of [
    "snapshot",
    "message.final",
    "approval.requested",
    "turn.completed",
    "resync.required",
  ]) {
    frame(stream.source, "message.delta", ++seq, { delta: "a" });
    frame(stream.source, "reasoning.delta", ++seq, { delta: "b" });
    frame(stream.source, barrier, ++seq);
  }
  paint();
  assert.deepEqual(
    batches.map((events) => events.map((event) => event.type)),
    [
      "snapshot",
      "message.final",
      "approval.requested",
      "turn.completed",
      "resync.required",
    ].flatMap((barrier) => [["message.delta", "reasoning.delta"], [barrier]]),
  );
  assert.equal(stream.store.get("cursor:a b/c"), `c${seq}`);
  stream.stop();
});

test("navigation flush and unsubscribe preserve queued deltas exactly once", (t) => {
  const paint = animationFrames(t);
  const batches: DomainEvent[][] = [];
  const stream = setup(t, (events) => void batches.push(events));
  frame(stream.source, "subagent.event", 1, {
    kind: "message.delta",
    delta: "helper",
  });
  stream.stop.flush!();
  frame(stream.source, "message.delta", 2, { delta: "parent" });
  stream.stop();
  paint();
  frame(stream.source, "message.delta", 3);
  assert.deepEqual(
    batches.flat().map((event) => event.seq),
    [1, 2],
  );
  assert.equal(stream.store.get("cursor:a b/c"), "c2");
});

test("delivery failure leaves cursor behind and prevents later checkpoint leap", (t) => {
  t.mock.method(console, "error", () => {});
  const paint = animationFrames(t);
  const stream = setup(t, () => {
    throw new Error("consumer failed");
  });
  frame(stream.source, "message.delta", 1);
  paint();
  frame(stream.source, "turn.completed", 2);
  assert.equal(stream.store.size, 0);
  assert.equal(stream.source.closed, true);
  assert.equal(stream.resyncs(), 1);
  assert.deepEqual(stream.statuses, ["Disconnected"]);
});

test("stale ownership rejects a batch without cursor advance or later delivery", (t) => {
  const paint = animationFrames(t);
  let calls = 0;
  const stream = setup(t, () => {
    calls++;
    return false;
  });
  frame(stream.source, "message.delta", 1);
  paint();
  frame(stream.source, "turn.completed", 2);
  assert.equal(calls, 1);
  assert.equal(stream.store.size, 0);
  assert.equal(stream.source.closed, true);
});

test("malformed frame flushes accepted text then closes without checkpoint leap", (t) => {
  t.mock.method(console, "error", () => {});
  const batches: DomainEvent[][] = [];
  const stream = setup(t, (events) => void batches.push(events));
  frame(stream.source, "message.delta", 1);
  stream.source.onmessage!({ data: "bad json", lastEventId: "c2" });
  assert.deepEqual(
    batches.flat().map((event) => event.seq),
    [1],
  );
  assert.equal(stream.store.get("cursor:a b/c"), "c1");
  frame(stream.source, "reasoning.delta", 3);
  assert.deepEqual(
    batches.flat().map((event) => event.seq),
    [1],
  );
  assert.equal(stream.store.get("cursor:a b/c"), "c1");
  assert.equal(stream.source.closed, true);
  assert.deepEqual(stream.statuses, ["Disconnected"]);
  stream.stop();
});

test("fatal connection error flushes accepted text before reporting failure", (t) => {
  t.mock.method(console, "error", () => {});
  const batches: DomainEvent[][] = [];
  const stream = setup(t, (events) => void batches.push(events));
  frame(stream.source, "reasoning.delta", 1);
  stream.source.emit(
    "stream.error",
    JSON.stringify({ error: "connection broke" }),
  );
  assert.deepEqual(
    batches.flat().map((event) => event.seq),
    [1],
  );
  assert.equal(stream.store.get("cursor:a b/c"), "c1");
  assert.equal(stream.source.closed, true);
  assert.equal(stream.failures.length, 1);
  frame(stream.source, "turn.completed", 2);
  stream.source.onopen!();
  assert.equal(stream.store.get("cursor:a b/c"), "c1");
  assert.deepEqual(stream.statuses, ["Disconnected"]);
  stream.stop();
});

test("ordinary consumer failure does not acknowledge its frame", (t) => {
  t.mock.method(console, "error", () => {});
  const stream = setup(t, undefined, () => {
    throw new Error("consumer failed");
  });
  frame(stream.source, "message.delta", 1);
  assert.equal(stream.store.size, 0);
  assert.equal(stream.resyncs(), 1);
  assert.equal(stream.source.closed, true);
});

test("JSON scalars, arrays and invalid envelopes request recovery without checkpoint", (t) => {
  t.mock.method(console, "error", () => {});
  for (const data of [
    "null",
    "4",
    "[]",
    "{}",
    '{"type":"snapshot","data":null}',
    '{"type":"snapshot","data":[]}',
  ]) {
    const stream = setup(t);
    stream.source.onmessage!({ data, lastEventId: "c1" });
    assert.equal(stream.store.size, 0);
    assert.equal(stream.events.length, 0);
    assert.equal(stream.resyncs(), 1);
    assert.equal(stream.source.closed, true);
    stream.stop();
  }
});

test("invalid text delta and snapshot protocol shapes recover instead of entering reducers", (t) => {
  t.mock.method(console, "error", () => {});
  for (const [type, data] of [
    ["message.delta", { delta: 42 }],
    ["reasoning.delta", {}],
    ["snapshot", { state: {}, pending: [], messages: [] }],
    ["snapshot", { state: { kind: "idle" }, pending: [], messages: {} }],
    ["snapshot", { state: { kind: "idle" }, pending: {}, messages: [] }],
    ...["thinking", "subAgents", "timings"].map((key) => [
      "snapshot",
      { state: { kind: "idle" }, pending: [], messages: [], [key]: {} },
    ]),
  ] as [string, unknown][]) {
    const stream = setup(t);
    frame(stream.source, type, 1, data);
    assert.equal(stream.events.length, 0);
    assert.equal(stream.store.size, 0);
    assert.equal(stream.resyncs(), 1);
    assert.equal(stream.source.closed, true);
  }
});

test("unknown future event types keep envelope compatibility", (t) => {
  const stream = setup(t);
  frame(stream.source, "future.event", 1, { feature: true });
  assert.equal(stream.events.length, 1);
  assert.equal(stream.store.get("cursor:a b/c"), "c1");
  stream.stop();
});
