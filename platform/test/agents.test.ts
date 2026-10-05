import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { DEFAULT_CHAT_AGENT_ID, newAgent } from "../src/agents";
import { insertFixtures } from "./fixtures";

test(
  "default chat excludes unsupported routes and a missing gateway",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "agent-model-route-test",
    ).connect();
    const oldUrl = process.env.MODEL_GATEWAY_URL;
    const oldSecret = process.env.MODEL_GATEWAY_SECRET;
    delete process.env.MODEL_GATEWAY_URL;
    delete process.env.MODEL_GATEWAY_SECRET;
    t.after(async () => {
      if (oldUrl === undefined) delete process.env.MODEL_GATEWAY_URL;
      else process.env.MODEL_GATEWAY_URL = oldUrl;
      if (oldSecret === undefined) delete process.env.MODEL_GATEWAY_SECRET;
      else process.env.MODEL_GATEWAY_SECRET = oldSecret;
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const profile = {
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "chat-model",
      apikey: "key",
    };
    await store.profiles.insertOne({
      ...profile,
      _id: "000-chat",
      wireApi: "chat",
    });
    await store.profiles.insertOne({
      ...profile,
      _id: "001-invalid",
      wireApi: "invalid",
    });
    await store.profiles.insertOne({
      ...profile,
      _id: "002-invalid-route",
      wireApi: "chat",
      route: "direct",
    });
    const service = new PlatformService(store);
    // The existing catalog contract is unchanged; default selection is stricter.
    assert.equal((await service.models()).length, 4);
    assert.equal(
      (await service.agents()).find((a) => a.isDefault)?.model,
      "gpt-5",
    );
    const tenant = {
      id: "gateway-only",
      dbName: "truex_t_gateway_only",
      allowedModelIds: ["000-chat"],
    };
    await store.withTenant(tenant as any, async () => {
      assert.deepEqual(await service.agents(), []);
      assert.equal(await store.agents.countDocuments(), 0);
    });
    process.env.MODEL_GATEWAY_URL = "http://127.0.0.1:4300";
    process.env.MODEL_GATEWAY_SECRET = "test-gateway-secret";
    const remoteService = new PlatformService(store, [
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
    ]);
    await store.withTenant(tenant as any, async () => {
      assert.deepEqual(await remoteService.agents(), []);
      assert.equal(await store.agents.countDocuments(), 0);
      for (const address of ["invalid", "file:///tmp/gateway"]) {
        process.env.MODEL_GATEWAY_URL = address;
        assert.deepEqual(await service.agents(), []);
      }
      process.env.MODEL_GATEWAY_URL = "http://127.0.0.1:4300";
    });
    await store.withTenant(tenant as any, async () => {
      assert.equal(
        (await service.agents()).find((a) => a.isDefault)?.model,
        "chat-model",
      );
    });
    // Provisioning is stable even when another route later becomes usable.
    assert.equal(
      (await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID }))
        ?.modelProfileId,
      "default",
    );
    delete process.env.MODEL_GATEWAY_URL;
    delete process.env.MODEL_GATEWAY_SECRET;
    await store.withTenant(tenant as any, async () => {
      assert.deepEqual(await service.agents(), []);
      assert.equal(
        (await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID }))
          ?.modelProfileId,
        "000-chat",
      );
    });
  },
);

test("agent validation rejects bad input and server-owned fields", () => {
  const ok = { name: "Research Scout", modelProfileId: "default" };
  for (const [body, code] of [
    [null, "INVALID_INPUT"],
    [[], "INVALID_INPUT"],
    [{ ...ok, name: "" }, "INVALID_INPUT"],
    [{ ...ok, name: "   " }, "INVALID_INPUT"],
    [{ ...ok, name: "x".repeat(41) }, "INVALID_INPUT"],
    [{ ...ok, name: "🙂 ✨" }, "AGENT_HANDLE_INVALID"],
    [{ ...ok, description: "x".repeat(81) }, "INVALID_INPUT"],
    [{ ...ok, systemPrompt: 42 }, "INVALID_INPUT"],
    [{ ...ok, look: 12 }, "INVALID_INPUT"],
    [{ ...ok, look: 1.5 }, "INVALID_INPUT"],
    [{ ...ok, tint: "red" }, "INVALID_INPUT"],
    [{ ...ok, modelProfileId: "" }, "INVALID_INPUT"],
    [{ ...ok, builtin: true }, "INVALID_INPUT"],
    [{ ...ok, isDefault: true }, "INVALID_INPUT"],
    [{ ...ok, sandbox: "danger-full-access" }, "INVALID_INPUT"],
    [{ ...ok, persona: "x" }, "INVALID_INPUT"],
  ] as const)
    assert.throws(() => newAgent(body), { code }, JSON.stringify(body));
  const agent = newAgent({ ...ok, systemPrompt: "  Cite sources.  " });
  assert.equal(agent.handle, "researchscout");
  assert.equal(agent.systemPrompt, "Cite sources.");
  assert.equal(agent.look, 2);
  assert.equal(agent.tint, "ice");
  assert.equal(agent.builtin, false);
  assert.equal(agent.sandbox, "read-only");
  assert.equal(agent.scope, "general");
});

test(
  "agents are created in the tenant, get unique handles and list their look",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "agents-test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    await store.profiles.insertOne({
      _id: "nokey",
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "no-key",
    });
    await store.profiles.insertOne({
      _id: "off",
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "off",
      apikey: "k",
      enabled: false,
    });
    const service = new PlatformService(store);

    // Only usable models are offered, and never with credentials.
    const models = await service.models();
    assert.deepEqual(models, [
      { id: "default", name: "gpt-5", provider: "fixture" },
    ]);
    assert.equal(JSON.stringify(models).includes("test-fixture-key"), false);

    const created = await service.createAgent({
      name: "Research Scout",
      description: "Web research",
      systemPrompt: "Cite sources.",
      look: 4,
      tint: "mint",
      modelProfileId: "default",
    });
    assert.equal(created.handle, "researchscout");
    assert.equal(created.model, "gpt-5");
    const stored = await store.agents.findOne({ _id: created.id });
    assert.equal(stored?.systemPrompt, "Cite sources.");
    assert.equal(stored?.builtin, false);
    assert.equal(stored?.scope, "general");

    // It works as a chat agent: instructions become the system prompt.
    const config = await service.configuration(created.id);
    assert.match(config.baseInstructions, /^Cite sources\./);
    assert.equal(config.scope, "general");

    const listed = (await service.agents()).find((a) => a.id === created.id);
    assert.deepEqual(
      { look: listed?.look, tint: listed?.tint, builtin: listed?.builtin },
      { look: 4, tint: "mint", builtin: false },
    );
    // Older agents without look fields fall back to the defaults.
    const legacy = (await service.agents()).find((a) => a.id === "assistant");
    assert.deepEqual(
      { look: legacy?.look, tint: legacy?.tint, handle: legacy?.handle },
      { look: 2, tint: "ice", handle: undefined },
    );

    await assert.rejects(
      service.createAgent({
        name: "research-scout",
        modelProfileId: "default",
      }),
      { status: 409, code: "AGENT_HANDLE_TAKEN" },
    );
    for (const modelProfileId of ["nokey", "off", "missing"])
      await assert.rejects(
        service.createAgent({
          name: "Other " + modelProfileId,
          modelProfileId,
        }),
        { status: 422, code: "MODEL_UNAVAILABLE" },
      );

    // Handles are unique per tenant, and a tenant's allow-list is enforced.
    const other = {
      id: "acme",
      dbName: "truex_t_acme",
      allowedModelIds: ["x"],
    };
    await store.withTenant(other as any, async () => {
      assert.deepEqual(await service.models(), []);
      await assert.rejects(
        service.createAgent({
          name: "Research Scout",
          modelProfileId: "default",
        }),
        { code: "MODEL_UNAVAILABLE" },
      );
    });
    const open = { id: "beta", dbName: "truex_t_beta" };
    await store.withTenant(open as any, async () => {
      const again = await service.createAgent({
        name: "Research Scout",
        modelProfileId: "default",
      });
      assert.equal(again.handle, "researchscout");
      assert.equal((await service.agents()).length, 2);
    });
    assert.equal(
      await store.agents.countDocuments({ handle: "researchscout" }),
      1,
    );
  },
);

test(
  "general defaults provision once per tenant, preserve configuration, and fail closed",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "default-agent-test",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const profile = {
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "other-model",
      apikey: "private-key",
    };
    await store.profiles.insertOne({ ...profile, _id: "aaa" });
    await store.profiles.insertOne({
      ...profile,
      _id: "000-no-key",
      apikey: "",
    });
    await store.profiles.insertOne({
      ...profile,
      _id: "001-disabled",
      enabled: false,
    });
    const service = new PlatformService(store);
    const specialist = await service.createAgent({
      name: "Truex",
      modelProfileId: "default",
      systemPrompt: "Only discuss finance.",
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => service.agents()),
    );
    for (const response of responses) {
      const defaults = response.filter((a) => a.isDefault);
      assert.equal(defaults.length, 1);
      assert.equal(defaults[0].id, DEFAULT_CHAT_AGENT_ID);
      assert.equal(
        response.find((a) => a.id === specialist.id)?.isDefault,
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(response),
        /private-key|test-fixture-key/,
      );
    }
    assert.equal(
      await store.agents.countDocuments({ _id: DEFAULT_CHAT_AGENT_ID }),
      1,
    );
    const stored = await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID });
    assert.equal(stored?.modelProfileId, "aaa");
    assert.equal(stored?.scope, "general");
    assert.equal(stored?.handle, undefined); // Existing @truex specialist is preserved.
    assert.deepEqual(stored?.mcpProfileIds, []);
    assert.deepEqual(stored?.skillIds, []);
    assert.equal(
      (await store.agents.findOne({ _id: specialist.id }))?.systemPrompt,
      "Only discuss finance.",
    );

    const tenant = {
      id: "restricted",
      dbName: "truex_t_restricted",
      allowedModelIds: ["default"],
    };
    await store.withTenant(tenant as any, async () => {
      const [general] = await service.agents();
      assert.equal(general.isDefault, true);
      assert.equal(general.model, "gpt-5");
      assert.equal(
        (await store.agents.findOne({ _id: general.id }))?.modelProfileId,
        "default",
      );
      await store.agents.updateOne(
        { _id: general.id },
        { $set: { systemPrompt: "Custom general instructions" } },
      );
      await service.agents();
      assert.equal(
        (await store.agents.findOne({ _id: general.id }))?.systemPrompt,
        "Custom general instructions",
      );
      await store.agents.updateOne(
        { _id: general.id },
        { $set: { enabled: false } },
      );
      assert.deepEqual(await service.agents(), []);
      assert.equal(
        (await store.agents.findOne({ _id: general.id }))?.enabled,
        false,
      );
    });
    await store.withTenant(
      { ...tenant, allowedModelIds: [] } as any,
      async () => {
        assert.deepEqual(await service.agents(), []);
      },
    );
    await store.withTenant(
      { id: "empty", dbName: "truex_t_empty", allowedModelIds: [] } as any,
      async () => {
        assert.deepEqual(await service.agents(), []);
        assert.equal(await store.agents.countDocuments(), 0);
      },
    );
    // A newly available earlier profile must not silently change the saved model.
    await store.profiles.insertOne({ ...profile, _id: "000-new" });
    await service.agents();
    assert.equal(
      (await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID }))
        ?.modelProfileId,
      "aaa",
    );
    await store.withTenant(
      {
        id: "default",
        dbName: store.database,
        allowedModelIds: ["default"],
      } as any,
      async () => {
        assert.equal(
          (await service.agents()).some((a) => a.isDefault),
          false,
        );
        assert.equal(
          (await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID }))
            ?.modelProfileId,
          "aaa",
        );
      },
    );
    await store.profiles.deleteOne({ _id: "aaa" });
    assert.equal(
      (await service.agents()).some((a) => a.isDefault),
      false,
    );
    assert.equal(
      (await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID }))
        ?.modelProfileId,
      "aaa",
    );
  },
);

test(
  "agent configuration edits persist without changing identity or runtime policy",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "agent-edit-test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store);
    const created = await service.createAgent({
      name: "Research Scout",
      modelProfileId: "default",
      systemPrompt: "Cite sources.",
    });
    await store.agents.updateOne(
      { _id: created.id },
      {
        $set: {
          persona: "private persona",
          scope: "business",
          skillIds: ["skill"],
          mcpProfileIds: ["mcp"],
        },
      },
    );
    await store.skills.insertOne({
      _id: "skill",
      name: "test-skill",
      description: "Fixture",
      body: "Fixture instructions",
      version: 1,
    });
    const config = await service.agentConfiguration(created.id);
    assert.equal(config.version, 0);
    assert.equal(config.systemPrompt, "Cite sources.");
    assert.doesNotMatch(
      JSON.stringify(config),
      /private persona|test-fixture-key|apiKey|baseUrl|skillIds|mcpProfileIds|approvalPolicy/,
    );
    await store.profiles.insertOne({
      _id: "alternate",
      provider: "other-provider",
      modelName: "other-model",
      baseUrl: "http://127.0.0.1:1/v1",
      apikey: "private-alternate-key",
      wireApi: "responses",
    });
    const fields = {
      name: "Renamed Researcher",
      description: "Research",
      systemPrompt: "  Answer general questions too.  ",
      look: 5,
      tint: "mint",
      modelProfileId: "alternate",
      version: config.version,
    };
    const updated = await service.updateAgent(created.id, fields);
    assert.equal(updated.id, created.id);
    assert.equal(updated.handle, "researchscout");
    assert.equal(updated.name, fields.name);
    assert.equal(updated.systemPrompt, "Answer general questions too.");
    assert.equal(updated.version, 1);
    assert.equal(updated.model, "other-model");
    assert.equal(updated.provider, "other-provider");
    const runtime = await service.configuration(created.id);
    assert.equal(runtime.model, "other-model");
    assert.match(runtime.baseInstructions, /Answer general questions too\./);
    assert.deepEqual(await service.agentConfiguration(created.id), updated);
    assert.equal(
      (await service.agents()).find((a) => a.id === created.id)?.tint,
      "mint",
    );
    const stored = await store.agents.findOne({ _id: created.id });
    assert.equal(stored?.scope, "business");
    assert.equal(stored?.persona, "private persona");
    assert.equal(stored?.sandbox, "read-only");
    assert.equal(stored?.approvalPolicy, "on-request");
    assert.deepEqual(stored?.skillIds, ["skill"]);
    assert.deepEqual(stored?.mcpProfileIds, ["mcp"]);

    await assert.rejects(service.updateAgent(created.id, fields), {
      code: "AGENT_CONFIG_CONFLICT",
      status: 409,
    });
    for (const patch of [
      { version: -1 },
      { version: 1.5 },
      { version: undefined },
      { name: "" },
      { systemPrompt: 42 },
      { systemPrompt: "x".repeat(20001) },
      { look: 12 },
      { tint: "red" },
      { handle: "new-handle" },
      { builtin: true },
      { isDefault: true },
      { sandbox: "danger-full-access" },
      { persona: "overwrite" },
      { scope: "general" },
    ]) {
      await assert.rejects(
        service.updateAgent(created.id, { ...fields, version: 1, ...patch }),
        { code: "INVALID_INPUT" },
      );
    }
    await assert.rejects(
      service.updateAgent(created.id, {
        ...fields,
        version: 1,
        modelProfileId: "missing",
      }),
      { code: "MODEL_UNAVAILABLE" },
    );
    assert.equal((await service.agentConfiguration(created.id)).version, 1);
    const races = await Promise.allSettled([
      service.updateAgent(created.id, { ...fields, version: 1, name: "First" }),
      service.updateAgent(created.id, {
        ...fields,
        version: 1,
        name: "Second",
      }),
    ]);
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (races.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.code,
      "AGENT_CONFIG_CONFLICT",
    );
    assert.equal((await service.agentConfiguration(created.id)).version, 2);

    const tenant = { id: "isolated", dbName: "truex_t_edit_isolated" };
    await store.withTenant(tenant, async () => {
      await assert.rejects(service.agentConfiguration(created.id), {
        status: 404,
      });
      await assert.rejects(service.updateAgent(created.id, fields), {
        status: 404,
      });
      const other = await service.createAgent({
        name: "Research Scout",
        modelProfileId: "default",
      });
      await service.updateAgent(other.id, { ...fields, version: 0 });
    });
    assert.equal((await service.agentConfiguration(created.id)).version, 2);
    await store.withTenant({ ...tenant, allowedModelIds: [] }, async () => {
      const other = await store.agents.findOne({ handle: "researchscout" });
      await assert.rejects(
        service.updateAgent(String(other!._id), { ...fields, version: 1 }),
        { code: "MODEL_UNAVAILABLE" },
      );
    });
    await service.agents();
    await assert.rejects(service.agentConfiguration(DEFAULT_CHAT_AGENT_ID), {
      status: 403,
      code: "AGENT_READ_ONLY",
    });
    await assert.rejects(service.updateAgent(DEFAULT_CHAT_AGENT_ID, fields), {
      status: 403,
      code: "AGENT_READ_ONLY",
    });
    await store.agents.updateOne(
      { _id: created.id },
      { $set: { enabled: false } },
    );
    await assert.rejects(service.agentConfiguration(created.id), {
      status: 404,
    });
    await assert.rejects(service.updateAgent(created.id, fields), {
      status: 404,
    });
  },
);
