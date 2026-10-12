import { testEnvironment } from "./environment";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn, ChildProcess } from "node:child_process";
import { createServer as netServer } from "node:net";
import { createServer as httpServer, type IncomingHttpHeaders } from "node:http";
import { resolve } from "node:path";
import { Store } from "../src/store";
import { tenantDbName } from "../src/tenant";
import { emailKey, hashToken, newToken } from "../src/auth";
import { parsePasswordHash, verifyPassword } from "../src/admin";
import { inviteMailer, lookupInvite } from "../src/invites";
import { insertFixtures } from "./fixtures";
import { BAD_EMAILS, EMAIL_VECTORS } from "./email-vectors";

const root = resolve("..");
const FRONTEND = "http://localhost:3000";
const ADMIN = "http://localhost:3001";
const APP_URL = "http://app.test";
const PASSWORD = "correct horse battery staple";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function port() {
  const server = netServer();
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
      env: testEnvironment({
        ...extra,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (x) => (logs += x));
  child.stderr?.on("data", (x) => (logs += x));
  return { child, logs: () => logs };
}
// Runs scripts/<script> the way `npm run <name> --` does, with explicit env
// so a local platform/.env cannot fill anything in.
function script(
  name: string,
  args: string[],
  env: Record<string, string> = {},
  input = "",
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, fail) => {
      const child = spawn(
        process.execPath,
        [resolve(root, "scripts", name), ...args],
        { cwd: root, env: testEnvironment({
            ...env,
          }) },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (x) => (stdout += x));
      child.stderr.on("data", (x) => (stderr += x));
      child.on("error", fail);
      child.on("exit", (code) => done({ code, stdout, stderr }));
      child.stdin.end(input);
    },
  );
}
// Env for a dev-mode platform; every key the tests depend on is explicit.
async function platformEnv(
  uri: string,
  db: string,
  extra: Record<string, string>,
) {
  return {
    PORT: String(await port()),
    MONGO_URI: uri,
    MONGO_DB: db,
    CATALOG_MONGO_DB: db,
    MCP_ALLOWED_PRIVATE_HOSTS: "example.com",
    // Nothing listens here; these tests never reach agent-core.
    AGENT_CORE_URLS: `http://127.0.0.1:${await port()}`,
    AUTH_MODE: "dev",
    NODE_ENV: "test",
    DEV_TENANT_HEADER: "on",
    DEV_USER_HEADER: "on",
    FRONTEND_ORIGIN: FRONTEND,
    ADMIN_ORIGIN: ADMIN,
    APP_PUBLIC_URL: APP_URL,
    TRUST_PROXY: "",
    ADMIN_USERNAME: "",
    ADMIN_PASSWORD_HASH: "",
    RESEND_API_KEY: "",
    RESEND_API_URL: "",
    INVITE_FROM_EMAIL: "Truex <invites@example.com>",
    ...extra,
  };
}
// Records every request; replies with the queued statuses, then 200.
async function resendStub() {
  const requests: { path: string; headers: IncomingHttpHeaders; body: any }[] =
    [];
  const replies: number[] = [];
  const server = httpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(raw || "{}"),
      });
      const status = replies.shift() ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          status === 200
            ? { id: `email_${requests.length}` }
            : {
                name:
                  status === 429 ? "rate_limit_exceeded" : "application_error",
              },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    requests,
    replies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
const linkToken = (text: string) =>
  text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
const withoutRequestId = ({ requestId: _, ...rest }: any) => rest;

test("hash-password: stdin only, and the value verifies", { timeout: 30000 }, async () => {
  const out = await script("admin.mjs", ["hash-password"], {}, `${PASSWORD}\n`);
  assert.equal(out.code, 0, out.stderr);
  const value = out.stdout.trim();
  assert.match(value, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  const spec = parsePasswordHash(value);
  assert.ok(spec);
  assert.equal(await verifyPassword(spec, PASSWORD), true);
  assert.equal(await verifyPassword(spec, `${PASSWORD}!`), false);
  // Each run salts afresh.
  const again = await script("admin.mjs", ["hash-password"], {}, PASSWORD);
  assert.notEqual(again.stdout.trim(), value);
  // Never from argv, so it stays out of shell history.
  const argv = await script("admin.mjs", ["hash-password", PASSWORD]);
  assert.equal(argv.code, 1);
  assert.match(argv.stderr, /takes no arguments/);
  const short = await script("admin.mjs", ["hash-password"], {}, "short\n");
  assert.equal(short.code, 1);
  assert.match(short.stderr, /at least 12 characters/);
  // Anything but scrypt$N$r$p$salt$hash disables login instead.
  assert.equal(parsePasswordHash("plaintext"), undefined);
  assert.equal(parsePasswordHash("scrypt$1000$8$1$c2FsdHNhbHQ=$aGFzaA=="), undefined);
});

test("tenant CLI: invite and members match the platform's rules", { timeout: 60000 }, async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "admin_cli", "admin_cli").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const env = {
    MONGO_URI: mongo.getUri(),
    MONGO_DB: "admin_cli",
    CATALOG_MONGO_DB: "admin_cli",
    APP_PUBLIC_URL: APP_URL,
  };
  const tenant = (...args: string[]) => script("tenant.mjs", args, env);
  assert.equal((await tenant("create", "p1", "Parity", "Co")).code, 0);

  const out = await tenant("invite", "p1", "A.Shok+x@gmail.com", "--role", "user");
  assert.equal(out.code, 0, out.stderr);
  const token = linkToken(out.stdout);
  assert.ok(token, out.stdout);
  assert.ok(out.stdout.includes(`${APP_URL}/invite/${token}`));
  const doc = await store.invites.findOne({ tenantId: "p1" });
  assert.ok(doc);
  // The CLI's copies of emailKey and the token hash agree with auth.ts.
  assert.equal(doc.emailKey, emailKey("ashok@gmail.com"));
  assert.equal(doc.emailKey, emailKey("A.Shok+x@gmail.com"));
  assert.equal(doc.tokenHash, hashToken(token));
  assert.equal(doc.email, "A.Shok+x@gmail.com");
  assert.equal(doc.role, "user");
  assert.equal(doc.status, "pending");
  assert.ok(doc.expiresAt instanceof Date);
  assert.ok(Math.abs(doc.expiresAt.getTime() - Date.now() - 7 * DAY) < 60_000);
  assert.match(doc._id, /^inv_[0-9a-f-]{36}$/);
  assert.equal(doc.sentAt, undefined);
  // And the platform's lookup reads it.
  const { serverNow, ...found } = await lookupInvite(store, token);
  assert.ok(serverNow);
  assert.deepEqual(found, {
    status: "valid",
    ttlDays: 7,
    tenantName: "Parity Co",
    email: "A.Shok+x@gmail.com",
    role: "user",
    sentAt: doc.createdAt,
    expiresAt: doc.expiresAt.toISOString(),
  });

  const other = await tenant("invite", "p1", "ashok@example", "--role", "user");
  assert.equal(other.code, 1);
  assert.match(other.stderr, /valid email address/);
  // The CLI's emailKey agrees with the server's on every shared vector, and
  // rejects the same bad addresses.
  assert.equal((await tenant("create", "p2", "Vectors")).code, 0);
  const seen = new Set<string>();
  for (const [typed, key] of EMAIL_VECTORS) {
    if (seen.has(key)) continue;
    seen.add(key);
    const made = await tenant("invite", "p2", typed, "--role", "user");
    assert.equal(made.code, 0, `${typed}: ${made.stderr}`);
    const stored = await store.invites.findOne({ tenantId: "p2", email: typed });
    assert.equal(stored?.emailKey, key, typed);
    assert.equal(stored?.emailKey, emailKey(typed), typed);
  }
  for (const bad of BAD_EMAILS.filter((b) => b && !b.includes("\u0000"))) {
    const refused = await tenant("invite", "p2", bad, "--role", "user");
    assert.equal(refused.code, 1, JSON.stringify(bad));
  }
  assert.equal(await store.invites.countDocuments({ tenantId: "p2" }), seen.size);
  const twice = await tenant("invite", "p1", "ashok@gmail.com", "--role", "admin");
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /already has a pending invite/);
  assert.equal((await tenant("invite", "p1", "b@gmail.com", "--role", "owner")).code, 1);
  assert.equal((await tenant("invite", "nope", "b@gmail.com", "--role", "user")).code, 1);
  assert.equal(await store.invites.countDocuments({ tenantId: "p1" }), 1);

  await store.users.insertOne({
    _id: "u_ashok",
    googleSub: "sub-ashok",
    email: "ashok@gmail.com",
    emailKey: "ashok@gmail.com",
    status: "active",
    createdAt: new Date().toISOString(),
    lastLoginAt: "2026-09-01T00:00:00.000Z",
  });
  await store.memberships.insertOne({
    _id: "u_ashok:p1",
    userId: "u_ashok",
    tenantId: "p1",
    role: "admin",
    status: "active",
    createdAt: new Date().toISOString(),
  });
  const members = await tenant("members", "p1");
  assert.equal(members.code, 0, members.stderr);
  assert.match(members.stdout, /u_ashok\tashok@gmail\.com\tadmin\tactive\tlast sign-in 2026-09-01/);
  // An active member cannot be invited again.
  const member = await tenant("invite", "p1", "a.shok@gmail.com", "--role", "user");
  assert.equal(member.code, 1);
  assert.match(member.stderr, /already a member/);
});

test("production without RESEND_API_KEY starts: invitations record 'not sent' and log no link", async (t) => {
  // Public demo signup needs no email, so a missing key is no longer a startup
  // failure. It must not fall back to logging the invite link, which is the
  // credential: the mailer refuses, and the invite shows as not sent.
  const lines: string[] = [];
  const write = t.mock.method(process.stderr, "write", (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  const mailer = inviteMailer({ NODE_ENV: "production" });
  await assert.rejects(
    mailer.send({
      inviteId: "inv_1",
      tokenHash: "h",
      to: "a@example.com",
      tenantName: "Acme",
      role: "user",
      link: "https://app.test/invite/SECRET-TOKEN",
      expiresAt: new Date(),
    }),
    /Invitation email is not configured/,
  );
  write.mock.restore();
  assert.ok(!lines.join("").includes("SECRET-TOKEN"));
  assert.match(lines.join(""), /invitation email is unavailable/);
  // Outside production the developer-friendly logger remains.
  const dev = inviteMailer({ NODE_ENV: "development" });
  await dev.send({
    inviteId: "inv_2",
    tokenHash: "h",
    to: "a@example.com",
    tenantName: "Acme",
    role: "user",
    link: "http://localhost:3000/invite/x",
    expiresAt: new Date(),
  });
});

test(
  "production POC starts without Google or Resend, uses one identity, and disables auth and invitations",
  { timeout: 60000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "poc", "poc").connect();
    await insertFixtures(store);
    const env = await platformEnv(mongo.getUri(), "poc", {
      AUTH_MODE: "poc",
      NODE_ENV: "production",
      ALLOW_DEV_TENANT: "off",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      RESEND_API_KEY: "",
      AGENTCORE_RUNTIME_ARN: "",
      DEV_TENANT_ID: "default",
      DEV_USER_ID: "dev-user",
      DEV_USER_ROLE: "admin",
      DEV_USER_EMAIL: "dev-user@dev.local",
      // POC must ignore these overrides even when a previous env enabled them.
      DEV_USER_HEADER: "on",
      DEV_TENANT_HEADER: "on",
    });
    const { child, logs } = launch(env);
    t.after(async () => {
      await stop(child);
      await store.client.close();
      await mongo.stop();
    });
    const base = `http://127.0.0.1:${env.PORT}`;
    await wait(async () => (await fetch(`${base}/livez`)).ok).catch((e) => {
      throw new Error(`${e.message}\n${logs()}`);
    });
    const me = await fetch(`${base}/api/me`, {
      headers: {
        "x-truex-user": "another-user",
        "x-truex-role": "user",
        "x-truex-tenant": "another-tenant",
      },
    });
    assert.equal(me.status, 200);
    const identity = (await me.json()) as any;
    assert.equal(identity.user.id, "dev-user");
    assert.equal(identity.role, "admin");
    assert.equal(identity.tenant.id, "default");
    const agents = await fetch(`${base}/api/agents`);
    assert.equal(agents.status, 200);
    assert.equal(((await agents.json()) as any[]).length, 2);

    for (const [method, path] of [
      ["GET", "/auth/me"],
      ["GET", "/auth/google/start"],
      ["GET", "/auth/invites/fixture"],
      ["POST", "/auth/admin/login"],
      ["GET", "/api/admin/tenants"],
      ["POST", "/api/admin/tenants/default/invites"],
    ]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 404, path);
      assert.equal(
        ((await response.json()) as any).code,
        "AUTH_DISABLED",
        path,
      );
    }
    const project = { name: "POC project" };
    const foreign = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://foreign.test",
      },
      body: JSON.stringify(project),
    });
    assert.equal(foreign.status, 403);
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: FRONTEND },
      body: JSON.stringify(project),
    });
    assert.equal(created.status, 201);
    assert.equal(await store.invites.countDocuments(), 0);
    assert.doesNotMatch(
      logs(),
      /RESEND_API_KEY is not set|invite link \(not emailed\)/,
    );
  },
);

test("admin login disabled without ADMIN_PASSWORD_HASH; dev logs invite links", { timeout: 60000 }, async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "admin_off", "admin_off").connect();
  const env = await platformEnv(mongo.getUri(), "admin_off", {
    ADMIN_USERNAME: "admin",
  });
  const { child, logs } = launch(env);
  t.after(async () => {
    await stop(child);
    await store.client.close();
    await mongo.stop();
  });
  const base = `http://127.0.0.1:${env.PORT}`;
  await wait(async () => (await fetch(`${base}/livez`)).ok).catch((e) => {
    throw new Error(`${e.message}\n${logs()}`);
  });
  assert.match(logs(), /admin login disabled.*ADMIN_PASSWORD_HASH is not set/);
  assert.match(logs(), /RESEND_API_KEY is not set/);
  const res = await fetch(`${base}/auth/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "" }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "ADMIN_LOGIN_DISABLED");
  assert.equal(res.headers.getSetCookie().length, 0);

  // Invites still work through a (seeded) admin session: the link is logged.
  const token = newToken();
  await store.authSessions.insertOne({
    _id: hashToken(token),
    userId: null,
    tenantId: null,
    app: "admin",
    createdAt: new Date(),
    lastSeenAt: new Date(),
    idleExpiresAt: new Date(Date.now() + HOUR),
    absoluteExpiresAt: new Date(Date.now() + HOUR),
  });
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `truex_admin=${token}` },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/api/admin/tenants", { id: "solo", name: "Solo" })).status, 201);
  const invited = await post("/api/admin/tenants/solo/invites", {
    email: "someone@gmail.com",
    role: "user",
  });
  assert.equal(invited.status, 201);
  await wait(async () => /invite link \(not emailed\)/.test(logs()));
  const link = linkToken(logs().split("invite link (not emailed)")[1]);
  assert.ok(link);
  const lookup = await (await fetch(`${base}/auth/invites/${link}`)).json();
  assert.equal(lookup.email, "someone@gmail.com");
});

test("dev mode: admin login, admin API, invites and members", { timeout: 120000 }, async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "admin_test", "admin_test").connect();
  const resend = await resendStub();
  const hashed = await script("admin.mjs", ["hash-password"], {}, `${PASSWORD}\n`);
  assert.equal(hashed.code, 0, hashed.stderr);
  const env = await platformEnv(mongo.getUri(), "admin_test", {
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: hashed.stdout.trim(),
    RESEND_API_KEY: "re_test_key",
    RESEND_API_URL: resend.url,
  });
  const { child, logs } = launch(env);
  t.after(async () => {
    await stop(child);
    await resend.close();
    await store.client.close();
    await mongo.stop();
  });
  const base = `http://127.0.0.1:${env.PORT}`;
  await wait(async () => (await fetch(`${base}/livez`)).ok).catch((e) => {
    throw new Error(`${e.message}\n${logs()}`);
  });
  assert.doesNotMatch(logs(), /admin login disabled/);

  const call = (
    method: string,
    path: string,
    options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  const json = async (res: Response, status: number) => {
    const text = await res.text();
    assert.equal(res.status, status, text);
    return text ? JSON.parse(text) : undefined;
  };
  const session = async (fields: {
    app: "main" | "admin";
    userId?: string | null;
    tenantId?: string | null;
    absolute?: number;
  }) => {
    const token = newToken();
    const at = Date.now();
    await store.authSessions.insertOne({
      _id: hashToken(token),
      userId: fields.userId ?? null,
      tenantId: fields.tenantId ?? null,
      app: fields.app,
      createdAt: new Date(at),
      lastSeenAt: new Date(at),
      idleExpiresAt: new Date(at + (fields.absolute ?? 8 * HOUR)),
      absoluteExpiresAt: new Date(at + (fields.absolute ?? 8 * HOUR)),
    });
    return `${fields.app === "admin" ? "truex_admin" : "truex_session"}=${token}`;
  };
  const login = (username: string, password: string) =>
    call("POST", "/auth/admin/login", { body: { username, password } });

  await t.test("login: right credentials, same error for wrong ones, rate limit", async () => {
    const good = await login("admin", PASSWORD);
    assert.deepEqual(await json(good, 200), { username: "admin" });
    const [cookie] = good.headers.getSetCookie();
    assert.match(
      cookie,
      /^truex_admin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800$/,
    );
    const token = cookie.split(";")[0].split("=")[1];
    const row = await store.authSessions.findOne({ _id: hashToken(token) });
    assert.ok(row);
    assert.equal(row.app, "admin");
    assert.equal(row.userId, null);
    assert.equal(row.tenantId, null);
    // 8 hours, no sliding.
    assert.equal(row.absoluteExpiresAt.getTime() - row.createdAt.getTime(), 8 * HOUR);
    assert.equal(row.idleExpiresAt.getTime(), row.absoluteExpiresAt.getTime());
    const me = await call("GET", "/auth/admin/me", { cookie: cookie.split(";")[0] });
    assert.deepEqual(await json(me, 200), { username: "admin" });

    const wrongUser = await json(await login("root", PASSWORD), 401);
    const wrongPass = await json(await login("admin", "not the password"), 401);
    assert.equal(wrongUser.code, "INVALID_CREDENTIALS");
    assert.match(JSON.stringify(wrongUser), /Wrong username or password/);
    assert.deepEqual(withoutRequestId(wrongUser), withoutRequestId(wrongPass));
    assert.equal((await login("admin", "")).status, 401);
    assert.equal((await login("", "")).status, 401);
    // The sixth attempt within a minute is refused, even with the right password.
    const limited = await login("admin", PASSWORD);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "RATE_LIMITED");
    assert.ok(limited.headers.get("retry-after"));

    const out = await call("POST", "/auth/admin/logout", { cookie: cookie.split(";")[0] });
    assert.equal(out.status, 204);
    assert.match(out.headers.getSetCookie()[0], /^truex_admin=; .*Max-Age=0/);
    assert.equal(await store.authSessions.countDocuments({ _id: hashToken(token) }), 0);
    assert.equal((await call("GET", "/auth/admin/me", { cookie: cookie.split(";")[0] })).status, 401);
    assert.equal((await call("GET", "/auth/admin/me")).status, 401);
  });

  const A = await session({ app: "admin" });
  const now = new Date().toISOString();

  await t.test("admin API gate: admin session only, never dev headers", async () => {
    const devHeaders = {
      "x-truex-user": "u_boss",
      "x-truex-role": "admin",
      "x-truex-tenant": "default",
    };
    const bare = await json(await call("GET", "/api/admin/tenants", { headers: devHeaders }), 401);
    assert.equal(bare.code, "UNAUTHENTICATED");
    const created = await call("POST", "/api/admin/tenants", {
      headers: devHeaders,
      body: { id: "sneaky", name: "Sneaky" },
    });
    assert.equal(created.status, 401);
    assert.equal(await store.tenantRegistry.countDocuments({ _id: "sneaky" }), 0);
    const mainCookie = await session({ app: "main", userId: "u_boss", tenantId: "default" });
    const wrong = await json(
      await call("GET", "/api/admin/tenants", { cookie: mainCookie, headers: devHeaders }),
      403,
    );
    assert.equal(wrong.code, "WRONG_APP");
    // An expired admin session is 401, and cleaned up.
    const expired = await session({ app: "admin", absolute: -1000 });
    assert.equal((await call("GET", "/api/admin/tenants", { cookie: expired })).status, 401);
    assert.equal((await call("GET", "/auth/admin/me", { cookie: expired })).status, 401);
    // Unknown admin paths stay inside the admin router.
    assert.equal((await call("GET", "/api/admin/nope")).status, 401);
    assert.equal((await call("GET", "/api/admin/nope", { cookie: A })).status, 404);
    // A foreign Origin is refused before the gate.
    const csrf = await call("POST", "/api/admin/tenants", {
      cookie: A,
      body: { id: "x1", name: "X" },
      headers: { origin: "https://evil.example" },
    });
    assert.equal(csrf.status, 403);
    // The rest of /api still goes through the dev resolvers.
    const me = await json(await call("GET", "/api/me", { headers: devHeaders }), 200);
    assert.equal(me.user.id, "u_boss");
  });

  await t.test("tenants: create adds no members, shares index setup, patch", async () => {
    const created = await json(
      await call("POST", "/api/admin/tenants", {
        cookie: A,
        body: { id: "t1", name: "Team <One>" },
      }),
      201,
    );
    assert.equal(created.tenant.id, "t1");
    assert.equal(created.tenant.status, "active");
    assert.equal(created.tenant.members, 0);
    assert.equal(await store.memberships.countDocuments({ tenantId: "t1" }), 0);
    const doc = await store.tenantRegistry.findOne({ _id: "t1" });
    assert.equal(doc?.dbName, tenantDbName("t1"));
    // Same index setup as the platform's own, including the handle index.
    const db = store.client.db(tenantDbName("t1"));
    const agents = await db.collection("truex_agents").indexes();
    // A new workspace is private: handles are unique per creator, and the
    // workspace-wide handle index is never created for it.
    assert.ok(agents.some((i) => i.name === "agent_creator_handle" && i.unique));
    assert.ok(!agents.some((i) => i.name === "handle_1"));
    assert.equal(doc?.isUserSpecific, true);
    assert.equal(doc?.chatVisibility, "own");
    assert.equal(doc?.admissionPolicy, "inviteOnly");
    assert.equal(created.tenant.isUserSpecific, true);
    assert.equal(created.tenant.admissionPolicy, "inviteOnly");
    const mcp = (await db.collection("truex_mcp").indexes()).map((i) => i.name);
    assert.ok(mcp.includes("tenant_mcp_name") && mcp.includes("user_mcp_name"));
    assert.equal(
      (await json(await call("POST", "/api/admin/tenants", { cookie: A, body: { id: "t1", name: "Again" } }), 409)).code,
      "TENANT_EXISTS",
    );
    assert.equal(
      (await json(await call("POST", "/api/admin/tenants", { cookie: A, body: { id: "Bad_Id", name: "Bad" } }), 400)).code,
      "INVALID_TENANT",
    );
    await json(await call("POST", "/api/admin/tenants", { cookie: A, body: { id: "t3", name: " " } }), 400);
    await json(await call("POST", "/api/admin/tenants", { cookie: A, body: { id: "t2", name: "Two" } }), 201);

    const patch = (id: string, body: unknown) =>
      call("PATCH", `/api/admin/tenants/${id}`, { cookie: A, body });
    assert.equal((await json(await patch("t1", { chatVisibility: "own" }), 200)).tenant.chatVisibility, "own");
    assert.equal((await json(await patch("t1", { status: "disabled" }), 200)).tenant.status, "disabled");
    assert.equal((await json(await patch("t1", { status: "active" }), 200)).tenant.status, "active");
    await json(await patch("t1", { status: "gone" }), 400);
    await json(await patch("t1", { chatVisibility: "some" }), 400);
    await json(await patch("t1", {}), 400);
    await json(await patch("t1", { allowedModelIds: ["missing"] }), 400);
    await store.catalog.collection("truex_models").insertOne({ _id: "m1" } as any);
    assert.deepEqual((await json(await patch("t1", { allowedModelIds: ["m1"] }), 200)).tenant.allowedModelIds, ["m1"]);
    assert.equal((await json(await patch("t1", { allowedModelIds: null }), 200)).tenant.allowedModelIds, undefined);
    assert.equal((await store.tenantRegistry.findOne({ _id: "t1" }))?.allowedModelIds, undefined);
    await json(await patch("zz", { status: "active" }), 404);
  });

  // Ashok and Dharun are users of t1 (Ashok of t2 too), Boss is t1's admin.
  await store.users.insertMany([
    { _id: "u_ashok", googleSub: "s-a", email: "ashok@gmail.com", emailKey: "ashok@gmail.com", status: "active", createdAt: now, lastLoginAt: "2026-09-01T00:00:00.000Z" },
    { _id: "u_dharun", googleSub: "s-d", email: "dharun@gmail.com", emailKey: "dharun@gmail.com", status: "active", createdAt: now },
    { _id: "u_boss", googleSub: "s-b", email: "boss@gmail.com", emailKey: "boss@gmail.com", status: "active", createdAt: now },
  ]);
  const member = (userId: string, tenantId: string, role: "admin" | "user") =>
    ({ _id: `${userId}:${tenantId}`, userId, tenantId, role, status: "active", createdAt: now }) as const;
  await store.memberships.insertMany([
    member("u_ashok", "t1", "user"),
    member("u_ashok", "t2", "user"),
    member("u_dharun", "t1", "user"),
    member("u_boss", "t1", "admin"),
  ]);
  const invite = (email: string, role = "user") =>
    call("POST", "/api/admin/tenants/t1/invites", { cookie: A, body: { email, role } });

  let firstId = "";
  let firstToken = "";
  await t.test("invites: google accounts, 409s, one Resend call with the link", async () => {
    for (const bad of [
      "person@",
      "person",
      "a@b",
      "per son@example.com",
      "person@exa mple.com",
      "pers\u0000on@example.com",
      "bödy@example.com",
      "x".repeat(250) + "@example.com",
      ".person@example.com",
      "pe..rson@example.com",
    ])
      assert.equal((await json(await invite(bad), 400)).code, "INVALID_EMAIL", bad);
    await json(await invite("person@gmail.com", "owner"), 400);
    // Ashok is an active member under any Gmail spelling.
    assert.equal((await json(await invite("A.Shok+x@gmail.com"), 409)).code, "ALREADY_MEMBER");
    assert.equal(resend.requests.length, 0);

    const created = (await json(await invite("New.Person@gmail.com"), 201)).invite;
    firstId = created.id;
    assert.equal(created.status, "pending");
    assert.equal(created.delivery, "sent");
    assert.equal(created.tokenHash, undefined);
    assert.equal(resend.requests.length, 1);
    const [sent] = resend.requests;
    const doc = await store.invites.findOne({ _id: firstId });
    assert.ok(doc);
    assert.equal(doc.emailKey, "newperson@gmail.com");
    assert.ok(doc.expiresAt instanceof Date);
    assert.ok(Math.abs(doc.expiresAt.getTime() - Date.now() - 7 * DAY) < 60_000);
    assert.ok(doc.sentAt);
    assert.equal(sent.path, "/emails");
    assert.equal(sent.headers.authorization, "Bearer re_test_key");
    assert.equal(sent.headers["idempotency-key"], `${firstId}:${doc.tokenHash.slice(0, 12)}`);
    assert.equal(sent.body.from, "Truex <invites@example.com>");
    assert.deepEqual(sent.body.to, ["New.Person@gmail.com"]);
    assert.equal(sent.body.subject, "You're invited to Team <One> on Truex");
    firstToken = linkToken(sent.body.text)!;
    assert.equal(hashToken(firstToken), doc.tokenHash);
    const link = `${APP_URL}/invite/${firstToken}`;
    const expiry = doc.expiresAt.toUTCString();
    for (const part of [sent.body.text, sent.body.html]) {
      assert.ok(part.includes(link));
      assert.ok(part.includes(expiry));
      assert.match(part, /a member/);
    }
    assert.ok(sent.body.html.includes("Team &lt;One&gt;"));
    assert.ok(!sent.body.html.includes("<One>"));
    assert.ok(sent.body.text.includes("Team <One>"));
    // Already invited, under another spelling of the same address.
    assert.equal((await json(await invite("newperson+hi@gmail.com"), 409)).code, "ALREADY_INVITED");
    assert.equal(resend.requests.length, 1);
  });

  await t.test("invite lookup returns the status shape and no ids", async () => {
    const res = await call("GET", `/auth/invites/${firstToken}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const found = await json(res, 200);
    assert.deepEqual(Object.keys(found).sort(), [
      "email", "expiresAt", "role", "sentAt", "serverNow", "status", "tenantName", "ttlDays",
    ]);
    assert.equal(found.status, "valid");
    assert.equal(found.tenantName, "Team <One>");
    assert.equal(found.email, "New.Person@gmail.com");
    assert.equal(found.role, "user");
    assert.equal(found.ttlDays, 7);
    assert.ok(Math.abs(Date.parse(found.serverNow) - Date.now()) < 60_000);
    const doc = (await store.invites.findOne({ _id: firstId }))!;
    assert.equal(found.sentAt, doc.createdAt);
    assert.equal(found.expiresAt, doc.expiresAt.toISOString());
    const text = JSON.stringify(found);
    for (const secret of [doc._id, doc.tokenHash, doc.tenantId]) assert.ok(!text.includes(secret));
    for (const token of [newToken(), "garbage"]) {
      const missing = await json(await call("GET", `/auth/invites/${token}`), 200);
      assert.deepEqual(Object.keys(missing).sort(), ["serverNow", "status", "ttlDays"]);
      assert.equal(missing.status, "not_found");
      assert.equal(missing.ttlDays, 7);
    }
  });

  await t.test("resend: new token and expiry, old link stops working", async () => {
    await store.invites.updateOne({ _id: firstId }, { $set: { expiresAt: new Date(Date.now() + HOUR) } });
    const before = await store.invites.findOne({ _id: firstId });
    const view = (await json(await call("POST", `/api/admin/tenants/t1/invites/${firstId}/resend`, { cookie: A }), 200)).invite;
    assert.equal(view.delivery, "sent");
    const after = await store.invites.findOne({ _id: firstId });
    assert.ok(after && before);
    assert.notEqual(after.tokenHash, before.tokenHash);
    assert.ok(after.expiresAt.getTime() > Date.now() + 7 * DAY - 60_000);
    assert.equal(resend.requests.length, 2);
    const token = linkToken(resend.requests[1].body.text)!;
    assert.equal(hashToken(token), after.tokenHash);
    assert.equal(resend.requests[1].headers["idempotency-key"], `${firstId}:${after.tokenHash.slice(0, 12)}`);
    assert.equal((await json(await call("GET", `/auth/invites/${firstToken}`), 200)).status, "not_found");
    assert.equal((await json(await call("GET", `/auth/invites/${token}`), 200)).email, "New.Person@gmail.com");
    firstToken = token;
    await json(await call("POST", "/api/admin/tenants/t2/invites/" + firstId + "/resend", { cookie: A }), 404);
  });

  await t.test("send failures keep the invite as not sent; 429 is retried", async () => {
    resend.replies.push(500);
    const failed = (await json(await invite("fail@gmail.com"), 201)).invite;
    assert.equal(failed.delivery, "not sent");
    assert.match(failed.sendError, /500/);
    const stored = await store.invites.findOne({ _id: failed.id });
    assert.equal(stored?.status, "pending");
    assert.match(stored?.sendError ?? "", /500/);
    assert.equal(stored?.sentAt, undefined);
    const listed = (await json(await call("GET", "/api/admin/tenants/t1/invites", { cookie: A }), 200)).invites;
    assert.equal(listed.find((i: any) => i.id === failed.id).delivery, "not sent");
    assert.ok(listed.every((i: any) => i.tokenHash === undefined));
    // Resend then succeeds and clears the error.
    const retried = (await json(await call("POST", `/api/admin/tenants/t1/invites/${failed.id}/resend`, { cookie: A }), 200)).invite;
    assert.equal(retried.delivery, "sent");
    assert.equal(retried.sendError, undefined);
    assert.equal((await store.invites.findOne({ _id: failed.id }))?.sendError, undefined);

    // Two 429s, then success: three calls with one idempotency key.
    let start = resend.requests.length;
    resend.replies.push(429, 429);
    const slow = (await json(await invite("retry@gmail.com"), 201)).invite;
    assert.equal(slow.delivery, "sent");
    let calls = resend.requests.slice(start);
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.headers["idempotency-key"])).size, 1);
    // Four 429s: three retries, then not sent.
    start = resend.requests.length;
    resend.replies.push(429, 429, 429, 429);
    const busy = (await json(await invite("busy@gmail.com"), 201)).invite;
    calls = resend.requests.slice(start);
    assert.equal(calls.length, 4);
    assert.equal(busy.delivery, "not sent");
    assert.match(busy.sendError, /429/);
  });

  await t.test("revoked, expired and used invites are closed", async () => {
    const created = (await json(await invite("gone@gmail.com"), 201)).invite;
    const token = linkToken(resend.requests.at(-1)!.body.text)!;
    const revoked = (await json(await call("DELETE", `/api/admin/tenants/t1/invites/${created.id}`, { cookie: A }), 200)).invite;
    assert.equal(revoked.status, "revoked");
    const doc = await store.invites.findOne({ _id: created.id });
    assert.equal(doc?.status, "revoked");
    assert.ok(doc?.revokedAt);
    const revokedLookup = await json(await call("GET", `/auth/invites/${token}`), 200);
    assert.equal(revokedLookup.status, "revoked");
    assert.equal(revokedLookup.tenantName, "Team <One>");
    // Closed invites other than expired hide the email and role.
    assert.equal(revokedLookup.email, undefined);
    assert.equal(revokedLookup.role, undefined);
    assert.ok(revokedLookup.expiresAt && revokedLookup.sentAt);
    assert.equal((await json(await call("DELETE", `/api/admin/tenants/t1/invites/${created.id}`, { cookie: A }), 409)).code, "INVITE_CLOSED");
    await json(await call("POST", `/api/admin/tenants/t1/invites/${created.id}/resend`, { cookie: A }), 409);
    await json(await call("DELETE", "/api/admin/tenants/t1/invites/inv_bogus", { cookie: A }), 404);
    // A revoked invite frees the address for a new one.
    await json(await invite("gone@gmail.com"), 201);

    const old = (await json(await invite("late@gmail.com"), 201)).invite;
    const lateToken = linkToken(resend.requests.at(-1)!.body.text)!;
    await store.invites.updateOne({ _id: old.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expiredLookup = await json(await call("GET", `/auth/invites/${lateToken}`), 200);
    assert.equal(expiredLookup.status, "expired");
    assert.equal(expiredLookup.email, "late@gmail.com");
    assert.equal(expiredLookup.role, "user");
    assert.equal(expiredLookup.tenantName, "Team <One>");

    // google.ts claims with this filter; closed invites never match, and of
    // two parallel claims exactly one wins.
    const claim = (id: string) =>
      store.invites.findOneAndUpdate(
        { _id: id, status: "pending", expiresAt: { $gt: new Date() } },
        { $set: { status: "accepted", acceptedAt: new Date().toISOString(), acceptedBy: "u_new" } },
        { returnDocument: "after" },
      );
    assert.equal(await claim(created.id), null);
    assert.equal(await claim(old.id), null);
    const results = await Promise.all([claim(firstId), claim(firstId)]);
    assert.equal(results.filter(Boolean).length, 1);
    const usedLookup = await json(await call("GET", `/auth/invites/${firstToken}`), 200);
    assert.equal(usedLookup.status, "used");
    assert.equal(usedLookup.tenantName, "Team <One>");
    assert.equal(usedLookup.email, undefined);
    assert.equal(usedLookup.viewer, undefined);
    await json(await call("POST", `/api/admin/tenants/t1/invites/${firstId}/resend`, { cookie: A }), 409);

    const listed = (await json(await call("GET", "/api/admin/tenants/t1/invites", { cookie: A }), 200)).invites;
    const status = (id: string) => listed.find((i: any) => i.id === id).status;
    assert.equal(status(firstId), "accepted");
    assert.equal(status(created.id), "revoked");
    assert.equal(status(old.id), "expired");
    const tenants = (await json(await call("GET", "/api/admin/tenants", { cookie: A }), 200)).tenants;
    const t1 = tenants.find((x: any) => x.id === "t1");
    assert.equal(t1.members, 3);
    assert.equal(t1.admins, 1);
    // fail, retry, busy and the second gone@ are pending; late@ has expired.
    assert.equal(t1.pendingInvites, 4);
    assert.ok(tenants.some((x: any) => x.id === "default"));
  });

  await t.test("members: list, role change, removal ends sessions and user MCPs", async () => {
    const list = (await json(await call("GET", "/api/admin/tenants/t1/members", { cookie: A }), 200)).members;
    const ashok = list.find((m: any) => m.userId === "u_ashok");
    assert.equal(ashok.role, "user");
    assert.equal(ashok.email, "ashok@gmail.com");
    assert.equal(ashok.lastLoginAt, "2026-09-01T00:00:00.000Z");
    assert.equal(list.find((m: any) => m.userId === "u_dharun").lastLoginAt, null);

    const role = (userId: string, body: unknown) =>
      call("PATCH", `/api/admin/tenants/t1/members/${userId}`, { cookie: A, body });
    assert.deepEqual(await json(await role("u_dharun", { role: "admin" }), 200), { userId: "u_dharun", role: "admin" });
    assert.equal((await store.memberships.findOne({ _id: "u_dharun:t1" }))?.role, "admin");
    await json(await role("u_dharun", { role: "owner" }), 400);
    await json(await role("u_nobody", { role: "user" }), 404);

    const t1 = store.client.db(tenantDbName("t1")).collection("truex_mcp");
    const t2 = store.client.db(tenantDbName("t2")).collection("truex_mcp");
    await t1.insertMany([
      { _id: "m_a1", scope: "user", ownerId: "u_ashok", name: "one" },
      { _id: "m_a2", scope: "user", ownerId: "u_ashok", name: "two" },
      { _id: "m_d1", scope: "user", ownerId: "u_dharun", name: "one" },
      { _id: "m_t1", scope: "tenant", name: "shared" },
    ] as any[]);
    await t2.insertOne({ _id: "m_a3", scope: "user", ownerId: "u_ashok", name: "one" } as any);
    await session({ app: "main", userId: "u_ashok", tenantId: "t1" });
    await session({ app: "main", userId: "u_ashok", tenantId: "t1" });
    const other = await session({ app: "main", userId: "u_ashok", tenantId: "t2" });

    const removed = await json(await call("DELETE", "/api/admin/tenants/t1/members/u_ashok", { cookie: A }), 200);
    assert.deepEqual(removed, { userId: "u_ashok", status: "removed", sessionsRevoked: 2, mcpsDeleted: 2 });
    assert.equal((await store.memberships.findOne({ _id: "u_ashok:t1" }))?.status, "removed");
    assert.equal((await store.memberships.findOne({ _id: "u_ashok:t2" }))?.status, "active");
    const left = await store.authSessions.find({ userId: "u_ashok" }).toArray();
    assert.deepEqual(left.map((s) => s._id), [hashToken(other.split("=")[1])]);
    assert.deepEqual((await t1.find({}).sort({ _id: 1 }).toArray()).map((d) => d._id), ["m_d1", "m_t1"]);
    assert.equal(await t2.countDocuments({ ownerId: "u_ashok" }), 1);
    // The admin session is untouched.
    assert.equal((await call("GET", "/api/admin/tenants", { cookie: A })).status, 200);
    await json(await call("DELETE", "/api/admin/tenants/t1/members/u_ashok", { cookie: A }), 404);
    const after = (await json(await call("GET", "/api/admin/tenants/t1/members", { cookie: A }), 200)).members;
    assert.ok(!after.some((m: any) => m.userId === "u_ashok"));
    // No longer an active member, so Ashok can be invited again.
    await json(await invite("ashok@gmail.com"), 201);
  });
});
