// Shared harness for the Google-mode HTTP tests: a MongoDB replica set (the
// catalog needs transactions), a fake Google issuer, a fake agent-core that
// records every call, and the real platform running as a child process.
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer, type Server, type ServerResponse } from "node:http";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/store";
import { hashToken, newToken, emailKey } from "../src/auth";
import { createTenant } from "../src/admin";
import type { UserRole } from "../src/user";

export const root = resolve("..");
export const FRONTEND = "http://localhost:3000";
export const CLIENT_ID = "test-client";

export async function freePort() {
  const server = createNetServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return value;
}
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeout = 20_000, every = 50, what = "condition" } = {},
) {
  const begin = Date.now();
  while (!(await Promise.resolve(predicate()).catch(() => false))) {
    if (Date.now() - begin > timeout)
      throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function stopChild(child: ChildProcess) {
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

// ---- Fake OIDC issuer ----------------------------------------------------

export interface Claims {
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
  picture?: string;
}
const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** How the issuer should break the next ID token it signs (tests of forgery). */
export type Tamper = "signature" | "audience" | "issuer" | "expired" | "nonce";

export async function fakeIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = "test-key";
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const codes = new Map<string, { nonce: string; claims: Claims }>();
  let next: Claims = { sub: "nobody", email: "nobody@gmail.com" };
  let issuer = "";
  let tamper: Tamper | undefined;
  const signIdToken = (claims: Claims, nonce: string) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ alg: "RS256", typ: "JWT", kid });
    const payload = b64url({
      iss: tamper === "issuer" ? "https://evil.example" : issuer,
      aud: tamper === "audience" ? "someone-elses-client" : CLIENT_ID,
      iat: now,
      exp: tamper === "expired" ? now - 3600 : now + 300,
      nonce: tamper === "nonce" ? "not-the-nonce-we-sent" : nonce,
      email_verified: true,
      ...claims,
    });
    // "signature": signed by a different key than the one the issuer publishes.
    const key =
      tamper === "signature"
        ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
        : privateKey;
    const signature = sign(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      key,
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
      const code = randomBytes(16).toString("hex");
      // A flow can carry its own identity (x_claims), so people signing in at
      // the same moment are never mixed up; otherwise the shared "next" is used.
      const own = url.searchParams.get("x_claims");
      const claims: Claims = own
        ? JSON.parse(Buffer.from(own, "base64url").toString())
        : next;
      codes.set(code, { nonce: url.searchParams.get("nonce") ?? "", claims });
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
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer,
    as(claims: Claims) {
      next = claims;
    },
    /** Breaks every ID token signed from now on, until called with undefined. */
    tamper(how: Tamper | undefined) {
      tamper = how;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---- Fake agent-core -----------------------------------------------------

export interface CoreCall {
  method: string;
  path: string;
}
/** Answers every thread call, records them, and holds event streams open. */
export async function fakeCore() {
  const calls: CoreCall[] = [];
  const streams = new Set<ServerResponse>();
  let threads = 0;
  const behavior = {
    /** Status for POST .../turns; 200 accepts. */
    turnStatus: 200,
    /** Delay before answering POST .../resume, in ms. */
    resumeDelayMs: 0,
  };
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const path = new URL(req.url!, "http://x").pathname;
    const method = req.method ?? "GET";
    calls.push({ method, path });
    const reply = (value: unknown, status = 200) =>
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));
    if (path === "/healthz") return reply({ ok: true });
    if (path === "/threads") return reply({ threadId: "th-" + ++threads });
    if (path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": open\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    if (path.endsWith("/resume")) {
      if (behavior.resumeDelayMs) await sleep(behavior.resumeDelayMs);
      return reply({});
    }
    if (
      path.endsWith("/records") ||
      path.endsWith("/agents") ||
      (path.endsWith("/documents") && method === "GET")
    )
      return reply([]);
    if (path.endsWith("/items")) return reply({ data: [], nextCursor: null });
    if (path.endsWith("/turns"))
      return behavior.turnStatus === 200
        ? reply({ turnId: "turn-" + calls.length })
        : reply(
            { error: "rejected", code: "TURN_REFUSED" },
            behavior.turnStatus,
          );
    if (path.endsWith("/interrupt"))
      return reply({ error: "No running turn" }, 409);
    if (path.endsWith("/capabilities")) return reply({ goal: null });
    return reply({});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    calls,
    behavior,
    openStreams: () => streams.size,
    /** Calls recorded after the given mark. */
    since: (mark: number) => calls.slice(mark),
    /**
     * The same, without the platform's own background sync, which polls every
     * thread's /records on a timer whoever is looking and so can land in any
     * short window.
     */
    sinceExcludingSync: (mark: number) =>
      calls.slice(mark).filter((c) => !c.path.endsWith("/records")),
    mark: () => calls.length,
    close: async () => {
      for (const s of streams) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---- The platform --------------------------------------------------------

export interface Reply<T = any> {
  status: number;
  data: T;
  headers: Headers;
  text: string;
}

export async function startPlatform(
  options: { env?: Record<string, string> } = {},
) {
  const idp = await fakeIssuer();
  const core = await fakeCore();
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const db = "harness";
  const store = await new Store(mongo.getUri(), db, db).connect();
  const port = await freePort();
  let logs = "";
  const child = spawn(
    process.execPath,
    [resolve(root, "platform/node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
    {
      cwd: resolve(root, "platform"),
      env: {
        ...process.env,
        // Never the developer's own platform/.env.
        DOTENV_CONFIG_PATH: "/nonexistent",
        PORT: String(port),
        MONGO_URI: mongo.getUri(),
        MONGO_DB: db,
        CATALOG_MONGO_DB: db,
        AGENT_CORE_URLS: core.url,
        AGENTCORE_RUNTIME_ARN: "",
        AUTH_MODE: "google",
        GOOGLE_CLIENT_ID: CLIENT_ID,
        GOOGLE_CLIENT_SECRET: "test-secret",
        GOOGLE_ISSUER_URL: idp.issuer,
        FRONTEND_ORIGIN: FRONTEND,
        APP_PUBLIC_URL: FRONTEND,
        ADMIN_ORIGIN: "",
        TRUST_PROXY: "loopback",
        MCP_ALLOWED_PRIVATE_HOSTS: "example.com",
        MCP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        NODE_ENV: "",
        DEMO_TENANT_ID: "",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (x) => (logs += x));
  child.stderr?.on("data", (x) => (logs += x));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${base}/livez`)).ok, {
    what: "the platform",
  }).catch((e) => {
    throw new Error(`${e.message}\n${logs}`);
  });

  let ips = 0;
  const nextIp = () => `10.1.${Math.floor(++ips / 250)}.${(ips % 250) + 1}`;
  const cookieOf = (res: Response, name: string) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (pair.slice(0, i) === name) return pair.slice(i + 1);
    }
    return undefined;
  };

  // Start → fake Google → callback, returning where the browser lands and the
  // session cookie it would hold.
  async function signIn(claims: Claims, inviteToken?: string) {
    const from = nextIp();
    const query = new URLSearchParams();
    if (inviteToken) query.set("invite", inviteToken);
    const start = await fetch(
      `${base}/auth/google/start${query.size ? `?${query}` : ""}`,
      {
        redirect: "manual",
        headers: { "x-forwarded-for": from },
      },
    );
    assert.equal(start.status, 302, `start: ${start.status}`);
    const google = new URL(start.headers.get("location")!);
    if (google.origin !== idp.issuer)
      return { location: google, cookie: undefined as string | undefined };
    const flow = cookieOf(start, "truex_flow");
    google.searchParams.set(
      "x_claims",
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
    );
    const authorized = new URL(
      (await fetch(google, { redirect: "manual" })).headers.get("location")!,
    );
    const res = await fetch(
      `${base}/auth/google/callback${authorized.search}`,
      {
        redirect: "manual",
        headers: {
          "x-forwarded-for": from,
          ...(flow ? { cookie: `truex_flow=${flow}` } : {}),
        },
      },
    );
    assert.equal(res.status, 302, `callback: ${res.status}`);
    const session = cookieOf(res, "truex_session");
    return {
      location: new URL(res.headers.get("location")!),
      cookie: session ? `truex_session=${session}` : undefined,
      response: res,
    };
  }
  /** Signs in and returns the session cookie; fails if sign-in did not succeed. */
  async function session(claims: Claims, inviteToken?: string) {
    const result = await signIn(claims, inviteToken);
    assert.ok(result.cookie, `sign-in failed: ${result.location}`);
    return result.cookie;
  }

  async function request<T = any>(
    cookie: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    extra: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Reply<T>> {
    const res = await fetch(`${base}${path}`, {
      method,
      signal: extra.signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { Origin: FRONTEND } : {}),
        ...(cookie ? { cookie } : {}),
        "x-forwarded-for": nextIp(),
        ...extra.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: res.status, data, headers: res.headers, text };
  }

  /** A platform-admin (control plane) session cookie, made directly. */
  async function adminCookie() {
    const token = newToken();
    const now = new Date();
    await store.authSessions.insertOne({
      _id: hashToken(token),
      userId: null,
      tenantId: null,
      app: "admin",
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + 3_600_000),
      absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
    });
    return `truex_admin=${token}`;
  }

  /** A customer-style workspace, created exactly as the admin API creates one. */
  async function workspace(id: string, name = id) {
    return createTenant(store, { id, name });
  }
  /** An approved demo model plus the allow-lists the demo requires. */
  async function approveDemoModel(tenantId: string, modelId = "demo-model") {
    await store.profiles.updateOne(
      { _id: modelId },
      {
        $setOnInsert: {
          _id: modelId,
          provider: "fixture",
          baseUrl: "http://127.0.0.1:1/v1",
          modelName: "fixture-model",
          apiKey: "fixture-key",
          wireApi: "responses",
        },
      },
      { upsert: true },
    );
    await store.tenantRegistry.updateOne(
      { _id: tenantId },
      { $set: { allowedModelIds: [modelId], allowedSkillIds: [] } },
    );
    store.invalidateTenant(tenantId);
  }
  /** A member created directly, like an accepted invite would. */
  async function addMember(
    claims: Claims,
    tenantId: string,
    role: UserRole = "user",
    status: "active" | "removed" = "active",
  ) {
    let user = await store.users.findOne({ googleSub: claims.sub });
    if (!user) {
      user = {
        _id: `u_${randomBytes(6).toString("hex")}`,
        googleSub: claims.sub,
        email: claims.email,
        emailKey: emailKey(claims.email),
        status: "active",
        createdAt: new Date().toISOString(),
      };
      await store.users.insertOne(user);
    }
    await store.memberships.updateOne(
      { userId: user._id, tenantId },
      {
        $set: { role, status },
        $setOnInsert: {
          _id: randomBytes(8).toString("hex"),
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    return user._id;
  }

  return {
    base,
    pid: child.pid!,
    store,
    idp,
    core,
    mongo,
    logs: () => logs,
    nextIp,
    cookieOf,
    signIn,
    session,
    request,
    adminCookie,
    workspace,
    approveDemoModel,
    addMember,
    async stop() {
      await stopChild(child);
      await store.client.close();
      await mongo.stop();
      await core.close();
      await idp.close();
    },
  };
}
export type Platform = Awaited<ReturnType<typeof startPlatform>>;
