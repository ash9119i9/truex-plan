import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import {
  gatewaySettings,
  resolveRoute,
  signGatewayToken,
  verifyGatewayToken,
} from "../src/model-route";

const base = {
  _id: "m",
  provider: "p",
  baseUrl: "https://x/v1",
  modelName: "m",
};

test("resolveRoute: Responses stays direct, other wire APIs use the gateway", () => {
  for (const [input, expected] of [
    [{}, { wireApi: "responses", route: "direct" }],
    [{ wireApi: "responses" }, { wireApi: "responses", route: "direct" }],
    [{ wireApi: "chat" }, { wireApi: "chat", route: "gateway" }],
    [{ wireApi: "anthropic" }, { wireApi: "anthropic", route: "gateway" }],
    [{ wireApi: "gemini" }, { wireApi: "gemini", route: "gateway" }],
    [
      { wireApi: "responses", route: "gateway" },
      { wireApi: "responses", route: "gateway" },
    ],
  ] as const)
    assert.deepEqual(resolveRoute({ ...base, ...input }), expected);
  assert.throws(
    () => resolveRoute({ ...base, wireApi: "bogus" }),
    /unknown wireApi/,
  );
  assert.throws(
    () => resolveRoute({ ...base, route: "bogus" }),
    /unknown route/,
  );
  assert.throws(
    () => resolveRoute({ ...base, wireApi: "chat", route: "direct" }),
    /requires the model gateway/,
  );
});

test("gateway tokens: bound to profile, never expire, reject tampering", () => {
  const token = signGatewayToken("abc", "s3cret");
  assert.deepEqual(verifyGatewayToken(token, "s3cret"), { profileId: "abc" });
  assert.equal(verifyGatewayToken(token, "other"), null);
  const [, sig] = token.split(".");
  const forged =
    Buffer.from(JSON.stringify({ p: "xyz" })).toString("base64url") + "." + sig;
  assert.equal(verifyGatewayToken(forged, "s3cret"), null);
  assert.equal(verifyGatewayToken("garbage", "s3cret"), null);
  // Tokens issued with an expiry before this change keep working.
  const legacy = Buffer.from(JSON.stringify({ p: "abc", exp: 1 })).toString(
    "base64url",
  );
  const legacySig = createHmac("sha256", "s3cret")
    .update(legacy)
    .digest("base64url");
  assert.deepEqual(verifyGatewayToken(`${legacy}.${legacySig}`, "s3cret"), {
    profileId: "abc",
  });
  assert.equal(gatewaySettings({}), null);
  assert.equal(gatewaySettings({ MODEL_GATEWAY_URL: "http://g" }), null);
  assert.deepEqual(
    gatewaySettings({
      MODEL_GATEWAY_URL: "http://g/",
      MODEL_GATEWAY_SECRET: "k",
    }),
    { url: "http://g", secret: "k" },
  );
});

test(
  "configuration: direct profiles unchanged, gateway profiles never see the key",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create({
      instance: { dbName: "test" },
    });
    const store = await new Store(mongo.getUri(), "test").connect();
    const saved = { ...process.env };
    t.after(async () => {
      process.env = saved;
      await store.client.close();
      await mongo.stop();
    });
    await store.profiles.insertMany([
      {
        _id: "direct",
        provider: "OpenAI",
        baseUrl: "https://api.example/v1",
        modelName: "gpt-5",
        apiKey: "direct-secret",
        wireApi: "responses",
        reasoningEffort: "low",
        webSearch: "cached",
      },
      {
        _id: "claude",
        provider: "Anthropic",
        baseUrl: "https://api.anthropic.example",
        modelName: "claude-sonnet-5",
        apiKey: "gateway-secret",
        wireApi: "anthropic",
        contextWindow: 200000,
        autoCompactTokenLimit: 160000,
      },
    ] as any);
    await store.agents.insertMany([
      { _id: "a-direct", name: "D", modelProfileId: "direct" },
      { _id: "a-gateway", name: "G", modelProfileId: "claude" },
    ] as any);
    const service = new PlatformService(store);

    // Direct output must match the pre-gateway shape exactly, with or without a gateway.
    const expectedDirect = {
      web_search: "cached",
      "model_providers.profile_direct": {
        name: "OpenAI",
        base_url: "https://api.example/v1",
        wire_api: "responses",
        experimental_bearer_token: "direct-secret",
      },
      model_reasoning_effort: "low",
    };
    delete process.env.MODEL_GATEWAY_URL;
    delete process.env.MODEL_GATEWAY_SECRET;
    assert.deepEqual(
      (await service.configuration("a-direct")).config,
      expectedDirect,
    );
    await assert.rejects(
      service.configuration("a-gateway"),
      (e: any) => e.code === "GATEWAY_NOT_CONFIGURED",
    );

    process.env.MODEL_GATEWAY_URL = "http://gateway.internal:4200/";
    process.env.MODEL_GATEWAY_SECRET = "hmac-secret";
    assert.deepEqual(
      (await service.configuration("a-direct")).config,
      expectedDirect,
    );

    const gw = await service.configuration("a-gateway");
    assert.equal(gw.model, "claude-sonnet-5");
    assert.equal(gw.modelProvider, "profile_claude");
    assert.doesNotMatch(JSON.stringify(gw), /gateway-secret/);
    const p = gw.config["model_providers.profile_claude"];
    assert.equal(p.base_url, "http://gateway.internal:4200/p/claude/v1");
    assert.equal(p.wire_api, "responses");
    assert.deepEqual(
      verifyGatewayToken(p.experimental_bearer_token, "hmac-secret"),
      // Outside a registered tenant the thread belongs to "default".
      {
        profileId: "claude",
        tenantId: "default",
      },
    );
    assert.equal(gw.config.web_search, "disabled");
    assert.equal(gw.config.model_context_window, 200000);
    assert.equal(gw.config.model_auto_compact_token_limit, 160000);
  },
);
