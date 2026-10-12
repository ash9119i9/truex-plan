import { test } from "node:test";
import assert from "node:assert/strict";
import { startPlatform, type Claims } from "./harness";
import { GENERAL_AGENT_ID, GENERAL_AGENT_HANDLE } from "../../shared/contracts";

const who = (name: string): Claims => ({
  sub: `general-${name}`,
  email: `${name}@gmail.com`,
  email_verified: true,
  name,
});
const body = (name = "My Helper") => ({
  name,
  description: "My own helper",
  systemPrompt: "Be brief.",
  modelProfileId: "demo-model",
  look: 4,
  tint: "mint",
});

test(
  "default tenant shares one locked General Agent and preserves private agents and chats",
  { timeout: 180_000 },
  async (t) => {
    // Exercise the configured id rather than relying on the default spelling.
    const p = await startPlatform({
      env: { DEFAULT_SIGNUP_TENANT_ID: "personal" },
    });
    t.after(() => p.stop());
    await p.workspace("personal");
    await p.approveDemoModel("personal");
    await p.store.profiles.insertOne({
      _id: "default",
      provider: "fixture",
      modelName: "default-model",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "default-fixture-key",
    });
    await p.store.tenantRegistry.updateOne(
      { _id: "personal" },
      {
        $set: { allowedModelIds: ["default", "demo-model"] },
      },
    );
    await p.workspace("team");
    await p.addMember(who("admin"), "personal", "admin");
    await p.addMember(who("team"), "team");
    const [alice, bob, admin, team] = await Promise.all([
      p.session(who("alice")),
      p.session(who("bob")),
      p.session(who("admin")),
      p.session(who("team")),
    ]);
    const path = `/api/agents/${GENERAL_AGENT_ID}`;
    const get = (cookie: string, url: string) => p.request(cookie, "GET", url);
    const post = (cookie: string, url: string, value: unknown) =>
      p.request(cookie, "POST", url, value);
    const tenant = (await p.store.resolveTenant("personal", { fresh: true }))!;

    await t.test(
      "existing and newly signed-in users see exactly one built-in without per-user records",
      async () => {
        const newcomer = await p.session(who("newcomer"));
        for (const listed of await Promise.all(
          [alice, bob, admin, newcomer, alice].map((c) =>
            get(c, "/api/agents"),
          ),
        )) {
          assert.equal(listed.status, 200, listed.text);
          assert.equal(listed.data.length, 1);
          const agent = listed.data[0];
          assert.equal(agent.id, GENERAL_AGENT_ID);
          assert.equal(agent.name, "General Agent");
          assert.equal(agent.handle, GENERAL_AGENT_HANDLE);
          assert.equal(agent.builtin, true);
          assert.equal(agent.canUse, true);
          assert.equal(agent.canWrite, false);
          assert.equal(agent.createdBy, undefined);
          assert.equal(listed.text.includes("fixture-key"), false);
        }
        assert.equal(
          await p.store.withTenant(tenant, () =>
            p.store.agents.countDocuments(),
          ),
          0,
        );
        assert.deepEqual((await get(team, "/api/agents")).data, []);
        assert.equal((await get(team, path)).status, 404);
        assert.equal((await p.request(undefined, "GET", path)).status, 401);
      },
    );

    await t.test(
      "all users can read and chat with General while conversations remain private",
      async () => {
        for (const cookie of [alice, bob, admin]) {
          const details = await get(cookie, path);
          assert.equal(details.status, 200, details.text);
          assert.equal(details.data.modelProfileId, "default");
          assert.ok(details.data.systemPrompt);
          assert.equal(details.text.includes("fixture-key"), false);
        }
        const a = await post(alice, "/api/sessions", {
          agentId: GENERAL_AGENT_ID,
        });
        const b = await post(bob, "/api/sessions", {
          agentId: GENERAL_AGENT_ID,
        });
        assert.equal(a.status, 201, a.text);
        assert.equal(b.status, 201, b.text);
        assert.notEqual(a.data._id, b.data._id);
        assert.equal(a.data.agentId, GENERAL_AGENT_ID);
        assert.equal(
          (await get(bob, `/api/sessions/${a.data._id}`)).status,
          404,
        );
        assert.equal(
          (await get(alice, `/api/sessions/${b.data._id}`)).status,
          404,
        );
        assert.deepEqual(
          (await get(alice, "/api/sessions")).data.map((s: any) => s._id),
          [a.data._id],
        );
        assert.deepEqual(
          (await get(bob, "/api/sessions")).data.map((s: any) => s._id),
          [b.data._id],
        );
      },
    );

    await t.test(
      "member and admin writes cannot change General or its connectors",
      async () => {
        for (const cookie of [alice, bob, admin]) {
          for (const [url, value] of [
            [path, body("Renamed")],
            [`${path}/mcp`, { profileIds: [] }],
          ] as const) {
            const reply = await post(cookie, url, value);
            assert.equal(reply.status, 403, reply.text);
            assert.equal(reply.data.code, "BUILTIN_AGENT_LOCKED");
          }
        }
        const reserved = await post(
          alice,
          "/api/agents",
          body("General Agent"),
        );
        assert.equal(reserved.status, 409);
        assert.equal(reserved.data.code, "AGENT_HANDLE_TAKEN");
        assert.equal((await get(alice, path)).data.name, "General Agent");
      },
    );

    let ownId = "";
    await t.test(
      "owner editing updates the existing agent and keeps server-owned identity and policies",
      async () => {
        const made = await post(alice, "/api/agents", body());
        assert.equal(made.status, 201, made.text);
        ownId = made.data.id;
        const before = await p.store.withTenant(tenant, () =>
          p.store.agents.findOne({ _id: ownId }),
        );
        const update = {
          ...body("Renamed Helper"),
          description: "New purpose",
          systemPrompt: "Give examples.",
          look: 8,
          tint: "lilac",
        };
        const edited = await post(alice, `/api/agents/${ownId}`, update);
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.data.canWrite, true);
        assert.equal(edited.data.canUse, true);
        assert.equal(edited.data.name, update.name);
        assert.equal(edited.data.look, 8);
        assert.equal(edited.data.handle, made.data.handle);
        assert.equal(edited.data.createdBy, made.data.createdBy);
        const after = await p.store.withTenant(tenant, () =>
          p.store.agents.findOne({ _id: ownId }),
        );
        for (const field of [
          "_id",
          "createdBy",
          "handle",
          "sandbox",
          "approvalPolicy",
          "scope",
          "builtin",
          "enabled",
          "mcpProfileIds",
          "skillIds",
        ] as const)
          assert.deepEqual(after?.[field], before?.[field], field);
        assert.equal(after?.systemPrompt, update.systemPrompt);
        const details = await get(alice, `/api/agents/${ownId}`);
        assert.equal(details.status, 200);
        assert.equal(details.data.systemPrompt, update.systemPrompt);
        assert.equal(details.data.modelProfileId, "demo-model");
        assert.equal(details.text.includes("fixture-key"), false);
        assert.equal((await get(alice, "/api/agents")).data.length, 2);
        assert.equal((await get(bob, "/api/agents")).data.length, 1);
      },
    );

    await t.test(
      "editing enforces ownership, validation, allowed models and CSRF",
      async () => {
        for (const [cookie, status] of [
          [bob, 404],
          [admin, 403],
          [team, 404],
        ] as const)
          assert.equal(
            (await post(cookie, `/api/agents/${ownId}`, body())).status,
            status,
          );
        for (const value of [
          null,
          [],
          { ...body(), name: "" },
          { ...body(), look: 12 },
          { ...body(), tint: "red" },
          { ...body(), builtin: true },
          { ...body(), createdBy: "other" },
          { ...body(), handle: "generalagent" },
          { ...body(), sandbox: "danger-full-access" },
        ])
          assert.equal(
            (await post(alice, `/api/agents/${ownId}`, value)).status,
            400,
            JSON.stringify(value),
          );
        await p.store.profiles.insertOne({
          _id: "unapproved",
          provider: "fixture",
          modelName: "other",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "hidden-key",
        });
        for (const modelProfileId of ["missing", "unapproved"])
          assert.equal(
            (
              await post(alice, `/api/agents/${ownId}`, {
                ...body(),
                modelProfileId,
              })
            ).status,
            422,
          );
        assert.equal(
          (
            await p.request(alice, "POST", `/api/agents/${ownId}`, body(), {
              headers: { Origin: "https://evil.example" },
            })
          ).status,
          403,
        );
        assert.equal(
          (await get(alice, `/api/agents/${ownId}`)).data.name,
          "Renamed Helper",
        );
      },
    );

    await t.test(
      "General uses an approved usable model and fails before runtime if none is available",
      async () => {
        await p.store.profiles.updateOne(
          { _id: "default" },
          { $set: { enabled: false } },
        );
        assert.equal(
          (await get(alice, path)).data.modelProfileId,
          "demo-model",
        );
        await p.store.profiles.updateOne(
          { _id: "demo-model" },
          { $set: { enabled: false } },
        );
        const mark = p.core.mark();
        const refused = await post(alice, "/api/sessions", {
          agentId: GENERAL_AGENT_ID,
        });
        assert.equal(refused.status, 422, refused.text);
        assert.equal(refused.data.code, "MODEL_CONFIGURATION");
        assert.equal(
          p.core.since(mark).some((c) => c.path === "/threads"),
          false,
        );
        assert.equal(
          (await get(alice, "/api/agents")).data.filter(
            (a: any) => a.id === GENERAL_AGENT_ID,
          ).length,
          1,
        );
      },
    );
  },
);
