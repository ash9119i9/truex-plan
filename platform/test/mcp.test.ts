import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { mcpConfig, newMcpProfile } from "../src/mcp";
import { insertFixtures } from "./fixtures";

test("MCP validation rejects unsupported transports, malformed auth and runtime config", () => {
  for (const input of [
    { transport: "sse", url: "https://example.com/sse" },
    { transport: "http", url: "file:///tmp/mcp" },
    { transport: "http", url: "https://user:secret@example.com" },
    {
      transport: "http",
      url: "https://example.com",
      auth: { kind: "header" },
      apiKey: "secret",
    },
    { transport: "http", url: "https://example.com", auth: { kind: "bearer" } },
    { transport: "stdio", command: "node", args: "bad" },
    { transport: "stdio", command: "node", env: { key: 42 } },
    {
      transport: "http",
      url: "https://example.com",
      capabilities: { requestTimeoutMs: -1 },
    },
    { config: { command: "node", url: "https://example.com" } },
  ])
    assert.throws(() =>
      mcpConfig({ _id: "test", name: "test", ...input } as any),
    );
  assert.deepEqual(
    mcpConfig(
      newMcpProfile({
        name: "sap",
        transport: "http",
        url: "https://example.com/mcp",
        auth: { kind: "bearer" },
        apiKey: "secret",
        capabilities: { requestTimeoutMs: 1500 },
      }),
    ),
    {
      url: "https://example.com/mcp",
      http_headers: { Authorization: "Bearer secret" },
      tool_timeout_sec: 1.5,
    },
  );
});

test(
  "MCP profiles persist, attach by ObjectId, isolate agents and never disclose credentials",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "mcp-test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store);
    const created = await service.createMcp({
      name: "sap",
      transport: "http",
      url: "https://example.com/mcp?secret=hidden",
      auth: { kind: "header", headerName: "x-api-key" },
      apiKey: "secret-value",
    });
    const localId = new ObjectId();
    await store.mcp.insertOne({
      _id: localId,
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { PASSWORD: "hidden-env" },
    });
    await assert.rejects(
      service.setAgentMcp("assistant", [created.id, String(localId)]),
      /Local command/,
    );
    await service.setAgentMcp("assistant", [created.id]);
    const listing = await service.agentMcp("assistant");
    assert.deepEqual(listing.profileIds, [created.id]);
    assert.doesNotMatch(JSON.stringify(listing), /secret|hidden|server.js/);

    await service.setAgentMcp("assistant", [created.id]);
    const config = await service.configuration("assistant");
    assert.equal(
      config.config["mcp_servers.sap"].http_headers["x-api-key"],
      "secret-value",
    );

    assert.match(
      config.baseInstructions,
      /discover and call the relevant tools/,
    );
    assert.match(
      config.baseInstructions,
      /Configured MCP server names for this agent: \["sap"\]/,
    );
    assert.doesNotMatch(config.baseInstructions, /secret|hidden|x-api-key/);
    assert.doesNotMatch(
      (await service.configuration("developer")).baseInstructions,
      /Configured MCP server names/,
    );
    assert.equal(
      Object.keys((await service.configuration("developer")).config).some((k) =>
        k.startsWith("mcp_servers"),
      ),
      false,
    );
    await assert.rejects(
      service.setAgentMcp("assistant", ["missing"]),
      /missing/,
    );
    const duplicate = await service.createMcp({
      name: "sap",
      transport: "http",
      url: "https://example.com/duplicate",
    });
    await assert.rejects(
      service.setAgentMcp("assistant", [created.id, duplicate.id]),
      /Duplicate/,
    );
    assert.deepEqual((await service.agentMcp("assistant")).profileIds, [
      created.id,
    ]);
    await store.mcp.updateOne(
      { _id: created.id },
      { $set: { enabled: false } },
    );
    await assert.rejects(service.configuration("assistant"), /disabled/);
    await service.setAgentMcp("assistant", []);
    assert.deepEqual((await service.agentMcp("assistant")).profileIds, []);
  },
);
