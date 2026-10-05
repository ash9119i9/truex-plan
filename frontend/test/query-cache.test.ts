import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCache, metadataTtl, safeMetadata } from "../lib/query-cache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("metadata allow-list excludes live/private routes, query variants and secrets", () => {
  for (const path of [
    "/api/me",
    "/api/sessions",
    "/api/sessions/s1",
    "/api/sessions/s1/turns/t/context",
    "/api/sessions/s1/documents",
    "/api/agents?filter=other",
    "/api/admin/models",
  ])
    assert.equal(metadataTtl(path), 0);
  assert.equal(metadataTtl("/api/agents/a/mcp"), 5000);
  assert.equal(metadataTtl("/api/models"), 30000);
  assert.ok(safeMetadata({ profiles: [{ name: "sap", hasKey: true }] }));
  assert.equal(safeMetadata({ profiles: [{ apiKey: "hidden" }] }), false);
});

test("single-flight callers receive independent values; expiry reloads and failed loads retry", async () => {
  let now = 0,
    calls = 0;
  const cache = new QueryCache(undefined, () => now);
  const value = deferred<unknown>();
  const load = async () => {
    calls++;
    return value.promise;
  };
  const a = cache.get("tenant:user", 100, load),
    b = cache.get("tenant:user", 100, load);
  value.resolve({ names: ["first"] });
  const [first, second] = await Promise.all([a, b]);
  first.names.push("changed");
  assert.deepEqual(second, { names: ["first"] });
  assert.equal(calls, 1);
  assert.deepEqual(await cache.get("tenant:user", 100, load), second);
  now = 101;
  await cache.get("tenant:user", 100, load);
  assert.equal(calls, 2);
  await assert.rejects(
    cache.get("failed", 100, async () => {
      throw new Error("origin down");
    }),
    /origin down/,
  );
  assert.equal(
    await cache.get("failed", 100, async () => "recovered"),
    "recovered",
  );
});

test("count, UTF-8 bytes, value and expired-entry limits hold", async () => {
  let now = 0;
  const cache = new QueryCache(
    { entries: 2, bytes: 30, valueBytes: 25, pending: 2 },
    () => now,
  );
  for (const key of ["a", "b", "c"])
    await cache.get(key, 100, async () => "界界");
  assert.equal(cache.stats().entries, 2);
  assert.ok(cache.stats().bytes <= 30);
  await cache.get("oversize", 100, async () => "界".repeat(20));
  assert.equal(cache.stats().entries, 2);
  now = 101;
  await cache.get("new", 100, async () => "new");
  assert.equal(cache.stats().entries, 1);
  await cache.get(
    "secret",
    100,
    async () => ({ apiKey: "private" }),
    safeMetadata,
  );
  assert.equal(cache.stats().entries, 1);
});

test("mutation/identity invalidation aborts loads and rejects late responses even if origin ignores abort", async () => {
  const cache = new QueryCache();
  const late = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const old = cache.get("key", 100, async (s) => {
    signal = s;
    return late.promise;
  });
  await Promise.resolve();
  cache.clear();
  assert.ok(signal?.aborted);
  late.resolve({ old: true });
  await assert.rejects(old, { code: "CACHE_INVALIDATED" });
  assert.equal(cache.stats().entries, 0);
  assert.deepEqual(await cache.get("key", 100, async () => ({ fresh: true })), {
    fresh: true,
  });
});

test("pending slots remain bounded through invalidation storms", async () => {
  const cache = new QueryCache({
    entries: 2,
    bytes: 100,
    valueBytes: 100,
    pending: 1,
  });
  const late = deferred<unknown>();
  const old = cache.get("one", 100, () => late.promise);
  await Promise.resolve();
  cache.clear();
  await assert.rejects(
    cache.get("two", 100, async () => ({})),
    { code: "CACHE_BUSY" },
  );
  assert.equal(cache.stats().pending, 1);
  late.resolve({});
  await assert.rejects(old, { code: "CACHE_INVALIDATED" });
  assert.equal(cache.stats().pending, 0);
});

test("a warm hit invalidated before delivery is rejected", async () => {
  const cache = new QueryCache();
  await cache.get("key", 100, async () => "old");
  const old = cache.get("key", 100, async () => "unused");
  cache.clear();
  await assert.rejects(old, { code: "CACHE_INVALIDATED" });
});

test("hot-key subscribers are bounded even with one pending origin", async () => {
  const cache = new QueryCache({
    entries: 2,
    bytes: 100,
    valueBytes: 100,
    pending: 1,
  });
  const origin = deferred<unknown>();
  const readers = Array.from({ length: 16 }, () =>
    cache.get("hot", 100, () => origin.promise),
  );
  await assert.rejects(
    cache.get("hot", 100, () => origin.promise),
    { code: "CACHE_BUSY" },
  );
  assert.equal(cache.stats().readers, 16);
  origin.resolve({ ok: true });
  await Promise.all(readers);
  assert.equal(cache.stats().readers, 0);
});
