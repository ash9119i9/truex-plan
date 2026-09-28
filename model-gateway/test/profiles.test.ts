import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  createProfileStore,
  parseSecret,
  type ProfileCollection,
  type StoredProfile,
} from "../src/profiles";

const base = { baseUrl: "http://p/v1", modelName: "m", wireApi: "chat" };

function fakeCollection(docs: Record<string, StoredProfile>) {
  const calls: any[] = [];
  let fail = false;
  const collection: ProfileCollection = {
    async findOne(filter) {
      calls.push(filter);
      if (fail) throw new Error("mongo down");
      for (const id of filter._id.$in) {
        const doc = docs[String(id)];
        if (doc) return doc;
      }
      return null;
    },
  };
  return {
    collection,
    calls,
    setFail: (v: boolean) => (fail = v),
  };
}

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("profile store: caches hits for the TTL, then reloads", async () => {
  const db = fakeCollection({ a: { _id: "a", ...base, apiKey: "k1" } });
  const c = clock();
  const store = createProfileStore({
    collection: db.collection,
    ttlMs: 1000,
    now: c.now,
  });
  assert.equal((await store.find("a"))?.apiKey, "k1");
  assert.equal((await store.find("a"))?.apiKey, "k1");
  assert.equal(db.calls.length, 1);
  c.advance(999);
  await store.find("a");
  assert.equal(db.calls.length, 1);
  c.advance(2);
  await store.find("a");
  assert.equal(db.calls.length, 2);
  store.clear();
  await store.find("a");
  assert.equal(db.calls.length, 3);
});

test("profile store: misses are cached briefly", async () => {
  const db = fakeCollection({});
  const c = clock();
  const store = createProfileStore({
    collection: db.collection,
    negativeTtlMs: 500,
    now: c.now,
  });
  assert.equal(await store.find("nope"), null);
  assert.equal(await store.find("nope"), null);
  assert.equal(db.calls.length, 1);
  c.advance(501);
  await store.find("nope");
  assert.equal(db.calls.length, 2);
});

test("profile store: concurrent lookups share one query", async () => {
  const db = fakeCollection({ a: { _id: "a", ...base, apiKey: "k" } });
  const store = createProfileStore({ collection: db.collection });
  const results = await Promise.all([
    store.find("a"),
    store.find("a"),
    store.find("a"),
  ]);
  assert.equal(db.calls.length, 1);
  assert.ok(results.every((r) => r?.apiKey === "k"));
});

test("profile store: Mongo errors are not cached", async () => {
  const db = fakeCollection({ a: { _id: "a", ...base, apiKey: "k" } });
  const store = createProfileStore({ collection: db.collection });
  db.setFail(true);
  await assert.rejects(store.find("a"), /mongo down/);
  db.setFail(false);
  assert.equal((await store.find("a"))?.apiKey, "k");
  assert.equal(db.calls.length, 2);
});

test("profile store: looks up string and ObjectId ids", async () => {
  const oid = new ObjectId();
  const db = fakeCollection({
    [String(oid)]: { _id: oid, ...base, apikey: "legacy" },
  });
  const store = createProfileStore({ collection: db.collection });
  const found = await store.find(String(oid));
  // Plaintext keys in Mongo keep working, including the lowercase field.
  assert.equal(found?.apikey, "legacy");
  assert.equal(db.calls[0]._id.$in.length, 2);
  await store.find("not-an-object-id");
  assert.deepEqual(db.calls[1]._id.$in, ["not-an-object-id"]);
});

test("profile store: resolves apiKeySecretArn (raw and JSON) and caches it", async () => {
  const db = fakeCollection({
    raw: { _id: "raw", ...base, apiKeySecretArn: "arn:raw" },
    json: { _id: "json", ...base, apiKeySecretArn: "arn:json" },
  });
  const asked: string[] = [];
  const c = clock();
  const store = createProfileStore({
    collection: db.collection,
    ttlMs: 10,
    now: c.now,
    secrets: {
      async get(arn) {
        asked.push(arn);
        return arn === "arn:raw" ? "  raw-key\n" : '{"api_key":"json-key"}';
      },
    },
  });
  const raw = await store.find("raw");
  assert.equal(raw?.apiKey, "raw-key");
  assert.ok(!("apiKeySecretArn" in (raw as object)));
  assert.equal((await store.find("json"))?.apiKey, "json-key");
  // The profile cache expires first; the secret is still reused.
  c.advance(20);
  await store.find("raw");
  assert.equal(db.calls.length, 3);
  assert.deepEqual(asked, ["arn:raw", "arn:json"]);
});

test("profile store: a failing secret yields no key and is retried soon", async () => {
  const db = fakeCollection({
    a: { _id: "a", ...base, apiKeySecretArn: "arn:a" },
  });
  const logs: string[] = [];
  let fail = true;
  const c = clock();
  const store = createProfileStore({
    collection: db.collection,
    negativeTtlMs: 100,
    now: c.now,
    log: (l) => logs.push(l),
    secrets: {
      async get() {
        if (fail) throw Object.assign(new Error("denied"), { name: "Denied" });
        return "fixed-key";
      },
    },
  });
  const first = await store.find("a");
  assert.ok(first);
  assert.equal(first.apiKey, undefined);
  assert.match(logs.join("\n"), /secret lookup failed \(Denied\)/);
  fail = false;
  c.advance(101);
  assert.equal((await store.find("a"))?.apiKey, "fixed-key");
});

test("profile store: plaintext key wins over a secret ARN", async () => {
  const db = fakeCollection({
    a: { _id: "a", ...base, apiKey: "plain", apiKeySecretArn: "arn:a" },
  });
  const store = createProfileStore({
    collection: db.collection,
    secrets: {
      async get() {
        throw new Error("should not be called");
      },
    },
  });
  assert.equal((await store.find("a"))?.apiKey, "plain");
});

test("parseSecret handles raw keys, JSON fields and junk", () => {
  assert.equal(parseSecret("abc"), "abc");
  assert.equal(parseSecret('{"apiKey":"a"}'), "a");
  assert.equal(parseSecret('{"key":"k"}'), "k");
  assert.equal(parseSecret('{"other":"x"}'), undefined);
  assert.equal(parseSecret("{not json"), undefined);
  assert.equal(parseSecret("   "), undefined);
});

test("profile store: after the TTL, serves the cached profile at once and refreshes in the background", async () => {
  const docs: Record<string, StoredProfile> = {
    a: { _id: "a", ...base, apiKey: "k1" },
  };
  let release!: () => void;
  let slow = false;
  const calls: any[] = [];
  const collection: ProfileCollection = {
    async findOne(filter) {
      calls.push(filter);
      if (slow) await new Promise<void>((r) => (release = r));
      return docs[String(filter._id.$in[0])] ?? null;
    },
  };
  const c = clock();
  const store = createProfileStore({ collection, ttlMs: 1000, now: c.now });
  assert.equal((await store.find("a"))?.apiKey, "k1");
  // Mongo becomes slow and the profile changes; the TTL expires.
  slow = true;
  docs.a = { _id: "a", ...base, apiKey: "k2", enabled: false };
  c.advance(1001);
  // Served immediately from cache, without waiting for the slow lookup.
  assert.equal((await store.find("a"))?.apiKey, "k1");
  assert.equal((await store.find("a"))?.apiKey, "k1");
  assert.equal(calls.length, 2, "one background refresh, shared");
  release();
  await new Promise((r) => setImmediate(r));
  // The refreshed document (now disabled) is used from the next request on.
  const next = await store.find("a");
  assert.equal(next?.apiKey, "k2");
  assert.equal(next?.enabled, false);
});

test("profile store: a failed background refresh keeps the stale copy, bounded by maxStaleMs", async () => {
  const db = fakeCollection({ a: { _id: "a", ...base, apiKey: "k" } });
  const c = clock();
  const logs: string[] = [];
  const store = createProfileStore({
    collection: db.collection,
    ttlMs: 1000,
    maxStaleMs: 5000,
    now: c.now,
    log: (l) => logs.push(l),
  });
  await store.find("a");
  db.setFail(true);
  c.advance(1001);
  assert.equal((await store.find("a"))?.apiKey, "k");
  await new Promise((r) => setImmediate(r));
  assert.match(logs.join("\n"), /background refresh failed \(Error\)/);
  assert.doesNotMatch(logs.join("\n"), /"k"|apiKey/);
  // Past maxStaleMs the request waits for Mongo, and sees the failure.
  c.advance(5000);
  await assert.rejects(store.find("a"), /mongo down/);
});

test("profile store: missing profiles are never served stale", async () => {
  const docs: Record<string, StoredProfile> = {};
  const collection: ProfileCollection = {
    async findOne(filter) {
      return docs[String(filter._id.$in[0])] ?? null;
    },
  };
  const c = clock();
  const store = createProfileStore({
    collection,
    negativeTtlMs: 500,
    now: c.now,
  });
  assert.equal(await store.find("a"), null);
  docs.a = { _id: "a", ...base, apiKey: "k" };
  c.advance(501);
  // Waits for the lookup instead of returning the cached miss.
  assert.equal((await store.find("a"))?.apiKey, "k");
});
