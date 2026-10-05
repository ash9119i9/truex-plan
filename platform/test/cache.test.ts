import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JsonReadCache,
  SingleFlight,
  CacheCapacityError,
} from "../../shared/cache";
import { PlatformReadCache, publicRows } from "../src/cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
test("JSON cache isolates callers, honors expiry, and bounds entries/bytes", async () => {
  let now = 0;
  const cache = new JsonReadCache<{ name: string }>({
    maxEntries: 2,
    maxBytes: 90,
    maxValueBytes: 60,
    now: () => now,
  });
  cache.set("a", { value: { name: "a" }, expiresAt: 10 });
  const copy = cache.get("a")!;
  copy.name = "changed";
  assert.equal(cache.get("a")?.name, "a");
  cache.set("b", { value: { name: "b" }, expiresAt: 10 });
  cache.get("a");
  cache.set("c", { value: { name: "c" }, expiresAt: 10 });
  assert.equal(cache.get("b"), undefined);
  cache.set("huge", { value: { name: "x".repeat(100) }, expiresAt: 10 });
  assert.equal(cache.get("huge"), undefined);
  assert.ok(cache.snapshot().bytes <= 90);
  now = 10;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.snapshot().bytes, 0);
});
test("a backwards wall clock cannot extend a local entry's admitted lifetime", () => {
  let wall = 100,
    elapsed = 0;
  const cache = new JsonReadCache({
    now: () => wall,
    monotonicNow: () => elapsed,
  });
  cache.set("clock", { value: "safe display", expiresAt: 110 });
  wall = 90;
  elapsed = 9;
  assert.equal(cache.get("clock"), "safe display");
  elapsed = 10;
  assert.equal(cache.get("clock"), undefined);
});
test("concurrent misses coalesce; clear fences old loads, bounds real work and permits new generations", async () => {
  const cache = new JsonReadCache<{ value: number }>({ maxPending: 2 });
  const old = deferred<{ value: { value: number }; expiresAt: number }>();
  const first = cache.getOrLoad("k", () => old.promise);
  const duplicate = cache.getOrLoad("k", () => {
    throw new Error("not reached");
  });
  cache.clear();
  const fresh = cache.getOrLoad("k", async () => ({
    value: { value: 2 },
    expiresAt: Date.now() + 1000,
  }));
  await assert.rejects(
    cache.getOrLoad("overload", async () => ({
      value: { value: 3 },
      expiresAt: Date.now() + 1000,
    })),
    CacheCapacityError,
  );
  assert.deepEqual(await fresh, { value: 2 });
  old.resolve({ value: { value: 1 }, expiresAt: Date.now() + 1000 });
  assert.deepEqual(await first, { value: 1 });
  const copied = await duplicate;
  copied.value = 9;
  assert.deepEqual(cache.get("k"), { value: 2 });
  assert.equal(cache.snapshot().pending, 0);
});
test("failed source loads are not cached or swallowed; single-flight frees capacity", async () => {
  const cache = new JsonReadCache<number>();
  await assert.rejects(
    cache.getOrLoad("x", async () => {
      throw new Error("source failed");
    }),
    /source failed/,
  );
  assert.equal(cache.snapshot().pending, 0);
  const flight = new SingleFlight(1);
  const wait = deferred<number>();
  const a = flight.run("a", () => wait.promise);
  const b = flight.run("a", () => Promise.resolve(2));
  await assert.rejects(
    flight.run("b", () => Promise.resolve(3)),
    CacheCapacityError,
  );
  wait.resolve(1);
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  assert.equal(await flight.run("b", () => Promise.resolve(3)), 3);
});
test("hot keys bound waiting callers independently of origin concurrency", async () => {
  const cache = new JsonReadCache<number>({ maxPending: 1, maxWaiters: 2 });
  const wait = deferred<{ value: number; expiresAt: number }>();
  const first = cache.getOrLoad("hot", () => wait.promise);
  const second = cache.getOrLoad("hot", () => wait.promise);
  await assert.rejects(
    cache.getOrLoad("hot", () => wait.promise),
    CacheCapacityError,
  );
  cache.clear();
  await assert.rejects(
    cache.getOrLoad("new", () => wait.promise),
    CacheCapacityError,
  );
  wait.resolve({ value: 1, expiresAt: Date.now() + 1000 });
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(cache.snapshot().waiters, 0);
  const flight = new SingleFlight(1, 2);
  const held = deferred<number>();
  const a = flight.run("hot", () => held.promise),
    b = flight.run("hot", () => held.promise);
  await assert.rejects(
    flight.run("hot", () => held.promise),
    CacheCapacityError,
  );
  held.resolve(1);
  await Promise.all([a, b]);
  assert.equal(await flight.run("new", async () => 2), 2);
});
test("invalidation and shutdown prevent an old loader from writing shared data", async () => {
  let writes = 0;
  const backend = {
    start: async () => {},
    get: async () => null,
    set: async () => {
      writes++;
    },
    flush: async () => {},
    close: () => {},
  };
  const cache = new PlatformReadCache({ enabled: true, backend }, {});
  const wait = deferred<number>();
  const old = cache.read(
    "k",
    1000,
    () => wait.promise,
    (_): _ is number => true,
    true,
  );
  await new Promise((r) => setImmediate(r));
  cache.invalidate();
  wait.resolve(1);
  await old;
  assert.equal(writes, 0);
  assert.equal(cache.local.snapshot().entries, 0);
  const after = deferred<number>();
  const closing = cache.read(
    "k",
    1000,
    () => after.promise,
    (_): _ is number => true,
    true,
  );
  await new Promise((r) => setImmediate(r));
  cache.close();
  after.resolve(2);
  await closing;
  assert.equal(writes, 0);
});
test("L2 remainder never receives a new full L1 TTL; corruption falls back to authority", async () => {
  let now = 1000,
    loads = 0;
  let raw: string | null = JSON.stringify({
    v: 1,
    expiresAt: 1005,
    value: [{ id: "a", name: "A", provider: "fixture" }],
  });
  const backend = {
    start: async () => {},
    get: async () => raw,
    set: async () => {},
    flush: async () => {},
    close: () => {},
  };
  const cache = new PlatformReadCache(
    { enabled: true, backend, now: () => now, jitter: () => 1 },
    {},
  );
  const valid = publicRows<{ id: string; name: string; provider: string }>(
    ["id", "name", "provider"],
    ["id", "name", "provider"],
  );
  const load = async () => {
    loads++;
    return [{ id: "b", name: "B", provider: "fixture" }];
  };
  assert.equal((await cache.read("k", 100, load, valid, true))[0].id, "a");
  now = 1006;
  raw = "{bad";
  assert.equal((await cache.read("k", 100, load, valid, true))[0].id, "b");
  assert.equal(loads, 1);
  cache.invalidate();
  raw = JSON.stringify({
    v: 1,
    expiresAt: 9999999,
    value: [{ id: "a", name: "A", provider: "fixture", apiKey: "private" }],
  });
  assert.equal((await cache.read("k", 100, load, valid, true))[0].id, "b");
  assert.equal(loads, 2);
});
test("disabled cache preserves source errors and configuration rejects unsafe L2 setup", async () => {
  const cache = new PlatformReadCache({}, {});
  await assert.rejects(
    cache.read(
      "x",
      10,
      async () => {
        throw new Error("source");
      },
      (_): _ is number => true,
    ),
    /source/,
  );
  assert.throws(
    () => new PlatformReadCache({}, { CACHE_L2: "on" }),
    /requires/,
  );
  assert.throws(
    () =>
      new PlatformReadCache(
        {},
        { CACHE_L1: "on", CACHE_L2: "on", CACHE_URL: "redis://localhost" },
      ),
    /NAMESPACE/,
  );
});
