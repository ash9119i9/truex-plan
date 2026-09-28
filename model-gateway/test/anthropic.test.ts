import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGateway, type GatewayProfile } from "../src/server";
import { signGatewayToken } from "../../shared/gateway-token";
import { encodeReasoning, toAnthropicRequest } from "../src/adapters/anthropic";

const secret = "a".repeat(32);

const profile: GatewayProfile = {
  _id: "claude",
  baseUrl: "https://api.anthropic.example/v1/",
  modelName: "claude-opus-5",
  wireApi: "anthropic",
  apiKey: "anthropic-secret",
};

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

// ---------- request translation ----------

test("toAnthropicRequest: system merge, tools, tool_use/tool_result pairing", () => {
  const { params, tools } = toAnthropicRequest(
    {
      instructions: "Base",
      tool_choice: "auto",
      reasoning: { effort: "high" },
      tools: [
        {
          type: "function",
          name: "shell",
          description: "Run",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
          },
        },
        {
          type: "namespace",
          name: "mcp__qlik__",
          tools: [{ type: "function", name: "list_apps" }],
        },
        { type: "web_search" },
        { type: "custom", name: "apply_patch" },
        { type: "tool_search" },
      ],
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Dev" }],
        },
        user("Hi"),
        {
          type: "function_call",
          call_id: "c1",
          name: "list_apps",
          namespace: "mcp__qlik__",
          arguments: '{"q":1}',
        },
        {
          type: "function_call",
          call_id: "c2",
          name: "shell",
          arguments: "not json",
        },
        { type: "function_call_output", call_id: "c1", output: "apps" },
        {
          type: "function_call_output",
          call_id: "c2",
          output: [{ type: "input_text", text: "ok" }],
        },
        { type: "function_call_output", call_id: "orphan", output: "dropped" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
        {
          type: "function_call",
          call_id: "c3",
          name: "shell",
          arguments: "{}",
        },
        // c3 was interrupted: the next user message follows without output.
        user("Next"),
      ],
    },
    { modelName: "claude-opus-5" },
  );
  assert.equal(params.model, "claude-opus-5");
  assert.equal(params.max_tokens, 64000);
  assert.equal(params.stream, true);
  assert.deepEqual(params.cache_control, { type: "ephemeral" });
  assert.equal(params.system, "Base\n\nDev");
  assert.deepEqual(params.tool_choice, { type: "auto" });
  assert.deepEqual(params.thinking, {
    type: "adaptive",
    display: "summarized",
  });
  assert.deepEqual(params.output_config, { effort: "high" });
  const sentTools = params.tools as any[];
  assert.deepEqual(
    sentTools.map((t) => t.name),
    ["shell", "mcp__qlik__list_apps"],
  );
  assert.deepEqual(sentTools[1].input_schema, {
    type: "object",
    properties: {},
  });
  assert.equal(sentTools[0].input_schema.properties.cmd.type, "string");
  assert.deepEqual(tools.fromProvider("mcp__qlik__list_apps"), {
    name: "list_apps",
    namespace: "mcp__qlik__",
  });

  const m = params.messages as any[];
  assert.deepEqual(
    m.map((x) => x.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  assert.deepEqual(m[0].content, [{ type: "text", text: "Hi" }]);
  assert.deepEqual(m[1].content, [
    {
      type: "tool_use",
      id: "c1",
      name: "mcp__qlik__list_apps",
      input: { q: 1 },
    },
    {
      type: "tool_use",
      id: "c2",
      name: "shell",
      input: { arguments: "not json" },
    },
  ]);
  // Both results in one user message, orphan dropped.
  assert.deepEqual(m[2].content, [
    { type: "tool_result", tool_use_id: "c1", content: "apps" },
    {
      type: "tool_result",
      tool_use_id: "c2",
      content: [{ type: "text", text: "ok" }],
    },
  ]);
  assert.deepEqual(m[3].content, [
    { type: "text", text: "Done" },
    { type: "tool_use", id: "c3", name: "shell", input: {} },
  ]);
  // Placeholder result leads the next user message.
  assert.deepEqual(m[4].content, [
    {
      type: "tool_result",
      tool_use_id: "c3",
      content: "No output: the call was interrupted.",
      is_error: true,
    },
    { type: "text", text: "Next" },
  ]);
});

test("toAnthropicRequest: images, first message is user, trailing call gets a placeholder", () => {
  const { params } = toAnthropicRequest(
    {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Earlier" }],
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Look" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            { type: "input_image", image_url: "https://img.example/a.jpg" },
            { type: "input_image", image_url: "file:///nope" },
          ],
        },
        { type: "function_call", call_id: "t1", name: "x", arguments: "" },
      ],
    },
    { modelName: "m", maxOutputTokens: 1234 },
  );
  assert.equal(params.max_tokens, 1234);
  assert.equal(params.tools, undefined);
  assert.equal(params.system, undefined);
  const m = params.messages as any[];
  assert.equal(m[0].role, "user");
  assert.equal(m[1].role, "assistant");
  assert.deepEqual(m[2].content, [
    { type: "text", text: "Look" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    },
    {
      type: "image",
      source: { type: "url", url: "https://img.example/a.jpg" },
    },
  ]);
  assert.deepEqual(m[3].content, [
    { type: "tool_use", id: "t1", name: "x", input: {} },
  ]);
  assert.equal(m[4].role, "user");
  assert.equal(m[4].content[0].is_error, true);
});

test("toAnthropicRequest: reasoning items put thinking blocks first, unmodified", () => {
  const thinking = [
    { type: "thinking", thinking: "Plan it", signature: "sig/+==" },
    { type: "redacted_thinking", data: "opaque" },
  ] as const;
  const { params } = toAnthropicRequest(
    {
      input: [
        user("Q"),
        {
          type: "reasoning",
          summary: [],
          encrypted_content: encodeReasoning([thinking[0]]),
        },
        {
          type: "reasoning",
          summary: [],
          encrypted_content: encodeReasoning([thinking[1]]),
        },
        {
          type: "reasoning",
          summary: [],
          encrypted_content: "gAAAA-openai-blob",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Calling" }],
        },
        { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c", output: "r" },
      ],
    },
    { modelName: "m" },
  );
  const m = params.messages as any[];
  assert.equal(m.length, 3);
  assert.deepEqual(m[1].content, [
    thinking[0],
    thinking[1],
    { type: "text", text: "Calling" },
    { type: "tool_use", id: "c", name: "f", input: {} },
  ]);
  assert.deepEqual(m[2].content, [
    { type: "tool_result", tool_use_id: "c", content: "r" },
  ]);
});

test("toAnthropicRequest: effort mapping, tool_choice and thinking:false", () => {
  const effort = (e: unknown) =>
    toAnthropicRequest(
      { reasoning: { effort: e }, input: [] },
      { modelName: "m" },
    ).params.output_config?.effort;
  assert.equal(effort("none"), "low");
  assert.equal(effort("minimal"), "low");
  for (const e of ["low", "medium", "high", "xhigh", "max"])
    assert.equal(effort(e), e);
  assert.equal(effort("bogus"), undefined);
  assert.equal(effort(undefined), undefined);

  const tools = [{ type: "function", name: "f" }];
  assert.deepEqual(
    toAnthropicRequest(
      { tools, tool_choice: "none", input: [] },
      { modelName: "m" },
    ).params.tool_choice,
    { type: "none" },
  );
  assert.equal(
    toAnthropicRequest(
      { tools, tool_choice: "required", input: [] },
      { modelName: "m" },
    ).params.tool_choice,
    undefined,
  );

  const off = toAnthropicRequest({ reasoning: { effort: "high" }, input: [] }, {
    modelName: "claude-haiku-4-5",
    thinking: false,
  } as any).params;
  assert.equal(off.thinking, undefined);
  assert.equal(off.output_config, undefined);
});

// ---------- gateway + stream translation ----------

type Call = { url: string; init: RequestInit };

async function withGateway(
  upstream: (call: Call) => Response | Promise<Response>,
  run: (
    post: (body?: unknown) => Promise<Response>,
    calls: Call[],
  ) => Promise<void>,
  p: GatewayProfile = profile,
) {
  const calls: Call[] = [];
  const server = createGateway({
    secret,
    findProfile: async (id) => (id === String(p._id) ? p : null),
    fetch: (async (url: any, init: any) => {
      const call = { url: String(url), init };
      calls.push(call);
      return upstream(call);
    }) as typeof fetch,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown = { input: [user("Hello")] }) =>
    fetch(`${base}/p/${p._id}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signGatewayToken(String(p._id), secret)}`,
      },
      body: JSON.stringify(body),
    });
  try {
    await run(post, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const sse = (events: object[], end = true) =>
  new Response(
    events
      .map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("") + (end ? "" : ""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

const start = (usage: object = { input_tokens: 10, output_tokens: 1 }) => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
  },
});
const delta = (
  stop_reason: string,
  usage: object = { output_tokens: 5 },
  stop_details: object | null = null,
) => ({
  type: "message_delta",
  delta: { stop_reason, stop_sequence: null, stop_details },
  usage,
});
const stop = { type: "message_stop" };

function parseEvents(text: string) {
  return text
    .split("\n\n")
    .filter((c) => c.includes("data: "))
    .map((c) => JSON.parse(c.slice(c.indexOf("data: ") + 6)));
}

test("anthropic: text + thinking + tool_use stream, headers, url and usage", async () => {
  await withGateway(
    () =>
      sse([
        start({
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          output_tokens: 1,
        }),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me " },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "check." },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "SIG123" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Checking" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: " files." },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp__qlik__list_apps",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"q":' },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"x"}' },
        },
        { type: "content_block_stop", index: 2 },
        delta("tool_use", { output_tokens: 42 }),
        stop,
      ]),
    async (post, calls) => {
      const res = await post({
        instructions: "Sys",
        tools: [
          {
            type: "namespace",
            name: "mcp__qlik__",
            tools: [{ type: "function", name: "list_apps" }],
          },
        ],
        input: [user("Hello")],
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, /anthropic-secret/);
      const events = parseEvents(text);
      assert.equal(calls[0].url, "https://api.anthropic.example/v1/messages");
      const headers = new Headers(calls[0].init.headers as any);
      assert.equal(headers.get("x-api-key"), "anthropic-secret");
      assert.equal(headers.get("authorization"), null);
      const sent = JSON.parse(String(calls[0].init.body));
      assert.equal(sent.system, "Sys");
      assert.equal(sent.stream, true);

      const done = events
        .filter((e) => e.type === "response.output_item.done")
        .map((e) => e.item);
      assert.deepEqual(
        done.map((i) => i.type),
        ["reasoning", "message", "function_call"],
      );
      assert.deepEqual(done[0].summary, [
        { type: "summary_text", text: "Let me check." },
      ]);
      const decoded = JSON.parse(
        Buffer.from(
          done[0].encrypted_content.slice("anthropic:v1:".length),
          "base64",
        ).toString(),
      );
      assert.deepEqual(decoded, [
        { type: "thinking", thinking: "Let me check.", signature: "SIG123" },
      ]);
      assert.equal(done[1].content[0].text, "Checking files.");
      assert.equal(done[2].call_id, "toolu_1");
      assert.equal(done[2].name, "list_apps");
      assert.equal(done[2].namespace, "mcp__qlik__");
      assert.equal(done[2].arguments, '{"q":"x"}');
      const completed = events.at(-1);
      assert.equal(completed.type, "response.completed");
      assert.deepEqual(completed.response.usage, {
        input_tokens: 130,
        output_tokens: 42,
        total_tokens: 172,
        input_tokens_details: { cached_tokens: 100 },
      });
    },
  );
});

test("anthropic: max_tokens drops an unfinished tool call and completes", async () => {
  await withGateway(
    () =>
      sse([
        start(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Hi" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t", name: "f", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"a":' },
        },
        { type: "content_block_stop", index: 1 },
        delta("max_tokens"),
        stop,
      ]),
    async (post) => {
      const events = parseEvents(await (await post()).text());
      assert.equal(events.at(-1).type, "response.completed");
      assert.ok(!events.some((e) => e.item?.type === "function_call"));
      assert.ok(
        events.some(
          (e) => e.type === "response.output_text.delta" && e.delta === "Hi",
        ),
      );
    },
  );
});

test("anthropic: refusal, context window stop, stream cut early and in-stream errors fail the stream", async () => {
  const cases: [Response, string, RegExp][] = [
    [
      sse([
        start(),
        delta(
          "refusal",
          { output_tokens: 1 },
          { type: "refusal", category: "cyber", explanation: "Nope" },
        ),
        stop,
      ]),
      "cyber_policy",
      /Nope/,
    ],
    [sse([start(), delta("refusal"), stop]), "cyber_policy", /declined/],
    [
      sse([start(), delta("model_context_window_exceeded"), stop]),
      "context_length_exceeded",
      /context window/,
    ],
    [
      sse([
        start(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "partial" },
        },
      ]),
      "server_error",
      /closed the stream early/,
    ],
    [
      new Response(
        `event: message_start\ndata: ${JSON.stringify(start())}\n\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
      "server_is_overloaded",
      /Overloaded/,
    ],
    [
      new Response(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Boom" } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
      "server_error",
      /Boom/,
    ],
  ];
  const queue = cases.map((c) => c[0]);
  await withGateway(
    () => queue.shift()!,
    async (post) => {
      for (const [, code, message] of cases) {
        const res = await post();
        assert.equal(res.status, 200);
        const last = parseEvents(await res.text()).at(-1);
        assert.equal(last.type, "response.failed");
        assert.equal(last.response.error.code, code);
        assert.match(last.response.error.message, message);
      }
    },
  );
});

test("anthropic: HTTP errors keep status, forward Retry-After, map 529 and prompt-too-long", async () => {
  const json = (
    status: number,
    type: string,
    message: string,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify({ type: "error", error: { type, message } }), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  const queue = [
    json(429, "rate_limit_error", "Slow down", { "retry-after": "7" }),
    json(529, "overloaded_error", "Overloaded"),
    json(
      400,
      "invalid_request_error",
      "prompt is too long: 250000 tokens > 200000 maximum",
    ),
    json(401, "authentication_error", "invalid x-api-key"),
    json(400, "invalid_request_error", "messages: bad"),
  ];
  await withGateway(
    () => queue.shift()!,
    async (post, calls) => {
      const limited = await post();
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "7");
      assert.deepEqual((await limited.json()).error, {
        message: "Slow down",
        type: "rate_limit_error",
        code: "rate_limit_error",
      });

      const overloaded = await post();
      assert.equal(overloaded.status, 503);
      assert.equal(
        (await overloaded.json()).error.code,
        "server_is_overloaded",
      );

      const tooLong = await post();
      assert.equal(tooLong.status, 200);
      const last = parseEvents(await tooLong.text()).at(-1);
      assert.equal(last.response.error.code, "context_length_exceeded");

      const auth = await post();
      assert.equal(auth.status, 401);
      assert.doesNotMatch(await auth.text(), /anthropic-secret/);

      const bad = await post();
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.message, "messages: bad");
      // maxRetries: 0 — one upstream call per Codex request.
      assert.equal(calls.length, 5);
    },
  );
});

test("anthropic: unreachable provider becomes 502; base URL without /v1 works", async () => {
  await withGateway(
    () => {
      throw new TypeError("fetch failed");
    },
    async (post, calls) => {
      const res = await post();
      assert.equal(res.status, 502);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.anthropic.example/v1/messages");
    },
    { ...profile, baseUrl: "https://api.anthropic.example" },
  );
});
