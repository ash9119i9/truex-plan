import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  pocEngine,
  snapshot,
  node,
  assertSnapshot,
  type EngineKind,
} from "./poc-engine";

for (const kind of ["openfga", "spicedb"] as EngineKind[]) {
  test(
    `${kind}: real policy privacy and revision isolation`,
    { timeout: 120_000 },
    async (t) => {
      const engine = await pocEngine(kind);
      t.after(() => engine.close());
      const s = snapshot();
      await engine.write(s.tuples);

      await t.test(
        "capability AND content: owners, roles, explicit shares and service ownership",
        async () => {
          assert.equal(
            await engine.check(s.user("owner"), "can_read", s.conversation),
            true,
          );
          assert.equal(
            await engine.check(s.user("owner"), "can_send", s.conversation),
            true,
          );
          assert.equal(
            await engine.check(s.user("reader"), "can_read", s.conversation),
            true,
          );
          assert.equal(
            await engine.check(s.user("reader"), "can_send", s.conversation),
            false,
          );
          assert.equal(
            await engine.check(s.user("reader"), "can_approve", s.conversation),
            false,
          );
          assert.equal(
            await engine.check(
              s.user("reader"),
              "can_settings",
              s.conversation,
            ),
            false,
          );
          assert.equal(
            await engine.check(
              s.user("administrator"),
              "read_cap",
              s.conversation,
            ),
            true,
          );
          assert.equal(
            await engine.check(
              s.user("administrator"),
              "can_read",
              s.conversation,
            ),
            false,
          );
          assert.equal(
            await engine.check(s.user("owner"), "can_read", s.other),
            false,
          );
          assert.equal(
            await engine.check(s.user("service-owner"), "can_read", s.other),
            true,
          );
          assert.equal(
            await engine.check(s.user("administrator"), "can_read", s.document),
            false,
          );
          assert.equal(
            await engine.check(s.user("reader"), "can_read", s.document),
            true,
          );
        },
      );

      await t.test(
        "content ownership alone is insufficient without the fixed role capability",
        async () => {
          const resource = s.id("conversation", "unscoped-owner");
          await engine.write([
            { user: s.user("unscoped"), relation: "owner", object: resource },
            { user: s.workspace, relation: "workspace", object: resource },
          ]);
          assert.equal(
            await engine.check(s.user("unscoped"), "content_reader", resource),
            true,
          );
          assert.equal(
            await engine.check(s.user("unscoped"), "can_read", resource),
            false,
          );
        },
      );

      await t.test(
        "lists do not leak another owner's private conversation",
        async () => {
          const found = await engine.list(
            s.user("reader"),
            "conversation",
            "can_read",
          );
          assert.ok(found.includes(s.conversation));
          assert.ok(!found.includes(s.other));
          assert.deepEqual(
            await engine.list(
              s.user("administrator"),
              "conversation",
              "can_read",
            ),
            [],
          );
        },
      );

      await t.test(
        "nested groups supply only explicit read sharing",
        async () => {
          const child = s.id("group", "nested");
          await engine.write([
            {
              user: s.user("nested-reader"),
              relation: "member",
              object: child,
            },
            { user: `${child}#member`, relation: "member", object: s.group },
            {
              user: s.user("nested-reader"),
              relation: "assignee",
              object: s.memberRole,
            },
          ]);
          assert.equal(
            await engine.check(
              s.user("nested-reader"),
              "can_read",
              s.conversation,
            ),
            true,
          );
          assert.equal(
            await engine.check(
              s.user("nested-reader"),
              "can_send",
              s.conversation,
            ),
            false,
          );
        },
      );

      await t.test(
        "grant N, revoke N+1, then successful delayed N write cannot change active N+1",
        async () => {
          const old = snapshot();
          const next = snapshot();
          const oldMembership = {
            user: old.user("reader"),
            relation: "member",
            object: old.group,
          };
          const nextMembership = {
            user: next.user("reader"),
            relation: "member",
            object: next.group,
          };
          await engine.write(
            old.tuples.filter(
              (tuple) =>
                JSON.stringify(tuple) !== JSON.stringify(oldMembership),
            ),
          );
          await engine.write(
            next.tuples.filter(
              (tuple) =>
                JSON.stringify(tuple) !== JSON.stringify(nextMembership),
            ),
          );
          assert.equal(
            await engine.check(
              next.user("reader"),
              "can_read",
              next.conversation,
            ),
            false,
          );
          // The old engine request really succeeds after the revoke's snapshot is
          // complete. Rejecting only its acknowledgment would not protect a shared graph.
          await engine.write([oldMembership]);
          assert.equal(
            await engine.check(
              old.user("reader"),
              "can_read",
              old.conversation,
            ),
            true,
          );
          assert.equal(
            await engine.check(
              next.user("reader"),
              "can_read",
              next.conversation,
            ),
            false,
          );
          assert.equal(
            await engine.check(
              old.user("reader"),
              "can_read",
              next.conversation,
            ),
            false,
          );
        },
      );

      await t.test(
        "every traversable edge must stay in the same snapshot",
        () => {
          const other = node(randomUUID(), "user", "reader");
          assert.throws(
            () =>
              assertSnapshot(s.namespace, [
                { user: other, relation: "member", object: s.group },
              ]),
            /crosses namespaces/,
          );
          assert.throws(
            () =>
              assertSnapshot(s.namespace, [
                {
                  user: `${s.group}#member`,
                  relation: "reader",
                  object: node(randomUUID(), "conversation", "owned"),
                },
              ]),
            /crosses namespaces/,
          );
          assert.throws(
            () =>
              assertSnapshot(s.namespace, [
                { user: "user:*", relation: "reader", object: s.conversation },
              ]),
            /crosses namespaces|wildcard/,
          );
        },
      );
    },
  );
}
