import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWK,
} from "jose";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import {
  RuntimeTransport,
  type RuntimeRequest,
} from "../src/runtime-transport";
import { POLICY_VERSION } from "../src/public";
import { currentUser, userContext } from "../src/user";
import { currentTenant, tenantContext } from "../src/tenant";
import { currentRequestId } from "../src/http";
import {
  requireAuthorizationContext,
  withAuthorizationContext,
} from "../src/authorization-context";
import {
  WorkloadStore,
  WorkloadAuthenticator,
  WORKLOAD_AUDIENCE,
  WORKLOAD_CLAIM,
  requireWorkerAction,
  requireLiveWorkerAction,
  requireWorkloadRuntimeScope,
} from "../src/workload-auth";
import {
  WORKLOAD_ACTIONS,
  type AuthorizationContext,
} from "../../shared/authorization";
import type { Session, DomainEvent } from "../../shared/contracts";

const issuer = "https://workload-authority.invalid/";
const actor = {
  kind: "human",
  id: "operator",
  generation: "operator-g1",
} as const;
const denied = { code: "WORKLOAD_CREDENTIAL_INVALID" };

async function fixture(t: TestContext) {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  let store: Store;
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "oidc";
  try {
    store = new Store(mongo.getUri(), "default_fixture", "catalog_fixture");
  } finally {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  }
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await store.connect();
  const registry = new WorkloadStore(store);
  await registry.ensureIndexes();
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk: JWK = {
    ...(await exportJWK(pair.publicKey)),
    alg: "ES256",
    kid: "worker-key",
    use: "sig",
  };
  const key = await registry.registerKey(issuer, jwk, actor);
  const worker = await registry.registerPrincipal("ingestion", actor);
  const ref = {
    kind: "workload",
    id: worker._id,
    generation: worker.generation,
    purpose: worker.purpose,
  } as const;
  const bindings = new Map<
    string,
    Awaited<ReturnType<typeof registry.bindTenant>>
  >();
  for (const id of ["alpha", "beta"]) {
    await store.tenantRegistry.insertOne({
      _id: id,
      name: id,
      dbName: `fixture_${id}`,
      status: "active",
      authorizationGeneration: `${id}-g1`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    bindings.set(
      id,
      await registry.bindTenant(ref, id, WORKLOAD_ACTIONS.ingestion, actor),
    );
  }
  const auth = new WorkloadAuthenticator(registry, { issuer, keys: [jwk] });
  // JWT NumericDate must be at/after the millisecond binding fence.
  await delay(1000 - (Date.now() % 1000) + 5);
  async function token(
    target = "alpha",
    changes: JWTPayload = {},
    header: Record<string, unknown> = {},
    claimChanges: Record<string, unknown> = {},
  ) {
    const b = bindings.get(target)!;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: issuer,
      sub: worker._id,
      aud: WORKLOAD_AUDIENCE,
      iat: now,
      exp: now + 120,
      jti: "fixture-jti",
      scope: WORKLOAD_ACTIONS.ingestion.join(" "),
      [WORKLOAD_CLAIM]: {
        purpose: "ingestion",
        tenant_id: target,
        tenant_generation: b.tenantGeneration,
        workload_generation: worker.generation,
        binding_id: b._id,
        binding_generation: b.generation,
        credential_generation: b.credentialGeneration,
        key_generation: key.generation,
        ...claimChanges,
      },
      ...changes,
    })
      .setProtectedHeader({
        alg: "ES256",
        kid: jwk.kid!,
        typ: "truex-workload+jwt",
        ...header,
      })
      .sign(pair.privateKey);
  }
  return {
    mongo,
    store,
    registry,
    worker,
    ref,
    bindings,
    auth,
    token,
    key,
    jwk,
    pair,
  };
}

test(
  "signed workload credentials enter isolated explicit scopes without inheriting browser/admin/default-tenant authority",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const credential = await f.token("alpha", { scope: "worker.records.read" });
    const verified = await f.auth.authenticate(
      credential,
      "ingestion",
      "alpha",
    );
    assert.deepEqual(verified.principal, f.ref);
    assert.deepEqual(verified.credential.scopes, ["worker.records.read"]);
    assert.equal(verified.credential.kind, "workload");
    assert.notEqual(verified.credential.id, credential);
    const outerUser = {
      id: "browser-admin",
      role: "admin",
      email: "admin@corp.invalid",
    } as const;
    await userContext.run(outerUser, () =>
      tenantContext.run({ id: "foreign", dbName: "foreign" }, async () => {
        await f.auth.run(credential, "ingestion", "alpha", async () => {
          await delay(5);
          assert.equal(currentUser(), undefined);
          assert.equal(currentTenant(), undefined);
          assert.equal(requireAuthorizationContext().tenant.id, "alpha");
          assert.equal(
            currentRequestId(),
            requireAuthorizationContext().requestId,
          );
          assert.throws(
            () => requireWorkerAction("ingestion", "worker.records.persist"),
            { code: "AUTHORIZATION_CONTEXT_DENIED" },
          );
          assert.throws(
            () => requireWorkloadRuntimeScope("/threads/chat/turns", "POST"),
            { code: "WORKLOAD_ACTION_DENIED" },
          );
        });
        assert.equal(currentUser(), outerUser);
        assert.equal(currentTenant()?.id, "foreign");
      }),
    );
    await Promise.all(
      ["alpha", "beta"].map(async (id) =>
        f.auth.run(await f.token(id), "ingestion", id, async () => {
          await delay(id === "alpha" ? 15 : 5);
          const tenant = await f.store.resolveTenant(id);
          f.store.withTenant(tenant, () =>
            assert.equal(f.store.db.databaseName, `fixture_${id}`),
          );
        }),
      ),
    );
    assert.throws(requireAuthorizationContext, {
      code: "AUTHORIZATION_CONTEXT_REQUIRED",
    });
    assert.equal(
      JSON.stringify(await f.registry.audit.find({}).toArray()).includes(
        credential,
      ),
      false,
    );
  },
);

test(
  "worker token purpose, signature, audience, lifetime, scope and exact cohorts fail closed",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    for (const changes of [
      { aud: "truex-public-api" },
      { aud: [WORKLOAD_AUDIENCE] },
      { iss: "https://other.invalid/" },
      { sub: "human" },
      { nonce: "id-token" },
      { client_id: "service-client" },
      { scope: "conversation.send" },
      { scope: "worker.records.read worker.records.read" },
      { scope: " worker.records.read" },
      { scope: "worker.records.read\nworker.records.ack" },
      { exp: Math.floor(Date.now() / 1000) + 600 },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { iat: Math.floor(Date.now() / 1000) + 10 },
      { iat: 1.5 },
    ])
      await assert.rejects(
        f.auth.authenticate(
          await f.token("alpha", changes),
          "ingestion",
          "alpha",
        ),
        denied,
      );
    for (const header of [
      { typ: "at+jwt" },
      { typ: "JWT" },
      { typ: "application/truex-workload+jwt" },
      { jku: "https://attacker.invalid/keys" },
      { kid: "unknown" },
    ])
      await assert.rejects(
        f.auth.authenticate(
          await f.token("alpha", {}, header),
          "ingestion",
          "alpha",
        ),
        denied,
      );
    for (const claim of [
      { tenant_id: "beta" },
      { purpose: "cleanup" },
      { tenant_generation: "old" },
      { workload_generation: "old" },
      { binding_id: "other" },
      { binding_generation: "old" },
      { credential_generation: "old" },
      { key_generation: "old" },
      { extra: "untrusted" },
    ])
      await assert.rejects(
        f.auth.authenticate(
          await f.token("alpha", {}, {}, claim),
          "ingestion",
          "alpha",
        ),
        denied,
      );
    const valid = await f.token();
    await assert.rejects(
      f.auth.authenticate(valid, "cleanup", "alpha"),
      denied,
    );
    await assert.rejects(
      f.auth.authenticate(valid, "ingestion", "beta"),
      denied,
    );
    await assert.rejects(
      f.auth.authenticate("Bearer " + valid, "ingestion", "alpha"),
      denied,
    );
    await assert.rejects(
      f.auth.authenticate("x".repeat(8193), "ingestion", "alpha"),
      denied,
    );
    const other = await generateKeyPair("ES256", { extractable: true });
    const swapped = {
      ...(await exportJWK(other.publicKey)),
      kid: f.jwk.kid!,
      alg: "ES256",
      use: "sig",
    };
    const badAuth = new WorkloadAuthenticator(f.registry, {
      issuer,
      keys: [swapped],
    });
    await assert.rejects(
      badAuth.authenticate(valid, "ingestion", "alpha"),
      denied,
    );
    // A legitimately signed replacement key with the same kid cannot use old trust.
    const body = JSON.parse(
      Buffer.from(valid.split(".")[1], "base64url").toString(),
    );
    const replacement = await new SignJWT(body)
      .setProtectedHeader({
        alg: "ES256",
        kid: f.jwk.kid!,
        typ: "truex-workload+jwt",
      })
      .sign(other.privateKey);
    await assert.rejects(
      badAuth.authenticate(replacement, "ingestion", "alpha"),
      denied,
    );
  },
);

test(
  "live workload, binding, key and tenant status/generations override an otherwise valid credential",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const raw = await f.token();
    const b = f.bindings.get("alpha")!;
    const mutations = [
      [
        f.registry.principals,
        f.worker._id,
        { generation: "old" },
        { generation: f.worker.generation },
      ],
      [
        f.registry.bindings,
        b._id,
        { credentialGeneration: "old" },
        { credentialGeneration: b.credentialGeneration },
      ],
      [
        f.registry.bindings,
        b._id,
        { notBeforeMs: Date.now() + 10000 },
        { notBeforeMs: b.notBeforeMs },
      ],
      [
        f.store.tenantRegistry,
        "alpha",
        { authorizationGeneration: "old" },
        { authorizationGeneration: "alpha-g1" },
      ],
      [
        f.store.tenantRegistry,
        "alpha",
        { status: "disabled" },
        { status: "active" },
      ],
    ] as const;
    for (const [collection, target, changed, restored] of mutations) {
      await collection.updateOne({ _id: target }, { $set: changed } as any);
      await assert.rejects(
        f.auth.authenticate(raw, "ingestion", "alpha"),
        denied,
      );
      await collection.updateOne({ _id: target }, { $set: restored } as any);
    }
    await f.registry.bindings.updateOne(
      { _id: b._id },
      { $set: { scopes: ["worker.records.read"] } },
    );
    assert.deepEqual(
      (await f.auth.authenticate(raw, "ingestion", "alpha")).credential.scopes,
      ["worker.records.read"],
    );
    await f.registry.bindings.updateOne(
      { _id: b._id },
      { $set: { scopes: b.scopes } },
    );
    assert.equal(await f.registry.revoke("binding", b._id, actor), true);
    assert.equal(await f.registry.revoke("binding", b._id, actor), false);
    await assert.rejects(
      f.auth.authenticate(raw, "ingestion", "alpha"),
      denied,
    );
    await f.auth.authenticate(await f.token("beta"), "ingestion", "beta");
    await f.registry.revoke("key", f.key._id, actor);
    await assert.rejects(
      f.auth.authenticate(await f.token("beta"), "ingestion", "beta"),
      denied,
    );
    await assert.rejects(f.registry.registerKey(issuer, f.jwk, actor), {
      code: "WORKLOAD_RECORD_CONFLICT",
    });
    assert.equal(
      await f.registry.audit.countDocuments({
        action: "workload.binding.revoke",
        targetId: b._id,
      }),
      1,
    );
  },
);

test(
  "mandatory workload mutation audit failure rolls back grants and revocation",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const raw = await f.token();
    const cleanup = await f.registry.registerPrincipal("cleanup", actor);
    const cleanupRef = {
      kind: "workload",
      id: cleanup._id,
      generation: cleanup.generation,
      purpose: cleanup.purpose,
    } as const;
    const count = await f.registry.principals.countDocuments();
    const bindingCount = await f.registry.bindings.countDocuments();
    const keyCount = await f.registry.keys.countDocuments();
    await f.store.catalog.command({
      collMod: "authorization_workload_audit",
      validator: { blocked_fixture_field: { $exists: true } },
      validationLevel: "strict",
      validationAction: "error",
    });
    await assert.rejects(f.registry.registerPrincipal("cleanup", actor));
    await assert.rejects(
      f.registry.bindTenant(cleanupRef, "alpha", ["worker.cleanup"], actor),
    );
    await assert.rejects(
      f.registry.registerKey(issuer, { ...f.jwk, kid: "another-key" }, actor),
    );
    assert.equal(await f.registry.bindings.countDocuments(), bindingCount);
    assert.equal(await f.registry.keys.countDocuments(), keyCount);
    assert.equal(await f.registry.principals.countDocuments(), count);
    await assert.rejects(f.registry.revoke("principal", f.worker._id, actor));
    await f.auth.authenticate(raw, "ingestion", "alpha");
    await f.store.catalog.command({
      collMod: "authorization_workload_audit",
      validator: {},
    });
    await f.registry.revoke("principal", f.worker._id, actor);
    await assert.rejects(
      f.auth.authenticate(raw, "ingestion", "alpha"),
      denied,
    );
    await f.registry.revoke("principal", f.worker._id, actor);
    assert.equal(
      await f.registry.audit.countDocuments({
        action: "workload.principal.revoke",
      }),
      1,
    );
  },
);

test(
  "workload configuration rejects private keys, foreign purposes and scope widening before any write",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    for (const keys of [
      [],
      [f.jwk, f.jwk],
      [{ ...f.jwk, d: "private" }],
      [{ ...f.jwk, alg: "HS256" }],
    ])
      assert.throws(
        () => new WorkloadAuthenticator(f.registry, { issuer, keys }),
      );
    assert.throws(
      () =>
        new WorkloadAuthenticator(f.registry, {
          issuer: "http://authority.invalid/",
          keys: [f.jwk],
        }),
    );
    await assert.rejects(
      f.registry.registerPrincipal("runtime" as any, actor),
      { code: "INVALID_WORKLOAD_INPUT" },
    );
    await assert.rejects(
      f.registry.bindTenant(f.ref, "alpha", ["conversation.send"], actor),
      { code: "INVALID_WORKLOAD_INPUT" },
    );
    await assert.rejects(f.registry.registerPrincipal("cleanup", f.ref), {
      code: "INVALID_WORKLOAD_INPUT",
    });
    const human: AuthorizationContext = {
      ...(await f.auth.authenticate(await f.token(), "ingestion", "alpha")),
      principal: actor,
      credential: {
        kind: "session",
        id: "human-cookie",
        issuedAtMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 60000,
        scopes: ["worker.records.persist"],
      },
    };
    withAuthorizationContext(human, () =>
      assert.throws(
        () => requireWorkerAction("ingestion", "worker.records.persist"),
        { code: "WORKLOAD_ACTION_DENIED" },
      ),
    );
  },
);

test(
  "enterprise polling uses authenticated tenant workers, persists before ack and cannot dispatch new turns",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const calls: string[] = [];
    let malformed = false;
    let failPersist = true;
    let persisted = 0;
    const event = (threadId: string): DomainEvent => ({
      type: "message.final",
      threadId,
      seq: 1,
      cursor: "g:1",
      at: new Date().toISOString(),
      turnId: "turn",
      itemId: "item",
      data: { text: "accepted answer", messageIndex: 0 },
    });
    const transport = new RuntimeTransport();
    t.mock.method(transport, "request", async (r: RuntimeRequest) => {
      const ctx = requireAuthorizationContext();
      assert.equal(ctx.principal.kind, "workload");
      assert.equal(currentUser(), undefined);
      calls.push(`${ctx.tenant.id}:${r.path}`);
      assert.equal(r.requestId, ctx.requestId);
      if (r.path.endsWith("/records/ack")) {
        assert.ok(persisted > 0);
        return Response.json({ ok: true });
      }
      assert.ok(r.path.endsWith("/records"));
      return Response.json([
        {
          key: "record.json",
          event: event(
            malformed ? "foreign-thread" : `thread_${ctx.tenant.id}`,
          ),
        },
      ]);
    });
    const service = new PlatformService(
      f.store,
      ["http://fixture-core"],
      undefined,
      transport,
    );
    t.after(() => service.stop());
    await assert.rejects(service.poll(), {
      code: "WORKLOAD_AUTH_NOT_CONFIGURED",
    });
    // Fixture admission checks only. Receiver-side runtime authentication and
    // relationship/admission ordering are separate A07/A10 proofs, still gated.
    await f.auth.run(await f.token(), "ingestion", "alpha", async () => {
      await assert.rejects(
        service.call("http://fixture-core", "/threads/thread_alpha/records"),
        { code: "AUTHORIZATION_TENANT_CONTEXT_DENIED" },
      );
      const tenant = await f.store.resolveTenant("alpha");
      await f.store.withTenant(tenant, async () => {
        await assert.rejects(
          service.call("http://fixture-core", "/threads/thread_alpha/records"),
          { code: "AUTHORIZATION_NOT_READY" },
        );
      });
    });
    assert.equal(calls.length, 0);
    service.dispatchGuard = async () => {
      requireWorkerAction("ingestion", "worker.records.read");
    };
    service.ingestionWorkload = {
      authenticator: f.auth,
      credential: async (tenant) => f.token(tenant.id),
    };
    const sessions: Session[] = [];
    for (const id of ["alpha", "beta"]) {
      const s: Session = {
        _id: `session_${id}`,
        agentId: "agent",
        threadId: `thread_${id}`,
        agentCoreHost: "http://fixture-core",
        status: "active",
        cwd: "/fixture",
        createdAt: new Date().toISOString(),
        runtimePolicyVersion: POLICY_VERSION,
      };
      sessions.push(s);
      await f.auth.run(await f.token(id), "ingestion", id, async () => {
        const tenant = await f.store.resolveTenant(id);
        await f.store.withTenant(tenant, () => f.store.indexesReady());
      });
      await f.store.client
        .db(`fixture_${id}`)
        .collection<Session>("sessions")
        .insertOne(s);
    }
    const persist = f.store.persist.bind(f.store);
    t.mock.method(f.store, "persist", async (id: string, e: DomainEvent) => {
      if (failPersist) throw new Error("fixture persistence unavailable");
      await persist(id, e);
      persisted++;
    });
    await service.poll();
    assert.equal(
      calls.some((p) => p.endsWith("/records/ack")),
      false,
    );
    failPersist = false;
    await service.poll();
    assert.equal(calls.filter((p) => p.endsWith("/records/ack")).length, 2);
    for (const id of ["alpha", "beta"])
      assert.equal(
        await f.store.client
          .db(`fixture_${id}`)
          .collection("messages")
          .countDocuments(),
        1,
      );
    await f.auth.run(await f.token(), "ingestion", "alpha", async () => {
      const tenant = await f.store.resolveTenant("alpha");
      await f.store.withTenant(tenant, async () => {
        const before = calls.length;
        await assert.rejects(
          service.call(
            "http://fixture-core",
            "/threads/thread_alpha/turns",
            "POST",
            { text: "new turn" },
          ),
          { code: "WORKLOAD_ACTION_DENIED" },
        );
        await assert.rejects(service.ingest(sessions[1]), {
          code: "WORKLOAD_ACTION_DENIED",
        });
        assert.equal(calls.length, before);
        malformed = true;
        await assert.rejects(service.ingest(sessions[0]), {
          code: "WORKLOAD_RECORDS_INVALID",
        });
        assert.equal(calls.filter((p) => p.endsWith("/records/ack")).length, 2);
      });
    });
    const beforeExpiry = calls.length;
    const exp = Math.floor(Date.now() / 1000) + 2;
    service.dispatchGuard = async () => {
      await delay(
        requireAuthorizationContext().credential.expiresAtMs - Date.now() + 15,
      );
    };
    await f.auth.run(
      await f.token("alpha", { exp }),
      "ingestion",
      "alpha",
      async () => {
        const tenant = await f.store.resolveTenant("alpha");
        await f.store.withTenant(tenant, async () => {
          await assert.rejects(
            service.call(
              "http://fixture-core",
              "/threads/thread_alpha/records",
            ),
            { code: "AUTHORIZATION_CREDENTIAL_EXPIRED" },
          );
        });
      },
    );
    assert.equal(calls.length, beforeExpiry);
  },
);

test(
  "all bounded worker purposes authenticate, and live scope checks reject revocation and copied contexts",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const cases = [];
    for (const p of ["projection", "reconciliation", "cleanup"] as const) {
      const worker = await f.registry.registerPrincipal(p, actor);
      const binding = await f.registry.bindTenant(
        {
          kind: "workload",
          id: worker._id,
          generation: worker.generation,
          purpose: p,
        },
        "alpha",
        WORKLOAD_ACTIONS[p],
        actor,
      );
      cases.push({ p, worker, binding });
    }
    await delay(1000 - (Date.now() % 1000) + 5);
    for (const { p, worker, binding } of cases) {
      const raw = await f.token(
        "alpha",
        { sub: worker._id, scope: WORKLOAD_ACTIONS[p].join(" ") },
        {},
        {
          purpose: p,
          workload_generation: worker.generation,
          binding_id: binding._id,
          binding_generation: binding.generation,
          credential_generation: binding.credentialGeneration,
        },
      );
      const verified = await f.auth.authenticate(raw, p, "alpha");
      await withAuthorizationContext(verified, async () => {
        await assert.rejects(
          requireLiveWorkerAction(p, WORKLOAD_ACTIONS[p][0]),
          { code: "WORKLOAD_CONTEXT_REQUIRED" },
        );
      });
      await f.auth.run(raw, p, "alpha", async () => {
        assert.equal(
          (await requireLiveWorkerAction(p, WORKLOAD_ACTIONS[p][0])).principal
            .id,
          worker._id,
        );
        await f.registry.revoke("binding", binding._id, actor);
        // The immutable mechanical scope is insufficient after live revocation.
        requireWorkerAction(p, WORKLOAD_ACTIONS[p][0]);
        await assert.rejects(
          requireLiveWorkerAction(p, WORKLOAD_ACTIONS[p][0]),
          denied,
        );
      });
    }
    const raw = await f.token();
    await f.auth.run(raw, "ingestion", "alpha", async () => {
      await f.registry.bindings.updateOne(
        { _id: f.bindings.get("alpha")!._id },
        { $set: { scopes: ["worker.records.read"] } },
      );
      await assert.rejects(
        requireLiveWorkerAction("ingestion", "worker.records.persist"),
        { code: "WORKLOAD_ACTION_DENIED" },
      );
      await requireLiveWorkerAction("ingestion", "worker.records.read");
      await f.registry.revoke("key", f.key._id, actor);
      await assert.rejects(
        requireLiveWorkerAction("ingestion", "worker.records.read"),
        denied,
      );
    });
  },
);
