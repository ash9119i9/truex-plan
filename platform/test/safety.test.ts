import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { ApiError } from "../src/errors";
import {
  errorHandler,
  loggablePath,
  requestIdMiddleware,
  route,
} from "../src/http";
import {
  StreamLimiter,
  revalidateMs,
  watchAccess,
  MAX_REVALIDATE_MS,
} from "../src/streams";
import {
  assertGoogleConfig,
  googleRoutes,
  googleSettings,
  profileName,
  profilePicture,
} from "../src/google";
import {
  hashToken,
  newToken,
  readSession,
  type AuthSessionDocument,
} from "../src/auth";
import { assertFreshDatabase, createTenant } from "../src/admin";
import { recordAudit, requireAudit } from "../src/audit";
import { policyOf } from "../src/tenant";
import type { Request } from "express";

const root = resolve("..");

async function listen(app: express.Express) {
  const server = await new Promise<import("node:http").Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test("route(): an /api request without user and tenant context fails closed", async (t) => {
  const app = express();
  app.use(requestIdMiddleware);
  const ran: string[] = [];
  const handler = (name: string) =>
    route(() => {
      ran.push(name);
      return undefined;
    });
  // Middleware forgot to resolve anyone for /api/... : never an internal caller.
  app.get("/api/sessions/:id", handler("api"), (_req, res) =>
    res.json({ ok: true }),
  );
  app.get(
    "/api/me",
    (_req, res, next) => {
      res.locals.user = { id: "u1", email: "u@x.test", role: "user" };
      next();
    },
    handler("api-user-only"),
  );
  // Admin control plane passes its own gate (res.locals.admin) instead.
  app.get(
    "/api/admin/ping",
    (_req, res, next) => {
      res.locals.admin = true;
      next();
    },
    route((_req, res) => res.json({ admin: true })),
  );
  // Not under /api: health checks and the like run without a user.
  app.get(
    "/healthz",
    route((_req, res) => res.json({ ok: true })),
  );
  app.use(errorHandler);
  const server = await listen(app);
  t.after(server.close);

  const bare = await fetch(`${server.url}/api/sessions/s1`);
  assert.equal(bare.status, 500);
  assert.equal((await bare.json()).code, "CONTEXT_MISSING");
  const half = await fetch(`${server.url}/api/me`);
  assert.equal(
    half.status,
    500,
    "a user without a tenant is not enough either",
  );
  assert.deepEqual(ran, [], "no handler ran");
  assert.equal((await fetch(`${server.url}/api/admin/ping`)).status, 200);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  // A query string cannot disguise the path.
  assert.equal(
    (await fetch(`${server.url}/api/sessions/s1?x=/healthz`)).status,
    500,
  );
});

test("logged paths never carry invite or session tokens", () => {
  const token = newToken();
  const path = (originalUrl: string) => loggablePath({ originalUrl });
  assert.equal(path(`/auth/invites/${token}`), "/auth/invites/:token");
  assert.equal(
    path(`/auth/invites/${token}?x=${token}`),
    "/auth/invites/:token",
  );
  assert.equal(path(`/invite/${token}/extra`), "/invite/:token/extra");
  assert.equal(
    path("/api/sessions/sess_1/messages"),
    "/api/sessions/sess_1/messages",
  );
  assert.equal(
    path("/auth/google/callback?code=abc&state=def"),
    "/auth/google/callback",
  );
});

test("watchAccess: ends once on a withdrawn or unconfirmable verdict; never overlaps; stop is final", async () => {
  const ends: string[] = [];
  let calls = 0;
  const stop = watchAccess({
    intervalMs: 20,
    check: async () =>
      ++calls < 3 ? { ok: true } : { ok: false, reason: "revoked" },
    onEnd: (v) => ends.push(v.reason),
  });
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(ends, ["revoked"]);
  assert.equal(calls, 3, "no further checks after the verdict");
  stop();

  // The authority store failing is "unavailable": the stream does not outlive it.
  const failed: string[] = [];
  watchAccess({
    intervalMs: 20,
    check: async () => {
      throw new Error("database is down");
    },
    onEnd: (v) => failed.push(v.reason),
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(failed, ["unavailable"]);

  // A slow check is never started twice at once.
  let active = 0,
    peak = 0;
  const stopSlow = watchAccess({
    intervalMs: 10,
    check: async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 60));
      active--;
      return { ok: true };
    },
    onEnd: () => {},
  });
  await new Promise((r) => setTimeout(r, 200));
  stopSlow();
  assert.equal(peak, 1);

  // stop() before a verdict means no callback at all.
  let late = 0;
  const stopped = watchAccess({
    intervalMs: 10,
    check: async () => ({ ok: false, reason: "revoked" }),
    onEnd: () => late++,
  });
  stopped();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(late, 0);
});

test("revalidation interval is bounded under the thirty-second revocation limit", () => {
  assert.equal(revalidateMs({}), 10_000);
  assert.equal(revalidateMs({ STREAM_REVALIDATE_MS: "500" }), 500);
  assert.equal(
    revalidateMs({ STREAM_REVALIDATE_MS: "999999" }),
    MAX_REVALIDATE_MS,
  );
  assert.ok(MAX_REVALIDATE_MS < 30_000);
  assert.equal(revalidateMs({ STREAM_REVALIDATE_MS: "-5" }), 10_000);
  assert.equal(revalidateMs({ STREAM_REVALIDATE_MS: "nope" }), 10_000);
});

test("StreamLimiter: per-person cap, idempotent release, no leak", () => {
  const limiter = new StreamLimiter(2);
  const a1 = limiter.acquire("a")!,
    a2 = limiter.acquire("a")!;
  assert.ok(a1 && a2);
  assert.equal(limiter.acquire("a"), undefined);
  assert.ok(limiter.acquire("b"), "another person is unaffected");
  a1();
  a1();
  assert.ok(
    limiter.acquire("a"),
    "one slot freed, and a double release frees only one",
  );
  assert.equal(limiter.acquire("a"), undefined);
  a2();
  const last = limiter.acquire("a")!;
  last();
  assert.equal(limiter.acquire("c")!.constructor, Function);
});

test("readSession: a logout that wins the touch race is not undone, and a stream check never extends it", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "touch", "touch").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const token = newToken();
  const longAgo = new Date(Date.now() - 5 * 60_000);
  const doc: AuthSessionDocument = {
    _id: hashToken(token),
    userId: "u1",
    tenantId: "t1",
    app: "main",
    createdAt: longAgo,
    lastSeenAt: longAgo,
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 86_400_000),
  };
  await store.authSessions.insertOne(doc);
  const req = {
    get: (n: string) => (n === "cookie" ? `truex_session=${token}` : undefined),
  } as unknown as Request;

  // Passive: valid, and left exactly as it was.
  assert.ok(await readSession(store, req, "main", { touch: false }));
  assert.equal(
    (await store.authSessions.findOne({ _id: doc._id }))!.lastSeenAt.getTime(),
    longAgo.getTime(),
  );

  // The session is deleted between the read and the touch: the collection is
  // wrapped so a logout lands exactly when the touch is about to be written.
  const real = store.authSessions;
  Object.defineProperty(store, "authSessions", {
    configurable: true,
    get: () =>
      new Proxy(real, {
        get(target, prop) {
          if (prop === "updateOne")
            return async (...args: Parameters<typeof real.updateOne>) => {
              await target.deleteOne({ _id: doc._id });
              return target.updateOne(...args);
            };
          const value = (target as never as Record<string | symbol, unknown>)[
            prop
          ];
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  });
  assert.equal(
    await readSession(store, req, "main"),
    undefined,
    "the request that lost the race is refused",
  );
  assert.equal(
    await real.countDocuments({ _id: doc._id }),
    0,
    "and nothing was resurrected",
  );
  Object.defineProperty(store, "authSessions", {
    configurable: true,
    get: () => real,
  });

  // Expiry is judged from the stored dates, whatever the TTL monitor has done.
  const expired = newToken();
  await real.insertOne({
    ...doc,
    _id: hashToken(expired),
    idleExpiresAt: new Date(Date.now() - 1),
  });
  const reqExpired = {
    get: (n: string) =>
      n === "cookie" ? `truex_session=${expired}` : undefined,
  } as unknown as Request;
  assert.equal(await readSession(store, reqExpired, "main"), undefined);
});

test("production Google configuration is refused unless it is https and talks to Google", () => {
  const base = {
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "s",
    FRONTEND_ORIGIN: "https://app.example.com",
  };
  const settings = (env: Record<string, string>) =>
    googleSettings({ ...base, ...env });
  const prod = { NODE_ENV: "production" };
  assertGoogleConfig(settings({}), prod);
  assert.throws(
    () =>
      assertGoogleConfig(
        settings({ FRONTEND_ORIGIN: "http://app.example.com" }),
        prod,
      ),
    /https/,
  );
  assert.throws(
    () =>
      assertGoogleConfig(
        settings({ GOOGLE_ISSUER_URL: "https://idp.evil.example" }),
        prod,
      ),
    /GOOGLE_ISSUER_URL/,
  );
  assert.throws(
    () =>
      assertGoogleConfig(
        settings({ GOOGLE_ISSUER_URL: "http://127.0.0.1:9" }),
        prod,
      ),
    /GOOGLE_ISSUER_URL/,
  );
  // The test issuer and http origins stay possible outside production.
  assertGoogleConfig(
    settings({
      FRONTEND_ORIGIN: "http://localhost:3000",
      GOOGLE_ISSUER_URL: "http://127.0.0.1:9",
    }),
    {},
  );
  // An origin is an origin: no path, query or credentials, in any mode.
  for (const bad of [
    "https://app.example.com/path",
    "https://u:p@app.example.com",
    "not a url",
  ])
    assert.throws(
      () => assertGoogleConfig(settings({ FRONTEND_ORIGIN: bad }), {}),
      /origin|URL/i,
      bad,
    );
  assert.equal(
    settings({}).redirectUri,
    "https://app.example.com/auth/google/callback",
  );
});

test("Google display claims are bounded and cleaned before they are stored", () => {
  assert.equal(profileName("  Ada   Lovelace "), "Ada Lovelace");
  assert.equal(profileName("A\u202eB\u200bC\u0000D"), "A B C D");
  assert.equal([...profileName("x".repeat(400))!].length, 100);
  assert.equal(profileName("\u200b\u202e "), undefined);
  assert.equal(profileName(42), undefined);
  assert.equal(
    profilePicture("https://lh3.googleusercontent.com/a/x=s96"),
    "https://lh3.googleusercontent.com/a/x=s96",
  );
  for (const bad of [
    "http://lh3.googleusercontent.com/a.png",
    "https://evil.example/a.png",
    "https://googleusercontent.com.evil.example/a.png",
    "https://user:pw@lh3.googleusercontent.com/a.png",
    "https://lh3.googleusercontent.com:8443/a.png",
    "javascript:alert(1)",
    "https://lh3.googleusercontent.com/" + "a".repeat(600),
    "",
  ])
    assert.equal(profilePicture(bad), undefined, bad);
});

test("a tenant record with disagreeing privacy fields is refused, not guessed", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "policy", "policy").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const now = new Date().toISOString();
  const doc = (id: string, extra: object) => ({
    _id: id,
    name: id,
    dbName: `truex_t_${id}`,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  await store.tenantRegistry.insertMany([
    doc("fine", { isUserSpecific: true, chatVisibility: "own" }),
    doc("clash", { isUserSpecific: true, chatVisibility: "all" }),
    doc("junk", { chatVisibility: "everyone" }),
  ]);
  assert.equal((await store.resolveTenant("fine")).isUserSpecific, true);
  for (const id of ["clash", "junk"]) {
    await assert.rejects(store.resolveTenant(id), {
      status: 503,
      code: "TENANT_POLICY_INVALID",
    });
  }
  assert.throws(
    () => policyOf({ isUserSpecific: true, chatVisibility: "all" }),
    { code: "TENANT_POLICY_INVALID" },
  );
  // Background ingestion skips the broken tenant and keeps serving the rest.
  const active = (await store.activeTenants()).map((x) => x.id).sort();
  assert.ok(active.includes("fine"));
  assert.ok(!active.includes("clash") && !active.includes("junk"));
  // Cached results are dropped on demand, and a fresh read bypasses the cache.
  await store.resolveTenant("fine");
  await store.tenantRegistry.updateOne(
    { _id: "fine" },
    { $set: { status: "disabled" } },
  );
  assert.ok(await store.resolveTenant("fine"), "the cache is still serving");
  await assert.rejects(store.resolveTenant("fine", { fresh: true }), {
    code: "TENANT_DISABLED",
  });
  store.invalidateTenant("fine");
  await assert.rejects(store.resolveTenant("fine"), {
    code: "TENANT_DISABLED",
  });
});

test("catalog transactions need a replica set, and say so instead of working around it", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "tx", "tx").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  assert.equal(await store.supportsTransactions(), false);
  await assert.rejects(
    store.withCatalogTransaction(async (session) => {
      await store.users.insertOne(
        {
          _id: "u1",
          googleSub: "s",
          email: "a@x.test",
          emailKey: "a@x.test",
          status: "active",
          createdAt: "",
        },
        { session },
      );
    }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.code === "TRANSACTIONS_UNAVAILABLE",
  );
  assert.equal(await store.users.countDocuments(), 0, "nothing was written");
});

test("a new workspace never adopts a database that holds someone's data", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "fresh", "fresh").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await store.client
    .db("truex_t_leftover")
    .collection("sessions")
    .insertOne({ _id: "s", userId: "someone" });
  await assert.rejects(
    createTenant(store, { id: "leftover", name: "Leftover" }),
    { code: "TENANT_DB_NOT_EMPTY" },
  );
  assert.equal(
    await store.tenantRegistry.countDocuments({ _id: "leftover" }),
    0,
  );
  // Empty collections and indexes (an interrupted earlier run) are fine.
  await store.client
    .db("truex_t_resumed")
    .collection("sessions")
    .createIndex({ userId: 1 });
  await assertFreshDatabase(store, "truex_t_resumed");
  assert.ok(await createTenant(store, { id: "resumed", name: "Resumed" }));
});

test("audit rows: counted not duplicated, no content, and mandatory ones refuse on failure", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "aud", "aud").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const event = {
    actor: "u_admin",
    actorRole: "admin",
    action: "session.read",
    tenantId: "demo",
    target: { type: "session", id: "sess_1", ownerId: "u_alice" },
    requestId: "r1",
  };
  const now = new Date("2026-10-06T12:00:00Z");
  await recordAudit(store, event, now);
  await recordAudit(store, event, new Date(now.getTime() + 60_000));
  await recordAudit(store, event, new Date(now.getTime() + 11 * 60_000));
  const rows = await store.audit.find({}).sort({ at: 1 }).toArray();
  assert.equal(rows.length, 2, "one row per five-minute window");
  assert.equal(rows[0].count, 2);
  assert.ok(
    rows[0].expiresAt.getTime() - rows[0].at.getTime() >= 364 * 86_400_000,
    "a year of retention by default",
  );
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    [
      "_id",
      "action",
      "actor",
      "actorRole",
      "at",
      "count",
      "expiresAt",
      "outcome",
      "requestId",
      "target",
      "tenantId",
    ].sort(),
  );
  await store.catalog.command({
    collMod: "security_audit",
    validator: { neverPresent: { $exists: true } },
    validationAction: "error",
  });
  await assert.rejects(requireAudit(store, { ...event, actor: "u_other" }), {
    status: 503,
    code: "AUDIT_UNAVAILABLE",
  });
});

// ---- The operator command: scripts/tenant.mjs ---------------------------

test(
  "provision-demo: dry run changes nothing; refuses populated or foreign databases; is repeatable",
  { timeout: 120_000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "prov",
      "prov_catalog",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const env = {
      ...process.env,
      MONGO_URI: mongo.getUri(),
      MONGO_DB: "prov",
      CATALOG_MONGO_DB: "prov_catalog",
      DEMO_TENANT_ID: "",
      APP_PUBLIC_URL: "http://app.test",
    };
    const run = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [resolve(root, "scripts/tenant.mjs"), ...args],
        { env },
      ).then(
        (r) => ({ ...r, code: 0 }),
        (e) => ({
          stdout: e.stdout as string,
          stderr: e.stderr as string,
          code: 1,
        }),
      );
    const dbs = async () =>
      (await store.client.db().admin().listDatabases()).databases.map(
        (d) => d.name,
      );
    const untouched = async () => {
      assert.equal(await store.tenantRegistry.countDocuments(), 0);
      assert.ok(!(await dbs()).includes("truex_t_demo"));
    };

    // Dry run: reads only.
    const dry = await run("provision-demo", "--dry-run");
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /\[dry run\] would register tenant "demo"/);
    assert.match(dry.stdout, /no agents, connectors or credentials/);
    await untouched();

    // A populated database that is not registered is never adopted.
    await store.client
      .db("truex_t_demo")
      .collection("sessions")
      .insertOne({ _id: "old", userId: "someone" });
    for (const args of [["provision-demo"], ["provision-demo", "--dry-run"]]) {
      const refused = await run(...args);
      assert.equal(refused.code, 1);
      assert.match(
        refused.stderr,
        /already contains data \(sessions\) and is not registered/,
      );
    }
    assert.equal(await store.tenantRegistry.countDocuments(), 0);
    assert.equal(
      await store.client
        .db("truex_t_demo")
        .collection("sessions")
        .countDocuments(),
      1,
      "untouched",
    );
    await store.client.db("truex_t_demo").dropDatabase();

    // A database name owned by another tenant, the default tenant, or the catalog.
    const now = new Date().toISOString();
    await store.tenantRegistry.insertOne({
      _id: "squatter",
      name: "S",
      dbName: "truex_t_demo",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    assert.match(
      (await run("provision-demo")).stderr,
      /already belongs to tenant "squatter"/,
    );
    await store.tenantRegistry.deleteOne({ _id: "squatter" });
    assert.match(
      (await run("provision-demo", "default")).stderr,
      /cannot be the implicit "default"/,
    );
    assert.match(
      (await run("provision-demo", "Bad_Id")).stderr,
      /invalid tenant id/,
    );

    // The real run: registered private and invite-only, owner-aware indexes, nothing seeded.
    const made = await run("provision-demo");
    assert.equal(made.code, 0, made.stderr);
    assert.match(
      made.stdout,
      /created tenant "demo" \(Demo\) -> database truex_t_demo; private, invite-only, empty/,
    );
    const doc = await store.tenantRegistry.findOne({ _id: "demo" });
    assert.equal(doc?.dbName, "truex_t_demo");
    assert.equal(doc?.isUserSpecific, true);
    assert.equal(doc?.chatVisibility, "own");
    assert.equal(doc?.admissionPolicy, "inviteOnly");
    assert.equal(
      doc?.allowedModelIds,
      undefined,
      "no model is approved on the demo's behalf",
    );
    const demoDb = store.client.db("truex_t_demo");
    const indexes = (await demoDb.collection("truex_agents").indexes()).map(
      (i) => i.name,
    );
    assert.ok(indexes.includes("agent_creator_handle"));
    assert.ok(!indexes.includes("handle_1"), "no workspace-wide handle index");
    for (const name of ["truex_agents", "truex_mcp", "sessions", "messages"])
      assert.equal(
        await demoDb.collection(name).countDocuments(),
        0,
        `${name} is empty`,
      );

    // Repeating, or resuming after a crash, verifies and changes nothing else.
    const before = await store.tenantRegistry.findOne({ _id: "demo" });
    const again = await run("provision-demo");
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /verified tenant "demo"/);
    assert.deepEqual(
      await store.tenantRegistry.findOne({ _id: "demo" }),
      before,
    );
    await demoDb.collection("truex_agents").dropIndex("agent_creator_handle");
    assert.equal((await run("provision-demo")).code, 0);
    assert.ok(
      (await demoDb.collection("truex_agents").indexes()).some(
        (i) => i.name === "agent_creator_handle",
      ),
    );
    // A demo database that already has the workspace-wide handle index is reported, not "fixed".
    await demoDb
      .collection("truex_agents")
      .createIndex({ handle: 1 }, { unique: true, sparse: true });
    const bad = await run("provision-demo");
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /workspace-wide agent handle index \(handle_1\)/);
    // It names the likely cause and the way out, and says what state it left.
    assert.match(
      bad.stderr,
      /copy of the platform from before owner-aware agents/,
    );
    assert.match(bad.stderr, /dropIndex\("handle_1"\)/);
    assert.match(bad.stderr, /stays registered/);
    assert.ok(
      (await demoDb.collection("truex_agents").indexes()).some(
        (i) => i.name === "handle_1",
      ),
      "not dropped",
    );
    await demoDb.collection("truex_agents").dropIndex("handle_1");
    // A stray handle_1 found BEFORE registering is refused before anything is
    // written: no half-registered tenant is left behind.
    await store.client
      .db("truex_t_stray")
      .collection("truex_agents")
      .createIndex({ handle: 1 }, { unique: true, sparse: true });
    for (const args of [
      ["provision-demo", "stray"],
      ["provision-demo", "stray", "--dry-run"],
    ]) {
      const early = await run(...args);
      assert.equal(early.code, 1, args.join(" "));
      assert.match(early.stderr, /workspace-wide agent handle index/);
      assert.match(early.stderr, /Nothing was registered/);
    }
    assert.equal(
      await store.tenantRegistry.countDocuments({ _id: "stray" }),
      0,
    );
    // A real run says it is registering, not that it "would".
    const live = await run("provision-demo", "livewording");
    assert.equal(live.code, 0, live.stderr);
    assert.match(live.stdout, /^registering tenant "livewording"/m);
    assert.doesNotMatch(live.stdout, /would register/);
    // An existing tenant that is not private is not a demo.
    await store.tenantRegistry.insertOne({
      _id: "shared",
      name: "S",
      dbName: "truex_t_shared",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    assert.match((await run("provision-demo", "shared")).stderr, /not private/);

    // Disabling a workspace from the command line also signs its people out.
    const when = new Date();
    const session = (id: string, tenantId: string, app: "main" | "admin") => ({
      _id: id,
      userId: app === "main" ? "u1" : null,
      tenantId: app === "main" ? tenantId : null,
      app,
      createdAt: when,
      lastSeenAt: when,
      idleExpiresAt: new Date(when.getTime() + 3_600_000),
      absoluteExpiresAt: new Date(when.getTime() + 3_600_000),
    });
    await store.authSessions.insertMany([
      session("s-demo", "demo", "main"),
      session("s-other", "shared", "main"),
      session("s-admin", "demo", "admin"),
    ]);
    const off = await run("disable", "demo");
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /ended 1 signed-in session/);
    assert.deepEqual(
      (await store.authSessions.find({}).toArray()).map((x) => x._id).sort(),
      ["s-admin", "s-other"],
      "only the workspace's member sessions ended",
    );
    assert.equal((await run("enable", "demo")).code, 0);
    assert.equal(
      (await store.tenantRegistry.findOne({ _id: "demo" }))?.status,
      "active",
    );
    await store.authSessions.deleteMany({});

    // The staged index migration starts with a read-only inventory.
    const inventory = await run("agent-indexes", "demo");
    assert.equal(inventory.code, 0, inventory.stderr);
    assert.match(
      inventory.stdout,
      /per-creator handle index \(agent_creator_handle\): present/,
    );
    assert.match(
      inventory.stdout,
      /workspace-wide handle index \(handle_1\): absent/,
    );
    assert.match(inventory.stdout, /agents without a creator.*: 0/);
    await demoDb.collection("truex_agents").insertMany([
      { _id: "a1", handle: "dup" },
      { _id: "a2", handle: "dup", createdBy: "u1" },
    ]);
    const withLegacy = await run("agent-indexes", "demo");
    assert.match(
      withLegacy.stdout,
      /handles used by more than one agent: 1 \(dupx2\)/,
    );
    assert.match(withLegacy.stdout, /agents without a creator.*: 1/);
    assert.equal(
      await demoDb.collection("truex_agents").countDocuments(),
      2,
      "the inventory changed nothing",
    );
    await demoDb.collection("truex_agents").deleteMany({});

    // Opening admission is a separate, guarded step.
    assert.match(
      (await run("admission", "demo", "open")).stderr,
      /only for the configured demo tenant/,
    );
    env.DEMO_TENANT_ID = "demo";
    assert.match(
      (await run("admission", "demo", "open")).stderr,
      /no approved models/,
    );
    await store.profiles.insertOne({
      _id: "m1",
      provider: "p",
      baseUrl: "http://x/v1",
      modelName: "m",
      apiKey: "k",
    });
    assert.equal((await run("allow-models", "demo", "m1")).code, 0);
    assert.match(
      (await run("admission", "demo", "open")).stderr,
      /no skill allow-list/,
    );
    assert.equal((await run("allow-skills", "demo", "--none")).code, 0);
    assert.equal(
      (await store.tenantRegistry.findOne({ _id: "demo" }))?.allowedSkillIds
        ?.length,
      0,
    );
    const opened = await run("admission", "demo", "open");
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(
      (await store.tenantRegistry.findOne({ _id: "demo" }))?.admissionPolicy,
      "open",
    );
    // Another tenant can never be opened, nor the demo made shared.
    assert.match(
      (await run("admission", "shared", "open")).stderr,
      /only for the configured demo tenant/,
    );
    assert.match(
      (await run("chat-visibility", "demo", "all")).stderr,
      /is private/,
    );
    assert.equal((await run("admission", "demo", "inviteOnly")).code, 0);
    // Opening is refused while a workspace-wide handle index exists, as the
    // platform's own readiness check would refuse it.
    await demoDb
      .collection("truex_agents")
      .createIndex({ handle: 1 }, { unique: true, sparse: true });
    const refusedOpen = await run("admission", "demo", "open");
    assert.equal(refusedOpen.code, 1);
    assert.match(refusedOpen.stderr, /workspace-wide agent handle index/);
    assert.equal(
      (await store.tenantRegistry.findOne({ _id: "demo" }))?.admissionPolicy,
      "inviteOnly",
    );
    await demoDb.collection("truex_agents").dropIndex("handle_1");
    await demoDb.collection("truex_agents").dropIndex("agent_creator_handle");
    assert.match(
      (await run("admission", "demo", "open")).stderr,
      /no per-creator handle index/,
    );
    assert.equal((await run("provision-demo")).code, 0);

    assert.equal(
      (await store.tenantRegistry.findOne({ _id: "demo" }))?.admissionPolicy,
      "inviteOnly",
    );
    assert.match(
      (await run("list")).stdout,
      /demo\tactive\ttruex_t_demo\tDemo\t.*chats=own admission=inviteOnly/,
    );
  },
);

test("an unreachable Google ends sign-in recoverably: a retry message, no flow stored", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "disc", "disc").connect();
  const app = express();
  app.use(
    "/auth",
    googleRoutes(store, {
      ...googleSettings({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "s",
        FRONTEND_ORIGIN: "http://localhost:3000",
      }),
      issuer: "http://127.0.0.1:1",
    }),
  );
  const server = await listen(app);
  t.after(async () => {
    await server.close();
    await store.client.close();
    await mongo.stop();
  });
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${server.url}/auth/google/start`, {
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("location")!);
    assert.equal(to.pathname, "/login");
    assert.equal(to.searchParams.get("error"), "google_failed");
    assert.equal(
      res.headers.getSetCookie().length,
      0,
      "no flow cookie for a flow that never began",
    );
  }
  assert.equal(await store.authFlows.countDocuments(), 0);
});
