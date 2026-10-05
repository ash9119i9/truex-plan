import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createGateway,
  type GatewayOptions,
  type GatewayProfile,
} from "../src/server";
import { toChatRequest } from "../src/adapters/chat";
import { toAnthropicRequest } from "../src/adapters/anthropic";
import { toGeminiRequest } from "../src/adapters/gemini";
import { signGatewayToken } from "../../shared/gateway-token";

const secret = "s".repeat(32);
const profile: GatewayProfile = {
  _id: "model",
  baseUrl: "https://provider.example/v1",
  modelName: "test",
  wireApi: "chat",
  apiKey: "private-provider-key",
};
const user = (text: string) => ({
  role: "user",
  content: [{ type: "input_text", text }],
});
const finish = () =>
  new Response(
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

async function withGateway(
  p: GatewayProfile,
  flag: boolean,
  run: (
    post: (tenant?: string) => Promise<string>,
    calls: any[],
    logs: string[],
  ) => Promise<void>,
  upstream: () => Response = finish,
) {
  const calls: any[] = [],
    logs: string[] = [];
  const options: GatewayOptions = {
    secret,
    providerCacheControls: flag,
    findProfile: async () => p,
    log: (line) => logs.push(line),
    fetch: (async (_url: unknown, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return upstream();
    }) as typeof fetch,
  };
  const server = createGateway(options);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/p/model/v1/responses`;
  try {
    await run(
      async (tenant = "acme") => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${signGatewayToken("model", secret, tenant)}`,
          },
          body: JSON.stringify({
            instructions: "stable",
            input: [user("private prompt")],
            prompt_cache_key: "runtime-session",
            prompt_cache_retention: "24h",
          }),
        });
        assert.equal(response.status, 200);
        return response.text();
      },
      calls,
      logs,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("chat cache controls require both the feature flag and declared capabilities", async () => {
  for (const [flag, capability] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    await withGateway(
      {
        ...profile,
        ...(capability
          ? { promptCache: { key: true, retention: "24h" as const } }
          : {}),
      },
      flag,
      async (post, calls) => {
        await post();
        assert.equal(
          calls[0].prompt_cache_retention,
          flag && capability ? "24h" : undefined,
        );
        if (flag && capability)
          assert.match(calls[0].prompt_cache_key, /^[a-f0-9]{64}$/);
        else assert.equal(calls[0].prompt_cache_key, undefined);
        assert.ok(!JSON.stringify(calls).includes("runtime-session"));
      },
    );
  }
});

test("forwarded cache keys remain stable within a tenant and differ across tenants", async () => {
  await withGateway(
    { ...profile, promptCache: { key: true } },
    true,
    async (post, calls, logs) => {
      await post("acme");
      await post("acme");
      await post("other");
      assert.equal(calls[0].prompt_cache_key, calls[1].prompt_cache_key);
      assert.notEqual(calls[0].prompt_cache_key, calls[2].prompt_cache_key);
      assert.doesNotMatch(
        logs.join("\n"),
        /runtime-session|private prompt|private-provider-key/,
      );
    },
  );
});

test("invalid or transport-inapplicable capability fields are not forwarded", async () => {
  await withGateway(
    { ...profile, promptCache: { retention: "1h" as any, ttl: "1h" } },
    true,
    async (post, calls) => {
      await post();
      assert.equal(calls[0].prompt_cache_retention, undefined);
      assert.equal(calls[0].cache_control, undefined);
    },
  );
});

test("Anthropic explicit TTL is opt-in without affecting the existing automatic default", async () => {
  const upstream = () =>
    new Response(
      [
        {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "test",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 0 },
        },
        { type: "message_stop" },
      ]
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(""),
    );
  for (const flag of [false, true])
    await withGateway(
      {
        ...profile,
        wireApi: "anthropic",
        thinking: false,
        promptCache: { ttl: "1h" },
      },
      flag,
      async (post, calls) => {
        await post();
        const expected = { type: "ephemeral", ...(flag ? { ttl: "1h" } : {}) };
        assert.deepEqual(calls[0].cache_control, expected);
        assert.deepEqual(calls[0].system[0].cache_control, expected);
        assert.equal(calls[0].prompt_cache_retention, undefined);
      },
      upstream,
    );
});

test("cache-write counters survive provider translation, SSE and privacy-safe logs", async () => {
  const upstream = () =>
    new Response(
      [
        { choices: [{ delta: { content: "reply" }, finish_reason: "stop" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 10,
            total_tokens: 130,
            prompt_tokens_details: {
              cached_tokens: 70,
              cache_write_tokens: 20,
            },
          },
        },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("") + "data: [DONE]\n\n",
    );
  await withGateway(
    profile,
    false,
    async (post, _calls, logs) => {
      const text = await post();
      const completed = text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)))
        .find((e) => e.type === "response.completed");
      assert.deepEqual(completed.response.usage, {
        input_tokens: 120,
        output_tokens: 10,
        total_tokens: 130,
        input_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 },
      });
      await new Promise((r) => setImmediate(r));
      const access = logs
        .map((l) => JSON.parse(l))
        .find((l) => l.type === "access");
      assert.deepEqual(access.usage, {
        input_tokens: 120,
        output_tokens: 10,
        total_tokens: 130,
        cached_tokens: 70,
        cache_write_tokens: 20,
        uncached_input_tokens: 30,
      });
      assert.doesNotMatch(
        logs.join("\n"),
        /private prompt|private-provider-key|reply/,
      );
    },
    upstream,
  );
});

test("profile authority failure is a retryable503 without source details or dispatch", async () => {
  const logs: string[] = [];
  let dispatched = 0;
  const server = createGateway({
    secret,
    findProfile: async () => {
      throw new Error("private-source-credential");
    },
    log: (line) => logs.push(line),
    fetch: (async () => {
      dispatched++;
      return finish();
    }) as typeof fetch,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/p/model/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signGatewayToken("model", secret)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: [] }),
      },
    );
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /temporarily unavailable/);
    assert.equal(dispatched, 0);
    assert.doesNotMatch(body + logs.join("\n"), /private-source-credential/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("each adapter preserves the actual stable tools/system/history prefix as turns append", () => {
  const input = {
    instructions: "Guardrails and persona",
    reasoning: { effort: "low" },
    tools: [
      {
        type: "function",
        name: "list",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      {
        type: "namespace",
        name: "mcp__server",
        tools: [
          {
            type: "function",
            name: "read",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
    input: [
      user("first"),
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ],
  };
  const next = { ...input, input: [...input.input, user("second")] };
  const a = toChatRequest(input, "test"),
    b = toChatRequest(next, "test");
  assert.equal(JSON.stringify(a.body.tools), JSON.stringify(b.body.tools));
  assert.equal(
    JSON.stringify(a.body.messages),
    JSON.stringify(b.body.messages.slice(0, -1)),
  );
  assert.equal(
    JSON.stringify(a.body),
    JSON.stringify(toChatRequest(structuredClone(input), "test").body),
  );
  const ca = toAnthropicRequest(input, profile),
    cb = toAnthropicRequest(next, profile);
  assert.equal(
    JSON.stringify(ca.params.tools),
    JSON.stringify(cb.params.tools),
  );
  assert.equal(
    JSON.stringify(ca.params.system),
    JSON.stringify(cb.params.system),
  );
  assert.equal(
    JSON.stringify(ca.params.messages),
    JSON.stringify(cb.params.messages.slice(0, -1)),
  );
  const ga = toGeminiRequest(input, profile),
    gb = toGeminiRequest(next, profile);
  assert.equal(JSON.stringify(ga.body.tools), JSON.stringify(gb.body.tools));
  assert.equal(
    JSON.stringify(ga.body.systemInstruction),
    JSON.stringify(gb.body.systemInstruction),
  );
  assert.equal(
    JSON.stringify(ga.body.contents),
    JSON.stringify(gb.body.contents.slice(0, -1)),
  );
  const changed = toChatRequest(
    { ...input, instructions: "changed policy" },
    "test",
  );
  assert.notEqual(
    JSON.stringify(a.body.messages[0]),
    JSON.stringify(changed.body.messages[0]),
  );
});
