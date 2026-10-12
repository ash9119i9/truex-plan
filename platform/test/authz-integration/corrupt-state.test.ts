import assert from "node:assert/strict";
import test from "node:test";
import { harness, operation } from "./harness";

test(
  "corrupt policy pointers cannot reach an engine or produce a new revision",
  { timeout: 120_000 },
  async (t) => {
    const h = await harness();
    t.after(() => h.stop());
    const s = await h.seed("corrupt-pointer");
    const original = (await h.policy.states.findOne({
      _id: s.context.tenant.id,
    }))!;
    let checks = 0;
    for (const bad of [
      { ...original.active, revision: 0 },
      { ...original.active, revision: "2" },
      { ...original.active, revision: Number.NaN },
      { ...original.active, namespace: "" },
      { ...original.active, modelId: { $exists: true } },
      { ...original.active, tenantId: "other-tenant" },
    ]) {
      await h.policy.states.updateOne(
        { _id: original._id },
        { $set: { active: bad as any, desired: bad as any } },
      );
      await assert.rejects(
        h.policy.admit(s.admit("corrupt-send"), {
          async check() {
            checks++;
            return true;
          },
        }),
        { status: 503 },
      );
    }
    assert.equal(checks, 0);
    const before = await h.policy.outbox.countDocuments({
      tenantId: original._id,
    });
    await assert.rejects(
      h.policy.mutate({
        ...operation(original._id, "corrupt-mutation"),
        fence: "pending",
        changes: [
          {
            kind: "create",
            entity: {
              tenantId: original._id,
              kind: "group",
              id: "another-group",
              generation: "g1",
            },
          },
        ],
      }),
      { status: 503 },
    );
    assert.equal(
      await h.policy.outbox.countDocuments({ tenantId: original._id }),
      before,
    );
    assert.equal(
      await h.policy.entities.countDocuments({
        tenantId: original._id,
        id: "another-group",
      }),
      0,
    );
  },
);
