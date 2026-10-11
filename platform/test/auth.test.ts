import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { Request, Response } from "express";
import { Store } from "../src/store";
import { tenantDbName } from "../src/tenant";
import {
  cookieSpec,
  emailKey,
  hashToken,
  isGmail,
  newToken,
  parseCookies,
  rateLimit,
  revokeSessions,
  validEmail,
} from "../src/auth";
import { BAD_EMAILS, EMAIL_VECTORS } from "./email-vectors";

const root = resolve("..");
const FRONTEND = "http://localhost:3000";
const ADMIN = "http://localhost:3001";
async function port() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const value = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return value;
}
async function wait(predicate: () => Promise<boolean>, timeout = 20000) {
  const begin = Date.now();
  while (!(await predicate().catch(() => false))) {
    if (Date.now() - begin > timeout)
      throw new Error("Timed out waiting for the platform");
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((r) => {
    child.once("exit", () => r());
    setTimeout(() => {
      child.kill("SIGKILL");
      r();
    }, 6000).unref();
  });
}
function launch(extra: Record<string, string>) {
  let logs = "";
  const child = spawn(
    process.execPath,
    [resolve(root, "platform/node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
    {
      cwd: resolve(root, "platform"),
      env: { ...process.env, DOTENV_CONFIG_PATH: "/nonexistent", DEMO_TENANT_ID: "", DEFAULT_TENANT_SIGNUP: "on", DEFAULT_SIGNUP_TENANT_ID: "default-tenant", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (x) => (logs += x));
  child.stderr?.on("data", (x) => (logs += x));
  return { child, logs: () => logs };
}

test("emailKey and validEmail: Gmail aliases collapse, other domains do not", () => {
  for (const [typed, key] of EMAIL_VECTORS) {
    assert.equal(validEmail(typed), typed.trim(), typed);
    assert.equal(emailKey(typed), key, typed);
  }
  for (const bad of BAD_EMAILS) assert.equal(validEmail(bad), undefined, JSON.stringify(bad));
  assert.equal(validEmail(undefined), undefined);
  assert.equal(validEmail(42 as unknown), undefined);
  // Surrounding whitespace is trimmed, not part of the address.
  assert.equal(validEmail("  person@example.com\n"), "person@example.com");
  // Two different Workspace people are never one account.
  assert.notEqual(emailKey("jane.doe@acme.example"), emailKey("janedoe@acme.example"));
  assert.notEqual(emailKey("jane@acme.example"), emailKey("jane+x@acme.example"));
});

test("emailKey, isGmail and tokens", () => {
  assert.equal(emailKey("A.Shok+x@gmail.com"), "ashok@gmail.com");
  assert.equal(emailKey(" ashok@Gmail.com "), "ashok@gmail.com");
  assert.equal(isGmail("a.b+c@gmail.com"), true);
  assert.equal(isGmail("ashok@example.com"), false);
  assert.equal(isGmail("ashok@gmail.com.evil.io"), false);
  const token = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newToken(), token);
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
});

test("cookieSpec: __Host- and Secure only for https origins", () => {
  assert.deepEqual(
    cookieSpec("main", { FRONTEND_ORIGIN: "https://app.example.com" }),
    { name: "__Host-truex_session", secure: true },
  );
  assert.deepEqual(
    cookieSpec("admin", {
      FRONTEND_ORIGIN: "http://localhost:3000",
      ADMIN_ORIGIN: "https://admin.example.com",
    }),
    { name: "__Host-truex_admin", secure: true },
  );
  assert.deepEqual(cookieSpec("main", { FRONTEND_ORIGIN: FRONTEND }), {
    name: "truex_session",
    secure: false,
  });
  assert.deepEqual(cookieSpec("admin", { ADMIN_ORIGIN: ADMIN }), {
    name: "truex_admin",
    secure: false,
  });
});

test("parseCookies: first occurrence wins, malformed parts ignored", () => {
  const cookies = parseCookies("a=1; junk; b=%zz; a=2; c = 3 ");
  assert.equal(cookies.get("a"), "1");
  assert.equal(cookies.get("b"), "%zz");
  assert.equal(cookies.get("c"), "3");
  assert.equal(cookies.has("junk"), false);
});

test("rateLimit: per ip, 429 RATE_LIMITED past max", () => {
  const limit = rateLimit({ windowMs: 60_000, max: 2 });
  const res = { setHeader() {} } as unknown as Response;
  const call = (ip: string) => {
    let error: any = "none";
    limit({ ip } as Request, res, (e?: unknown) => (error = e));
    return error;
  };
  assert.equal(call("1.1.1.1"), undefined);
  assert.equal(call("1.1.1.1"), undefined);
  assert.equal(call("1.1.1.1").code, "RATE_LIMITED");
  assert.equal(call("1.1.1.1").status, 429);
  assert.equal(call("2.2.2.2"), undefined);
});

test("AUTH_MODE=google refuses to start without its keys", { timeout: 30000 }, async () => {
  const { child, logs } = launch({
    PORT: String(await port()),
    MONGO_URI: "mongodb://127.0.0.1:1",
    MONGO_DB: "auth_refuse",
    CATALOG_MONGO_DB: "auth_refuse",
    MCP_ALLOWED_PRIVATE_HOSTS: "example.com",
    AUTH_MODE: "google",
    // Explicitly empty so a local platform/.env cannot fill them in.
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    FRONTEND_ORIGIN: FRONTEND,
  });
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  assert.equal(code, 1);
  assert.match(logs(), /AUTH_MODE=google requires GOOGLE_CLIENT_ID/);
});

test(
  "google mode: sessions, memberships, tenants, switch and CSRF",
  { timeout: 90000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "auth_test", "auth_test").connect();
    const platformPort = await port();
    const { child, logs } = launch({
      PORT: String(platformPort),
      MONGO_URI: mongo.getUri(),
      MONGO_DB: "auth_test",
      CATALOG_MONGO_DB: "auth_test",
      MCP_ALLOWED_PRIVATE_HOSTS: "example.com",
      // Nothing listens here; these tests never reach agent-core.
      AGENT_CORE_URLS: `http://127.0.0.1:${await port()}`,
      AUTH_MODE: "google",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      FRONTEND_ORIGIN: FRONTEND,
      ADMIN_ORIGIN: ADMIN,
      TRUST_PROXY: "",
    });
    t.after(async () => {
      await stop(child);
      await store.client.close();
      await mongo.stop();
    });
    const base = `http://127.0.0.1:${platformPort}`;
    await wait(async () => (await fetch(`${base}/livez`)).ok).catch((e) => {
      throw new Error(`${e.message}\n${logs()}`);
    });

    const now = new Date().toISOString();
    await store.tenantRegistry.insertMany(
      ["acme", "beta", "gone"].map((id) => ({
        _id: id,
        name: id.toUpperCase(),
        dbName: tenantDbName(id),
        status: id === "gone" ? ("disabled" as const) : ("active" as const),
        createdAt: now,
        updatedAt: now,
      })),
    );
    await store.users.insertMany([
      {
        _id: "u_ashok",
        googleSub: "sub-ashok",
        email: "ashok@gmail.com",
        emailKey: "ashok@gmail.com",
        name: "Ashok",
        picture: "https://example.com/a.png",
        status: "active",
        createdAt: now,
      },
      {
        _id: "u_dharun",
        googleSub: "sub-dharun",
        email: "dharun@gmail.com",
        emailKey: "dharun@gmail.com",
        status: "active",
        createdAt: now,
      },
    ]);
    const member = (userId: string, tenantId: string, role: "admin" | "user") =>
      ({
        _id: `${userId}:${tenantId}`,
        userId,
        tenantId,
        role,
        status: "active",
        createdAt: now,
      }) as const;
    await store.memberships.insertMany([
      member("u_ashok", "acme", "admin"),
      member("u_ashok", "gone", "user"),
      member("u_dharun", "acme", "user"),
    ]);
    const DAY = 86_400_000;
    const session = async (
      fields: {
        userId?: string | null;
        tenantId?: string | null;
        app?: "main" | "admin";
        idle?: number;
        absolute?: number;
        lastSeen?: number;
      } = {},
    ) => {
      const token = newToken();
      const at = Date.now();
      await store.authSessions.insertOne({
        _id: hashToken(token),
        userId: fields.userId === undefined ? "u_ashok" : fields.userId,
        tenantId: fields.tenantId === undefined ? "acme" : fields.tenantId,
        app: fields.app ?? "main",
        createdAt: new Date(at),
        lastSeenAt: new Date(at + (fields.lastSeen ?? 0)),
        idleExpiresAt: new Date(at + (fields.idle ?? 7 * DAY)),
        absoluteExpiresAt: new Date(at + (fields.absolute ?? 30 * DAY)),
      });
      return token;
    };
    const main = (token: string) => `truex_session=${token}`;
    const admin = (token: string) => `truex_admin=${token}`;
    const get = (path: string, cookie?: string) =>
      fetch(base + path, { headers: cookie ? { cookie } : {} });
    const post = (
      path: string,
      cookie: string | undefined,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          origin: FRONTEND,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const code = async (res: globalThis.Response) => (await res.json()).code;

    // A valid session: /api/me in the plan's shape, name and picture included.
    const good = await session();
    const me = await get("/api/me", main(good));
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), {
      user: {
        id: "u_ashok",
        email: "ashok@gmail.com",
        name: "Ashok",
        picture: "https://example.com/a.png",
      },
      tenant: { id: "acme", name: "ACME" },
      role: "admin",
      tenants: [{ id: "acme", name: "ACME", role: "admin" }],
      // Lets the app know whether there is a session to end.
      auth: "google",
      selfService: false,
      showWorkspaces: true,
    });

    // Missing, tampered, expired and idle-expired cookies are 401.
    const missing = await get("/api/me");
    assert.equal(missing.status, 401);
    assert.equal(await code(missing), "UNAUTHENTICATED");
    const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    assert.equal((await get("/api/me", main(tampered))).status, 401);
    assert.equal((await get("/api/me", main("not-a-token"))).status, 401);
    const expired = await session({ absolute: -1000, idle: 7 * DAY });
    assert.equal((await get("/api/me", main(expired))).status, 401);
    const idle = await session({ idle: -1000 });
    assert.equal((await get("/api/me", main(idle))).status, 401);
    assert.equal(
      await store.authSessions.countDocuments({ _id: hashToken(idle) }),
      0,
    );

    // Touch: lastSeenAt and the idle extension are written once a minute at
    // most, and the idle expiry never passes the absolute one.
    const stale = await session({ lastSeen: -120_000, idle: DAY, absolute: 2 * DAY });
    assert.equal((await get("/api/me", main(stale))).status, 200);
    const touched = await store.authSessions.findOne({ _id: hashToken(stale) });
    assert.ok(Date.now() - touched!.lastSeenAt.getTime() < 10_000);
    assert.equal(
      touched!.idleExpiresAt.getTime(),
      touched!.absoluteExpiresAt.getTime(),
    );

    // Wrong app in both directions is 403 WRONG_APP.
    const adminToken = await session({ userId: null, tenantId: null, app: "admin" });
    const adminOnMain = await get("/api/me", admin(adminToken));
    assert.equal(adminOnMain.status, 403);
    assert.equal(await code(adminOnMain), "WRONG_APP");
    const mainOnAdmin = await get("/api/admin/tenants", main(good));
    assert.equal(mainOnAdmin.status, 403);
    assert.equal(await code(mainOnAdmin), "WRONG_APP");
    assert.equal((await get("/api/admin/tenants")).status, 401);
    // An admin session passes the gate (no admin routes exist yet).
    assert.notEqual(
      (await get("/api/admin/tenants", admin(adminToken))).status,
      401,
    );
    // A main-app cookie carrying an admin session's token is not accepted.
    assert.equal((await get("/api/me", main(adminToken))).status, 401);

    // CSRF: foreign or missing Origin, and non-JSON bodies, are refused.
    const foreign = await post("/auth/logout", main(good), undefined, {
      origin: "https://evil.example",
    });
    assert.equal(foreign.status, 403);
    assert.equal(await code(foreign), "CSRF_ORIGIN");
    const noOrigin = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { cookie: main(good), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noOrigin.status, 403);
    // A text body with the right Origin is still refused.
    const text = await fetch(`${base}/auth/switch-tenant`, {
      method: "POST",
      headers: { origin: FRONTEND, cookie: main(good), "content-type": "text/plain" },
      body: "tenantId=beta",
    });
    assert.equal(text.status, 415);
    assert.equal(await code(text), "UNSUPPORTED_MEDIA_TYPE");
    assert.equal((await get("/api/me", main(good))).status, 200);

    // /auth/tenants lists active memberships, skipping disabled tenants.
    const tenants = await get("/auth/tenants", main(good));
    assert.deepEqual(await tenants.json(), {
      tenants: [{ id: "acme", name: "ACME", role: "admin" }],
    });
    assert.equal((await get("/auth/tenants")).status, 401);

    // switch-tenant: 403 without a membership, then a new token on success.
    const denied = await post("/auth/switch-tenant", main(good), {
      tenantId: "beta",
    });
    assert.equal(denied.status, 403);
    assert.equal(await code(denied), "NOT_A_MEMBER");
    await store.memberships.insertOne(member("u_ashok", "beta", "user"));
    const switched = await post("/auth/switch-tenant", main(good), {
      tenantId: "beta",
    });
    assert.equal(switched.status, 200);
    assert.deepEqual(await switched.json(), {
      tenant: { id: "beta" },
      role: "user",
    });
    const cookies = switched.headers.getSetCookie();
    // http origin: no __Host- prefix and no Secure, or the browser drops it.
    const issued = cookies.find((c) => /^truex_session=[A-Za-z0-9_-]{43};/.test(c));
    assert.ok(issued, cookies.join("\n"));
    assert.match(issued!, /HttpOnly/);
    assert.match(issued!, /SameSite=Lax/);
    assert.match(issued!, /Path=\//);
    assert.doesNotMatch(issued!, /Secure|Domain/);
    const next = issued!.split(";")[0].split("=")[1];
    assert.notEqual(next, good);
    assert.equal((await get("/api/me", main(good))).status, 401);
    const onBeta = await get("/api/me", main(next));
    assert.equal(onBeta.status, 200);
    const betaMe = await onBeta.json();
    assert.equal(betaMe.tenant.id, "beta");
    assert.equal(betaMe.role, "user");

    // Logout deletes the session and clears the cookie.
    const out = await post("/auth/logout", main(next));
    assert.equal(out.status, 204);
    assert.match(out.headers.getSetCookie().join("\n"), /truex_session=;.*Max-Age=0/);
    assert.equal((await get("/api/me", main(next))).status, 401);

    // Removing a membership ends access on the next request.
    const dharun = await session({ userId: "u_dharun" });
    assert.equal((await get("/api/me", main(dharun))).status, 200);
    await store.memberships.updateOne(
      { _id: "u_dharun:acme" },
      { $set: { status: "removed" } },
    );
    assert.equal((await get("/api/me", main(dharun))).status, 401);
    // revokeSessions deletes a user's sessions in one tenant.
    const other = await session();
    // Also removes the earlier "stale" session, so at least two.
    assert.ok(
      (await revokeSessions(store, { userId: "u_ashok", tenantId: "acme" })) >= 2,
    );
    assert.equal((await get("/api/me", main(other))).status, 401);

    // A disabled user is signed out.
    const blocked = await session();
    await store.users.updateOne({ _id: "u_ashok" }, { $set: { status: "disabled" } });
    assert.equal((await get("/api/me", main(blocked))).status, 401);
    await store.users.updateOne({ _id: "u_ashok" }, { $set: { status: "active" } });

    // Disabling a tenant ends access once the 5s tenant cache expires.
    const live = await session();
    assert.equal((await get("/api/me", main(live))).status, 200);
    await store.tenantRegistry.updateOne(
      { _id: "acme" },
      { $set: { status: "disabled" } },
    );
    await new Promise((r) => setTimeout(r, 5200));
    const disabled = await get("/api/me", main(live));
    assert.equal(disabled.status, 403);
    assert.equal(await code(disabled), "TENANT_DISABLED");
  },
);
