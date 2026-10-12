import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { CustomFetch } from "openid-client";
import { harness } from "./authz-integration/harness";
import { IdentityStore, identityBindingId } from "../src/identity";
import {
  oidcRoutes,
  ensureOidcIndexes,
  validateOidcSettings,
  oidcSettings,
  type OidcLoginSettings,
} from "../src/oidc";
import { BROWSER_COHORT_CLAIM, browserTenants } from "../src/browser-auth";
import {
  authMiddleware,
  authRoutes,
  csrfMiddleware,
  hashToken,
  sessionRecord,
} from "../src/auth";
import { ApiAuthenticator, bearerGate, COHORT_CLAIM } from "../src/api-auth";
import { ApplicationError } from "../../shared/errors";
import type { AddressInfo } from "node:net";

const actor = {
  kind: "human",
  id: "named-operator",
  generation: "operator-g1",
} as const;
const settings: OidcLoginSettings = {
  connectionId: "broker",
  issuer: "https://broker.fixture.invalid/",
  authorizationEndpoint: "https://broker.fixture.invalid/authorize",
  tokenEndpoint: "https://broker.fixture.invalid/token",
  jwksUri: "https://broker.fixture.invalid/jwks",
  clientId: "browser-client",
  clientSecret: "synthetic-client-secret",
  clientAuth: "basic",
  signingAlgorithm: "ES256",
  frontendOrigin: "http://localhost:3000",
  sessionHours: 8,
};

async function fixture() {
  const h = await harness();
  try {
    const identity = new IdentityStore(h.store);
    await identity.ensureIndexes();
    await ensureOidcIndexes(h.store);
    const c = await identity.registerConnection(
      { _id: settings.connectionId, kind: "oidc", issuer: settings.issuer },
      actor,
    );
    const person = await identity.createPrincipal("human", actor);
    await identity.principals.updateOne(
      { _id: person._id },
      {
        $set: {
          profile: {
            email: "first.last+team@corp.example",
            name: "Corporate Person",
          },
        },
      },
    );
    const p = {
      kind: "human",
      id: person._id,
      generation: person.generation,
    } as const;
    const external = await identity.linkExternal(
      { connectionId: c._id, subject: "opaque-broker-subject", principal: p },
      actor,
    );
    for (const id of ["acme", "other"])
      await h.store.tenantRegistry.insertOne({
        _id: id,
        dbName: `db_${id}`,
        name: id,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        authorizationGeneration: `tenant-${id}-g1`,
      });
    const bindings = [
      await identity.bindTenant(p, "acme", actor),
      await identity.bindTenant(p, "other", actor),
    ];
    // Broker iat is whole seconds. Same-second binding issuance must fail.
    await new Promise((r) => setTimeout(r, 1100));
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const jwk = {
      ...(await exportJWK(publicKey)),
      alg: "ES256",
      use: "sig",
      kid: "fixture-key",
    };
    const codes = new Map<
      string,
      {
        nonce: string;
        challenge: string;
        claim?: Record<string, unknown>;
        header?: Record<string, unknown>;
        fault?: string;
      }
    >();
    const calls: string[] = [];
    let down = false;
    const transport: CustomFetch = async (url, options) => {
      calls.push(url);
      if (down) throw new Error("fixture broker outage");
      if (url === settings.jwksUri) return Response.json({ keys: [jwk] });
      assert.equal(url, settings.tokenEndpoint);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "manual");
      assert.match(options.headers.authorization, /^Basic /);
      const credentials = Buffer.from(
        options.headers.authorization.slice(6),
        "base64",
      )
        .toString("utf8")
        .split(":")
        .map(decodeURIComponent);
      assert.deepEqual(credentials, [settings.clientId, settings.clientSecret]);
      const body = new URLSearchParams(String(options.body));
      assert.equal(
        body.get("redirect_uri"),
        `${settings.frontendOrigin}/auth/oidc/callback`,
      );
      const stored = codes.get(body.get("code")!);
      codes.delete(body.get("code")!);
      if (!stored)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier")!)
          .digest("base64url"),
        stored.challenge,
      );
      if (stored.fault === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid" },
        });
      if (stored.fault === "oversized") return new Response(" ".repeat(262145));
      const now = Math.floor(Date.now() / 1000);
      const attestation = {
        principal_generation: p.generation,
        connection_generation: c.generation,
        tenants: bindings.map((b) => ({
          tenant: b.tenantId,
          tenant_generation: b.tenantGeneration,
          binding_generation: b.generation,
          credential_generation: b.credentialGeneration,
        })),
      };
      const claims = {
        sub: "opaque-broker-subject",
        iat: now,
        exp: now + 300,
        auth_time: now,
        nonce: stored.nonce,
        [BROWSER_COHORT_CLAIM]: attestation,
        email: "not-authority@elsewhere.example",
        roles: ["admin"],
        ...stored.claim,
      };
      let jwt = await new SignJWT(claims)
        .setIssuer(String(stored.claim?.iss ?? settings.issuer))
        .setAudience(String(stored.claim?.aud ?? settings.clientId))
        .setProtectedHeader({
          alg: "ES256",
          typ: "JWT",
          kid: "fixture-key",
          ...stored.header,
        })
        .sign(privateKey);
      if (stored.fault === "signature") {
        const parts = jwt.split(".");
        parts[2] = Buffer.alloc(64).toString("base64url");
        jwt = parts.join(".");
      }
      return Response.json({
        access_token: "unused-server-side-only",
        token_type: "Bearer",
        expires_in: 300,
        id_token: jwt,
      });
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      bearerGate(
        h.store,
        new ApiAuthenticator(identity, {
          issuers: [
            {
              connectionId: c._id,
              issuer: c.issuer,
              jwksUri: settings.jwksUri,
              audience: "https://api.fixture.invalid",
            },
          ],
          fetch: (async (url) => {
            assert.equal(String(url), settings.jwksUri);
            return Response.json({ keys: [jwk] });
          }) as typeof fetch,
        }),
      ),
    );
    async function apiToken() {
      const b = bindings[0];
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        client_id: "browser-client",
        scope: "agent.read",
        [COHORT_CLAIM]: {
          tenant: b.tenantId,
          principal_generation: p.generation,
          connection_generation: c.generation,
          tenant_generation: b.tenantGeneration,
          binding_generation: b.generation,
          credential_generation: b.credentialGeneration,
        },
      })
        .setIssuer(c.issuer)
        .setAudience("https://api.fixture.invalid")
        .setSubject("opaque-broker-subject")
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "fixture-key" })
        .sign(privateKey);
    }
    app.use(
      csrfMiddleware({
        origins: [settings.frontendOrigin],
        allowMissingOrigin: false,
      }),
    );
    app.use("/auth", authRoutes(h.store));
    app.use(
      "/auth",
      oidcRoutes(h.store, settings, {
        fetch: transport,
        failureRedirect: false,
      }),
    );
    app.use("/api", authMiddleware(h.store));
    app.get("/api/me", (_req, res) =>
      res.json({
        user: res.locals.user,
        authorization: res.locals.authorization,
        profile: res.locals.profile,
      }),
    );
    app.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res
          .status(error instanceof ApplicationError ? error.status : 500)
          .json({
            code: error instanceof ApplicationError ? error.code : "ERROR",
          });
      },
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string, cookie = "", options: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        redirect: "manual",
        ...options,
        headers: { cookie, ...options.headers },
      });
    async function begin(query = "") {
      const response = await request(`/auth/oidc/start${query}`);
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location")!);
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.equal(location.searchParams.get("prompt"), "login");
      assert.equal(location.searchParams.get("max_age"), "0");
      assert.equal(location.searchParams.get("scope"), "openid email profile");
      return { location, cookie };
    }
    async function finish(
      flow: Awaited<ReturnType<typeof begin>>,
      opts: {
        claim?: Record<string, unknown>;
        header?: Record<string, unknown>;
        fault?: string;
        cookie?: string;
        state?: string;
      } = {},
    ) {
      const code = randomUUID();
      codes.set(code, {
        nonce: flow.location.searchParams.get("nonce")!,
        challenge: flow.location.searchParams.get("code_challenge")!,
        ...opts,
      });
      const state = opts.state ?? flow.location.searchParams.get("state")!;
      const path = `/auth/oidc/callback?code=${code}&state=${state}`;
      return {
        response: await request(path, opts.cookie ?? flow.cookie),
        path,
        cookie: opts.cookie ?? flow.cookie,
      };
    }
    return {
      ...h,
      identity,
      person: p,
      c,
      external,
      bindings,
      codes,
      calls,
      request,
      apiToken,
      begin,
      finish,
      outage: (v: boolean) => {
        down = v;
      },
      async stop() {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await h.stop();
      },
    };
  } catch (error) {
    await h.stop();
    throw error;
  }
}
const mutation = (
  tenantId: string,
  origin = settings.frontendOrigin,
): RequestInit => ({
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ tenantId }),
});
const sessionCookie = (response: Response) =>
  response.headers.get("set-cookie")!.split(";")[0];

test("OIDC settings reject caller endpoints, insecure production origins and unbounded lifetimes", () => {
  assert.deepEqual(validateOidcSettings(settings), settings);
  for (const change of [
    { issuer: "http://broker.invalid" },
    { jwksUri: "https://u:p@broker.invalid/jwks" },
    { tokenEndpoint: "https://broker.invalid/token?x=1" },
    { frontendOrigin: "http://attacker.invalid" },
    { signingAlgorithm: "HS256" },
    { sessionHours: 25 },
    { authorizationParams: { redirect_uri: "https://evil.invalid" } },
    { connectionId: { $ne: null } },
  ])
    assert.throws(() => validateOidcSettings({ ...settings, ...change }));
  assert.throws(() => validateOidcSettings(settings, true));
  assert.throws(
    () =>
      oidcSettings({
        AUTH_MODE: "oidc",
        OIDC_LOGIN_CONFIG: "secret-invalid-json",
        FRONTEND_ORIGIN: settings.frontendOrigin,
      }),
    /valid OIDC_LOGIN_CONFIG JSON/,
  );
});

test("real OIDC SDK PKCE/nonce/signature flow creates a cohort-bound opaque multi-tenant session", async (t) => {
  const f = await fixture();
  t.after(() => f.stop());
  const flow = await f.begin();
  const finished = await f.finish(flow);
  assert.equal(
    finished.response.status,
    302,
    await finished.response.clone().text(),
  );
  assert.equal(
    finished.response.headers.get("location"),
    `${settings.frontendOrigin}/select-tenant`,
  );
  const cookie = sessionCookie(finished.response);
  assert.match(
    finished.response.headers.get("set-cookie")!,
    /HttpOnly; SameSite=Lax/,
  );
  const raw = cookie.split("=")[1];
  const document = (await f.store.authSessions.findOne({
    _id: hashToken(raw),
  }))!;
  assert.equal(document.userId, f.person.id);
  assert.equal(document.tenantId, null);
  assert.equal(document.authorization!.bindings.length, 2);
  assert.equal(
    document.absoluteExpiresAt.getTime() - document.createdAt.getTime() <=
      8 * 3600000,
    true,
  );
  assert.ok(!JSON.stringify(document).includes("unused-server-side-only"));
  assert.ok(!JSON.stringify(document).includes(raw));
  assert.equal(
    await f.store.users.countDocuments({ _id: f.person.id }),
    0,
    "no fake Google identity",
  );
  assert.equal(
    await f.identity.audit.countDocuments({
      action: "session.oidc.login",
      targetId: document._id,
    }),
    1,
  );
  assert.equal((await f.request("/api/me", cookie)).status, 409);
  assert.deepEqual(
    (await (await f.request("/auth/tenants", cookie)).json()).tenants.map(
      (v: any) => v.id,
    ),
    ["acme", "other"],
  );
  assert.equal(
    (
      await f.request(
        "/auth/switch-tenant",
        cookie,
        mutation("acme", "https://evil.invalid"),
      )
    ).status,
    403,
  );
  const switched = await f.request(
    "/auth/switch-tenant",
    cookie,
    mutation("acme"),
  );
  assert.equal(switched.status, 200);
  const rotated = sessionCookie(switched);
  const me = await (await f.request("/api/me", rotated)).json();
  assert.equal(me.user.email, "first.last+team@corp.example");
  assert.equal(me.user.role, "user");
  assert.equal(me.authorization.principal.kind, "human");
  const access = await f.apiToken();
  const bearerResponse = await f.request("/api/me", "", {
    headers: { authorization: `Bearer ${access}` },
  });
  assert.equal(bearerResponse.status, 200);
  const bearerMe = await bearerResponse.json();
  assert.deepEqual(
    bearerMe.authorization.principal,
    me.authorization.principal,
  );
  assert.deepEqual(bearerMe.authorization.tenant, me.authorization.tenant);
  assert.deepEqual(bearerMe.authorization.binding, me.authorization.binding);
  assert.equal(bearerMe.authorization.credential.kind, "access_token");
  assert.equal(me.authorization.credential.kind, "session");
  assert.equal(
    (
      await f.request("/api/me", rotated, {
        headers: { authorization: `Bearer ${access}` },
      })
    ).status,
    400,
  );
  assert.equal((await f.request("/api/me", cookie)).status, 401);
  const newDocument = (await f.store.authSessions.findOne({
    _id: hashToken(rotated.split("=")[1]),
  }))!;
  assert.deepEqual(newDocument.authorization, document.authorization);
  assert.equal(
    newDocument.absoluteExpiresAt.getTime(),
    document.absoluteExpiresAt.getTime(),
  );
  assert.equal(
    (await f.request(finished.path, finished.cookie)).status,
    401,
    "callback replay cannot mint a session",
  );
});

test("forged, stale, wrong-purpose, unbound and ambiguous OIDC callbacks cannot mint sessions", async (t) => {
  const f = await fixture();
  t.after(() => f.stop());
  const now = Math.floor(Date.now() / 1000);
  for (const change of [
    { fault: "signature" },
    { claim: { nonce: "wrong" } },
    { claim: { aud: "wrong-client" } },
    { claim: { iss: "https://evil.invalid" } },
    { claim: { exp: now - 100 } },
    { claim: { auth_time: now - 3600 } },
    { claim: { auth_time: undefined } },
    { claim: { iat: now + 60 } },
    { header: { kid: "unknown-key" } },
    { claim: { amr: { $ne: null } } },
    {
      claim: { sub: "unknown-subject", email: "first.last+team@corp.example" },
    },
    { claim: { [BROWSER_COHORT_CLAIM]: undefined } },
    { header: { typ: "at+jwt" } },
    { header: { jku: "https://evil.invalid/key" } },
    { fault: "redirect" },
    { fault: "oversized" },
  ]) {
    const flow = await f.begin();
    const { response, path, cookie } = await f.finish(flow, change);
    assert.equal(response.status, 401, JSON.stringify(change));
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal((await f.request(path, cookie)).status, 401);
  }
  const flow = await f.begin();
  const wrong = await f.finish(flow, { state: "wrong-state-0123456789" });
  assert.equal(wrong.response.status, 401);
  const good = await f.finish(flow);
  assert.equal(
    good.response.status,
    302,
    "wrong state does not consume real flow",
  );
  assert.equal(
    f.calls.some((url) => url.startsWith("https://evil.invalid")),
    false,
  );
  assert.equal(await f.store.authSessions.countDocuments({}), 1);
});

test("removal and rehire never revive a captured session, while another tenant remains usable", async (t) => {
  const f = await fixture();
  t.after(() => f.stop());
  const login = await f.finish(await f.begin("?tenant=acme"));
  assert.equal(login.response.status, 302);
  const cookie = sessionCookie(login.response);
  const old = (await f.store.authSessions.findOne({
    _id: hashToken(cookie.split("=")[1]),
  }))!;
  await f.identity.removeBinding(
    f.bindings[0]._id,
    f.bindings[0].generation,
    actor,
  );
  await f.identity.bindTenant(f.person, "acme", actor);
  assert.equal((await f.request("/api/me", cookie)).status, 403);
  assert.deepEqual(
    (await (await f.request("/auth/tenants", cookie)).json()).tenants.map(
      (v: any) => v.id,
    ),
    ["other"],
  );
  assert.equal(
    (await f.request("/auth/switch-tenant", cookie, mutation("acme"))).status,
    403,
  );
  const switched = await f.request(
    "/auth/switch-tenant",
    cookie,
    mutation("other"),
  );
  assert.equal(switched.status, 200);
  const newCookie = sessionCookie(switched);
  assert.equal((await f.request("/api/me", newCookie)).status, 200);
  const newest = (await f.store.authSessions.findOne({
    _id: hashToken(newCookie.split("=")[1]),
  }))!;
  assert.deepEqual(newest.authorization, old.authorization);
  await f.identity.disableConnection(f.c._id, f.c.generation, actor);
  assert.equal((await f.request("/auth/tenants", newCookie)).status, 401);
});

test("callback failure preserves existing cookies and concurrent switches have exactly one winner", async (t) => {
  const f = await fixture();
  t.after(() => f.stop());
  const issued = await f.finish(await f.begin("?tenant=acme"));
  const cookie = sessionCookie(issued.response);
  const a = await f.begin();
  const b = await f.begin();
  const oldReply = await f.finish(a, { cookie: b.cookie });
  assert.equal(oldReply.response.status, 401);
  assert.equal(oldReply.response.headers.has("set-cookie"), false);
  f.outage(true);
  const failed = await f.finish(b, { cookie: `${b.cookie}; ${cookie}` });
  assert.equal(failed.response.status, 401);
  assert.equal(failed.response.headers.has("set-cookie"), false);
  f.outage(false);
  assert.equal((await f.request("/api/me", cookie)).status, 200);
  await f.store.catalog.command({
    collMod: "identity_audit",
    validator: { action: { $ne: "session.oidc.login" } },
    validationLevel: "strict",
    validationAction: "error",
  });
  const auditFlow = await f.begin();
  const auditFailure = await f.finish(auditFlow, {
    cookie: `${auditFlow.cookie}; ${cookie}`,
  });
  assert.equal(auditFailure.response.status, 500);
  assert.equal(auditFailure.response.headers.has("set-cookie"), false);
  assert.equal(
    await f.store.authSessions.countDocuments({}),
    1,
    "failed issuance cannot leave a session without audit",
  );
  assert.equal((await f.request("/api/me", cookie)).status, 200);
  await f.store.catalog.command({ collMod: "identity_audit", validator: {} });
  const replies = await Promise.all([
    f.request("/auth/switch-tenant", cookie, mutation("acme")),
    f.request("/auth/switch-tenant", cookie, mutation("other")),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 401]);
  assert.equal(await f.store.authSessions.countDocuments({}), 1);
});

test("bounded tenant list reuses live cohort rules and rejects malformed stored cohorts", async (t) => {
  const f = await fixture();
  t.after(() => f.stop());
  const login = await f.finish(await f.begin());
  const cookie = sessionCookie(login.response);
  const session = (await f.store.authSessions.findOne({
    _id: hashToken(cookie.split("=")[1]),
  }))!;
  const large = structuredClone(session);
  const tenantDocs = Array.from({ length: 98 }, (_, n) => {
    const id = `tenant-${n}`;
    return {
      _id: id,
      dbName: `db_${id}`,
      name: id,
      status: "active" as const,
      authorizationGeneration: `tenant-${n}-g1`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
  await f.store.tenantRegistry.insertMany(tenantDocs);
  await f.identity.tenantBindings.insertMany(
    tenantDocs.map((t) => {
      const b = {
        _id: identityBindingId(f.person.id, t._id),
        tenantId: t._id,
        tenantGeneration: t.authorizationGeneration,
        principal: f.person,
        generation: `binding-${t._id}-g1`,
        credentialGeneration: `credential-${t._id}-g1`,
        notBeforeMs: session.authorization!.issuedAtMs - 1,
        status: "active" as const,
        epoch: 1,
        createdAt: new Date(),
      };
      large.authorization!.bindings.push({
        tenantId: b.tenantId,
        tenantGeneration: b.tenantGeneration,
        bindingId: b._id,
        bindingGeneration: b.generation,
        credentialGeneration: b.credentialGeneration,
      });
      return b;
    }),
  );
  // Mongo command count: catalog reads stay constant when listing many tenants.
  let reads = 0;
  const original = f.store.catalog.collection.bind(f.store.catalog);
  f.store.catalog.collection = ((...args: any[]) => {
    const col = original(...(args as [string]));
    return new Proxy(col, {
      get(target, property) {
        if (["find", "findOne"].includes(String(property)))
          return (...params: unknown[]) => {
            reads++;
            return (target[property as "find"] as Function).apply(
              target,
              params,
            );
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof f.store.catalog.collection;
  try {
    assert.equal((await browserTenants(f.store, large)).length, 100);
    assert.ok(reads <= 6, `unexpected N+1 reads: ${reads}`);
  } finally {
    f.store.catalog.collection = original;
  }
  await f.store.authSessions.updateOne(
    { _id: session._id },
    { $set: { "authorization.bindings.0.credentialGeneration": "stale" } },
  );
  assert.deepEqual(
    (await (await f.request("/auth/tenants", cookie)).json()).tenants.map(
      (v: any) => v.id,
    ),
    ["other"],
  );
  await f.store.authSessions.updateOne(
    { _id: session._id },
    { $set: { "authorization.extra": "untrusted" } },
  );
  assert.equal((await f.request("/auth/tenants", cookie)).status, 401);
});
