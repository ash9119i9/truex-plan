import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { insertFixtures } from "./fixtures";

test("legacy MCP attachments require migration instead of silently starting without tools", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "legacy_mcp").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await insertFixtures(store);
  const service = new PlatformService(store, ["http://core"]);
  const id = new ObjectId();
  await store.mcp.insertOne({
    _id: id,
    name: "qlik",
    url: "https://example.com/mcp",
    apiKey: "legacy-secret",
    enabled: true,
  });
  await store.agents.updateOne(
    { _id: "assistant" },
    { $set: { mcpProfileIds: [id.toHexString(), "missing"] } },
  );
  await assert.rejects(service.configuration("assistant"), {
    status: 422,
    code: "MCP_MIGRATION_REQUIRED",
  });
  // A legacy reference on another agent does not block a clean agent.
  assert.ok(
    !(await service.configuration("developer")).config["mcp_servers.qlik"],
  );
  await store.mcp.updateOne({ _id: id }, { $set: { enabled: false } });
  assert.ok(
    !(await service.configuration("assistant")).config["mcp_servers.qlik"],
  );
  await store.mcp.updateOne(
    { _id: id },
    { $set: { scope: "tenant", agentIds: ["assistant"], enabled: true } },
  );
  assert.equal(
    (await service.configuration("assistant")).config["mcp_servers.qlik"]
      .http_headers.Authorization,
    "Bearer legacy-secret",
  );
  // The migration leaves legacy references behind. Detachment must still work.
  await store.mcp.updateOne({ _id: id }, { $set: { agentIds: [] } });
  assert.ok(
    !(await service.configuration("assistant")).config["mcp_servers.qlik"],
  );
  await store.mcp.updateOne(
    { _id: id },
    { $set: { scope: "user", ownerId: "other", agentIds: ["assistant"] } },
  );
  assert.ok(
    !(await service.configuration("assistant", { ownerId: "ashok" })).config[
      "mcp_servers.qlik"
    ],
  );
});
