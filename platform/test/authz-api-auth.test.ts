import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type CryptoKey,
} from "jose";
import { harness } from "./authz-integration/harness";
import { IdentityStore } from "../src/identity";
import { backfillGoogleIdentities } from "../src/identity-migration";
import {
  ApiAuthenticator,
  COHORT_CLAIM,
  bearerGate,
  bearerRouteRequirement,
  type TrustedApiIssuer,
} from "../src/api-auth";
import { authMiddleware, csrfMiddleware } from "../src/auth";
import { ApplicationError } from "../../shared/errors";
import type { PrincipalRef } from "../../shared/authorization";

const ISS = "https://broker.example/";
const ISS_B = "https://other-broker.example/";
const AUD = "https://api.truex.example";
const ACTOR: PrincipalRef = {
  kind: "human",
  id: "platform-operator",
  generation: "operator-generation-1",
};

interface KeyPair {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}
async function keyPair(kid: string, alg = "ES256"): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" },
  };
}

/** Controllable JWKS transport: key sets per URL, call counts and outages. */
function jwksTransport() {
  const sets = new Map<string, JWK[]>();
  const calls = new Map<string, number>();
  let down = false;
  const fetchImpl = (async (url: string | URL | Request) => {
    const key = String(url);
    calls.set(key, (calls.get(key) ?? 0) + 1);
    if (down) throw new Error("jwks unreachable");
    const keys = sets.get(key);
    if (!keys) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    publish: (url: string, ...keys: KeyPair[]) =>
      sets.set(
        url,
        keys.map((k) => k.jwk),
      ),
    calls: (url: string) => calls.get(url) ?? 0,
    outage: (value: boolean) => (down = value),
  };
}

const JWKS_A = "https://broker.example/.well-known/jwks.json";
const JWKS_B = "https://other-broker.example/.well-known/jwks.json";
const issuers = (): TrustedApiIssuer[] => [
  { connectionId: "broker", issuer: ISS, jwksUri: JWKS_A, audience: AUD },
  { connectionId: "other", issuer: ISS_B, jwksUri: JWKS_B, audience: AUD },
];

async function fixture(
  overrides: Partial<ConstructorParameters<typeof ApiAuthenticator>[1]> = {},
) {
  const h = await harness();
  try {
    const identity = new IdentityStore(h.store);
    await identity.ensureIndexes();
    const now = new Date().toISOString();
    await h.store.tenantRegistry.insertOne({
      _id: "acme",
      name: "acme",
      dbName: "db_acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
      authorizationGeneration: "tenant-generation-1",
    });
    const broker = await identity.registerConnection(
      { _id: "broker", kind: "oidc", issuer: ISS },
      ACTOR,
    );
    const other = await identity.registerConnection(
      { _id: "other", kind: "oidc", issuer: ISS_B },
      ACTOR,
    );
    // Human with a legacy user row and membership (what backfill produces).
    await h.store.users.insertOne({
      _id: "person-1",
      googleSub: "legacy-sub",
      email: "person@corp.example",
      emailKey: "person@corp.example",
      status: "active",
      createdAt: now,
    });
    await h.store.memberships.insertOne({
      _id: "person-1-acme",
      userId: "person-1",
      tenantId: "acme",
      role: "user",
      status: "active",
      createdAt: now,
    });
    await identity.registerConnection(
      {
        _id: "legacy-google",
        kind: "google",
        issuer: "https://accounts.google.com",
      },
      ACTOR,
    );
    const migration = await backfillGoogleIdentities(
      identity,
      "legacy-google",
      true,
      ACTOR,
    );
    assert.equal(migration.issueCount, 0);
    const person = (await identity.principals.findOne({ _id: "person-1" }))!;
    const pref = {
      kind: "human" as const,
      id: person._id,
      generation: person.generation,
    };
    await identity.linkExternal(
      { connectionId: "broker", subject: "auth0|abc", principal: pref },
      ACTOR,
    );
    const binding = await identity.bindTenant(pref, "acme", ACTOR);
    const svc = await identity.createPrincipal("service", ACTOR, "svc-1");
    const sref = {
      kind: "service" as const,
      id: svc._id,
      generation: svc.generation,
    };
    const sbinding = await identity.bindTenant(sref, "acme", ACTOR);
    const client = await identity.registerClient(
      {
        connectionId: "broker",
        clientId: "robot-client",
        bindingId: sbinding._id,
      },
      ACTOR,
    );
    // Token `iat` has one-second resolution; model bindings created a while ago
    // so freshly minted fixture tokens are not older than the binding.
    await identity.tenantBindings.updateMany(
      {},
      { $set: { notBeforeMs: Date.now() - 60_000 } },
    );
    const transport = jwksTransport();
    const keyA = await keyPair("k1");
    const keyB = await keyPair("k1"); // same kid under a different issuer
    transport.publish(JWKS_A, keyA);
    transport.publish(JWKS_B, keyB);
    const auth = new ApiAuthenticator(identity, {
      issuers: issuers(),
      fetch: transport.fetch,
      ...overrides,
    });
    const cohort = (extra: Record<string, string> = {}) => ({
      tenant: "acme",
      principal_generation: pref.generation,
      binding_generation: binding.generation,
      credential_generation: binding.credentialGeneration,
      tenant_generation: binding.tenantGeneration,
      connection_generation: broker.generation,
      ...extra,
    });
    const serviceCohort = () => ({
      tenant: "acme",
      principal_generation: sref.generation,
      binding_generation: sbinding.generation,
      credential_generation: sbinding.credentialGeneration,
      tenant_generation: sbinding.tenantGeneration,
      connection_generation: broker.generation,
      client_generation: client.generation,
    });
    async function mint(
      options: {
        key?: KeyPair;
        alg?: string;
        typ?: string | null;
        header?: Record<string, unknown>;
        claims?: Record<string, unknown>;
        iss?: string;
        aud?: string;
        exp?: number;
        iat?: number;
        jti?: string;
      } = {},
    ) {
      const key = options.key ?? keyA;
      const iat = options.iat ?? Math.floor(Date.now() / 1000) - 1;
      const jwt = new SignJWT({
        client_id: "web-app",
        scope: "agent.read unknown.scope conversation.read",
        [COHORT_CLAIM]: cohort(),
        ...options.claims,
      })
        .setProtectedHeader({
          alg: options.alg ?? "ES256",
          kid: key.kid,
          ...(options.typ === null ? {} : { typ: options.typ ?? "at+jwt" }),
          ...options.header,
        })
        .setIssuer(options.iss ?? ISS)
        .setAudience(options.aud ?? AUD)
        .setSubject("auth0|abc")
        .setJti(options.jti ?? `jti-${Math.random()}`)
        .setIssuedAt(iat)
        .setExpirationTime(options.exp ?? iat + 300);
      return jwt.sign(key.privateKey);
    }
    return {
      ...h,
      identity,
      auth,
      transport,
      keyA,
      keyB,
      mint,
      cohort,
      serviceCohort,
      pref,
      binding,
      broker,
      sbinding,
    };
  } catch (error) {
    await h.stop();
    throw error;
  }
}

const deny =
  (code: string, status = 401) =>
  (error: unknown) => {
    assert.ok(error instanceof ApplicationError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
const bearer = (token: string) => `Bearer ${token}`;

test("a valid human token yields a live bound context; unknown scopes carry no authority", async () => {
  const f = await fixture();
  try {
    const v = await f.auth.authenticate(bearer(await f.mint()));
    assert.equal(v.kind, "human");
    assert.equal(v.context.principal.id, "person-1");
    const first = await f.mint({
      jti: "repeated-provider-id",
      claims: { scope: "agent.read" },
    });
    const second = await f.mint({
      jti: "repeated-provider-id",
      claims: { scope: "conversation.read" },
    });
    const a = await f.auth.authenticate(bearer(first));
    const b = await f.auth.authenticate(bearer(second));
    assert.notEqual(a.context.credential.id, b.context.credential.id);
    assert.equal(
      a.context.credential.id,
      (await f.auth.authenticate(bearer(first))).context.credential.id,
    );
    assert.equal(v.context.tenant.id, "acme");
    assert.equal(v.context.credential.kind, "access_token");
    assert.deepEqual(v.context.credential.scopes, [
      "agent.read",
      "conversation.read",
    ]);
    // Roles/groups claims never grant anything.
    const withRole = await f.auth.authenticate(
      bearer(await f.mint({ claims: { role: "admin", groups: ["owners"] } })),
    );
    assert.deepEqual(
      withRole.context.credential.scopes,
      v.context.credential.scopes,
    );
  } finally {
    await f.stop();
  }
});

test("forged, mismatched and ID-token-shaped credentials are all refused with one error", async () => {
  const f = await fixture();
  try {
    const wrongKey = await keyPair("k1");
    const nowSec = Math.floor(Date.now() / 1000);
    const bad: Record<string, string> = {
      "signature from another key, same kid": await f.mint({ key: wrongKey }),
      "same kid, issuer B's key": await f.mint({ key: f.keyB }),
      "wrong audience": await f.mint({ aud: "https://other-api.example" }),
      "untrusted issuer": await f.mint({ iss: "https://evil.example/" }),
      expired: await f.mint({ iat: nowSec - 4000, exp: nowSec - 3000 }),
      "lifetime too long": await f.mint({
        iat: nowSec - 1,
        exp: nowSec + 7200,
      }),
      "future iat": await f.mint({ iat: nowSec + 600, exp: nowSec + 900 }),
      "ID token typ": await f.mint({ typ: "JWT" }),
      "no typ": await f.mint({ typ: null }),
      "ID token claims": await f.mint({ claims: { nonce: "n", at_hash: "h" } }),
      "missing client_id": await f.mint({ claims: { client_id: undefined } }),
      "token-supplied jku": await f.mint({
        header: { jku: "https://evil.example/jwks.json" },
      }),
      "token-supplied jwk": await f.mint({
        header: { jwk: f.keyA.jwk },
      }),
      "unknown cohort claim": await f.mint({
        claims: { [COHORT_CLAIM]: f.cohort({ role: "owner" }) },
      }),
      "no cohort": await f.mint({ claims: { [COHORT_CLAIM]: undefined } }),
      "wrong tenant claim": await f.mint({
        claims: { [COHORT_CLAIM]: f.cohort({ tenant: "globex" }) },
      }),
      "stale binding generation": await f.mint({
        claims: { [COHORT_CLAIM]: f.cohort({ binding_generation: "old" }) },
      }),
      "stale connection generation": await f.mint({
        claims: { [COHORT_CLAIM]: f.cohort({ connection_generation: "old" }) },
      }),
      "unbound subject": await f.mint({ claims: { sub: "auth0|nobody" } }),
    };
    // Claims overriding sub must be applied by the library, not the helper.
    bad["unbound subject"] = await new SignJWT({
      client_id: "web-app",
      [COHORT_CLAIM]: f.cohort(),
    })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "at+jwt" })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject("auth0|nobody")
      .setJti("x")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(f.keyA.privateKey);
    for (const [name, token] of Object.entries(bad))
      await assert.rejects(
        f.auth.authenticate(bearer(token)),
        deny("BEARER_INVALID"),
        name,
      );

    // alg=none and HMAC-with-public-key confusion.
    const part = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const payload = {
      iss: ISS,
      aud: AUD,
      sub: "auth0|abc",
      client_id: "web-app",
      jti: "j",
      iat: nowSec,
      exp: nowSec + 300,
      [COHORT_CLAIM]: f.cohort(),
    };
    await assert.rejects(
      f.auth.authenticate(
        bearer(`${part({ alg: "none", typ: "at+jwt" })}.${part(payload)}.`),
      ),
      deny("BEARER_INVALID"),
    );
    const hs = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", kid: "k1", typ: "at+jwt" })
      .sign(new TextEncoder().encode(JSON.stringify(f.keyA.jwk)));
    await assert.rejects(
      f.auth.authenticate(bearer(hs)),
      deny("BEARER_INVALID"),
    );

    // Header shape: wrong scheme, oversized, extra segments, empty.
    for (const header of [
      "",
      "Basic abc",
      "Bearer",
      "Bearer a.b",
      "Bearer a.b.c d",
      `Bearer ${"a".repeat(9000)}.b.c`,
      "Bearer a.b.c, Bearer d.e.f",
    ])
      await assert.rejects(
        f.auth.authenticate(header),
        deny("BEARER_INVALID"),
        header.slice(0, 20),
      );
  } finally {
    await f.stop();
  }
});

test("emergency disable and lifecycle changes are live fences, not cached crypto results", async () => {
  const f = await fixture();
  try {
    const token = bearer(await f.mint());
    await f.auth.authenticate(token);

    await f.identity.connections.updateOne(
      { _id: "broker" },
      { $set: { status: "disabled" } },
    );
    await assert.rejects(f.auth.authenticate(token), deny("BEARER_INVALID"));
    await f.identity.connections.updateOne(
      { _id: "broker" },
      { $set: { status: "active" } },
    );
    await f.auth.authenticate(token);

    await f.identity.principals.updateOne(
      { _id: "person-1" },
      { $set: { status: "disabled" } },
    );
    await assert.rejects(f.auth.authenticate(token), deny("BEARER_INVALID"));
    await f.identity.principals.updateOne(
      { _id: "person-1" },
      { $set: { status: "active" } },
    );

    // Removal, then rehire: the old token cannot acquire the new generation.
    await f.identity.removeBinding(f.binding._id, f.binding.generation, ACTOR);
    await assert.rejects(f.auth.authenticate(token), deny("BEARER_INVALID"));
    await f.identity.bindTenant(f.pref, "acme", ACTOR);
    await assert.rejects(f.auth.authenticate(token), deny("BEARER_INVALID"));
  } finally {
    await f.stop();
  }
});

test("JWKS: rotation, unknown-key floods, outages and no stale-key extension", async () => {
  const f = await fixture({ jwksCooldownMs: 30_000 });
  try {
    await f.auth.authenticate(bearer(await f.mint()));
    assert.equal(f.transport.calls(JWKS_A), 1);

    // Flood of tokens naming unknown kids: refresh is rate limited.
    for (let i = 0; i < 25; i++) {
      const unknown = await keyPair(`rot-${i}`);
      await assert.rejects(
        f.auth.authenticate(bearer(await f.mint({ key: unknown }))),
        deny("BEARER_INVALID"),
      );
    }
    assert.equal(f.transport.calls(JWKS_A), 1, "cooldown bounds refetching");
    // Other issuers' key sets are untouched by a flood against one issuer.
    assert.equal(f.transport.calls(JWKS_B), 0);
  } finally {
    await f.stop();
  }

  const g = await fixture({ jwksCooldownMs: 0, jwksCacheMaxAgeMs: 1000 });
  try {
    const next = await keyPair("k2");
    const early = bearer(await g.mint({ key: next }));
    await assert.rejects(g.auth.authenticate(early), deny("BEARER_INVALID"));
    g.transport.publish(JWKS_A, g.keyA, next);
    // Rotation published: the new key verifies after one bounded refresh.
    assert.equal(
      (await g.auth.authenticate(bearer(await g.mint({ key: next })))).kind,
      "human",
    );
    // A retired key is honoured only for the bounded cache freshness window
    // (emergency disable uses the connection fence instead); then it fails.
    g.transport.publish(JWKS_A, next);
    const old = bearer(await g.mint());
    assert.equal((await g.auth.authenticate(old)).kind, "human");
    await new Promise((r) => setTimeout(r, 1150));
    await assert.rejects(g.auth.authenticate(old), deny("BEARER_INVALID"));
  } finally {
    await g.stop();
  }

  const h = await fixture({ jwksCacheMaxAgeMs: 1000, jwksCooldownMs: 0 });
  try {
    const token = bearer(await h.mint());
    await h.auth.authenticate(token);
    h.transport.outage(true);
    // Cached key is still within its bounded freshness.
    await h.auth.authenticate(token);
    await new Promise((r) => setTimeout(r, 1150));
    // Expired freshness plus outage denies as unavailable; never extended.
    await assert.rejects(
      h.auth.authenticate(token),
      deny("AUTH_UNAVAILABLE", 503),
    );
    h.transport.outage(false);
    await h.auth.authenticate(token);
  } finally {
    await h.stop();
  }

  // Fresh process with an unreachable JWKS endpoint: deny, not guess.
  const i = await fixture();
  try {
    const cold = new ApiAuthenticator(i.identity, {
      issuers: issuers(),
      fetch: i.transport.fetch,
    });
    i.transport.outage(true);
    await assert.rejects(
      cold.authenticate(bearer(await i.mint())),
      deny("AUTH_UNAVAILABLE", 503),
    );
  } finally {
    await i.stop();
  }
});

test("service tokens bind only to a registered client of the tenant", async () => {
  const f = await fixture();
  try {
    const iat = Math.floor(Date.now() / 1000) - 1;
    const service = (over: Record<string, unknown> = {}) =>
      new SignJWT({
        client_id: "robot-client",
        scope: "agent.read",
        [COHORT_CLAIM]: f.serviceCohort(),
        ...over,
      })
        .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "at+jwt" })
        .setIssuer(ISS)
        .setAudience(AUD)
        .setSubject(String(over.sub ?? over.client_id ?? "robot-client"))
        .setJti("service-jti")
        .setIssuedAt(iat)
        .setExpirationTime(iat + 300)
        .sign(f.keyA.privateKey);
    const v = await f.auth.authenticate(bearer(await service()));
    assert.equal(v.kind, "service");
    assert.equal(v.context.principal.id, "svc-1");
    // sub must equal client_id for client credentials.
    await assert.rejects(
      f.auth.authenticate(bearer(await service({ sub: "someone" }))),
      deny("BEARER_INVALID"),
    );
    await assert.rejects(
      f.auth.authenticate(
        bearer(
          await service({ client_id: "unregistered", sub: "unregistered" }),
        ),
      ),
      deny("BEARER_INVALID"),
    );
    // A human cohort cannot carry a client generation, nor a service omit it.
    await assert.rejects(
      f.auth.authenticate(
        bearer(
          await f.mint({
            claims: {
              [COHORT_CLAIM]: f.cohort({
                client_generation: f.sbinding.generation,
              }),
            },
          }),
        ),
      ),
      deny("BEARER_INVALID"),
    );
    const { client_generation: _drop, ...noClient } = f.serviceCohort();
    void _drop;
    await assert.rejects(
      f.auth.authenticate(bearer(await service({ [COHORT_CLAIM]: noClient }))),
      deny("BEARER_INVALID"),
    );
  } finally {
    await f.stop();
  }
});

test("issuer configuration rejects unsafe trust roots", async () => {
  const f = await fixture();
  try {
    const make = (issuer: Partial<TrustedApiIssuer>) =>
      new ApiAuthenticator(f.identity, {
        issuers: [{ ...issuers()[0], ...issuer }],
      });
    assert.throws(() => make({ jwksUri: "http://broker.example/jwks" }));
    assert.throws(() => make({ issuer: "http://broker.example/" }));
    assert.throws(() => make({ jwksUri: "https://u:p@broker.example/jwks" }));
    assert.throws(() => make({ issuer: "https://broker.example/?tenant=a" }));
    assert.throws(() => make({ audience: "" }));
    assert.throws(() => make({ algorithms: ["HS256" as never] }));
    assert.throws(() => new ApiAuthenticator(f.identity, { issuers: [] }));
    assert.throws(
      () =>
        new ApiAuthenticator(f.identity, {
          issuers: [issuers()[0], { ...issuers()[1], issuer: ISS }],
        }),
    );
    assert.throws(
      () =>
        new ApiAuthenticator(f.identity, {
          issuers: issuers(),
          clockToleranceSec: 3600,
        }),
    );
  } finally {
    await f.stop();
  }
});

test("route requirements come from the reviewed inventory and fail closed", () => {
  assert.deepEqual(bearerRouteRequirement("GET", "/api/me"), { actions: [] });
  assert.deepEqual(bearerRouteRequirement("HEAD", "/api/agents/"), {
    actions: ["agent.read"],
  });
  assert.deepEqual(bearerRouteRequirement("GET", "/api/sessions/abc"), {
    actions: ["conversation.read"],
  });
  assert.deepEqual(
    bearerRouteRequirement("POST", "/api/sessions/abc/messages"),
    {
      actions: ["conversation.send"],
    },
  );
  for (const [method, path] of [
    ["GET", "/api/sessions/abc/events"], // stream: Step 10
    ["POST", "/api/sessions/abc/capabilities"], // per-method actions: Step 09
    ["GET", "/api/capabilities"], // blocked
    ["GET", "/api/not-a-route"],
    ["DELETE", "/api/me"],
    ["GET", "/api/admin/tenants"],
    ["GET", "/api/sessions/a/b/c/d"],
  ])
    assert.equal(bearerRouteRequirement(method, path), undefined, path);
});

async function serve(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("HTTP: bearer is resolved before CSRF and resource code; ambiguity and fallback are refused", async () => {
  const f = await fixture();
  const reached: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/api", bearerGate(f.store, f.auth));
  app.use(
    ["/api"],
    csrfMiddleware({
      origins: ["https://app.truex.example"],
      allowMissingOrigin: false,
    }),
  );
  app.use("/api", authMiddleware(f.store));
  app.all(/^\/api\/.*/, (req, res) => {
    reached.push(`${req.method} ${req.path}`);
    res.json({ user: res.locals.user, tenant: res.locals.tenant?.id });
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const e = error as ApplicationError;
      res.status(e.status ?? 500).json({ code: e.code ?? "ERROR" });
    },
  );
  const server = await serve(app);
  try {
    const call = async (
      path: string,
      init: {
        method?: string;
        token?: string;
        headers?: Record<string, string>;
        body?: unknown;
      } = {},
    ) => {
      const res = await fetch(server.url + path, {
        method: init.method ?? "GET",
        headers: {
          ...(init.token ? { authorization: bearer(init.token) } : {}),
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      return {
        status: res.status,
        vary: res.headers.get("vary") ?? "",
        body: (await res.json().catch(() => ({}))) as Record<string, any>,
      };
    };
    const token = await f.mint();

    // Verified bearer: role comes from the live membership, not the token.
    const ok = await call("/api/agents", {
      token: await f.mint({ claims: { role: "admin" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, "user");
    assert.equal(ok.body.tenant, "acme");
    assert.match(ok.vary, /Authorization/i);

    // Scope ceiling.
    const noScope = await call("/api/projects", { token });
    assert.deepEqual(
      [noScope.status, noScope.body.code],
      [403, "SCOPE_DENIED"],
    );
    assert.equal(
      (
        await call("/api/me", {
          token: await f.mint({ claims: { scope: "" } }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("/api/sessions/x/events", { token })).body.code,
      "BEARER_ROUTE_UNSUPPORTED",
    );
    assert.equal(
      (await call("/api/admin/tenants", { token })).body.code,
      "BEARER_INVALID",
    );

    // CSRF: a verified bearer is exempt; an invalid one is refused first as
    // 401 (not 403, and never as a no-origin cookie request).
    const before = reached.length;
    const post = await call("/api/projects", {
      method: "POST",
      token: await f.mint({ claims: { scope: "project.create" } }),
      body: { name: "x" },
    });
    assert.equal(post.status, 200);
    assert.equal(reached.length, before + 1);
    const forged = await call("/api/projects", {
      method: "POST",
      token: await f.mint({ key: await keyPair("k1") }),
      body: { name: "x" },
    });
    assert.deepEqual(
      [forged.status, forged.body.code],
      [401, "BEARER_INVALID"],
    );
    // A bare Authorization header on a mutation is not a CSRF exemption.
    const bogus = await fetch(server.url + "/api/projects", {
      method: "POST",
      headers: {
        authorization: "Basic abc",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(bogus.status, 401);

    // No Authorization header: cookie mechanism, still CSRF protected.
    const cookieOnly = await call("/api/projects", {
      method: "POST",
      headers: { cookie: "truex_session=abc", origin: "https://evil.example" },
      body: {},
    });
    assert.deepEqual(
      [cookieOnly.status, cookieOnly.body.code],
      [403, "CSRF_ORIGIN"],
    );
    const unauth = await call("/api/agents");
    assert.equal(unauth.status, 401);

    // Both mechanisms: rejected before verification, even if the bearer is
    // garbage and the cookie would have been valid.
    for (const name of [
      "truex_session",
      "__Host-truex_session",
      "truex_admin",
    ]) {
      const both = await call("/api/agents", {
        token,
        headers: { cookie: `${name}=abc` },
      });
      assert.deepEqual(
        [both.status, both.body.code],
        [400, "AMBIGUOUS_CREDENTIALS"],
      );
      const garbage = await fetch(server.url + "/api/agents", {
        headers: { authorization: "Bearer nonsense", cookie: `${name}=abc` },
      });
      assert.equal(garbage.status, 400);
    }

    // Lifecycle fences apply on the HTTP path too.
    await f.store.memberships.updateOne(
      { _id: "person-1-acme" },
      { $set: { status: "removed" } },
    );
    assert.equal(
      (await call("/api/agents", { token })).body.code,
      "BEARER_INVALID",
    );
    await f.store.memberships.updateOne(
      { _id: "person-1-acme" },
      { $set: { status: "active" } },
    );
    await f.store.tenantRegistry.updateOne(
      { _id: "acme" },
      { $set: { status: "disabled" } },
    );
    assert.notEqual((await call("/api/agents", { token })).status, 200);
    await f.store.tenantRegistry.updateOne(
      { _id: "acme" },
      { $set: { status: "active" } },
    );

    // Service principals authenticate but cannot use legacy routes yet.
    const iat = Math.floor(Date.now() / 1000) - 1;
    const svc = await new SignJWT({
      client_id: "robot-client",
      scope: "agent.read",
      [COHORT_CLAIM]: f.serviceCohort(),
    })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "at+jwt" })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject("robot-client")
      .setJti("s")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .sign(f.keyA.privateKey);
    const s = await call("/api/agents", { token: svc });
    assert.deepEqual(
      [s.status, s.body.code],
      [403, "SERVICE_PRINCIPAL_UNSUPPORTED"],
    );

    assert.ok(
      reached.every(
        (r) =>
          r.startsWith("GET /api/agents") ||
          r.startsWith("POST /api/projects") ||
          r.startsWith("GET /api/me"),
      ),
      `unexpected handler reach: ${reached.join(", ")}`,
    );
  } finally {
    await server.close();
    await f.stop();
  }

  // Bearer disabled (no issuers configured): header is refused, not ignored.
  const g = await fixture();
  const app2 = express();
  app2.use("/api", bearerGate(g.store, undefined));
  app2.use("/api", (_req, res) => res.json({ reached: true }));
  app2.use(
    (
      e: unknown,
      _q: express.Request,
      res: express.Response,
      _n: express.NextFunction,
    ) =>
      res
        .status((e as ApplicationError).status)
        .json({ code: (e as ApplicationError).code }),
  );
  const s2 = await serve(app2);
  try {
    const res = await fetch(s2.url + "/api/x", {
      headers: { authorization: "Bearer a.b.c" },
    });
    assert.equal(res.status, 401);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "BEARER_UNSUPPORTED",
    );
    assert.equal((await fetch(s2.url + "/api/x")).status, 200);
  } finally {
    await s2.close();
    await g.stop();
  }
});
