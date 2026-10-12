import assert from "node:assert/strict";
import test from "node:test";
import { harness, operation, workerContext, barrier } from "./harness";

test(
  "policy workload authority remains bound and expires while queued",
  { timeout: 120_000 },
  async (t) => {
    const h = await harness();
    t.after(() => h.stop());
    const s = await h.seed("workload-queue");
    const desired = await h.policy.mutate({
      ...operation(s.context.tenant.id, "new-group"),
      fence: "pending",
      changes: [
        {
          kind: "create",
          entity: {
            tenantId: s.context.tenant.id,
            kind: "group",
            id: "group-1",
            generation: "group-generation-1",
          },
        },
      ],
    });
    const original = h.store.withCatalogTransaction.bind(h.store);
    const pause = () => {
      const entered = barrier(),
        release = barrier();
      h.store.withCatalogTransaction = async (callback) => {
        entered.resolve();
        await release.promise;
        return original(callback);
      };
      return { entered, release };
    };
    t.after(() => {
      h.store.withCatalogTransaction = original;
    });

    const gate = pause();
    const context = workerContext(s.context.tenant.id, "projection");
    const input = structuredClone(desired);
    const publishing = h.policy.publish(input, context);
    await gate.entered.promise;
    input.namespace = "different-namespace";
    context.principal.id = "different-workload";
    context.tenant.id = "different-tenant";
    gate.release.resolve();
    assert.equal(await publishing, true);
    const audit = await h.policy.audit.findOne({
      _id: `publish:${desired.namespace}`,
    });
    assert.equal(audit?.actor.id, "fixture-projection");
    assert.equal(audit?.revision.namespace, desired.namespace);

    for (const purpose of ["projection", "reconciliation"] as const) {
      const gate = pause();
      const context = workerContext(s.context.tenant.id, purpose);
      context.credential.expiresAtMs = Date.now() + 250;
      const pending =
        purpose === "projection"
          ? h.policy.publish(desired, context)
          : h.policy.fenceForRestore(s.context.tenant.id, context);
      const rejected = assert.rejects(pending, { status: 403 });
      await gate.entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 300));
      gate.release.resolve();
      await rejected;
      assert.equal(
        (await h.policy.states.findOne({ _id: s.context.tenant.id }))?.fence,
        null,
      );
    }
  },
);
