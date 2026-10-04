import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { publicEvent } from "../src/public";
import { insertFixtures } from "./fixtures";

test("built-in web search activity exposes status without queries or service data", () => {
  for (const [type, success, label] of [
    ["item.started", undefined, "Searching the web"],
    ["item.completed", true, "Web search finished"],
    ["item.completed", false, "Web search could not be completed"],
  ] as const) {
    const event = publicEvent({
      type,
      data: {
        item: {
          type: "dynamicToolCall",
          tool: "web_search",
          success,
          arguments: { query: "private search" },
          result: { url: "http://web-service.internal", secret: "service-key" },
        },
      },
    });
    assert.equal(event.type, "activity.updated");
    assert.deepEqual(event.data, { label });
    assert.doesNotMatch(JSON.stringify(event), /private|internal|service-key/);
  }
});

test(
  "default, live, cached and disabled models preserve search and read policies across provider routes",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "websearch-test").connect();
    const previousUrl = process.env.MODEL_GATEWAY_URL;
    const previousSecret = process.env.MODEL_GATEWAY_SECRET;
    process.env.MODEL_GATEWAY_URL = "http://gateway.internal";
    process.env.MODEL_GATEWAY_SECRET = "fixture-gateway-secret";
    t.after(async () => {
      if (previousUrl === undefined) delete process.env.MODEL_GATEWAY_URL;
      else process.env.MODEL_GATEWAY_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.MODEL_GATEWAY_SECRET;
      else process.env.MODEL_GATEWAY_SECRET = previousSecret;
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store);
    for (const [wireApi, route] of [
      ["responses", "direct"],
      ["responses", "gateway"],
      ["chat", "gateway"],
      ["anthropic", "gateway"],
      ["gemini", "gateway"],
    ] as const) {
      await store.profiles.updateOne(
        { _id: "default" },
        { $set: { wireApi, route }, $unset: { webSearch: "" } },
      );
      const enabled = await service.configuration("assistant");
      assert.equal(enabled.webSearchEnabled, true);
      assert.equal(enabled.webReadEnabled, true);
      assert.equal(enabled.webCrawlEnabled, true);
      if (wireApi !== "responses")
        assert.equal(enabled.config.web_search, "disabled");

      await store.profiles.updateOne(
        { _id: "default" },
        { $set: { webSearch: "live" } },
      );
      const live = await service.configuration("assistant");
      assert.equal(live.webSearchEnabled, true);
      assert.equal(live.webReadEnabled, true);
      assert.equal(live.webCrawlEnabled, true);
      assert.equal(
        live.config.web_search,
        wireApi === "responses" ? "live" : "disabled",
      );

      await store.profiles.updateOne(
        { _id: "default" },
        { $set: { webSearch: "cached" } },
      );
      const cached = await service.configuration("assistant");
      assert.equal(cached.webSearchEnabled, false);
      assert.equal(cached.webReadEnabled, true);
      assert.equal(cached.webCrawlEnabled, true);
      assert.equal(
        cached.config.web_search,
        wireApi === "responses" ? "cached" : "disabled",
      );

      await store.profiles.updateOne(
        { _id: "default" },
        { $set: { webSearch: "disabled" } },
      );
      const disabled = await service.configuration("assistant");
      assert.equal(disabled.webSearchEnabled, false);
      assert.equal(disabled.webReadEnabled, false);
      assert.equal(disabled.webCrawlEnabled, false);
      assert.equal(disabled.config.web_search, "disabled");
    }
  },
);
