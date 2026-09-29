import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { POLICY_VERSION } from "../src/public";
import { verifyGatewayToken } from "../src/model-route";
import { DEFAULT_TENANT_ID, tenantDbName, type TenantRef } from "../src/tenant";
import type { Session } from "../../shared/contracts";

const HOST = "http://core";

function tenantDoc(id: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    _id: id,
    name: id.toUpperCase(),
    dbName: tenantDbName(id),
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function session(_id: string, threadId: string): Session {
  return {
    _id,
    runtimePolicyVersion: POLICY_VERSION,
    agentId: "assistant",
    threadId,
    agentCoreHost: HOST,
    status: "active",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    approvals: [],
    timings: [],
  };
}

test(
  "tenancy: isolated tenant data, shared catalog, allow-lists, skills, gateway token, poll",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "truex",
      "truex_catalog",
    ).connect();
    const saved = { ...process.env };
    t.after(async () => {
      process.env = saved;
      await store.client.close();
      await mongo.stop();
    });
    await store.tenantRegistry.insertMany([
      tenantDoc("acme"),
      tenantDoc("globex", { allowedModelIds: ["other"] }),
      tenantDoc("initech", { status: "disabled" }),
    ]);
    await store.profiles.insertMany([
      {
        _id: "default",
        provider: "fixture",
        baseUrl: "http://127.0.0.1:1/v1",
        modelName: "gpt-5",
        apiKey: "k",
        wireApi: "responses",
      },
      {
        _id: "claude",
        provider: "Anthropic",
        baseUrl: "https://api.anthropic.example",
        modelName: "claude-sonnet-5",
        apiKey: "gateway-secret",
        wireApi: "anthropic",
      },
    ] as any);
    await store.skills.insertMany([
      {
        _id: "sk-report",
        name: "report",
        description: "Writes reports",
        body: "# Report",
        version: 2,
      },
      {
        _id: "sk-off",
        name: "off",
        description: "Disabled",
        body: "x",
        version: 1,
        enabled: false,
      },
    ]);

    // Registry: unknown and disabled tenants are refused; default needs no row.
    await assert.rejects(store.resolveTenant("nobody"), {
      status: 403,
      code: "TENANT_NOT_FOUND",
    });
    await assert.rejects(store.resolveTenant("initech"), {
      status: 403,
      code: "TENANT_DISABLED",
    });
    const def = await store.resolveTenant(DEFAULT_TENANT_ID);
    assert.deepEqual(def, { id: DEFAULT_TENANT_ID, dbName: "truex" });
    const a: TenantRef = await store.resolveTenant("acme");
    const b: TenantRef = await store.resolveTenant("globex");
    assert.equal(a.dbName, "truex_t_acme");
    assert.deepEqual(b.allowedModelIds, ["other"]);

    const service = new PlatformService(store, [HOST]);
    const threads: any[] = [];
    let recordCalls: string[] = [];
    const fetchMock = t.mock.method(globalThis, "fetch");
    fetchMock.mock.mockImplementation(async (url: any, init: any) => {
      const path = String(url).slice(HOST.length);
      const reply = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (path === "/threads") {
        threads.push(JSON.parse(init.body));
        return reply({ threadId: "thread-" + threads.length });
      }
      const records = path.match(/^\/threads\/([^/]+)\/records$/);
      if (records) {
        recordCalls.push(records[1]);
        return reply([
          {
            key: "k1",
            event: {
              type: "message.final",
              turnId: "turn-1",
              itemId: "i1",
              at: new Date().toISOString(),
              data: { text: "from " + records[1], messageIndex: 0 },
            },
          },
        ]);
      }
      return reply({});
    });

    // Tenant A creates an agent, project and session.
    const agent = {
      _id: "assistant",
      name: "Assistant",
      modelProfileId: "default",
      systemPrompt: "Help.",
      mcpProfileIds: [],
    };
    const created = await store.withTenant(a, async () => {
      await store.agents.insertOne({ ...agent, skillIds: ["sk-report"] });
      const project = await service.createProject("Alpha");
      const s = await service.create("assistant", undefined, project._id);
      return { project, session: s };
    });
    assert.equal(threads[0].tenantId, "acme");
    assert.deepEqual(threads[0].skills, [
      {
        name: "report",
        description: "Writes reports",
        body: "# Report",
        version: 2,
      },
    ]);
    const stored = await store.client
      .db("truex_t_acme")
      .collection<Session>("sessions")
      .findOne({ _id: created.session._id });
    assert.equal(stored?.projectId, created.project._id);
    const threadA = stored!.threadId;

    // Tenant B sees none of it and gets the same 404s as for unknown ids.
    await store.withTenant(b, async () => {
      assert.deepEqual(await service.agents(), []);
      assert.deepEqual(await service.projects(), []);
      assert.deepEqual(await service.sessions(), []);
      await assert.rejects(service.configuration("assistant"), {
        status: 404,
        code: "AGENT_NOT_FOUND",
      });
      await assert.rejects(service.agentMcp("assistant"), {
        status: 404,
        code: "AGENT_NOT_FOUND",
      });
      await assert.rejects(service.project(created.project._id), {
        status: 404,
        code: "PROJECT_NOT_FOUND",
      });
      await assert.rejects(service.renameProject(created.project._id, "x"), {
        status: 404,
        code: "PROJECT_NOT_FOUND",
      });
      await assert.rejects(service.session(created.session._id), {
        status: 404,
        code: "SESSION_NOT_FOUND",
      });
      await assert.rejects(
        service.setSessionProject(created.session._id, null),
        { status: 404 },
      );
    });
    // Nor does the default tenant.
    assert.deepEqual(await service.projects(), []);
    await assert.rejects(service.session(created.session._id), {
      status: 404,
    });

    // Models are shared: tenant A lists the catalog model; B's allow-list
    // hides it, so its agent cannot be configured.
    await store.withTenant(a, async () => {
      const [listed] = await service.agents();
      assert.equal(listed.model, "gpt-5");
    });
    await store.withTenant(b, async () => {
      await store.agents.insertOne({ ...agent });
      await assert.rejects(service.configuration("assistant"), {
        status: 422,
        code: "MODEL_CONFIGURATION",
      });
    });

    // Missing, disabled and not-allowed skills fail the configuration.
    await store.withTenant(a, async () => {
      for (const id of ["sk-missing", "sk-off"]) {
        await store.agents.updateOne(
          { _id: "assistant" },
          { $set: { skillIds: ["sk-report", id] } },
        );
        await assert.rejects(service.configuration("assistant"), {
          status: 422,
          code: "SKILL_CONFIGURATION",
          message: `Skill missing: ${id}`,
        });
      }
      await store.agents.updateOne(
        { _id: "assistant" },
        { $set: { skillIds: [] } },
      );
      const config = await service.configuration("assistant");
      assert.equal("skills" in config, false);
      assert.equal(config.tenantId, "acme");
    });
    await store.withTenant(
      { ...a, allowedSkillIds: ["sk-other"] },
      async () => {
        await store.agents.updateOne(
          { _id: "assistant" },
          { $set: { skillIds: ["sk-report"] } },
        );
        await assert.rejects(service.configuration("assistant"), {
          code: "SKILL_CONFIGURATION",
        });
      },
    );

    // The default tenant works unregistered, on the pre-tenancy database.
    await store.agents.insertOne({
      ...agent,
      _id: "gw",
      modelProfileId: "claude",
    });
    await store.agents.insertOne({ ...agent });
    const plain = await service.configuration("assistant");
    assert.equal(plain.tenantId, DEFAULT_TENANT_ID);
    assert.equal(
      await store.client
        .db("truex")
        .collection("truex_agents")
        .countDocuments(),
      2,
    );

    // Gateway tokens name the tenant; the default one included.
    process.env.MODEL_GATEWAY_URL = "http://gateway.internal:4200";
    process.env.MODEL_GATEWAY_SECRET = "hmac-secret";
    const token = async () =>
      (await service.configuration("gw")).config[
        "model_providers.profile_claude"
      ].experimental_bearer_token;
    assert.deepEqual(verifyGatewayToken(await token(), "hmac-secret"), {
      profileId: "claude",
      tenantId: DEFAULT_TENANT_ID,
    });
    await store.withTenant(a, async () => {
      await store.agents.insertOne({
        ...agent,
        _id: "gw",
        modelProfileId: "claude",
      });
      assert.deepEqual(verifyGatewayToken(await token(), "hmac-secret"), {
        profileId: "claude",
        tenantId: "acme",
      });
    });

    // poll() ingests each active tenant's sessions into its own database;
    // the disabled tenant is skipped.
    await store.sessions.insertOne(session("s-default", "t-default"));
    await store.withTenant(b, () =>
      store.sessions.insertOne(session("s-globex", "t-globex")),
    );
    await store.client
      .db(tenantDbName("initech"))
      .collection<Session>("sessions")
      .insertOne(session("s-initech", "t-initech"));
    recordCalls = [];
    await service.poll();
    assert.deepEqual(
      recordCalls.sort(),
      [threadA, "t-default", "t-globex"].sort(),
    );
    const texts = async (dbName: string) =>
      (await store.client.db(dbName).collection("messages").find().toArray())
        .map((m) => m.text)
        .sort();
    assert.deepEqual(await texts("truex"), ["from t-default"]);
    assert.deepEqual(await texts("truex_t_globex"), ["from t-globex"]);
    assert.deepEqual(await texts("truex_t_acme"), ["from " + threadA]);
    assert.deepEqual(await texts("truex_t_initech"), []);
  },
);
