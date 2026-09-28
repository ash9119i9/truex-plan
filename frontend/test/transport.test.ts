import { test } from "node:test";
import assert from "node:assert/strict";
import { transport } from "../lib/transport.ts";

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

function setup(t: any) {
  FakeEventSource.instances = [];
  const store = new Map<string, string>();
  (globalThis as any).EventSource = FakeEventSource;
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  const events: any[] = [],
    statuses: string[] = [],
    failures: any[] = [];
  let resyncs = 0;
  const stop = transport.subscribe(
    "a b/c",
    (e) => events.push(e),
    (s) => statuses.push(s),
    { onResync: () => resyncs++, onFailure: (f) => failures.push(f) },
  );
  const source = FakeEventSource.instances[0];
  return {
    store,
    events,
    statuses,
    failures,
    resyncs: () => resyncs,
    stop,
    source,
  };
}

test("the session id is encoded in the stream URL", (t) => {
  const { source } = setup(t);
  assert.match(source.url, /\/api\/sessions\/a%20b%2Fc\/events$/);
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
  assert.equal(
    failures[1].message,
    "The live connection to this conversation stopped.",
  );
});
