import { test } from "node:test";
import assert from "node:assert/strict";
import { transport } from "../lib/transport.ts";
import {
  api,
  apiIdentityScope,
  clearApiCache,
  onApiIdentityChange,
} from "../lib/api.ts";
const windowEvents = new Map<string, () => void>();

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
  constructor(url: string, publicOptions?: EventSourceInit) {
    this.url = url;
    this.options = publicOptions;
    FakeEventSource.instances.push(this);
  }
  options?: EventSourceInit;
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
  t.after(stop);
  return {
    store,
    events,
    statuses,
    failures,
    resyncs: () => resyncs,
    stop,
    get source() {
      return FakeEventSource.instances[0];
    },
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

test("enabled caching scopes stream cursors to identity and drops events after account switch", async (t) => {
  const previous = process.env.NEXT_PUBLIC_CLIENT_CACHE;
  process.env.NEXT_PUBLIC_CLIENT_CACHE = "on";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener(name: string, listener: () => void) {
        windowEvents.set(name, listener);
      },
    },
  });
  t.after(() => {
    clearApiCache(false);
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CLIENT_CACHE;
    else process.env.NEXT_PUBLIC_CLIENT_CACHE = previous;
    delete (globalThis as any).window;
  });
  let user = "alice";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ user: { id: user }, tenant: { id: "acme" }, role: "user" }),
  );
  await api("/api/me");
  const identity = apiIdentityScope();
  const subscription = setup(t);
  await new Promise((resolve) => setImmediate(resolve));
  const { source, store, events } = subscription;
  assert.equal(source.options?.withCredentials, true);
  source.onmessage!({
    data: '{"type":"turn.started","data":{}}',
    lastEventId: "c1",
  });
  assert.equal(store.get(`cursor:${identity}:a b/c`), "c1");
  assert.equal(store.has("cursor:a b/c"), false);
  user = "bob";
  await api("/api/me");
  assert.ok(source.closed);
  source.onmessage!({ data: "not json", lastEventId: "old" });
  source.emit("stream.error", "not json");
  source.onerror!();
  source.onopen!();
  assert.equal(subscription.resyncs(), 0);
  assert.equal(subscription.failures.length, 0);
  source.onmessage!({
    data: '{"type":"turn.completed","data":{}}',
    lastEventId: "c2",
  });
  assert.ok(source.closed);
  assert.equal(events.length, 1);
  assert.equal(store.get(`cursor:${identity}:a b/c`), "c1");
});

test("cache-enabled stream waits for identity bootstrap and cancellation cannot open a late stream", async (t) => {
  const previous = process.env.NEXT_PUBLIC_CLIENT_CACHE;
  process.env.NEXT_PUBLIC_CLIENT_CACHE = "on";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener(name: string, listener: () => void) {
        windowEvents.set(name, listener);
      },
    },
  });
  clearApiCache(false);
  t.after(() => {
    clearApiCache(false);
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CLIENT_CACHE;
    else process.env.NEXT_PUBLIC_CLIENT_CACHE = previous;
    delete (globalThis as any).window;
  });
  let release!: (response: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const subscription = setup(t);
  assert.equal(FakeEventSource.instances.length, 0);
  const simultaneousMe = api("/api/me");
  assert.equal(calls, 1);
  release(
    Response.json({
      user: { id: "alice" },
      tenant: { id: "acme" },
      role: "user",
    }),
  );
  await simultaneousMe;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeEventSource.instances.length, 1);
  const source = subscription.source;
  clearApiCache(false);
  assert.ok(source.closed);
  source.onmessage!({ data: "bad json", lastEventId: "stale" });
  source.emit("stream.error", "bad json");
  assert.equal(subscription.events.length, 0);
  assert.equal(subscription.resyncs(), 0);
  assert.equal(subscription.failures.length, 0);

  const cancelled = setup(t);
  cancelled.stop();
  release(
    Response.json({
      user: { id: "bob" },
      tenant: { id: "acme" },
      role: "user",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeEventSource.instances.length, 0);
});

test("focus without BroadcastChannel clears identity-bound views and reconnects only the same account", async (t) => {
  const previous = process.env.NEXT_PUBLIC_CLIENT_CACHE;
  process.env.NEXT_PUBLIC_CLIENT_CACHE = "on";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener(name: string, listener: () => void) {
        windowEvents.set(name, listener);
      },
    },
  });
  clearApiCache(false);
  t.after(() => {
    clearApiCache(false);
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CLIENT_CACHE;
    else process.env.NEXT_PUBLIC_CLIENT_CACHE = previous;
    delete (globalThis as any).window;
  });
  let user = "alice";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ user: { id: user }, tenant: { id: "acme" }, role: "user" }),
  );
  let viewScope: string | undefined;
  const stopView = onApiIdentityChange(() => {
    viewScope = apiIdentityScope();
  });
  t.after(stopView);
  const subscription = setup(t);
  await new Promise((resolve) => setImmediate(resolve));
  const first = subscription.source;
  assert.match(viewScope!, /alice/);
  windowEvents.get("focus")!();
  assert.equal(viewScope, undefined);
  assert.equal(apiIdentityScope(), undefined);
  assert.ok(first.closed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeEventSource.instances.length, 2);
  const resumed = FakeEventSource.instances[1];
  assert.equal(resumed.closed, false);
  assert.match(viewScope!, /alice/);

  user = "bob";
  windowEvents.get("focus")!();
  assert.equal(viewScope, undefined);
  assert.ok(resumed.closed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(viewScope!, /bob/);
  assert.equal(FakeEventSource.instances.length, 2);
  resumed.onmessage!({
    data: "malformed old account frame",
    lastEventId: "old",
  });
  resumed.emit("stream.error", "malformed old account error");
  assert.equal(subscription.events.length, 0);
  assert.equal(subscription.resyncs(), 0);
  assert.equal(subscription.failures.length, 0);
});
