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

test("profile store: a failing secret is unavailable, never cached as a missing key", async () => {
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
  await assert.rejects(store.find("a"), /credential source unavailable/);
  assert.equal(store.stats().profiles.entries, 0);
  assert.match(logs.join("\n"), /secret lookup failed \(Denied\)/);
  fail = false;
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

test("profile store: enabled keyless profiles use the short negative TTL", async () => {
  const docs = { a: { _id: "a", ...base } as StoredProfile };
  const db = fakeCollection(docs);
  const c = clock();
  const store = createProfileStore({
    collection: db.collection,
    now: c.now,
    ttlMs: 1000,
    negativeTtlMs: 50,
  });
  assert.equal((await store.find("a"))?.apiKey, undefined);
  docs.a = { ...docs.a, apiKey: "configured-key" };
  c.advance(51);
  assert.equal((await store.find("a"))?.apiKey, "configured-key");
  assert.equal(db.calls.length, 2);
});

test("parseSecret handles raw keys, JSON fields and junk", () => {
  assert.equal(parseSecret("abc"), "abc");
  assert.equal(parseSecret('{"apiKey":"a"}'), "a");
  assert.equal(parseSecret('{"key":"k"}'), "k");
  assert.equal(parseSecret('{"other":"x"}'), undefined);
  assert.equal(parseSecret("{not json"), undefined);
  assert.equal(parseSecret("   "), undefined);
});

test("profile store: expired profiles wait for refresh instead of dispatching stale keys", async () => {
  const c = clock();
  let value: StoredProfile = { _id: "a", ...base, apiKey: "k1" };
  let release!: () => void;
  let slow = false;
  let calls = 0;
  const store = createProfileStore({
    ttlMs: 1000,
    now: c.now,
    collection: {
      async findOne() {
        calls++;
        if (slow)
          await new Promise<void>((r) => {
            release = r;
          });
        return value;
      },
    },
  });
  assert.equal((await store.find("a"))?.apiKey, "k1");
  slow = true;
  value = { _id: "a", ...base, apiKey: "k2", enabled: false };
  c.advance(1001);
  let settled = false;
  const next = store.find("a").then((result) => {
    settled = true;
    return result;
  });
  const duplicate = store.find("a");
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(calls, 2);
  release();
  assert.equal((await next)?.enabled, false);
  assert.equal((await duplicate)?.apiKey, "k2");
});

test("profile store: expired security state never falls back when Mongo fails", async () => {
  const db = fakeCollection({ a: { _id: "a", ...base, apiKey: "k" } });
  const c = clock();
  const store = createProfileStore({
    collection: db.collection,
    ttlMs: 1000,
    now: c.now,
  });
  await store.find("a");
  db.setFail(true);
  c.advance(1001);
  await assert.rejects(store.find("a"), /mongo down/);
  assert.equal(store.stats().profiles.entries, 0);
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

test("profile store: clear during a secret lookup fences both secret and profile results", async () => {
  const db = fakeCollection({
    a: { _id: "a", ...base, apiKeySecretArn: "arn:a" },
  });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let calls = 0;
  const store = createProfileStore({
    collection: db.collection,
    secrets: {
      async get() {
        if (++calls === 1) {
          entered();
          await new Promise<void>((r) => {
            release = r;
          });
          return "old-key";
        }
        return "rotated-key";
      },
    },
  });
  const original = store.find("a");
  const rejected = assert.rejects(original, /invalidated/);
  await started;
  store.clear();
  await rejected;
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(store.stats().secrets.entries, 0);
  assert.equal(store.stats().profiles.entries, 0);
  assert.equal((await store.find("a"))?.apiKey, "rotated-key");
  assert.equal(calls, 2);
});

test("profile store: profile freshness cannot extend a secret's original expiry", async () => {
  const c = clock();
  const db = fakeCollection({
    a: { _id: "a", ...base, apiKeySecretArn: "arn:a" },
  });
  let calls = 0;
  const store = createProfileStore({
    collection: db.collection,
    now: c.now,
    ttlMs: 100,
    secretTtlMs: 150,
    secrets: {
      async get() {
        return `key-${++calls}`;
      },
    },
  });
  assert.equal((await store.find("a"))?.apiKey, "key-1");
  c.advance(101);
  assert.equal((await store.find("a"))?.apiKey, "key-1");
  c.advance(50);
  assert.equal((await store.find("a"))?.apiKey, "key-2");
});

test("profile store: profile, secret and negative entries obey count/byte limits", async () => {
  const db = fakeCollection(
    Object.fromEntries(
      ["a", "b", "c"].map((id) => [
        id,
        { _id: id, ...base, apiKeySecretArn: `arn:${id}` },
      ]),
    ),
  );
  const store = createProfileStore({
    collection: db.collection,
    maxEntries: 2,
    maxProfileBytes: 1000,
    maxSecretBytes: 50,
    secrets: {
      async get() {
        return "a-key";
      },
    },
  });
  for (const id of ["a", "b", "c", "missing-1", "missing-2", "missing-3"])
    await store.find(id);
  assert.equal(store.stats().profiles.entries, 2);
  assert.equal(store.stats().secrets.entries, 2);
  assert.ok(store.stats().profiles.bytes <= 1000);
  assert.ok(store.stats().secrets.bytes <= 50);
  const uncached = createProfileStore({
    collection: db.collection,
    maxProfileBytes: 1,
    maxSecretBytes: 1,
    secrets: {
      async get() {
        return "a-key";
      },
    },
  });
  assert.equal((await uncached.find("a"))?.apiKey, "a-key");
  assert.equal(uncached.stats().profiles.entries, 0);
  assert.equal(uncached.stats().secrets.entries, 0);
});

test("profile store: caller mutation cannot alter the cached profile", async () => {
  const db = fakeCollection({
    a: { _id: "a", ...base, apiKey: "k", headers: { "x-provider": "value" } },
  });
  const store = createProfileStore({ collection: db.collection });
  const result = (await store.find("a"))!;
  result.enabled = false;
  result.headers!["x-provider"] = "changed";
  const again = (await store.find("a"))!;
  assert.equal(again.enabled, undefined);
  assert.equal(again.headers!["x-provider"], "value");
});

test("profile store: timeout retains capacity until an abort-ignoring dependency settles", async () => {
  let release!: (profile: StoredProfile | null) => void;
  let calls = 0;
  const store = createProfileStore({
    maxPending: 1,
    lookupTimeoutMs: 15,
    collection: {
      async findOne() {
        calls++;
        return new Promise((r) => {
          release = r;
        });
      },
    },
  });
  const first = store.find("a");
  const duplicate = store.find("a");
  const outcomes = await Promise.allSettled([first, duplicate]);
  assert.ok(
    outcomes.every(
      (r) => r.status === "rejected" && /timed out/.test(String(r.reason)),
    ),
  );
  assert.equal(calls, 1);
  await assert.rejects(store.find("b"), /capacity exceeded/);
  assert.equal(store.stats().pending, 1);
  release({ _id: "a", ...base, apiKey: "late-key" });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.stats().pending, 0);
  assert.equal(store.stats().profiles.entries, 0);
});

test("profile store: concurrent profiles sharing a credential dedupe secret resolution", async () => {
  const db = fakeCollection({
    a: { _id: "a", ...base, apiKeySecretArn: "same" },
    b: { _id: "b", ...base, apiKeySecretArn: "same" },
  });
  let calls = 0;
  const store = createProfileStore({
    collection: db.collection,
    secrets: {
      async get() {
        calls++;
        await new Promise((r) => setImmediate(r));
        return "shared-key";
      },
    },
  });
  const [a, b] = await Promise.all([store.find("a"), store.find("b")]);
  assert.equal(a?.apiKey, "shared-key");
  assert.equal(b?.apiKey, "shared-key");
  assert.equal(calls, 1);
});

test("profile store: one-slot capacity still allows a profile to resolve its credential", async () => {
  const db = fakeCollection({
    a: { _id: "a", ...base, apiKeySecretArn: "arn:a" },
  });
  const store = createProfileStore({
    collection: db.collection,
    maxPending: 1,
    secrets: {
      async get() {
        return "key";
      },
    },
  });
  assert.equal((await store.find("a"))?.apiKey, "key");
  assert.equal(store.stats().pending, 0);
});

test("profile store: hot-key joiners are bounded and clear retains unsettled waiter reservations", async () => {
  let release!: (value: StoredProfile | null) => void;
  let calls = 0;
  const store = createProfileStore({
    maxWaiters: 2,
    collection: {
      async findOne() {
        calls++;
        return new Promise((r) => {
          release = r;
        });
      },
    },
  });
  const first = store.find("hot");
  const second = store.find("hot");
  const firstRejected = assert.rejects(first, /invalidated/);
  const secondRejected = assert.rejects(second, /invalidated/);
  await assert.rejects(store.find("hot"), /waiter capacity exceeded/);
  assert.equal(calls, 1);
  assert.equal(store.stats().waiters, 2);
  store.clear();
  const duringClear = store.find("hot");
  await assert.rejects(duringClear, /waiter capacity exceeded/);
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(store.stats().waiters, 0);
  assert.equal(store.stats().pending, 1);
  release({ _id: "hot", ...base, apiKey: "discarded-key" });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.stats().pending, 0);
  assert.equal(store.stats().profiles.entries, 0);
});
