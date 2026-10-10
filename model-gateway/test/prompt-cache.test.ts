import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGateway, type GatewayProfile } from "../src/server";
import { signGatewayToken } from "../../shared/gateway-token";
import { cachePolicyError, chatCacheOptions } from "../src/prompt-cache";
import { toChatRequest } from "../src/adapters/chat";
import { toAnthropicRequest } from "../src/adapters/anthropic";
import { streamAnthropic } from "../src/adapters/anthropic";
import { ResponsesStream } from "../src/responses";
import { ToolNames } from "../src/tool-names";
import { accessLogLine } from "../src/logging";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";

const fixture = {
  instructions: "Stable instructions",
  prompt_cache_key: "session-one",
  tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
  input: [
    { role: "user", content: [{ type: "input_text", text: "Question" }] },
  ],
};
const scope = { profileId: "p", tenantId: "acme" };
const stripCache = (value: any): any => {
  if (Array.isArray(value)) return value.map(stripCache);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "cache_control")
        .map(([k, v]) => [k, stripCache(v)]),
    );
  return value;
};

test("cache policies reject invalid stored settings without echoing values", () => {
  for (const [value, wire] of [
    [null, "chat"],
    [{ type: "chat" }, "gemini"],
    [{ type: "chat", keyScope: "secret-value" }, "chat"],
    [{ type: "chat", retention: 24 }, "chat"],
    [{ type: "chat", retention: ["24h"] }, "chat"],
    [{ type: "chat", keyScope: ["prefix"] }, "chat"],
    [{ type: "chat", retention: { toString: "secret-value" } }, "chat"],
    [{ type: "anthropic", ttl: "24h" }, "anthropic"],
    [{ type: "anthropic", ttl: ["1h"] }, "anthropic"],
    [{ type: "anthropic", enabled: "false" }, "anthropic"],
    [{ type: "anthropic", conversationBreakpoint: 1 }, "anthropic"],
    [{ type: "anthropic", unknown: "secret-value" }, "anthropic"],
  ] as const) {
    const error = cachePolicyError(value, wire);
    assert.ok(error);
    assert.ok(!error.includes("secret-value"));
  }
  assert.equal(cachePolicyError(undefined, "gemini"), null);
  assert.equal(
    cachePolicyError({ type: "chat", retention: "24h" }, "chat"),
    null,
  );
  assert.equal(
    cachePolicyError({ type: "anthropic", ttl: "1h" }, "anthropic"),
    null,
  );
});

test("Anthropic logs write TTLs and uncached input; absent provider counters stay unknown", async () => {
  for (const usage of [
    {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_creation: {
        ephemeral_5m_input_tokens: 12,
        ephemeral_1h_input_tokens: 8,
      },
    },
    { input_tokens: 10, output_tokens: 2 },
  ]) {
    const socket = new PassThrough();
    const res = new ServerResponse(new IncomingMessage(socket as any));
    res.assignSocket(socket as any);
    const events = [
      { type: "message_start", message: { usage } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "answer" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    async function* source() {
      for (const e of events) yield e as any;
    }
    await streamAnthropic(source(), new ResponsesStream(res), new ToolNames());
    const log = JSON.parse(
      accessLogLine({ requestId: "test" }, res, performance.now() - 100),
    );
    if ("cache_creation_input_tokens" in usage) {
      assert.equal(log.usage.input_tokens, 130);
      assert.equal(log.usage.cached_tokens, 100);
      assert.equal(log.usage.cache_write_tokens, 20);
      assert.equal(log.usage.cache_write_5m_tokens, 12);
      assert.equal(log.usage.cache_write_1h_tokens, 8);
      assert.equal(log.usage.uncached_input_tokens, 10);
    } else {
      assert.equal(log.usage.input_tokens, 10);
      for (const key of [
        "cached_tokens",
        "cache_write_tokens",
        "uncached_input_tokens",
      ])
        assert.ok(!(key in log.usage));
    }
    assert.ok(log.ttftMs >= 0);
    socket.destroy();
  }
});

test("Chat cache keys preserve prompt content and separate tenants, sessions and profiles", () => {
  const before = JSON.stringify(fixture);
  const { body } = toChatRequest(fixture, "model");
  const policy = { type: "chat" as const, retention: "24h" as const };
  const options = chatCacheOptions(policy, fixture, body, scope);
  assert.equal(options.prompt_cache_retention, "24h");
  assert.match(options.prompt_cache_key, /^truex:[a-f0-9]{64}$/);
  assert.equal(
    options.prompt_cache_key,
    chatCacheOptions(policy, fixture, body, scope).prompt_cache_key,
  );
  for (const other of [
    chatCacheOptions(policy, fixture, body, { ...scope, tenantId: "other" }),
    chatCacheOptions(policy, fixture, body, { ...scope, profileId: "other" }),
    chatCacheOptions(
      policy,
      { ...fixture, prompt_cache_key: "other" },
      body,
      scope,
    ),
    chatCacheOptions(policy, fixture, { ...body, model: "other" }, scope),
    chatCacheOptions(policy, fixture, { ...body, tools: [] }, scope),
  ])
    assert.notEqual(options.prompt_cache_key, other.prompt_cache_key);
  assert.equal(JSON.stringify(fixture), before);
  assert.deepEqual(body, toChatRequest(fixture, "model").body);
  assert.deepEqual(chatCacheOptions(undefined, fixture, body, scope), {});
  assert.deepEqual(chatCacheOptions(policy, {}, body, scope), {
    prompt_cache_retention: "24h",
  });
});

test("prefix keys reuse a prefix across questions without changing tool ordering", () => {
  const policy = { type: "chat" as const, keyScope: "prefix" as const };
  const { body } = toChatRequest(fixture, "model");
  const key = chatCacheOptions(policy, fixture, body, scope).prompt_cache_key;
  assert.equal(
    key,
    chatCacheOptions(
      policy,
      {},
      {
        ...body,
        messages: [
          body.messages[0],
          { role: "user", content: "Different question" },
        ],
      },
      scope,
    ).prompt_cache_key,
  );
  assert.notEqual(
    key,
    chatCacheOptions(
      policy,
      {},
      {
        ...body,
        messages: [{ role: "system", content: "Different instructions" }],
      },
      scope,
    ).prompt_cache_key,
  );
});

test("Anthropic TTL, disabled caching and conversation breakpoints preserve all content", () => {
  const before = JSON.stringify(fixture);
  const baseline = toAnthropicRequest(fixture, { modelName: "claude" }).params;
  for (const policy of [
    {
      type: "anthropic" as const,
      ttl: "1h" as const,
      conversationBreakpoint: true,
    },
    { type: "anthropic" as const, enabled: false },
  ]) {
    const changed = toAnthropicRequest(fixture, {
      modelName: "claude",
      promptCache: policy,
    }).params;
    assert.deepEqual(stripCache(changed), stripCache(baseline));
    if (policy.enabled === false)
      assert.equal(JSON.stringify(changed).includes("cache_control"), false);
    else {
      assert.deepEqual(changed.cache_control, { type: "ephemeral", ttl: "1h" });
      assert.deepEqual(
        (changed.messages[0].content as any[])[0].cache_control,
        { type: "ephemeral", ttl: "1h" },
      );
    }
  }
  assert.equal(JSON.stringify(fixture), before);
});

test("gateway forwards opt-in cache controls using the signed tenant and rejects bad configuration", async () => {
  const secret = "s".repeat(32);
  const profile: GatewayProfile = {
    _id: "p",
    baseUrl: "https://provider.example/v1",
    modelName: "model",
    wireApi: "chat",
    apiKey: "secret",
    promptCache: { type: "chat", keyScope: "prefix", retention: "24h" },
  };
  const calls: any[] = [];
  const server = createGateway({
    secret,
    findProfile: async () => profile,
    fetch: (async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    }) as typeof fetch,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const send = (tenant?: string) =>
      fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/p/p/v1/responses`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${signGatewayToken("p", secret, tenant)}`,
          },
          body: JSON.stringify({ ...fixture, tenantId: "forged" }),
        },
      );
    for (const tenant of ["acme", "other"]) {
      const res = await send(tenant);
      assert.equal(res.status, 200);
      await res.text();
    }
    assert.notEqual(calls[0].prompt_cache_key, calls[1].prompt_cache_key);
    const plain = toChatRequest(fixture, "model").body;
    assert.deepEqual(calls[0].messages, plain.messages);
    assert.deepEqual(calls[0].tools, JSON.parse(JSON.stringify(plain.tools)));
    assert.equal(
      calls[0].prompt_cache_key,
      chatCacheOptions(profile.promptCache, fixture, plain, scope)
        .prompt_cache_key,
    );
    assert.equal((await send()).status, 422);
    profile.promptCache = { type: "chat", retention: "bad" } as any;
    assert.equal((await send("acme")).status, 422);
    assert.equal(calls.length, 2);
    delete profile.promptCache;
    await (await send("acme")).text();
    assert.ok(!("prompt_cache_key" in calls[2]));
    assert.ok(!("prompt_cache_retention" in calls[2]));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
