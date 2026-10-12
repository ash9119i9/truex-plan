import assert from "node:assert/strict";
import test from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../../src/store";
import { PolicyStateStore } from "../../src/policy-state";
import { harness, operation } from "./harness";

test(
  "authoritative policy publication and audit",
  { timeout: 120_000 },
  async (t) => {
    const h = await harness();
    t.after(() => h.stop());

    await t.test(
      "pending policy never reaches a permission check",
      async () => {
        const s = await h.seed("pending");
        const revision = await h.policy.mutate({
          ...operation("pending", "new-agent"),
          fence: "pending",
          changes: [
            {
              kind: "create",
              entity: {
                tenantId: "pending",
                kind: "agent",
                id: "agent-1",
                generation: "g1",
              },
            },
          ],
        });
        let calls = 0;
        await assert.rejects(
          h.policy.admit(s.admit("send"), {
            async check() {
              calls++;
              return true;
            },
          }),
          { status: 503, code: "POLICY_UNAVAILABLE" },
        );
        assert.equal(calls, 0);
        assert.equal(
          (
            await h.policy.entities.findOne({
              tenantId: "pending",
              kind: "agent",
            })
          )?.status,
          "pending",
        );
        assert.equal(
          await h.publish({ ...revision, modelId: "other-model" }),
          false,
        );
        assert.equal(
          await h.publish({ ...revision, namespace: "other-namespace" }),
          false,
        );
        assert.equal(await h.publish(revision), true);
        assert.equal(await h.publish(revision), true, "idempotent publication");
        assert.equal(
          (
            await h.policy.entities.findOne({
              tenantId: "pending",
              kind: "agent",
            })
          )?.status,
          "active",
        );
      },
    );

    await t.test(
      "late acknowledgments never clear a later revoke",
      async () => {
        const s = await h.seed("revoked");
        const revision = await s.revoke("remove-member");
        assert.equal(await h.publish(s.revision), false);
        const state = await h.policy.states.findOne({ _id: "revoked" });
        assert.equal(state?.fence, "revoked");
        assert.equal(state?.desired.revision, revision.revision);
        assert.equal(await h.publish(revision), true);
        await assert.rejects(
          h.policy.admit(s.admit("old-credential"), {
            async check() {
              return true;
            },
          }),
          { status: 403 },
        );
        assert.equal(
          await h.policy.admissions.countDocuments({ tenantId: "revoked" }),
          0,
        );
      },
    );

    for (const collection of [
      "authorization_policy_state",
      "authorization_entities",
      "authorization_mutations",
      "authorization_audit",
      "authorization_outbox",
    ]) {
      await t.test(
        `${collection} failure rolls back state, entities and outbox together`,
        async () => {
          const tenantId =
            collection.replace("authorization_", "").replaceAll("_", "-") +
            "-fail";
          const s = await h.seed(tenantId);
          const before = await h.policy.states.findOne({ _id: tenantId });
          const counts = await Promise.all([
            h.policy.mutations.countDocuments({
              "revision.tenantId": tenantId,
            }),
            h.policy.outbox.countDocuments({ tenantId }),
            h.policy.audit.countDocuments({ tenantId }),
          ]);
          await h.store.catalog.command({
            collMod: collection,
            validator: { neverPresent: { $exists: true } },
            validationAction: "error",
          });
          try {
            await assert.rejects(s.revoke("failed-revoke"));
          } finally {
            await h.store.catalog.command({
              collMod: collection,
              validator: {},
            });
          }
          assert.deepEqual(
            await h.policy.states.findOne({ _id: tenantId }),
            before,
          );
          assert.equal(
            (await h.policy.entities.findOne({ tenantId, kind: "binding" }))
              ?.status,
            "active",
          );
          assert.deepEqual(
            await Promise.all([
              h.policy.mutations.countDocuments({
                "revision.tenantId": tenantId,
              }),
              h.policy.outbox.countDocuments({ tenantId }),
              h.policy.audit.countDocuments({ tenantId }),
            ]),
            counts,
          );
        },
      );
    }

    await t.test(
      "mutation replay after process restart has one audit/outbox event; changed digest conflicts",
      async () => {
        const s = await h.seed("replay");
        const revision = await s.revoke("remove-once");
        const restarted = new PolicyStateStore(h.store);
        const change = {
          ...operation("replay", "remove-once"),
          fence: "revoked" as const,
          changes: [
            {
              kind: "revoke" as const,
              entity: {
                tenantId: "replay",
                kind: "binding" as const,
                id: s.context.binding.id,
                generation: s.context.binding.generation,
                subject: s.context.principal,
              },
            },
          ],
        };
        assert.deepEqual(await restarted.mutate(change), revision);
        assert.equal(
          await h.policy.outbox.countDocuments({ _id: "replay:remove-once" }),
          1,
        );
        assert.equal(
          await h.policy.audit.countDocuments({ _id: "replay:remove-once" }),
          1,
        );
        await assert.rejects(
          restarted.mutate({ ...change, payloadDigest: "f".repeat(64) }),
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
      },
    );

    await t.test(
      "restored policy remains fenced against ordinary acknowledgment and mutations",
      async () => {
        const s = await h.seed("restored");
        await h.fenceForRestore("restored");
        assert.equal(await h.publish(s.revision), false);
        await assert.rejects(s.revoke("ordinary-mutation"), { status: 503 });
        await assert.rejects(
          h.policy.admit(s.admit("send"), {
            async check() {
              return true;
            },
          }),
          { status: 503 },
        );
        assert.equal(
          (await h.policy.states.findOne({ _id: "restored" }))?.fence,
          "restore",
        );
        assert.equal(
          await h.policy.audit.countDocuments({
            tenantId: "restored",
            outcome: "restore_fenced",
          }),
          1,
        );
      },
    );
  },
);

test(
  "standalone Mongo refuses authorization writes instead of falling back",
  { timeout: 120_000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "authz_standalone").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const policy = new PolicyStateStore(store);
    await policy.ensureIndexes();
    await assert.rejects(
      policy.initialize(operation("standalone", "bootstrap"), "model-1"),
      { status: 503, code: "TRANSACTIONS_UNAVAILABLE" },
    );
    assert.equal(await policy.states.countDocuments(), 0);
    assert.equal(await policy.audit.countDocuments(), 0);
    assert.equal(await policy.outbox.countDocuments(), 0);
  },
);
