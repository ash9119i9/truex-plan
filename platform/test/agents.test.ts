import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { newAgent } from "../src/agents";
import { insertFixtures } from "./fixtures";

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

    // It works as a chat agent: instructions become the system prompt.
    const config = await service.configuration(created.id);
    assert.match(config.baseInstructions, /^Cite sources\./);

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
      service.createAgent({ name: "research-scout", modelProfileId: "default" }),
      { status: 409, code: "AGENT_HANDLE_TAKEN" },
    );
    for (const modelProfileId of ["nokey", "off", "missing"])
      await assert.rejects(
        service.createAgent({ name: "Other " + modelProfileId, modelProfileId }),
        { status: 422, code: "MODEL_UNAVAILABLE" },
      );

    // Handles are unique per tenant, and a tenant's allow-list is enforced.
    const other = { id: "acme", dbName: "truex_t_acme", allowedModelIds: ["x"] };
    await store.withTenant(other as any, async () => {
      assert.deepEqual(await service.models(), []);
      await assert.rejects(
        service.createAgent({ name: "Research Scout", modelProfileId: "default" }),
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
      assert.equal((await service.agents()).length, 1);
    });
    assert.equal(await store.agents.countDocuments({ handle: "researchscout" }), 1);
  },
);
