import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { pocEngine, node, type EngineKind } from "./poc-engine";
import {
  component,
  compileComponent,
  componentFixture,
} from "./poc-components";

for (const kind of ["openfga", "spicedb"] as EngineKind[]) {
  test(
    `${kind}: immutable component publication`,
    { timeout: 120_000 },
    async (t) => {
      const engine = await pocEngine(kind, true);
      t.after(() => engine.close());
      const f = componentFixture();
      await engine.write(f.tuples);
      const check = (
        user: string,
        permission = "can_read",
        active = f.active,
      ) => engine.check(f.user(user), permission, f.owned.alias, { active });

      await t.test(
        "capabilities never bypass private content, sharing stays read only",
        async () => {
          assert.equal(await check("owner"), true);
          assert.equal(await check("reader"), true);
          assert.equal(await check("administrator"), false);
          assert.equal(await check("reader", "can_send"), false);
          assert.equal(await check("reader", "can_approve"), false);
          assert.equal(await check("reader", "can_settings"), false);
          assert.equal(
            await engine.check(
              f.user("service-owner"),
              "can_read",
              f.privateOther.alias,
              { active: f.active },
            ),
            true,
          );
          assert.deepEqual(
            await engine.list(
              f.user("reader"),
              "cmp_conversation",
              "can_read",
              { active: f.active },
            ),
            [f.owned.alias],
          );
        },
      );

      await t.test(
        "missing or unknown active references cannot grant",
        async () => {
          assert.equal(await check("reader", "can_read", {}), false);
          assert.equal(
            await check("reader", "can_read", {
              ...f.active,
              [f.group.alias]: "unknown",
            }),
            false,
          );
          const withoutRole = { ...f.active };
          delete withoutRole[f.role.alias];
          assert.equal(await check("owner", "can_read", withoutRole), false);
          if (kind === "openfga") {
            await assert.rejects(
              engine.check(f.user("owner"), "can_read", f.owned.alias),
              /context|parameter|condition/,
            );
            await assert.rejects(
              engine.list(f.user("reader"), "cmp_conversation", "can_read"),
              /400:.*validation_error/,
            );
          } else {
            assert.equal(
              await engine.check(f.user("owner"), "can_read", f.owned.alias),
              false,
            );
            assert.deepEqual(
              await engine.list(
                f.user("reader"),
                "cmp_conversation",
                "can_read",
              ),
              [],
            );
          }
        },
      );

      await t.test(
        "group revocation copies only its component; successful old grant cannot resurrect",
        async () => {
          const delayed = component(f.tenant, "group", "readers");
          const payload = compileComponent(delayed, [
            { user: f.user("reader"), relation: "member" },
          ]);
          await engine.write(
            payload.filter((tuple) => tuple.relation === "version"),
          );
          const next = component(f.tenant, "group", "readers");
          await engine.write(compileComponent(next, []));
          const active = { ...f.active, [next.alias]: next.version };
          assert.equal(await check("reader", "can_read", active), false);
          await engine.write(
            payload.filter((tuple) => tuple.relation !== "version"),
          );
          assert.equal(await check("reader", "can_read", active), false);
          assert.equal(
            await check("reader", "can_read", {
              ...f.active,
              [delayed.alias]: delayed.version,
            }),
            true,
          ); // Proves the delayed write really created its old grant.
          assert.equal(await check("owner", "can_read", active), true);
          const bulk = await engine.checkMany([
            {
              user: f.user("reader"),
              relation: "can_read",
              object: f.owned.alias,
              context: { active: f.active },
            },
            {
              user: f.user("reader"),
              relation: "can_read",
              object: f.owned.alias,
              context: { active },
            },
            {
              user: f.user("owner"),
              relation: "can_read",
              object: f.owned.alias,
              context: { active },
            },
            {
              user: f.user("administrator"),
              relation: "can_read",
              object: f.owned.alias,
              context: { active: f.active },
            },
          ]);
          assert.deepEqual(bulk, [true, false, true, false]);
          if (kind === "openfga") {
            await assert.rejects(
              engine.checkMany(
                [
                  {
                    user: f.user("owner"),
                    relation: "can_read",
                    object: f.owned.alias,
                    context: { active },
                  },
                ],
                "spicedb-only-marker",
              ),
              /SpiceDB token cannot select OpenFGA consistency/,
            );
          }
          if (kind === "spicedb") {
            assert.deepEqual(
              await engine.checkMany([
                {
                  user: f.user("reader"),
                  relation: "can_read",
                  object: f.owned.alias,
                },
              ]),
              [false],
            );
            await assert.rejects(
              engine.checkMany([
                {
                  user: f.user("reader"),
                  relation: "no_such_permission",
                  object: f.owned.alias,
                  context: { active },
                },
              ]),
              /unavailable/,
            );
          }
          assert.deepEqual(
            await engine.list(
              f.user("reader"),
              "cmp_conversation",
              "can_read",
              { active },
            ),
            [],
          );
        },
      );

      await t.test(
        "role and content revocations are independent of unchanged graph",
        async () => {
          const delayedRole = component(f.tenant, "role", "member");
          const delayedRolePayload = compileComponent(delayedRole, [
            { user: f.user("reader"), relation: "assignee" },
          ]);
          await engine.write(
            delayedRolePayload.filter((tuple) => tuple.relation === "version"),
          );
          const role = component(f.tenant, "role", "member");
          await engine.write(
            compileComponent(role, [
              { user: f.user("owner"), relation: "assignee" },
            ]),
          );
          const active = { ...f.active, [role.alias]: role.version };
          assert.equal(await check("reader", "can_read", active), false);
          assert.equal(await check("owner", "can_read", active), true);
          await engine.write(
            delayedRolePayload.filter((tuple) => tuple.relation !== "version"),
          );
          assert.equal(await check("reader", "can_read", active), false);
          assert.equal(
            await check("reader", "can_read", {
              ...f.active,
              [delayedRole.alias]: delayedRole.version,
            }),
            true,
          );
          const delayedContent = component(f.tenant, "conversation", "owned");
          const delayedContentPayload = compileComponent(delayedContent, [
            { user: f.org.alias, relation: "scope" },
            { user: f.user("owner"), relation: "owner" },
            { user: `${f.group.alias}#member`, relation: "reader" },
          ]);
          await engine.write(
            delayedContentPayload.filter(
              (tuple) => tuple.relation !== "reader",
            ),
          );
          const content = component(f.tenant, "conversation", "owned");
          await engine.write(
            compileComponent(content, [
              { user: f.org.alias, relation: "scope" },
              { user: f.user("owner"), relation: "owner" },
            ]),
          );
          const contentActive = {
            ...f.active,
            [content.alias]: content.version,
          };
          assert.equal(await check("reader", "can_read", contentActive), false);
          await engine.write(
            delayedContentPayload.filter(
              (tuple) => tuple.relation === "reader",
            ),
          );
          assert.equal(await check("reader", "can_read", contentActive), false);
          assert.equal(
            await check("reader", "can_read", {
              ...f.active,
              [delayedContent.alias]: delayedContent.version,
            }),
            true,
          );
        },
      );

      await t.test(
        "compiler forbids cross-tenant references, version rebinding and arbitrary relations",
        () => {
          assert.throws(
            () =>
              compileComponent(f.group, [
                {
                  user: node(randomUUID(), "cmp_user", "reader"),
                  relation: "member",
                },
              ]),
            /Invalid component/,
          );
          assert.throws(
            () => compileComponent({ ...f.group, version: f.role.version }, []),
            /Invalid immutable/,
          );
          assert.throws(
            () => component(f.tenant, "group", "readers__other", "v1"),
            /Invalid immutable/,
          );
          assert.throws(
            () => component(f.tenant, "group", "readers", "other__v1"),
            /Invalid immutable/,
          );
          assert.throws(
            () =>
              compileComponent(f.group, [
                { user: "cmp_user:*", relation: "member" },
              ]),
            /Invalid component/,
          );
          assert.throws(
            () =>
              compileComponent(f.group, [
                { user: f.user("reader"), relation: "owner" },
              ]),
            /Invalid component/,
          );
        },
      );
    },
  );
}
