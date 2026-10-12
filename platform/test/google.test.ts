import { testEnvironment } from "./environment";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { spawn, ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { resolve } from "node:path";
import { createTenant } from "../src/admin";
import { Store } from "../src/store";
import { tenantDbName } from "../src/tenant";
import { emailKey, hashToken, newToken } from "../src/auth";

const root = resolve("..");
// Never fetched: the callback is replayed straight against the platform.
const FRONTEND = "http://localhost:3000";
const CLIENT_ID = "test-client";

async function port() {
  const server = createNetServer();
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
        DOTENV_CONFIG_PATH: "/nonexistent",
        DEMO_TENANT_ID: "",
        DEFAULT_TENANT_SIGNUP: "on",
        DEFAULT_SIGNUP_TENANT_ID: "default-tenant",
        ...extra,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (x) => (logs += x));
  child.stderr?.on("data", (x) => (logs += x));
  return { child, logs: () => logs };
}

// ---- Fake OIDC issuer ----------------------------------------------------

interface Claims {
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}
const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

async function fakeIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = "test-key";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; claims: Claims }>();
  const authorizeCalls: URLSearchParams[] = [];
  // The identity the next /authorize "signs in" as.
  let next: Claims = { sub: "nobody", email: "nobody@gmail.com" };
  let issuer = "";

  const signIdToken = (claims: Claims, nonce: string) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ alg: "RS256", typ: "JWT", kid });
    const payload = b64url({
      iss: issuer,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 300,
      nonce,
      email_verified: true,
      ...claims,
    });
    const signature = sign(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      privateKey,
    ).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
      });
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      authorizeCalls.push(url.searchParams);
      const code = randomBytes(16).toString("hex");
      codes.set(code, { nonce: url.searchParams.get("nonce") ?? "", claims: next });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (x) => (body += x));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const grant = codes.get(params.get("code") ?? "");
        codes.delete(params.get("code") ?? "");
        if (!grant || !params.get("code_verifier"))
          return json(400, { error: "invalid_grant" });
        json(200, {
          access_token: randomBytes(16).toString("hex"),
          token_type: "Bearer",
          expires_in: 3600,
          id_token: signIdToken(grant.claims, grant.nonce),
        });
      });
      return;
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    issuer,
    authorizeCalls,
    as(claims: Claims) {
      next = claims;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---- Tests ---------------------------------------------------------------

test("google sign-in: invites, login, flows and sessions", { timeout: 120000 }, async (t) => {
  const idp = await fakeIssuer();
  // Sign-in writes (account, membership, invite) run in catalog transactions,
  // which need a replica set.
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const store = await new Store(mongo.getUri(), "google_test", "google_test").connect();
  await createTenant(store, { id: "default-tenant", name: "Default tenant" });
  const platformPort = await port();
  const { child, logs } = launch({
    PORT: String(platformPort),
    MONGO_URI: mongo.getUri(),
    MONGO_DB: "google_test",
    CATALOG_MONGO_DB: "google_test",
    MCP_ALLOWED_PRIVATE_HOSTS: "example.com",
    // Nothing listens here; these tests never reach agent-core.
    AGENT_CORE_URLS: `http://127.0.0.1:${await port()}`,
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_ISSUER_URL: idp.issuer,
    FRONTEND_ORIGIN: FRONTEND,
    APP_PUBLIC_URL: FRONTEND,
    ADMIN_ORIGIN: "",
    // Each flow sends its own X-Forwarded-For, so the /auth rate limit
    // (60 a minute per IP) never trips across this many flows.
    TRUST_PROXY: "loopback",
  });
  t.after(async () => {
    await stop(child);
    await store.client.close();
    await mongo.stop();
    await idp.close();
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
  const DAY = 86_400_000;
  const invite = async (
    tenantId: string,
    email: string,
    fields: { role?: "admin" | "user"; status?: "pending" | "accepted" | "revoked"; expiresIn?: number } = {},
  ) => {
    const token = newToken();
    const id = `inv_${randomBytes(6).toString("hex")}`;
    await store.invites.insertOne({
      _id: id,
      tenantId,
      email,
      emailKey: emailKey(email),
      role: fields.role ?? "user",
      tokenHash: hashToken(token),
      status: fields.status ?? "pending",
      createdAt: now,
      expiresAt: new Date(Date.now() + (fields.expiresIn ?? 7 * DAY)),
    });
    return { id, token };
  };

  let ipCounter = 0;
  const ip = () => `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  const cookieOf = (res: Response, name: string) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (pair.slice(0, i) === name) return pair.slice(i + 1);
    }
    return undefined;
  };
  const target = (res: Response) => {
    assert.equal(res.status, 302, `expected a redirect, got ${res.status}`);
    return new URL(res.headers.get("location")!);
  };

  // Start → fake Google → callback URL, without calling the callback yet.
  const startUrl = (inviteToken?: string, name?: string) => {
    const query = new URLSearchParams();
    if (inviteToken) query.set("invite", inviteToken);
    if (name !== undefined) query.set("name", name);
    return `${base}/auth/google/start${query.size ? `?${query}` : ""}`;
  };
  const begin = async (claims: Claims, inviteToken?: string, name?: string) => {
    const from = ip();
    const start = await fetch(startUrl(inviteToken, name), {
      redirect: "manual",
      headers: { "x-forwarded-for": from },
    });
    const google = target(start);
    assert.equal(google.origin, idp.issuer, `start did not go to Google: ${google}`);
    const flow = cookieOf(start, "truex_flow");
    assert.ok(flow, "start sets the flow cookie");
    const flowLine = start.headers.getSetCookie().find((l) => l.startsWith("truex_flow="))!;
    assert.match(flowLine, /HttpOnly/);
    assert.match(flowLine, /SameSite=Lax/);
    assert.match(flowLine, /Max-Age=600/);
    assert.doesNotMatch(flowLine, /Secure/);
    idp.as(claims);
    const authorized = target(await fetch(google, { redirect: "manual" }));
    assert.equal(authorized.origin + authorized.pathname, `${FRONTEND}/auth/google/callback`);
    return { flow, search: authorized.search, from, google };
  };
  const callback = (flow: string | undefined, search: string, from = ip()) =>
    fetch(`${base}/auth/google/callback${search}`, {
      redirect: "manual",
      headers: {
        "x-forwarded-for": from,
        ...(flow ? { cookie: `truex_flow=${flow}` } : {}),
      },
    });
  const signIn = async (claims: Claims, inviteToken?: string, name?: string) => {
    const { flow, search, from } = await begin(claims, inviteToken, name);
    const res = await callback(flow, search, from);
    return { res, location: target(res), session: cookieOf(res, "truex_session") };
  };
  const joined = (token: string) => `${FRONTEND}/invite/${token}?joined=1`;
  const lookup = async (token: string, session?: string) => {
    const res = await fetch(`${base}/auth/invites/${token}`, {
      headers: {
        "x-forwarded-for": ip(),
        ...(session ? { cookie: `truex_session=${session}` } : {}),
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return res.json();
  };
  const expectError = (
    location: URL,
    code: string,
    path = "/login",
  ) => {
    assert.equal(location.origin, FRONTEND);
    assert.equal(location.pathname, path);
    assert.equal(location.searchParams.get("error"), code);
  };
  const noSecretsInUrl = (location: URL) => {
    for (const key of ["code", "state", "id_token", "access_token", "nonce"])
      assert.equal(location.searchParams.has(key), false, `${key} leaked into ${location}`);
  };

  const ashok: Claims = {
    sub: "sub-ashok",
    email: "ashok@gmail.com",
    email_verified: true,
    name: "Ashok",
  };

  await t.test("wrong account keeps the invite pending", async () => {
    const inv = await invite("acme", "A.Shok+x@gmail.com", { role: "admin" });
    const { location } = await signIn(
      { sub: "sub-other", email: "other@gmail.com", email_verified: true },
      inv.token,
    );
    expectError(location, "wrong_account", `/invite/${inv.token}`);
    assert.equal(location.searchParams.get("email"), "other@gmail.com");
    noSecretsInUrl(location);
    assert.equal((await store.invites.findOne({ _id: inv.id }))?.status, "pending");
    assert.equal(await store.users.countDocuments({ googleSub: "sub-other" }), 0);

    // The invited address, spelled differently, accepts it.
    const { flow, search, from, google } = await begin(ashok, inv.token);
    assert.equal(google.searchParams.get("login_hint"), "A.Shok+x@gmail.com");
    assert.equal(google.searchParams.get("prompt"), "select_account");
    assert.equal(google.searchParams.get("scope"), "openid email profile");
    assert.equal(google.searchParams.get("code_challenge_method"), "S256");
    assert.equal(google.searchParams.get("redirect_uri"), `${FRONTEND}/auth/google/callback`);
    const res = await callback(flow, search, from);
    // An invite sign-in goes back to the invite page in its joined state.
    assert.equal(target(res).href, joined(inv.token));
    noSecretsInUrl(target(res));
    const session = cookieOf(res, "truex_session");
    assert.ok(session);
    // The flow cookie is cleared on the callback.
    assert.equal(cookieOf(res, "truex_flow"), "");

    const user = await store.users.findOne({ googleSub: "sub-ashok" });
    assert.ok(user);
    assert.match(user._id, /^u_[0-9a-f-]{36}$/);
    assert.equal(user.emailKey, "ashok@gmail.com");
    assert.equal(user.name, "Ashok");
    assert.equal(user.status, "active");
    assert.ok(user.lastLoginAt);
    const membership = await store.memberships.findOne({ userId: user._id, tenantId: "acme" });
    assert.equal(membership?.role, "admin");
    assert.equal(membership?.status, "active");
    const accepted = await store.invites.findOne({ _id: inv.id });
    assert.equal(accepted?.status, "accepted");
    assert.equal(accepted?.acceptedBy, user._id);
    assert.ok(accepted?.acceptedAt);

    // The session cookie works on /api/me.
    const me = await fetch(`${base}/api/me`, {
      headers: { cookie: `truex_session=${session}` },
    });
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.user.id, user._id);
    assert.equal(body.user.email, "ashok@gmail.com");
    assert.equal(body.tenant.id, "acme");
    assert.equal(body.role, "admin");

    // The lookup with the flow's session shows the viewer as a member;
    // without a cookie there is no viewer. No ids either way.
    const withViewer = await lookup(inv.token, session);
    assert.equal(withViewer.status, "used");
    assert.equal(withViewer.tenantName, "ACME");
    assert.deepEqual(withViewer.viewer, {
      email: "ashok@gmail.com",
      name: "Ashok",
      member: true,
      memberSince: membership?.createdAt,
    });
    const anonymous = await lookup(inv.token);
    assert.equal(anonymous.viewer, undefined);
    assert.equal(anonymous.status, "used");
    // A bad cookie is just no viewer, never an error.
    assert.equal((await lookup(inv.token, "garbage")).viewer, undefined);
    for (const body of [withViewer, anonymous]) {
      const text = JSON.stringify(body);
      for (const secret of [inv.id, hashToken(inv.token), user._id, "acme\"", "tokenHash", "inviteId", "tenantId", "userId"])
        assert.ok(!text.includes(secret), `${secret} leaked into the lookup`);
    }

    // The used link can't start another sign-in.
    const again = await fetch(`${base}/auth/google/start?invite=${inv.token}`, {
      redirect: "manual",
      headers: { "x-forwarded-for": ip() },
    });
    expectError(target(again), "invite_used", `/invite/${inv.token}`);
  });

  await t.test("start rejects expired, revoked and unknown invites", async () => {
    const expired = await invite("beta", "late@gmail.com", { expiresIn: -1000 });
    const revoked = await invite("beta", "gone@gmail.com", { status: "revoked" });
    const start = (token: string) =>
      fetch(`${base}/auth/google/start?invite=${token}`, {
        redirect: "manual",
        headers: { "x-forwarded-for": ip() },
      }).then(target);
    expectError(await start(expired.token), "invite_expired", `/invite/${expired.token}`);
    expectError(await start(revoked.token), "invite_revoked", `/invite/${revoked.token}`);
    expectError(await start(newToken()), "not_invited");
    expectError(await start("not-a-token"), "not_invited");
    assert.equal(await store.authFlows.countDocuments(), 0);
  });

  await t.test("only a verified, valid email is accepted; Workspace accounts are", async () => {
    const inv = await invite("beta", "ws@gmail.com");
    // Not verified, missing, or malformed: no account and no session.
    for (const claims of [
      { sub: "sub-ws", email: "ws@gmail.com", email_verified: false },
      { sub: "sub-ws", email: "ws@gmail.com", email_verified: undefined },
      { sub: "sub-ws", email: "not-an-email", email_verified: true },
      { sub: "sub-ws", email: "ws@@gmail.com", email_verified: true },
    ]) {
      expectError((await signIn(claims)).location, "email_unverified");
      expectError(
        (await signIn(claims, inv.token)).location,
        "email_unverified",
        `/invite/${inv.token}`,
      );
    }
    // A missing subject is a failed Google response, not an account.
    expectError((await signIn({ sub: "", email: "ws@gmail.com", email_verified: true })).location, "google_failed");
    assert.equal((await store.invites.findOne({ _id: inv.id }))?.status, "pending");
    assert.equal(await store.users.countDocuments({ googleSub: "sub-ws" }), 0);

    // A hosted-domain (Workspace) claim on a Gmail address, and a non-Gmail
    // address, are both ordinary accounts now.
    const hosted = await signIn(
      { sub: "sub-ws", email: "ws@gmail.com", email_verified: true, hd: "example.com" },
      inv.token,
    );
    assert.equal(hosted.location.href, joined(inv.token));
    const corp = await invite("beta", "Jane.Doe+Sales@Acme.Example");
    const worker = await signIn(
      { sub: "sub-corp", email: "jane.doe+sales@acme.example", email_verified: true, hd: "acme.example" },
      corp.token,
    );
    assert.equal(worker.location.href, joined(corp.token));
    const user = await store.users.findOne({ googleSub: "sub-corp" });
    // Dots and plus tags are kept off Gmail.
    assert.equal(user?.emailKey, "jane.doe+sales@acme.example");
    assert.equal((await store.invites.findOne({ _id: corp.id }))?.status, "accepted");
  });

  await t.test("/login joins the default tenant and never accepts pending invites", async () => {
    const inv = await invite("beta", "pending@gmail.com");
    const { location, session } = await signIn({
      sub: "sub-pending",
      email: "pending@gmail.com",
      email_verified: true,
    });
    assert.equal(location.pathname, "/");
    assert.ok(session);
    assert.equal((await store.invites.findOne({ _id: inv.id }))?.status, "pending");
    assert.equal(await store.users.countDocuments({ googleSub: "sub-pending" }), 1);
  });

  await t.test("/login remembers entered workspaces and offers a picker when no choice is remembered", async () => {
    const one = await signIn(ashok);
    assert.equal(one.location.href, `${FRONTEND}/`);
    assert.ok(one.session);

    const user = (await store.users.findOne({ googleSub: "sub-ashok" }))!;
    await store.memberships.insertOne({
      _id: `${user._id}:beta`,
      userId: user._id,
      tenantId: "beta",
      role: "user",
      status: "active",
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    const remembered = await signIn(ashok);
    assert.equal(remembered.location.href, `${FRONTEND}/`);
    await store.users.updateOne({ _id: user._id }, { $unset: { lastTenantId: "" } });
    const two = await signIn(ashok);
    assert.equal(two.location.href, `${FRONTEND}/select-tenant`);
    const me = await fetch(`${base}/api/me`, {
      headers: { cookie: `truex_session=${two.session}` },
    });
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.tenant.id, "acme");
    assert.deepEqual(body.tenants.map((x: any) => x.id).sort(), ["acme", "beta"]);
  });

  await t.test("/login: disabled account, disabled tenant, no tenant", async () => {
    const make = async (id: string, status: "active" | "disabled") =>
      store.users.insertOne({
        _id: id,
        googleSub: `sub-${id}`,
        email: `${id}@gmail.com`,
        emailKey: `${id}@gmail.com`,
        status,
        createdAt: now,
      });
    await make("offuser", "disabled");
    await make("goneuser", "active");
    await make("lonely", "active");
    await store.memberships.insertOne({
      _id: "goneuser:gone",
      userId: "goneuser",
      tenantId: "gone",
      role: "user",
      status: "active",
      createdAt: now,
    });
    const as = (id: string) => ({ sub: `sub-${id}`, email: `${id}@gmail.com`, email_verified: true });
    expectError((await signIn(as("offuser"))).location, "account_disabled");
    expectError((await signIn(as("goneuser"))).location, "tenant_disabled");
    assert.equal((await signIn(as("lonely"))).location.pathname, "/");
  });

  await t.test("reused, expired and missing flows are rejected", async () => {
    const { flow, search, from } = await begin(ashok);
    // Ashok has two tenants by now, so the first use lands on the picker.
    assert.equal(target(await callback(flow, search, from)).href, `${FRONTEND}/select-tenant`);
    expectError(target(await callback(flow, search)), "session_expired");

    const stale = await begin(ashok);
    await store.authFlows.updateOne(
      { _id: hashToken(stale.flow!) },
      { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } },
    );
    expectError(target(await callback(stale.flow, stale.search)), "session_expired");

    const missing = await begin(ashok);
    expectError(target(await callback(undefined, missing.search)), "session_expired");
    expectError(target(await callback(newToken(), missing.search)), "session_expired");
  });

  await t.test("Google errors and failed exchanges end with google_failed", async () => {
    // Cancelling at Google comes back with the real state and an error.
    const denied = await begin(ashok);
    const deniedQuery = new URLSearchParams(denied.search);
    deniedQuery.delete("code");
    deniedQuery.set("error", "access_denied");
    const res = await callback(denied.flow, `?${deniedQuery}`);
    expectError(target(res), "google_failed");
    assert.equal(cookieOf(res, "truex_session"), undefined);
    // The flow is spent: the same cancellation cannot be replayed.
    expectError(target(await callback(denied.flow, `?${deniedQuery}`)), "session_expired");

    // A callback whose code Google refuses ends the flow, and never retries it.
    const refused = await begin(ashok);
    const refusedQuery = new URLSearchParams(refused.search);
    refusedQuery.set("code", "not-a-code-google-issued");
    expectError(target(await callback(refused.flow, `?${refusedQuery}`)), "google_failed");
    expectError(target(await callback(refused.flow, refused.search)), "session_expired");

    // Repeated parameters are not one code and one state.
    const repeated = await begin(ashok);
    expectError(
      target(await callback(repeated.flow, `${repeated.search}&code=again`)),
      "google_failed",
    );
    assert.doesNotMatch(logs(), /id_token|eyJ/);
  });

  await t.test("a callback for another flow is refused and does not spend the newer one", async () => {
    // Two tabs start sign-in; the second start replaces the flow cookie.
    const first = await begin(ashok);
    const second = await begin(ashok);
    const olderQuery = new URLSearchParams(first.search);
    // The older tab's callback arrives carrying the newer flow's cookie.
    const stale = await callback(second.flow, `?${olderQuery}`, first.from);
    expectError(target(stale), "session_expired");
    assert.equal(cookieOf(stale, "truex_session"), undefined);
    // The newer flow was not consumed, so the newer tab still completes.
    const done = await callback(second.flow, second.search, second.from);
    assert.ok(cookieOf(done, "truex_session"), "the newer sign-in still succeeds");
    // And only once.
    expectError(target(await callback(second.flow, second.search)), "session_expired");
  });

  await t.test("two parallel accepts of one invite create one membership", async () => {
    const inv = await invite("beta", "dharun@gmail.com");
    const dharun = { sub: "sub-dharun", email: "dharun@gmail.com", email_verified: true };
    const first = await begin(dharun, inv.token);
    const second = await begin(dharun, inv.token);
    const results = await Promise.all([
      callback(first.flow, first.search, first.from),
      callback(second.flow, second.search, second.from),
    ]);
    const locations = results.map((r) => target(r));
    const ok = locations.filter((l) => l.href === joined(inv.token));
    const used = locations.filter((l) => l.searchParams.get("error") === "invite_used");
    assert.equal(ok.length, 1, locations.join(" "));
    assert.equal(used.length, 1, locations.join(" "));
    assert.equal(used[0].pathname, `/invite/${inv.token}`);
    const users = await store.users.find({ googleSub: "sub-dharun" }).toArray();
    assert.equal(users.length, 1);
    assert.equal(
      await store.memberships.countDocuments({ userId: users[0]._id, tenantId: "beta" }),
      1,
    );
  });

  await t.test("accepting races revoking and expiry: one committed result, never an orphan grant", async () => {
    const outcomes = { accepted: 0, closed: 0 };
    for (let i = 0; i < 8; i++) {
      const email = `racer${i}@gmail.com`;
      const inv = await invite("beta", email);
      const claimsFor = { sub: `sub-race-${i}`, email, email_verified: true };
      const { flow, search, from } = await begin(claimsFor, inv.token);
      const others = [
        // Revoke (as the admin API does), or let it expire, at the same moment.
        i % 2
          ? store.invites.updateOne({ _id: inv.id, status: "pending" }, { $set: { status: "revoked", revokedAt: now } })
          : store.invites.updateOne({ _id: inv.id, status: "pending" }, { $set: { expiresAt: new Date(Date.now() - 1) } }),
      ];
      const [res] = await Promise.all([callback(flow, search, from), ...others]);
      const invite_ = (await store.invites.findOne({ _id: inv.id }))!;
      const user = await store.users.findOne({ googleSub: claimsFor.sub });
      const members = user
        ? await store.memberships.countDocuments({ userId: user._id, tenantId: "beta", status: "active" })
        : 0;
      if (invite_.status === "accepted") {
        outcomes.accepted++;
        assert.ok(cookieOf(res, "truex_session"), "the winner signs in");
        assert.equal(members, 1);
        assert.equal(invite_.acceptedBy, user?._id);
      } else {
        outcomes.closed++;
        assert.equal(cookieOf(res, "truex_session"), undefined, "the loser gets no session");
        assert.equal(members, 0, "a lost race leaves no membership");
        assert.equal(user, null, "and no account");
      }
    }
    assert.equal(outcomes.accepted + outcomes.closed, 8);
  });

  await t.test("an email tied to another Google account is account_conflict", async () => {
    await store.users.insertOne({
      _id: "u_conf",
      googleSub: "sub-conf-old",
      email: "conf@gmail.com",
      emailKey: "conf@gmail.com",
      status: "active",
      createdAt: now,
    });
    const inv = await invite("acme", "conf@gmail.com");
    const { location } = await signIn(
      { sub: "sub-conf-new", email: "conf@gmail.com", email_verified: true },
      inv.token,
    );
    expectError(location, "account_conflict", `/invite/${inv.token}`);
    assert.equal((await store.invites.findOne({ _id: inv.id }))?.status, "pending");
    assert.equal(await store.users.countDocuments({ googleSub: "sub-conf-new" }), 0);
  });

  await t.test("a failure after the claim hands the invite back", async () => {
    const inv = await invite("acme", "fail@gmail.com");
    // Passes every pre-check, then the user insert after the claim fails.
    await store.catalog.command({
      collMod: "users",
      validator: { googleSub: { $ne: "sub-fail" } },
      validationAction: "error",
    });
    try {
      const { flow, search, from } = await begin(
        { sub: "sub-fail", email: "fail@gmail.com", email_verified: true },
        inv.token,
      );
      const res = await callback(flow, search, from);
      // The claim, user and membership share one transaction: a failure rolls
      // all of it back, and the person is told to try again.
      expectError(target(res), "unavailable");
      assert.equal(cookieOf(res, "truex_session"), undefined);
    } finally {
      await store.catalog.command({ collMod: "users", validator: {} });
    }
    const released = await store.invites.findOne({ _id: inv.id });
    assert.equal(released?.status, "pending");
    assert.equal(released?.acceptedAt, undefined);
    assert.equal(released?.acceptedBy, undefined);
    assert.equal(await store.users.countDocuments({ googleSub: "sub-fail" }), 0);

    // The same link then works.
    const retry = await signIn(
      { sub: "sub-fail", email: "fail@gmail.com", email_verified: true },
      inv.token,
    );
    assert.equal(retry.location.href, joined(inv.token));
    assert.equal((await store.invites.findOne({ _id: inv.id }))?.status, "accepted");
  });

  await t.test("an invite to a disabled tenant is tenant_disabled", async () => {
    const inv = await invite("gone", "ashok@gmail.com");
    const { location, session } = await signIn(ashok, inv.token);
    expectError(location, "tenant_disabled");
    assert.equal(session, undefined);
    assert.equal((await store.invites.findOne({ _id: inv.id }))?.status, "pending");
  });

  await t.test("a removed membership is reactivated with the invite's role", async () => {
    const user = (await store.users.findOne({ googleSub: "sub-dharun" }))!;
    await store.memberships.updateOne(
      { userId: user._id, tenantId: "beta" },
      { $set: { status: "removed" } },
    );
    const inv = await invite("beta", "dharun@gmail.com", { role: "admin" });
    const { location } = await signIn(
      { sub: "sub-dharun", email: "dharun@gmail.com", email_verified: true },
      inv.token,
    );
    assert.equal(location.href, joined(inv.token));
    const membership = await store.memberships.findOne({ userId: user._id, tenantId: "beta" });
    assert.equal(membership?.status, "active");
    assert.equal(membership?.role, "admin");
    assert.equal(
      await store.memberships.countDocuments({ userId: user._id, tenantId: "beta" }),
      1,
    );
  });

  await t.test("lookup shape for valid and expired invites", async () => {
    const valid = await invite("beta", "Look.Up@gmail.com", { role: "admin" });
    const body = await lookup(valid.token);
    assert.deepEqual(Object.keys(body).sort(), [
      "email", "expiresAt", "role", "sentAt", "serverNow", "status", "tenantName", "ttlDays",
    ]);
    assert.equal(body.status, "valid");
    assert.equal(body.tenantName, "BETA");
    assert.equal(body.email, "Look.Up@gmail.com");
    assert.equal(body.role, "admin");
    assert.equal(body.sentAt, now);
    assert.equal(body.ttlDays, 7);

    const late = await invite("beta", "late2@gmail.com", { expiresIn: -1000 });
    const expired = await lookup(late.token);
    assert.equal(expired.status, "expired");
    assert.equal(expired.email, "late2@gmail.com");
    assert.equal(expired.role, "user");

    const revoked = await invite("beta", "rev2@gmail.com", { status: "revoked" });
    const closed = await lookup(revoked.token);
    assert.equal(closed.status, "revoked");
    assert.equal(closed.tenantName, "BETA");
    assert.equal(closed.email, undefined);
    assert.equal(closed.role, undefined);

    assert.deepEqual(Object.keys(await lookup(newToken())).sort(), ["serverNow", "status", "ttlDays"]);
  });

  await t.test("the typed name replaces Google's, for new and existing users", async () => {
    // New user.
    const inv = await invite("acme", "named@gmail.com");
    const named = { sub: "sub-named", email: "named@gmail.com", email_verified: true, name: "Google Name" };
    const { location, session } = await signIn(named, inv.token, "  Priya \t  Raman ");
    assert.equal(location.href, joined(inv.token));
    // The name goes into no URL.
    assert.doesNotMatch(location.href, /Priya/);
    const user = await store.users.findOne({ googleSub: "sub-named" });
    assert.equal(user?.name, "Priya Raman");
    assert.equal(await store.authFlows.countDocuments({ displayName: { $exists: true } }), 0);
    assert.equal((await lookup(inv.token, session)).viewer?.name, "Priya Raman");

    // Existing user joining a second tenant, with a non-Latin name.
    const second = await invite("beta", "named@gmail.com");
    const again = await signIn(named, second.token, "Анна Ли");
    assert.equal(again.location.href, joined(second.token));
    assert.equal((await store.users.findOne({ googleSub: "sub-named" }))?.name, "Анна Ли");
    // Plain /login ignores name and keeps the stored one.
    const plain = await fetch(`${base}/auth/google/start?name=x`, {
      redirect: "manual",
      headers: { "x-forwarded-for": ip() },
    });
    assert.equal(new URL(target(plain)).origin, idp.issuer);
    assert.doesNotMatch(logs(), /Priya|Анна/);
  });

  await t.test("an invalid name is invalid_name and leaves the invite pending", async () => {
    const inv = await invite("acme", "badname@gmail.com");
    const flowsBefore = await store.authFlows.countDocuments();
    for (const name of ["", " ", "a", "12345", "!!", "x".repeat(61)]) {
      const res = await fetch(startUrl(inv.token, name), {
        redirect: "manual",
        headers: { "x-forwarded-for": ip() },
      });
      const location = target(res);
      expectError(location, "invalid_name", `/invite/${inv.token}`);
      assert.equal(location.searchParams.has("name"), false);
    }
    // A repeated name is rejected too.
    const twice = await fetch(`${startUrl(inv.token, "Good Name")}&name=Other`, {
      redirect: "manual",
      headers: { "x-forwarded-for": ip() },
    });
    expectError(target(twice), "invalid_name", `/invite/${inv.token}`);
    assert.equal(await store.authFlows.countDocuments(), flowsBefore);
    assert.equal((await store.invites.findOne({ _id: inv.id }))?.status, "pending");
    assert.equal(await store.users.countDocuments({ emailKey: "badname@gmail.com" }), 0);
    // Exactly 2 and 60 characters are fine.
    for (const name of ["Al", "x".repeat(60)]) {
      const ok = await fetch(startUrl(inv.token, name), {
        redirect: "manual",
        headers: { "x-forwarded-for": ip() },
      });
      assert.equal(target(ok).origin, idp.issuer);
    }
  });
});
