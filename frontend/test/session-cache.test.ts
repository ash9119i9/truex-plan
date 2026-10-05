import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionCache } from "../lib/session-cache.ts";

test("warm reads return the same display reference and touch LRU recency", () => {
  const cache = new SessionCache<object>({ maxEntries: 2 });
  const a = { id: "a" };
  cache.set("a", a);
  cache.set("b", { id: "b" });
  assert.equal(cache.get("a"), a);
  cache.set("c", { id: "c" });
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), a);
  assert.deepEqual(cache.get("c"), { id: "c" });
});

test("the byte budget evicts the least recently used value", () => {
  const cache = new SessionCache<string>({
    maxEntries: 10,
    maxBytes: 6,
    estimateBytes: (value) => value.length,
  });
  cache.set("a", "aaa");
  cache.set("b", "bbb");
  cache.get("a");
  cache.set("c", "ccc");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "aaa");
  assert.equal(cache.get("c"), "ccc");
});

test("replacement subtracts old bytes and makes the new value recent", () => {
  const cache = new SessionCache<string>({
    maxBytes: 8,
    estimateBytes: (value) => value.length,
  });
  cache.set("a", "aaaaaa");
  cache.set("b", "bb");
  cache.set("a", "a");
  cache.set("c", "ccccc");
  assert.equal(cache.get("b"), "bb");
  assert.equal(cache.get("a"), "a");
  assert.equal(cache.get("c"), "ccccc");
  cache.set("d", "d");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "a");
});

test("oversized replacement drops stale data without evicting other chats", () => {
  const cache = new SessionCache<string>({
    maxBytes: 4,
    estimateBytes: (value) => value.length,
  });
  cache.set("a", "aa");
  cache.set("b", "bb");
  cache.set("a", "oversized");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "bb");
  cache.set("c", "cc");
  assert.equal(cache.get("b"), "bb");
  assert.equal(cache.get("c"), "cc");
});

test("TTL measures idle time and expires at the exact boundary", () => {
  let now = 0;
  const cache = new SessionCache<string>({ idleTtlMs: 100, now: () => now });
  cache.set("a", "a");
  now = 99;
  assert.equal(cache.get("a"), "a");
  now = 198;
  assert.equal(cache.get("a"), "a");
  now = 298;
  assert.equal(cache.get("a"), undefined);
});

test("writes prune expired values before budget eviction", () => {
  let now = 0;
  const cache = new SessionCache<string>({
    maxEntries: 2,
    idleTtlMs: 100,
    now: () => now,
  });
  cache.set("a", "a");
  now = 50;
  cache.set("b", "b");
  now = 100;
  cache.set("c", "c");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "b");
  assert.equal(cache.get("c"), "c");
});

test("delete and clear release accounting and permit fresh values", () => {
  const cache = new SessionCache<string>({
    maxBytes: 4,
    estimateBytes: (value) => value.length,
  });
  cache.set("a", "aaaa");
  cache.delete("a");
  cache.delete("missing");
  cache.set("b", "bbbb");
  assert.equal(cache.get("b"), "bbbb");
  cache.clear();
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), undefined);
  cache.set("c", "cccc");
  assert.equal(cache.get("c"), "cccc");
});

test("unserializable values and invalid estimates do not disrupt display", () => {
  const cache = new SessionCache<object>();
  const circular: { self?: object } = {};
  circular.self = circular;
  assert.doesNotThrow(() => cache.set("circular", circular));
  assert.equal(cache.get("circular"), undefined);
  for (const bytes of [NaN, Infinity, -1, -0.1]) {
    const invalid = new SessionCache<string>({ estimateBytes: () => bytes });
    invalid.set("a", "a");
    assert.equal(invalid.get("a"), undefined);
  }
});

test("the default estimate counts serialized Unicode strings conservatively", () => {
  const tooSmall = new SessionCache<string>({ maxBytes: 5 });
  tooSmall.set("a", "界");
  assert.equal(tooSmall.get("a"), undefined);
  const exact = new SessionCache<string>({ maxBytes: 6 });
  exact.set("a", "界");
  assert.equal(exact.get("a"), "界");
});

test("zero limits disable caching and invalid limits are rejected", () => {
  for (const options of [
    { maxEntries: 0 },
    { maxBytes: 0 },
    { idleTtlMs: 0 },
  ]) {
    const cache = new SessionCache<string>(options);
    cache.set("a", "a");
    assert.equal(cache.get("a"), undefined);
  }
  for (const options of [
    { maxEntries: -1 },
    { maxEntries: 1.5 },
    { maxBytes: Infinity },
    { idleTtlMs: NaN },
  ])
    assert.throws(() => new SessionCache(options), RangeError);
});
