import assert from "node:assert/strict";
import test from "node:test";
import {
  IdentityStore,
  type CredentialCohort,
  type IdentityTenantBinding,
  type IdentityConnection,
} from "../../src/identity";
import { backfillGoogleIdentities } from "../../src/identity-migration";
import { emailKey } from "../../src/auth";
import { harness } from "./harness";
import { spawn } from "node:child_process";
import { testEnvironment } from "../environment";
const actor = {
  kind: "human",
  id: "operator",
  generation: "operator-g1",
} as const;
const issuer = "https://broker.example";
const cohort = (
  b: IdentityTenantBinding,
  c: IdentityConnection,
  extras: Partial<CredentialCohort> = {},
): CredentialCohort => ({
  principalGeneration: b.principal.generation,
  bindingGeneration: b.generation,
  tenantGeneration: b.tenantGeneration,
  credentialGeneration: b.credentialGeneration,
  connectionGeneration: c.generation,
  issuedAtMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  ...extras,
});

test(
  "canonical identities preserve privacy of identity mapping and fresh lifecycle generations",
  { timeout: 120_000 },
  async (t) => {
    const h = await harness();
    t.after(() => h.stop());
    const s = new IdentityStore(h.store);
    await s.ensureIndexes();
    for (const id of ["identity-a", "identity-b"])
      await h.store.tenantRegistry.insertOne({
        _id: id,
        name: id,
        dbName: `truex_${id.replaceAll("-", "_")}`,
        status: "active",
        authorizationGeneration: `${id}-g1`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    const c = await s.registerConnection(
      { _id: "broker", kind: "oidc", issuer },
      actor,
    );
    const person = await s.createPrincipal("human", actor, "stable-person");
    const p = {
      kind: person.kind,
      id: person._id,
      generation: person.generation,
    };
    const external = await s.linkExternal(
      { connectionId: c._id, subject: "external-person", principal: p },
      actor,
    );
    const a = await s.bindTenant(p, "identity-a", actor);
    const b = await s.bindTenant(p, "identity-b", actor);
    const credential = (
      binding: IdentityTenantBinding,
      extras: Partial<CredentialCohort> = {},
    ) => ({
      connectionId: c._id,
      verifiedIssuer: issuer,
      principal: p,
      tenantId: binding.tenantId,
      bindingId: binding._id,
      cohort: cohort(binding, c, {
        externalBindingId: external._id,
        ...extras,
      }),
    });
    await t.test(
      "issuer/subject bindings are exact and never merged by an email-like subject",
      async () => {
        assert.equal(
          (await s.resolveHuman(c._id, issuer, "external-person")).principal.id,
          person._id,
        );
        await assert.rejects(
          s.resolveHuman(c._id, issuer + "/", "external-person"),
          { status: 401 },
        );
        await assert.rejects(
          s.resolveHuman(c._id, issuer, "person@company.example"),
          { status: 401 },
        );
        const other = await s.createPrincipal("human", actor);
        await assert.rejects(
          s.linkExternal(
            {
              connectionId: c._id,
              subject: "external-person",
              principal: {
                kind: other.kind,
                id: other._id,
                generation: other.generation,
              },
            },
            actor,
          ),
          { status: 409 },
        );
        const second = await s.registerConnection(
          {
            _id: "other-broker",
            kind: "oidc",
            issuer: "https://other.example",
          },
          actor,
        );
        await s.linkExternal(
          {
            connectionId: second._id,
            subject: "external-person",
            principal: {
              kind: other.kind,
              id: other._id,
              generation: other.generation,
            },
          },
          actor,
        );
        assert.equal(
          (await s.resolveHuman(second._id, second.issuer, "external-person"))
            .principal.id,
          other._id,
        );
        assert.equal(
          emailKey("a.b+tag@company.example"),
          "a.b+tag@company.example",
        );
      },
    );
    await t.test(
      "missing generations, query operators, expired and cross-tenant credentials deny",
      async () => {
        await s.validateCredential(credential(a));
        for (const changes of [
          { bindingGeneration: undefined },
          { principalGeneration: "old" },
          { credentialGeneration: "old" },
          { connectionGeneration: "old" },
          { tenantGeneration: "old" },
          { externalBindingId: "missing" },
          { issuedAtMs: 0 },
          { issuedAtMs: Date.now() + 100_000 },
          { expiresAtMs: Date.now() },
          { bindingGeneration: { $exists: true } },
        ])
          await assert.rejects(
            s.validateCredential(credential(a, changes as any)),
            { status: 401 },
          );
        await assert.rejects(
          s.validateCredential({ ...credential(a), tenantId: b.tenantId }),
          { status: 401 },
        );
        await assert.rejects(
          s.validateCredential({
            ...credential(a),
            principal: { ...p, id: { $ne: null } } as any,
          }),
          { status: 401 },
        );
      },
    );
    await t.test(
      "corrupt lifecycle counters and issuance cutoffs never authenticate",
      async () => {
        const original = (await s.tenantBindings.findOne({ _id: a._id }))!;
        try {
          for (const bad of [
            { epoch: 0 },
            { epoch: -1 },
            { epoch: Number.NaN },
            { epoch: "1" },
            { notBeforeMs: -1 },
            { notBeforeMs: { $exists: true } },
          ]) {
            await s.tenantBindings.replaceOne({ _id: a._id }, {
              ...original,
              ...bad,
            } as any);
            await assert.rejects(s.validateCredential(credential(a)), {
              status: 401,
            });
            if ("epoch" in bad)
              await assert.rejects(
                s.removeBinding(a._id, a.generation, actor),
                { status: 409 },
              );
          }
        } finally {
          await s.tenantBindings.replaceOne({ _id: a._id }, original);
        }
        await s.validateCredential(credential(a));
      },
    );
    await t.test(
      "removal is idempotent, rehire rotates both cohorts, unrelated tenant survives",
      async () => {
        const old = credential(a);
        await s.removeBinding(a._id, a.generation, actor);
        await s.removeBinding(a._id, a.generation, actor);
        assert.equal(
          await s.tombstones.countDocuments({ bindingId: a._id }),
          1,
        );
        assert.equal(
          await s.audit.countDocuments({
            action: "binding.remove",
            targetId: a._id,
          }),
          1,
        );
        await assert.rejects(s.validateCredential(old), { status: 401 });
        await s.validateCredential(credential(b));
        const fresh = await s.bindTenant(p, a.tenantId, actor);
        assert.notEqual(fresh.generation, a.generation);
        assert.notEqual(fresh.credentialGeneration, a.credentialGeneration);
        // Even a freshly issued timestamp cannot upgrade an old token's cohort.
        await assert.rejects(
          s.validateCredential({
            ...old,
            cohort: { ...old.cohort, issuedAtMs: Date.now() },
          }),
          { status: 401 },
        );
        await s.validateCredential(credential(fresh));
        await assert.rejects(s.removeBinding(fresh._id, a.generation, actor), {
          status: 409,
        });
        assert.equal(
          await s.tombstones.countDocuments({ bindingId: a._id }),
          1,
        );
      },
    );
    await t.test(
      "concurrent new bindings converge to one generation and audit event",
      async () => {
        const n = await s.createPrincipal("service", actor);
        const pr = { kind: n.kind, id: n._id, generation: n.generation };
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            s.bindTenant(pr, "identity-a", actor),
          ),
        );
        assert.equal(new Set(results.map((r) => r.generation)).size, 1);
        assert.equal(
          await s.audit.countDocuments({
            action: "binding.create",
            targetId: results[0]._id,
          }),
          1,
        );
      },
    );
    await t.test(
      "service clients need registered exact issuer/client/tenant/cohort and no fake Google identity",
      async () => {
        const n = await s.createPrincipal("service", actor);
        const pr = { kind: n.kind, id: n._id, generation: n.generation };
        const binding = await s.bindTenant(pr, "identity-a", actor);
        const client = await s.registerClient(
          {
            connectionId: c._id,
            clientId: "machine-client",
            bindingId: binding._id,
          },
          actor,
        );
        assert.equal(await h.store.users.countDocuments({ _id: n._id }), 0);
        const request = {
          connectionId: c._id,
          verifiedIssuer: issuer,
          principal: pr,
          tenantId: binding.tenantId,
          bindingId: binding._id,
          clientId: client.clientId,
          cohort: cohort(binding, c, { clientGeneration: client.generation }),
        };
        await s.validateCredential(request);
        await assert.rejects(
          s.validateCredential({ ...request, clientId: "unregistered" }),
          { status: 401 },
        );
        await assert.rejects(
          s.validateCredential({
            ...request,
            cohort: { ...request.cohort, clientGeneration: undefined },
          }),
          { status: 401 },
        );
        await s.disablePrincipal(n._id, n.generation, actor);
        await assert.rejects(s.validateCredential(request), { status: 401 });
        await assert.rejects(s.createPrincipal("service", actor, n._id), {
          status: 409,
        });
      },
    );
    await t.test(
      "mandatory audit failure rolls back both removal and tombstone",
      async () => {
        const current = (await s.tenantBindings.findOne({ _id: b._id }))!;
        await h.store.catalog.command({
          collMod: "identity_audit",
          validator: { action: { $ne: "binding.remove" } },
          validationLevel: "strict",
          validationAction: "error",
        });
        try {
          await assert.rejects(
            s.removeBinding(current._id, current.generation, actor),
          );
        } finally {
          await h.store.catalog.command({
            collMod: "identity_audit",
            validator: {},
          });
        }
        assert.equal(
          (await s.tenantBindings.findOne({ _id: current._id }))!.status,
          "active",
        );
        assert.equal(
          await s.tombstones.countDocuments({ bindingId: current._id }),
          0,
        );
        await s.validateCredential(credential(b));
      },
    );
    await t.test(
      "tenant-scoped trust cannot register clients or credentials in another tenant",
      async () => {
        const conn = await s.registerConnection(
          {
            _id: "tenant-connection",
            kind: "oidc",
            issuer,
            tenantId: "identity-a",
          },
          actor,
        );
        const n = await s.createPrincipal("service", actor);
        const binding = await s.bindTenant(
          { kind: n.kind, id: n._id, generation: n.generation },
          "identity-b",
          actor,
        );
        await assert.rejects(
          s.registerClient(
            {
              connectionId: conn._id,
              clientId: "scoped-client",
              bindingId: binding._id,
            },
            actor,
          ),
          { status: 401 },
        );
        await assert.rejects(
          s.validateCredential({
            ...credential(b),
            connectionId: conn._id,
            cohort: {
              ...credential(b).cohort,
              connectionGeneration: conn.generation,
            },
          }),
          { status: 401 },
        );
      },
    );
    await t.test(
      "connection disable and revoked identity stop previously valid credentials",
      async () => {
        const request = credential(b);
        await s.externalBindings.updateOne(
          { _id: external._id },
          { $set: { status: "revoked" } },
        );
        await assert.rejects(s.validateCredential(request), { status: 401 });
        await s.externalBindings.updateOne(
          { _id: external._id },
          { $set: { status: "active" } },
        );
        await s.disableConnection(c._id, c.generation, actor);
        await assert.rejects(s.validateCredential(request), { status: 401 });
        await assert.rejects(s.resolveHuman(c._id, issuer, "external-person"), {
          status: 401,
        });
      },
    );
  },
);

test(
  "Google expansion backfill is repeatable, additive and refuses identity collisions",
  { timeout: 120_000 },
  async (t) => {
    const h = await harness();
    t.after(() => h.stop());
    const s = new IdentityStore(h.store);
    await s.ensureIndexes();
    const c = await s.registerConnection(
      { _id: "google", kind: "google", issuer: "https://accounts.google.com" },
      actor,
    );
    await h.store.tenantRegistry.insertOne({
      _id: "migration-tenant",
      name: "migration",
      dbName: "truex_migration",
      status: "active",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    for (const [id, status, mstatus] of [
      ["old-person", "active", "active"],
      ["removed-person", "active", "removed"],
      ["disabled-person", "disabled", "active"],
    ] as const) {
      await h.store.users.insertOne({
        _id: id,
        googleSub: `sub-${id}`,
        email: `${id}@company.example`,
        emailKey: `${id}@company.example`,
        status,
        createdAt: "2026-01-01",
      });
      await h.store.memberships.insertOne({
        _id: `${id}-membership`,
        userId: id,
        tenantId: "migration-tenant",
        status: mstatus,
        role: "user",
        createdAt: "2026-01-01",
      });
    }
    await h.store.authSessions.insertOne({
      _id: "old-session",
      userId: "old-person",
      tenantId: "migration-tenant",
      app: "main",
      createdAt: new Date(),
      lastSeenAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    });
    await t.test(
      "dry run reads only, repeat reports match, stable IDs and original session survive apply",
      async () => {
        const oldUsers = await h.store.users
          .find({})
          .sort({ _id: 1 })
          .toArray();
        const session = await h.store.authSessions.findOne({
          _id: "old-session",
        });
        const audit = await s.audit.countDocuments({});
        const first = await backfillGoogleIdentities(s, c._id);
        assert.deepEqual(first, await backfillGoogleIdentities(s, c._id));
        assert.equal(first.ready, 3);
        assert.equal(first.issueCount, 0);
        assert.equal(await s.principals.countDocuments({}), 0);
        assert.deepEqual(
          await h.store.users.find({}).sort({ _id: 1 }).toArray(),
          oldUsers,
        );
        assert.equal(await s.audit.countDocuments({}), audit);
        await assert.rejects(backfillGoogleIdentities(s, c._id, true), {
          code: "NAMED_MIGRATION_ACTOR_REQUIRED",
        });
        const applied = await backfillGoogleIdentities(s, c._id, true, actor);
        assert.equal(applied.migrated, 3);
        assert.equal(applied.issueCount, 0);
        const again = await backfillGoogleIdentities(s, c._id, true, actor);
        assert.equal(again.verified, 3);
        assert.equal(again.migrated, 0);
        assert.deepEqual(
          await h.store.authSessions.findOne({ _id: "old-session" }),
          session,
        );
        assert.equal(await s.principals.countDocuments({}), 3);
        assert.equal(
          (await s.resolveHuman(c._id, c.issuer, "sub-old-person")).principal
            .id,
          "old-person",
        );
        await assert.rejects(
          s.resolveHuman(c._id, c.issuer, "sub-disabled-person"),
          { status: 401 },
        );
        const removed = (await s.tenantBindings.findOne({
          "principal.id": "removed-person",
        }))!;
        assert.equal(removed.status, "removed");
        assert.equal(
          await s.tombstones.countDocuments({ bindingId: removed._id }),
          1,
        );
        assert.equal(
          (await h.store.users.indexes()).find((r) => r.name === "googleSub_1")
            ?.unique,
          true,
        );
      },
    );
    await t.test(
      "legacy drift is reported rather than automatically reopening a removed generation",
      async () => {
        await h.store.memberships.updateOne(
          { userId: "removed-person" },
          { $set: { status: "active" } },
        );
        const r = await backfillGoogleIdentities(s, c._id, true, actor);
        assert.equal(r.issueCount, 1);
        assert.equal(r.issues[0].code, "MEMBERSHIP_BINDING_CONFLICT");
        assert.equal(
          (await s.tenantBindings.findOne({
            "principal.id": "removed-person",
          }))!.status,
          "removed",
        );
        await h.store.memberships.updateOne(
          { userId: "removed-person" },
          { $set: { status: "removed" } },
        );
      },
    );
    await t.test(
      "mixed schema reads reject legacy disable/removal and fresh canonical rehire updates legacy generation",
      async () => {
        const human = await s.resolveHuman(c._id, c.issuer, "sub-old-person");
        const binding = (await s.tenantBindings.findOne({
          "principal.id": "old-person",
        }))!;
        const request = {
          connectionId: c._id,
          verifiedIssuer: c.issuer,
          principal: human.principal,
          tenantId: binding.tenantId,
          bindingId: binding._id,
          cohort: cohort(binding, c, {
            externalBindingId: human.externalBindingId,
          }),
        };
        await s.validateCredential(request);
        await h.store.users.updateOne(
          { _id: "old-person" },
          { $set: { status: "disabled" } },
        );
        await assert.rejects(s.validateCredential(request), {
          status: 401,
        });
        await h.store.users.updateOne(
          { _id: "old-person" },
          { $set: { status: "active" } },
        );
        await h.store.memberships.updateOne(
          { _id: "old-person-membership" },
          { $set: { status: "removed" } },
        );
        await assert.rejects(s.validateCredential(request), {
          status: 401,
        });
        // Restore the fixture, then exercise the canonical transactional lifecycle.
        await h.store.memberships.updateOne(
          { _id: "old-person-membership" },
          { $set: { status: "active" } },
        );
        await s.removeBinding(binding._id, binding.generation, actor);
        assert.equal(
          (await h.store.memberships.findOne({
            _id: "old-person-membership",
          }))!.status,
          "removed",
        );
        const fresh = await s.bindTenant(
          human.principal,
          binding.tenantId,
          actor,
        );
        assert.equal(
          (await h.store.memberships.findOne({
            _id: "old-person-membership",
          }))!.authorizationGeneration,
          fresh.generation,
        );
        await assert.rejects(s.validateCredential(request), {
          status: 401,
        });
        await s.validateCredential({
          ...request,
          cohort: cohort(fresh, c, {
            externalBindingId: human.externalBindingId,
          }),
        });
        assert.equal((await backfillGoogleIdentities(s, c._id)).issueCount, 0);
      },
    );
    await t.test(
      "the real CLI defaults to dry run and needs explicit catalog, connection and named apply actor",
      async () => {
        const run = (args: string[], named = false) =>
          new Promise<{
            code: number | null;
            stdout: string;
            stderr: string;
          }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                "scripts/authz-identity-backfill.ts",
                ...args,
              ],
              {
                env: testEnvironment({
                  AUTHZ_MIGRATION_MONGO_URI: h.mongo.getUri(),
                  ...(named
                    ? {
                        AUTHZ_MIGRATION_ACTOR_ID: actor.id,
                        AUTHZ_MIGRATION_ACTOR_GENERATION: actor.generation,
                      }
                    : {}),
                }),
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "",
              stderr = "";
            const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
            child.stdout.on("data", (d) => {
              stdout += d;
            });
            child.stderr.on("data", (d) => {
              stderr += d;
            });
            child.on("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve({ code, stdout, stderr });
            });
          });
        const auditBefore = await s.audit.countDocuments({});
        const result = await run([h.store.catalogDatabase, c._id]);
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).mode, "dry-run");
        assert.equal(await s.audit.countDocuments({}), auditBefore);
        assert.equal(
          (await run([h.store.catalogDatabase, c._id, "--apply"])).code,
          1,
        );
        const apply = await run(
          [h.store.catalogDatabase, c._id, "--apply"],
          true,
        );
        assert.equal(apply.code, 0);
        assert.equal(JSON.parse(apply.stdout).verified, 3);
        assert.equal(apply.stderr, "");
      },
    );
    await t.test(
      "conflicting subject and malformed legacy records are bounded ID/code reports",
      async () => {
        // Deliberately remove the legacy uniqueness protection to inspect a
        // corrupted database; the migration tool must still reject both rows.
        await h.store.users.dropIndex("googleSub_1");
        await h.store.users.insertOne({
          _id: "collision-person",
          googleSub: "sub-old-person",
          email: "different@company.example",
          emailKey: "different@company.example",
          status: "active",
          createdAt: "2026-01-01",
        });
        const r = await backfillGoogleIdentities(s, c._id);
        assert.equal(r.issueCount, 2);
        assert.ok(r.issues.every((i) => i.code === "DUPLICATE_GOOGLE_SUBJECT"));
        assert.equal(JSON.stringify(r).includes("@company.example"), false);
        await h.store.users.deleteOne({ _id: "collision-person" });
        await h.store.users.createIndex({ googleSub: 1 }, { unique: true });
      },
    );
    await t.test(
      "failure during audit rolls back principal, subject, user and membership stamps",
      async () => {
        await h.store.users.insertOne({
          _id: "rollback-person",
          googleSub: "sub-rollback",
          email: "rollback@company.example",
          emailKey: "rollback@company.example",
          status: "active",
          createdAt: "2026-01-01",
        });
        await h.store.memberships.insertOne({
          _id: "rollback-membership",
          userId: "rollback-person",
          tenantId: "migration-tenant",
          status: "active",
          role: "user",
          createdAt: "2026-01-01",
        });
        await h.store.catalog.command({
          collMod: "identity_audit",
          validator: { targetId: { $ne: "rollback-person" } },
          validationLevel: "strict",
          validationAction: "error",
        });
        try {
          await assert.rejects(backfillGoogleIdentities(s, c._id, true, actor));
        } finally {
          await h.store.catalog.command({
            collMod: "identity_audit",
            validator: {},
          });
        }
        assert.equal(
          await s.principals.countDocuments({ _id: "rollback-person" }),
          0,
        );
        assert.equal(
          await s.externalBindings.countDocuments({ subject: "sub-rollback" }),
          0,
        );
        assert.equal(
          (await h.store.users.findOne({ _id: "rollback-person" }))!
            .authorizationGeneration,
          undefined,
        );
        assert.equal(
          (await h.store.memberships.findOne({ _id: "rollback-membership" }))!
            .authorizationGeneration,
          undefined,
        );
      },
    );
  },
);
