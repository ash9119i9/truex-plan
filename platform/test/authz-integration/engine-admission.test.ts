import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { harness, barrier } from "./harness";
import { pocEngine, node, type EngineKind } from "./poc-engine";
import { component, compileComponent } from "./poc-components";
import type { PolicyChecker } from "../../src/policy-state";

for (const kind of ["openfga", "spicedb"] as EngineKind[]) {
  test(
    `${kind}: actual engine check precedes serialized admission`,
    { timeout: 120_000 },
    async (t) => {
      const h = await harness();
      t.after(() => h.stop());
      const engine = await pocEngine(kind, true);
      t.after(() => engine.close());
      const s = await h.seed(`engine-${kind}`);
      const namespace = randomUUID();
      const actorId = `${s.context.principal.kind}-${s.context.principal.id}-${s.context.principal.generation}`;
      const actor = node(namespace, "cmp_user", actorId);
      const role = component(namespace, "role", "member");
      const org = component(namespace, "org", "organization");
      const content = component(
        namespace,
        "conversation",
        `${s.resource.id}-${s.resource.generation}`,
      );
      await engine.write([
        ...compileComponent(role, [{ user: actor, relation: "assignee" }]),
        ...compileComponent(org, [
          { user: `${role.alias}#assignee`, relation: "send_cap" },
        ]),
        ...compileComponent(content, [
          { user: org.alias, relation: "scope" },
          { user: actor, relation: "owner" },
        ]),
      ]);
      // Fixture-only immutable root. Production payload/root atomic persistence
      // and server model/store routing are separate A07 requirements.
      const roots = h.store.catalog.collection<{
        _id: string;
        modelId: string;
        active: Record<string, string>;
      }>("authorization_poc_roots");
      await roots.insertOne({
        _id: s.revision.namespace,
        modelId: s.revision.modelId,
        active: Object.fromEntries(
          [role, org, content].map((c) => [c.alias, c.version]),
        ),
      });
      const checker: PolicyChecker = {
        async check({ context, action, resource, policy }) {
          assert.equal(context.tenant.id, s.context.tenant.id);
          assert.equal(action, "conversation.send");
          const root = await roots.findOne(
            { _id: policy.namespace, modelId: policy.modelId },
            { readConcern: { level: "majority" } },
          );
          if (!root) return false;
          return engine.check(
            node(
              namespace,
              "cmp_user",
              `${context.principal.kind}-${context.principal.id}-${context.principal.generation}`,
            ),
            "can_send",
            node(
              namespace,
              "cmp_conversation",
              `${resource.id}-${resource.generation}`,
            ),
            { active: root.active },
          );
        },
      };
      const receipt = await h.policy.admit(s.admit("engine-allowed"), checker);
      assert.equal(receipt.policy.namespace, s.revision.namespace);
      assert.equal(await h.policy.consume(receipt), true);
      assert.equal(await h.policy.consume(receipt), false);

      const checked = barrier();
      const release = barrier();
      const pending = h.policy.admit(s.admit("engine-before-revoke"), {
        async check(input) {
          assert.equal(await checker.check(input), true);
          checked.resolve();
          await release.promise;
          return true;
        },
      });
      const rejected = assert.rejects(pending, {
        status: 503,
        code: "POLICY_UNAVAILABLE",
      });
      await checked.promise;
      const revoke = await s.revoke("revoke-after-real-engine-allow");
      release.resolve();
      await rejected;
      await h.publish(revoke);
      await assert.rejects(
        h.policy.admit(s.admit("engine-after-revoke"), checker),
        { status: 403 },
      );
      assert.equal(
        await h.policy.admissions.countDocuments({
          tenantId: s.context.tenant.id,
        }),
        1,
      );
      assert.equal(
        await h.policy.audit.countDocuments({
          tenantId: s.context.tenant.id,
          outcome: "admitted",
        }),
        1,
      );
    },
  );
}
