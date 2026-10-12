import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { harness, barrier, operation, workerContext } from "./harness";
import type { PolicyChecker } from "../../src/policy-state";

// These allow/deny doubles exercise ordering only. Real-engine privacy and
// permission semantics are a separate mandatory POC, never inferred here.
const allow: PolicyChecker = {
  async check() {
    return true;
  },
};

test(
  "sensitive admission ordering on a three-member replica set",
  { timeout: 180_000 },
  async (t) => {
    const h = await harness(3);
    t.after(() => h.stop());

    await t.test(
      "publication rejects missing, human, expired and wrong-purpose workload authority",
      async () => {
        const s = await h.seed("worker-authority");
        const valid = workerContext("worker-authority", "projection");
        for (const context of [
          undefined,
          {
            ...valid,
            principal: { kind: "human", id: "operator-1", generation: "g1" },
          },
          {
            ...valid,
            credential: { ...valid.credential, expiresAtMs: Date.now() - 1 },
          },
          {
            ...valid,
            principal: {
              kind: "workload",
              id: "ingestion-1",
              generation: "g1",
              purpose: "ingestion",
            },
          },
        ])
          await assert.rejects(h.policy.publish(s.revision, context as any), {
            status: 403,
          });
      },
    );

    await t.test(
      "caller mutations during an engine check cannot change admitted identity, target or digest",
      async () => {
        const s = await h.seed("immutable");
        const checking = barrier();
        const release = barrier();
        const input = s.admit("original-send");
        const originalContext = structuredClone(input.context);
        const originalResource = structuredClone(input.resource);
        const originalDigest = input.payloadDigest;
        const pending = h.policy.admit(input, {
          async check({ context, resource, policy }) {
            assert.ok(Object.isFrozen(context));
            assert.ok(Object.isFrozen(context.credential.scopes));
            assert.ok(Object.isFrozen(resource));
            assert.ok(Object.isFrozen(policy));
            checking.resolve();
            await release.promise;
            return true;
          },
        });
        await checking.promise;
        input.context.principal.id = "different-person";
        input.resource.generation = "different-resource";
        input.operationId = "changed-send";
        input.payloadDigest = "f".repeat(64);
        release.resolve();
        const receipt = await pending;
        assert.deepEqual(receipt.principal, originalContext.principal);
        assert.deepEqual(receipt.resource, originalResource);
        assert.equal(receipt.operationId, "original-send");
        assert.equal(receipt.payloadDigest, originalDigest);
      },
    );

    await t.test(
      "stale engine allow obtained before revoke cannot admit after revoke commits",
      async () => {
        const s = await h.seed("ordered");
        const checking = barrier();
        const release = barrier();
        const request = h.policy.admit(s.admit("racing-send"), {
          async check() {
            checking.resolve();
            await release.promise;
            return true;
          },
        });
        // Install the rejection observer before the synchronized race.
        const rejected = assert.rejects(request, {
          status: 503,
          code: "POLICY_UNAVAILABLE",
        });
        await checking.promise;
        await s.revoke("remove-member");
        release.resolve();
        await rejected;
        assert.equal(
          await h.policy.admissions.countDocuments({ tenantId: "ordered" }),
          0,
        );
        assert.equal(
          await h.policy.audit.countDocuments({
            tenantId: "ordered",
            outcome: "admitted",
          }),
          0,
        );
      },
    );

    await t.test(
      "concurrent admissions serialize without rejecting harmless epoch changes",
      async () => {
        const s = await h.seed("concurrent");
        const before = await h.policy.states.findOne({ _id: "concurrent" });
        const receipts = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            h.policy.admit(s.admit(`send-${i}`), allow),
          ),
        );
        assert.equal(new Set(receipts.map((r) => r.id)).size, 10);
        assert.equal(
          await h.policy.admissions.countDocuments({ tenantId: "concurrent" }),
          10,
        );
        assert.equal(
          await h.policy.audit.countDocuments({
            tenantId: "concurrent",
            outcome: "admitted",
          }),
          10,
        );
        assert.equal(
          (await h.policy.states.findOne({ _id: "concurrent" }))!.epoch,
          before!.epoch + 10,
        );
      },
    );

    await t.test(
      "simultaneous grant and revoke cannot resurrect the removed binding",
      async () => {
        const s = await h.seed("grant-race");
        const [grant, revoke] = await Promise.all([
          h.policy.mutate({
            ...operation("grant-race", "add-agent"),
            fence: "pending",
            changes: [
              {
                kind: "create",
                entity: {
                  tenantId: "grant-race",
                  kind: "agent",
                  id: "agent-1",
                  generation: "g1",
                },
              },
            ],
          }),
          s.revoke("remove-member"),
        ]);
        const state = await h.policy.states.findOne({ _id: "grant-race" });
        assert.equal(
          state?.desired.revision,
          Math.max(grant.revision, revoke.revision),
        );
        const old = grant.revision < revoke.revision ? grant : revoke;
        assert.equal(await h.publish(old), false);
        assert.equal(await h.publish(state!.desired), true);
        assert.equal(
          (
            await h.policy.entities.findOne({
              tenantId: "grant-race",
              kind: "binding",
            })
          )?.status,
          "revoked",
        );
        await assert.rejects(
          h.policy.admit(s.admit("send-after-removal"), allow),
          { status: 403 },
        );
      },
    );

    await t.test(
      "duplicate operation has one receipt, changed request conflicts and dispatch consumes once",
      async () => {
        const s = await h.seed("idempotent");
        const receipts = await Promise.all(
          Array.from({ length: 5 }, () =>
            h.policy.admit(s.admit("same-send"), allow),
          ),
        );
        assert.equal(new Set(receipts.map((r) => r.id)).size, 1);
        assert.equal(
          await h.policy.admissions.countDocuments({ tenantId: "idempotent" }),
          1,
        );
        assert.equal(
          await h.policy.audit.countDocuments({
            tenantId: "idempotent",
            outcome: "admitted",
          }),
          1,
        );
        await assert.rejects(
          h.policy.admit(
            s.admit("same-send", { payloadDigest: "f".repeat(64) }),
            allow,
          ),
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
        await assert.rejects(
          h.policy.admit(
            s.admit("same-send", {
              context: {
                ...s.context,
                credential: {
                  ...s.context.credential,
                  id: "different-session",
                },
              },
            }),
            allow,
          ),
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
        const receipt = receipts[0];
        for (const changed of [
          { ...receipt, action: "conversation.delete" as const },
          {
            ...receipt,
            resource: { ...receipt.resource, id: "another-conversation" },
          },
          {
            ...receipt,
            principal: {
              ...receipt.principal,
              generation: "another-generation",
            },
          },
          {
            ...receipt,
            binding: { ...receipt.binding, id: "another-binding" },
          },
          { ...receipt, credentialId: "another-session" },
          {
            ...receipt,
            policy: { ...receipt.policy, namespace: "another-policy" },
          },
          { ...receipt, expiresAtMs: receipt.expiresAtMs + 60_000 },
        ])
          assert.equal(await h.policy.consume(changed), false);
        for (const invalid of [
          null,
          [],
          {},
          { ...receipt, id: { $exists: true } },
          { ...receipt, action: { $exists: true } },
          { ...receipt, resource: { ...receipt.resource, $ne: null } },
          { ...receipt, policy: { ...receipt.policy, revision: { $gt: 0 } } },
        ])
          assert.equal(await h.policy.consume(invalid as any), false);
        assert.deepEqual(
          (
            await Promise.all([
              h.policy.consume(receipts[0]),
              h.policy.consume(receipts[0]),
            ])
          ).sort(),
          [false, true],
        );
        await assert.rejects(h.policy.admit(s.admit("same-send"), allow), {
          status: 403,
        });
      },
    );

    await t.test(
      "stale principal, binding, tenant and resource generations deny even with engine allow",
      async () => {
        const s = await h.seed("generations");
        const contexts = [
          {
            ...s.context,
            principal: { ...s.context.principal, generation: "stale" },
          },
          {
            ...s.context,
            binding: { ...s.context.binding, generation: "stale" },
          },
          {
            ...s.context,
            tenant: { ...s.context.tenant, generation: "stale" },
          },
        ];
        for (const context of contexts)
          await assert.rejects(
            h.policy.admit(s.admit("invalid-generation", { context }), allow),
            { status: 403 },
          );
        await assert.rejects(
          h.policy.admit(
            s.admit("invalid-resource", {
              resource: { ...s.resource, generation: "stale" },
            }),
            allow,
          ),
          { status: 403 },
        );
        assert.equal(
          await h.policy.admissions.countDocuments({ tenantId: "generations" }),
          0,
        );
      },
    );

    await t.test(
      "audit/storage/engine failure and a hung checker do not admit or extend authority",
      async () => {
        const s = await h.seed("admission-fail");
        const before = await h.policy.states.findOne({ _id: "admission-fail" });
        for (const collection of [
          "authorization_policy_state",
          "authorization_admissions",
          "authorization_audit",
        ]) {
          await h.store.catalog.command({
            collMod: collection,
            validator: { neverPresent: { $exists: true } },
            validationAction: "error",
          });
          try {
            await assert.rejects(
              h.policy.admit(
                s.admit(`failure-${collection.replaceAll("_", "-")}`),
                allow,
              ),
            );
          } finally {
            await h.store.catalog.command({
              collMod: collection,
              validator: {},
            });
          }
          assert.deepEqual(
            await h.policy.states.findOne({ _id: "admission-fail" }),
            before,
          );
          assert.equal(
            await h.policy.admissions.countDocuments({
              tenantId: "admission-fail",
            }),
            0,
          );
          assert.equal(
            await h.policy.audit.countDocuments({
              tenantId: "admission-fail",
              outcome: "admitted",
            }),
            0,
          );
        }
        await assert.rejects(
          h.policy.admit(s.admit("engine-denies"), {
            async check() {
              return false;
            },
          }),
          { status: 403 },
        );
        await assert.rejects(
          h.policy.admit(s.admit("engine-malformed"), {
            async check() {
              return "true" as any;
            },
          }),
          { status: 403 },
        );
        await assert.rejects(
          h.policy.admit(s.admit("engine-down"), {
            async check() {
              throw new Error("dependency detail must stay internal");
            },
          }),
          { status: 503 },
        );
        const start = performance.now();
        await assert.rejects(
          h.policy.admit(s.admit("engine-hung"), {
            check() {
              return new Promise<boolean>(() => {});
            },
          }),
          { status: 503 },
        );
        assert.ok(
          performance.now() - start < 2500,
          "independent deadline bounds an uncooperative adapter",
        );
      },
    );

    await t.test(
      "lost commit response retries commit without duplicating receipt or audit",
      async () => {
        const s = await h.seed("commit-retry");
        // MongoDB's official convenient-transaction tests use failCommand with
        // closeConnection on commitTransaction to exercise unknown commit outcomes.
        await h.store.client.db("admin").command({
          configureFailPoint: "failCommand",
          mode: { times: 1 },
          data: {
            failCommands: ["commitTransaction"],
            closeConnection: true,
          },
        });
        let checks = 0;
        try {
          const receipt = await h.policy.admit(s.admit("send-once"), {
            async check() {
              checks++;
              return true;
            },
          });
          assert.ok(receipt.id);
        } finally {
          await h.store.client
            .db("admin")
            .command({ configureFailPoint: "failCommand", mode: "off" });
        }
        assert.equal(
          checks,
          1,
          "engine/remote effects are not retried inside the Mongo callback",
        );
        assert.equal(
          await h.policy.admissions.countDocuments({
            tenantId: "commit-retry",
          }),
          1,
        );
        assert.equal(
          await h.policy.audit.countDocuments({
            tenantId: "commit-retry",
            outcome: "admitted",
          }),
          1,
        );
      },
    );

    await t.test(
      "committed revoke survives primary failover and later admissions stay denied",
      async () => {
        const s = await h.seed("failover");
        const revision = await s.revoke("remove-before-failover");
        const hello = await h.store.client.db("admin").command({ hello: 1 });
        const primary = hello.primary as string;
        const direct = await new MongoClient(
          `mongodb://${primary}/?directConnection=true`,
          { serverSelectionTimeoutMS: 3000 },
        ).connect();
        try {
          await direct.db("admin").command({ replSetStepDown: 5, force: true });
        } catch (error) {
          if (
            !/connection|socket|not primary|stepped down/i.test(String(error))
          )
            throw error;
        } finally {
          await direct.close();
        }
        const deadline = Date.now() + 15_000;
        let newPrimary = primary;
        while (Date.now() < deadline) {
          const current = await h.store.client
            .db("admin")
            .command({ hello: 1 })
            .catch(() => null);
          if (current?.primary && current.primary !== primary) {
            newPrimary = current.primary;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.notEqual(
          newPrimary,
          primary,
          "a different replica must become primary",
        );
        assert.equal(
          (await h.policy.states.findOne({ _id: "failover" }))?.desired
            .namespace,
          revision.namespace,
        );
        await assert.rejects(
          h.policy.admit(s.admit("send-after-failover"), allow),
          { status: 503 },
        );
        assert.equal(await h.publish(revision), true);
        await assert.rejects(
          h.policy.admit(s.admit("send-after-publication"), allow),
          { status: 403 },
        );
        assert.equal(
          await h.policy.admissions.countDocuments({ tenantId: "failover" }),
          0,
        );
      },
    );
  },
);
