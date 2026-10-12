import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIONS,
  WORKLOAD_ACTIONS,
  type Action,
} from "../../../shared/authorization";
import {
  candidateSpiceSchema,
  enginePermission,
  ORGANIZATION_ACTIONS,
} from "../../src/authorization-model";
import { pocEngine, node, type Tuple } from "./poc-engine";

test(
  "SpiceDB validates the fixed catalog and preserves private content across all actions",
  { timeout: 120_000 },
  async (t) => {
    assert.equal(
      readFileSync(resolve("policy/authorization.candidate.v1.zed"), "utf8"),
      candidateSpiceSchema(),
    );
    assert.equal(new Set(ACTIONS.map(enginePermission)).size, ACTIONS.length);
    const engine = await pocEngine("spicedb");
    t.after(() => engine.close());
    const tenant = randomUUID();
    const n = (type: string, id: string) => node(tenant, `az_v1_${type}`, id);
    const user = (id: string) => n("principal", `${id}-g1`);
    const active: Record<string, string> = {};
    const tuples: Tuple[] = [];
    const part = (
      type: string,
      id: string,
      edges: { user: string; relation: string }[],
    ) => {
      const alias = n(type, `${id}-g1`);
      const version = n(`${type}_version`, `${id}-g1__v1`);
      active[alias] = version;
      tuples.push(...edges.map((e) => ({ ...e, object: version })), {
        user: version,
        relation: "version",
        object: alias,
        condition: {
          name: "az_v1_active_version",
          context: { key: alias, revision: version },
        },
      });
      return alias;
    };
    const role = part(
      "role",
      "all-fixed-caps",
      ["owner", "reader", "administrator", "service-owner"].map((id) => ({
        user: user(id),
        relation: "assignee",
      })),
    );
    const workerSubjects = new Map<Action, string>();
    const workerRoles = new Map<Action, string>();
    for (const [purpose, allowed] of Object.entries(WORKLOAD_ACTIONS)) {
      const mechanical = allowed.filter((action) =>
        action.startsWith("worker."),
      );
      if (!mechanical.length) continue;
      const subject = n("workload", `${purpose}-g1`);
      const role = part("role", `${purpose}-mechanical`, [
        { user: subject, relation: "assignee" },
      ]);
      for (const action of mechanical) {
        workerSubjects.set(action, subject);
        workerRoles.set(action, role);
      }
    }
    const org = part(
      "org",
      "organization",
      ACTIONS.map((action) => ({
        user: `${workerRoles.get(action) ?? role}#assignee`,
        relation: `cap_${enginePermission(action)}`,
      })),
    );
    const workspace = part("workspace", "workspace", [
      { user: org, relation: "scope" },
    ]);
    const group = part("group", "readers", [
      { user: user("reader"), relation: "member" },
    ]);
    const basic = [
      { user: workspace, relation: "scope" },
      { user: user("owner"), relation: "owner" },
    ];
    const shared = [...basic, { user: `${group}#member`, relation: "reader" }];
    const conversation = part("conversation", "conversation", shared);
    const agent = part("agent", "agent", shared);
    const project = part("project", "personal-folder", basic);
    const document = part("document", "document", [
      { user: workspace, relation: "scope" },
      { user: conversation, relation: "conversation" },
    ]);
    const connector = part("connector", "connector", [
      ...basic,
      { user: `${role}#assignee`, relation: "allowed" },
    ]);
    const model = part("model", "model", [
      { user: workspace, relation: "scope" },
      { user: `${role}#assignee`, relation: "allowed" },
    ]);
    const skill = part("skill", "skill", [
      { user: workspace, relation: "scope" },
      { user: `${role}#assignee`, relation: "allowed" },
    ]);
    await engine.write(tuples);
    const objects: Record<string, string> = {
      agent,
      conversation,
      project,
      document,
      connector,
      model,
      skill,
      workspace,
    };
    const target = (action: Action) => {
      if (ORGANIZATION_ACTIONS.includes(action)) return org;
      if (action === "support.approve_access") return conversation;
      if (action.endsWith(".create")) return workspace;
      if (action.startsWith("tool.")) return connector;
      if (action === "document.upload") return conversation;
      const object = objects[action.split(".")[0]];
      assert.ok(object, `Missing native action target: ${action}`);
      return object;
    };
    const check = (
      id: string,
      action: Action,
      object = target(action),
      refs = active,
    ) =>
      engine.check(user(id), enginePermission(action), object, {
        active: refs,
      });

    await t.test(
      "every fixed action has an engine-parsed permission with an allowed fixture",
      async () => {
        for (const action of ACTIONS)
          assert.equal(
            await engine.check(
              workerSubjects.get(action) ?? user("owner"),
              enginePermission(action),
              target(action),
              { active },
            ),
            true,
            action,
          );
        for (const action of ACTIONS.filter((a) => a.startsWith("worker.")))
          assert.equal(await check("owner", action), false, action);
      },
    );
    await t.test(
      "an administrator with every capability still cannot read or mutate private content",
      async () => {
        for (const action of ACTIONS.filter(
          (a) =>
            ["conversation.", "agent.", "project.", "document."].some((p) =>
              a.startsWith(p),
            ) && !a.endsWith(".create"),
        ))
          assert.equal(await check("administrator", action), false, action);
        assert.equal(
          await check("administrator", "organization.members.manage"),
          true,
        );
      },
    );
    await t.test(
      "server-selected immutable versions preserve capability/content checks with causal freshness",
      async () => {
        const version = active[conversation];
        assert.equal(
          await engine.check(user("owner"), "conversation_read", version, {
            active,
          }),
          true,
        );
        const token = engine.lastObservedToken;
        assert.ok(token);
        for (const action of ACTIONS.filter(
          (a) => a.startsWith("conversation.") && !a.endsWith(".create"),
        )) {
          assert.equal(
            await engine.check(
              user("administrator"),
              enginePermission(action),
              version,
              { active },
              token,
            ),
            false,
            action,
          );
          const expected = [
            "conversation.read",
            "conversation.trace.read",
            "conversation.goal.read",
          ].includes(action);
          assert.equal(
            await engine.check(
              user("reader"),
              enginePermission(action),
              version,
              { active },
              token,
            ),
            expected,
            action,
          );
        }
        await assert.rejects(
          engine.check(
            user("owner"),
            "conversation_read",
            version,
            { active },
            "invalid-token",
          ),
        );
      },
    );
    await t.test(
      "read-only group shares allow content and inherited documents, never owner mutations",
      async () => {
        for (const action of ACTIONS.filter(
          (a) => a.startsWith("conversation.") && !a.endsWith(".create"),
        )) {
          const expected = [
            "conversation.read",
            "conversation.trace.read",
            "conversation.goal.read",
          ].includes(action);
          assert.equal(await check("reader", action), expected, action);
        }
        for (const action of ["document.read", "document.download"] as Action[])
          assert.equal(await check("reader", action), true, action);
        for (const action of [
          "document.upload",
          "document.delete",
          "support.approve_access",
        ] as Action[])
          assert.equal(await check("reader", action), false, action);
        assert.equal(await check("reader", "project.read"), false);
      },
    );
    await t.test(
      "service ownership and missing capability/reference behavior remain explicit",
      async () => {
        const serviceConversation = part("conversation", "service-owned", [
          { user: workspace, relation: "scope" },
          { user: user("service-owner"), relation: "owner" },
        ]);
        await engine.write(
          tuples.filter((tuple) => tuple.object.includes("service-owned")),
        );
        assert.equal(
          await check(
            "service-owner",
            "conversation.send",
            serviceConversation,
          ),
          true,
        );
        assert.equal(
          await check("owner", "conversation.read", serviceConversation),
          false,
        );
        const noRole = { ...active };
        delete noRole[role];
        assert.equal(
          await check("owner", "conversation.read", conversation, noRole),
          false,
        );
        assert.equal(
          await check("owner", "conversation.read", conversation, {}),
          false,
        );
      },
    );
    await t.test(
      "fixed emergency read expiry cannot become owner mutation authority",
      async () => {
        const conversation = part("conversation", "emergency-read", basic);
        const version = active[conversation];
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 10_000).toISOString();
        await engine.write([
          ...tuples.filter((tuple) => tuple.object.includes("emergency-read")),
          {
            user: user("administrator"),
            relation: "emergency_reader",
            object: version,
            condition: {
              name: "az_v1_emergency_unexpired",
              context: { expires_at: expiresAt },
            },
          },
        ]);
        const read = (context: Record<string, unknown>) =>
          engine.check(
            user("administrator"),
            "conversation_read",
            conversation,
            context,
          );
        assert.equal(
          await read({ active, current_time: now.toISOString() }),
          true,
        );
        assert.equal(await read({ active }), false);
        const future = new Date(now.getTime() + 20_000).toISOString();
        assert.equal(await read({ active, current_time: future }), false);
        assert.equal(
          await read({
            active,
            current_time: future,
            expires_at: new Date(now.getTime() + 60_000).toISOString(),
          }),
          false,
        );
        assert.equal(
          await engine.check(
            user("administrator"),
            "conversation_send",
            conversation,
            { active, current_time: now.toISOString() },
          ),
          false,
        );
      },
    );
    await t.test(
      "coexisting model types pin old reads while a new model has tighter semantics",
      async () => {
        const next = (value: string) =>
          value.replaceAll("az_v1_", "az_overlap_v2_");
        const copied = tuples.map((tuple) => ({
          user: next(tuple.user),
          relation: tuple.relation,
          object: next(tuple.object),
          ...(tuple.condition
            ? {
                condition: {
                  name: next(tuple.condition.name),
                  context: {
                    key: next(String(tuple.condition.context.key)),
                    revision: next(String(tuple.condition.context.revision)),
                  },
                },
              }
            : {}),
        }));
        await engine.write(copied);
        const refs = Object.fromEntries(
          Object.entries(active).map(([key, value]) => [
            next(key),
            next(value),
          ]),
        );
        assert.equal(await check("reader", "conversation.read"), true);
        assert.equal(
          await engine.check(
            next(user("reader")),
            "conversation_read",
            next(conversation),
            { active: refs },
          ),
          false,
        );
        assert.equal(
          await engine.check(
            next(user("owner")),
            "conversation_read",
            next(conversation),
            { active: refs },
          ),
          true,
        );
        assert.equal(await check("administrator", "conversation.read"), false);
      },
    );
  },
);
