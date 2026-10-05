import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { insertFixtures } from "./fixtures";
import { PlatformService } from "../src/service";
import { PlatformReadCache } from "../src/cache";
import type { DomainEvent } from "../../shared/contracts";
test(
  "MongoDB: isolated fixtures, redacted summaries, idempotent final/decision/timing persistence",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create({
      instance: { dbName: "test" },
    });
    const store = await new Store(mongo.getUri(), "test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    await insertFixtures(store);
    assert.equal(await store.agents.countDocuments(), 2);
    await store.profiles.updateOne(
      { _id: "default" },
      { $set: { apikey: "secret-test-key" } },
    );
    let cacheTime = Date.now();
    const cache = new PlatformReadCache({
      now: () => cacheTime,
      jitter: () => 1,
    });
    const service = new PlatformService(
      store,
      undefined,
      undefined,
      undefined,
      cache,
    );
    t.after(() => service.stop());
    assert.equal(
      JSON.stringify(await service.agents()).includes("secret-test-key"),
      false,
    );
    await store.sessions.insertOne({
      _id: "s",
      agentId: "assistant",
      threadId: "t",
      agentCoreHost: "http://127.0.0.1:4100",
      status: "active",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
    });
    const event = {
      type: "message.final",
      threadId: "t",
      turnId: "turn",
      itemId: "item",
      seq: 1,
      cursor: "a:1",
      at: new Date().toISOString(),
      data: { text: "Final text" },
    } as DomainEvent;
    await Promise.all([store.persist("s", event), store.persist("s", event)]);
    assert.equal(await store.messages.countDocuments(), 1);
    const decision = {
      ...event,
      type: "approval.resolved",
      data: {
        requestId: "request",
        result: { decision: "decline" },
        reason: "expired",
      },
    } as DomainEvent;
    await store.persist("s", decision);
    await store.persist("s", decision);
    assert.equal(
      (await store.sessions.findOne({ _id: "s" }))?.approvals?.length,
      1,
    );
    await store.profiles.deleteOne({ _id: "default" });
    // Direct database writers have a bounded display TTL, but configuration
    // must immediately reject a missing profile even while the picker is warm.
    await assert.rejects(service.configuration("assistant"), {
      code: "MODEL_CONFIGURATION",
    });
    if (cache.enabled)
      assert.equal((await service.agents())[0].provider, "fixture");
    cacheTime += 15_000;
    assert.equal((await service.agents())[0].provider, "unknown");
  },
);

test(
  "truex document shapes: ObjectId references, database-only keys and HTTP MCP authentication",
  { timeout: 120000 },
  async (t) => {
    const { ObjectId } = await import("mongodb");
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "truex").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const modelId = new ObjectId(),
      mcpId = new ObjectId(),
      agentId = new ObjectId();
    await store.profiles.insertOne({
      _id: modelId,
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "fixture-model",
      apiKey: "database-model-secret",
    });
    await store.mcp.insertOne({
      _id: mcpId,
      name: "qlik",
      scope: "tenant",
      agentIds: [agentId.toHexString()],
      transport: "http",
      url: "https://mcp.example/mcp",
      apiKey: "database-mcp-secret",
      auth: { kind: "header", headerName: "x-api-qlik-key" },
      capabilities: { connectTimeoutMs: 30000, requestTimeoutMs: 120000 },
      enabled: true,
    });
    await store.agents.insertOne({
      _id: agentId,
      name: "User agent",
      modelProfileId: modelId.toHexString(),
      mcpProfileIds: [mcpId.toHexString()],
    });
    let cacheTime = Date.now();
    const cache = new PlatformReadCache({
      now: () => cacheTime,
      jitter: () => 1,
    });
    const service = new PlatformService(
        store,
        undefined,
        undefined,
        undefined,
        cache,
      ),
      summaries = await service.agents();
    t.after(() => service.stop());
    assert.equal(summaries[0].id, agentId.toHexString());
    assert.equal(summaries[0].model, "fixture-model");
    assert.doesNotMatch(
      JSON.stringify(summaries),
      /database-.*secret|apiKey|apikey/,
    );
    const config = await service.configuration(agentId.toHexString());
    assert.equal(config.sandbox, "read-only");
    assert.equal(config.approvalPolicy, "on-request");
    assert.equal(
      config.config[`model_providers.profile_${modelId}`]
        .experimental_bearer_token,
      "database-model-secret",
    );
    assert.deepEqual(config.config["mcp_servers.qlik"], {
      url: "https://mcp.example/mcp",
      http_headers: { "x-api-qlik-key": "database-mcp-secret" },
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    });
    await store.profiles.updateOne(
      { _id: modelId },
      { $set: { wireApi: "chat" } },
    );
    // Non-Responses profiles need the gateway; without it they fail clearly.
    await assert.rejects(
      service.configuration(agentId.toHexString()),
      /GATEWAY_NOT_CONFIGURED|gateway, which is not configured/,
    );
    await store.profiles.updateOne(
      { _id: modelId },
      { $set: { wireApi: "responses", enabled: false } },
    );
    await assert.rejects(service.configuration(agentId.toHexString()), {
      code: "MODEL_CONFIGURATION",
    });
    if (cache.enabled)
      assert.equal((await service.agents())[0].model, "fixture-model");
    cacheTime += 15_000;
    assert.equal((await service.agents())[0].model, "unknown");
  },
);
