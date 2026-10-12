import test from "node:test";
import assert from "node:assert/strict";
import { startPlatform } from "./harness";
import { IdentityStore } from "../src/identity";
import { hashToken, sessionRecord } from "../src/auth";

const operator = {
  kind: "human",
  id: "operator",
  generation: "operator-g1",
} as const;
const issuer = "https://synthetic-broker.invalid/";
test("actual platform OIDC mode exposes login/account only and cannot dispatch unguarded enterprise operations", async (t) => {
  const h = await startPlatform({
    env: {
      AUTH_MODE: "oidc",
      OIDC_LOGIN_CONFIG: JSON.stringify({
        connectionId: "broker",
        issuer,
        authorizationEndpoint: `${issuer}authorize`,
        tokenEndpoint: `${issuer}token`,
        jwksUri: `${issuer}jwks`,
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      }),
    },
  });
  t.after(() => h.stop());
  const method = await h.request(undefined, "GET", "/auth/method");
  assert.equal(method.status, 200);
  assert.deepEqual(method.data, { kind: "oidc", href: "/auth/oidc/start" });
  assert.equal(method.headers.get("cache-control"), "no-store");
  const deniedCallback = await fetch(
    `${h.base}/auth/oidc/callback?state=wrong-state-0123456789&code=synthetic-code`,
    { redirect: "manual" },
  );
  assert.equal(deniedCallback.status, 302);
  assert.equal(
    deniedCallback.headers.get("location"),
    "http://localhost:3000/login?error=oidc_failed",
  );
  assert.equal(deniedCallback.headers.has("set-cookie"), false);
  const identity = new IdentityStore(h.store);
  const c = await identity.registerConnection(
    { _id: "broker", kind: "oidc", issuer },
    operator,
  );
  const p = await identity.createPrincipal("human", operator);
  await identity.principals.updateOne(
    { _id: p._id },
    { $set: { profile: { name: "Human Without Google" } } },
  );
  const principal = {
    kind: "human",
    id: p._id,
    generation: p.generation,
  } as const;
  const ext = await identity.linkExternal(
    { connectionId: c._id, subject: "opaque", principal },
    operator,
  );
  await h.store.tenantRegistry.insertOne({
    _id: "enterprise",
    dbName: "enterprise",
    name: "Enterprise",
    status: "active",
    authorizationGeneration: "tenant-g1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const b = await identity.bindTenant(principal, "enterprise", operator);
  const bound = sessionRecord({
    userId: p._id,
    tenantId: b.tenantId,
    app: "main",
    authorization: {
      version: 1,
      principalGeneration: p.generation,
      connectionId: c._id,
      connectionGeneration: c.generation,
      externalBindingId: ext._id,
      issuedAtMs: Date.now(),
      authenticatedAtMs: Date.now(),
      bindings: [
        {
          tenantId: b.tenantId,
          tenantGeneration: b.tenantGeneration,
          bindingId: b._id,
          bindingGeneration: b.generation,
          credentialGeneration: b.credentialGeneration,
        },
      ],
    },
  });
  await h.store.authSessions.insertOne(bound.document);
  const cookie = `truex_session=${bound.token}`;
  const mark = h.core.mark();
  const me = await h.request(cookie, "GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.auth, "oidc");
  assert.equal(me.data.selfService, false);
  assert.equal(me.data.user.name, "Human Without Google");
  assert.equal(me.data.user.email, "");
  for (const [method, path] of [
    ["GET", "/api/agents"],
    ["POST", "/api/conversations"],
    ["GET", "/api/models"],
    ["GET", "/api/conversations/x/events"],
    ["POST", "/api/conversations/x/turns"],
    ["POST", "/api/capabilities"],
  ]) {
    const result = await h.request(
      cookie,
      method,
      path,
      method === "POST" ? {} : undefined,
    );
    assert.equal(result.status, 503, path);
    assert.equal(result.data.code, "AUTHORIZATION_NOT_READY", path);
  }
  assert.deepEqual(
    h.core.since(mark),
    [],
    "no protected runtime call escaped the preparation gate",
  );
  const admin = await h.request(cookie, "POST", "/auth/admin/login", {
    password: "synthetic",
  });
  assert.equal(admin.status, 403);
  assert.equal(admin.data.code, "NAMED_OPERATOR_REQUIRED");
  assert.equal(
    (await h.request(cookie, "GET", "/auth/google/start")).status,
    404,
  );
  assert.equal(
    (await h.request(cookie, "GET", "/auth/workspaces")).status,
    404,
  );
  const old = sessionRecord({
    userId: p._id,
    tenantId: b.tenantId,
    app: "main",
  });
  await h.store.authSessions.insertOne(old.document);
  assert.equal(
    (await h.request(`truex_session=${old.token}`, "GET", "/auth/tenants"))
      .status,
    401,
    "generationless cookies cannot acquire enterprise authority",
  );
  const forged = await h.request(undefined, "GET", "/api/me", undefined, {
    headers: {
      "x-truex-user": p._id,
      "x-truex-role": "admin",
      "x-truex-tenant": b.tenantId,
    },
  });
  assert.equal(forged.status, 401);
  await h.store.authSessions.updateOne(
    { _id: hashToken(bound.token) },
    { $set: { tenantId: null } },
  );
  const selection = await h.request(cookie, "GET", "/api/me");
  assert.equal(selection.status, 409);
  assert.equal(selection.data.code, "TENANT_SELECTION_REQUIRED");
});
