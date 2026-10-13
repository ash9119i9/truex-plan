import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGateway, type GatewayProfile } from "../src/server";
import { signGatewayToken } from "../../shared/gateway-token";
import {
  decodeSignatures,
  encodeSignatures,
  toGeminiRequest,
} from "../src/adapters/gemini";

const secret = "s".repeat(32);
const sse = (...chunks: unknown[]) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");

const gemini: GatewayProfile = {
  _id: "gem",
  baseUrl: "https://gemini.example/v1beta/",
  modelName: "gemini-3-pro-preview",
  wireApi: "gemini",
  apiKey: "gemini-secret",
  maxOutputTokens: 4096,
};

async function withGateway(
  upstream: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: (
    post: (body?: unknown) => Promise<Response>,
    calls: { url: string; init: RequestInit }[],
  ) => Promise<void>,
  profile: GatewayProfile = gemini,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const server = createGateway({
    secret,
    findProfile: async (id) => (id === "gem" ? profile : null),
    fetch: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return upstream(String(url), init);
    }) as typeof fetch,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown = { input: [] }) =>
    fetch(`${base}/p/gem/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signGatewayToken("gem", secret)}`,
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

// Parses the gateway's Responses SSE into its events.
async function events(res: Response) {
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}
const doneItems = (evs: any[]) =>
  evs.filter((e) => e.type === "response.output_item.done").map((e) => e.item);

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

test("toGeminiRequest: system instruction, roles, tools, images and tool pairing", () => {
  const { body, tools } = toGeminiRequest(
    {
      instructions: "Base",
      tool_choice: "auto",
      reasoning: { effort: "high" },
      tools: [
        {
          type: "function",
          name: "conversation_files",
          description: "Files",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        {
          type: "namespace",
          name: "mcp__qlik__",
          tools: [{ type: "function", name: "list_apps" }],
        },
        { type: "web_search" },
        { type: "custom", name: "apply_patch" },
      ],
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Dev" }],
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Look" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            { type: "input_image", image_url: "https://x.example/a.png" },
          ],
        },
        user("More"),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Sure" }],
        },
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
          name: "conversation_files",
          arguments: "not json",
        },
        { type: "function_call_output", call_id: "c1", output: "apps" },
        { type: "function_call_output", call_id: "orphan", output: "drop" },
        // c2 never got output (interrupted): a placeholder is sent.
        user("Next"),
        { type: "function_call_output", call_id: "late", output: "drop" },
      ],
    },
    { modelName: "gemini-3-pro-preview", maxOutputTokens: 1000 },
  );
  assert.deepEqual(body.systemInstruction, {
    parts: [{ text: "Base\n\nDev" }],
  });
  assert.deepEqual(body.toolConfig, {
    functionCallingConfig: { mode: "AUTO" },
  });
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 1000,
    thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
  });
  const decls = body.tools[0].functionDeclarations;
  assert.deepEqual(
    decls.map((d: any) => d.name),
    ["conversation_files", "mcp__qlik__list_apps"],
  );
  assert.equal(decls[0].parametersJsonSchema.additionalProperties, false);
  assert.deepEqual(decls[1].parametersJsonSchema, {
    type: "object",
    properties: {},
  });
  assert.deepEqual(tools.fromProvider("mcp__qlik__list_apps"), {
    name: "list_apps",
    namespace: "mcp__qlik__",
  });
  assert.deepEqual(body.contents, [
    {
      role: "user",
      parts: [
        { text: "Look" },
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
        { text: "[Image not sent: only inline images are supported.]" },
        { text: "More" },
      ],
    },
    {
      role: "model",
      parts: [
        { text: "Sure" },
        {
          functionCall: {
            id: "c1",
            name: "mcp__qlik__list_apps",
            args: { q: 1 },
          },
        },
        {
          functionCall: {
            id: "c2",
            name: "conversation_files",
            args: { arguments: "not json" },
          },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "c1",
            name: "mcp__qlik__list_apps",
            response: { output: "apps" },
          },
        },
        {
          functionResponse: {
            id: "c2",
            name: "conversation_files",
            response: { output: "No output: the call was interrupted." },
          },
        },
        { text: "Next" },
      ],
    },
  ]);
});

test("toGeminiRequest: signatures round-trip; foreign reasoning is ignored", () => {
  const generated = "call_" + "a".repeat(32);
  const { body } = toGeminiRequest(
    {
      input: [
        user("Hi"),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Thinking aloud" }],
        },
        {
          type: "reasoning",
          summary: [],
          encrypted_content: encodeSignatures({
            signatures: { [generated]: "SIG_CALL" },
            textSignature: "SIG_TEXT",
          }),
        },
        { type: "reasoning", summary: [], encrypted_content: "openai-blob" },
        {
          type: "function_call",
          call_id: generated,
          name: "conversation_files",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: generated, output: "none" },
      ],
    },
    { modelName: "gemini-2.5-flash" },
  );
  assert.deepEqual(body.contents[1], {
    role: "model",
    parts: [
      { text: "Thinking aloud", thoughtSignature: "SIG_TEXT" },
      // Ids the gateway invented are not sent back to Gemini.
      {
        functionCall: { name: "conversation_files", args: {} },
        thoughtSignature: "SIG_CALL",
      },
    ],
  });
  assert.deepEqual(body.contents[2].parts[0], {
    functionResponse: {
      name: "conversation_files",
      response: { output: "none" },
    },
  });
  assert.equal(decodeSignatures("openai-blob"), null);
  // Gemini 2.x takes a budget instead of a level, and no effort means no budget.
  assert.deepEqual(body.generationConfig, {
    thinkingConfig: { includeThoughts: true },
  });
  const budget = toGeminiRequest(
    { input: [], reasoning: { effort: "low" } },
    { modelName: "gemini-2.5-pro" },
  ).body;
  assert.equal(budget.generationConfig.thinkingConfig.thinkingBudget, 1024);
  const off = toGeminiRequest(
    { input: [], reasoning: { effort: "low" } },
    { modelName: "gemini-3-pro", thinking: false },
  ).body;
  assert.equal(off.generationConfig, undefined);
});

test("gemini: streams text with usage to the right URL with the api key", async () => {
  await withGateway(
    () =>
      new Response(
        sse(
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "He" }] } },
            ],
          },
          {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "llo" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 3,
              cachedContentTokenCount: 4,
              thoughtsTokenCount: 2,
              totalTokenCount: 15,
            },
          },
        ),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    async (post, calls) => {
      const res = await post({ instructions: "Be brief", input: [user("Hi")] });
      assert.equal(res.status, 200);
      const evs = await events(res);
      assert.equal(
        evs
          .filter((e) => e.type === "response.output_text.delta")
          .map((e) => e.delta)
          .join(""),
        "Hello",
      );
      const done = evs.at(-1);
      assert.equal(done.type, "response.completed");
      assert.deepEqual(done.response.usage, {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 2 },
      });
      assert.equal(
        calls[0].url,
        "https://gemini.example/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse",
      );
      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers["x-goog-api-key"], "gemini-secret");
      assert.equal(headers.Authorization, undefined);
      const sent = JSON.parse(String(calls[0].init.body));
      assert.equal(sent.generationConfig.maxOutputTokens, 4096);
      assert.deepEqual(sent.contents, [
        { role: "user", parts: [{ text: "Hi" }] },
      ]);
    },
  );
});

test("gemini: thoughts and signatures become a reasoning item before function calls", async () => {
  await withGateway(
    () =>
      new Response(
        sse(
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "Plan the lookup", thought: true }],
                },
              },
            ],
          },
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: {
                        id: "g1",
                        name: "mcp__qlik__list_apps",
                        args: { q: 1 },
                      },
                      thoughtSignature: "SIG1",
                    },
                    {
                      functionCall: { name: "conversation_files", args: {} },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
        ),
      ),
    async (post) => {
      const res = await post({
        tools: [
          { type: "function", name: "conversation_files" },
          {
            type: "namespace",
            name: "mcp__qlik__",
            tools: [{ type: "function", name: "list_apps" }],
          },
        ],
        input: [user("Apps?")],
      });
      const evs = await events(res);
      assert.equal(evs.at(-1).type, "response.completed");
      assert.ok(!evs.some((e) => e.type === "response.output_text.delta"));
      const [reasoning, first, second] = doneItems(evs);
      assert.equal(reasoning.type, "reasoning");
      assert.deepEqual(reasoning.summary, [
        { type: "summary_text", text: "Plan the lookup" },
      ]);
      assert.deepEqual(first, {
        ...first,
        type: "function_call",
        call_id: "g1",
        name: "list_apps",
        namespace: "mcp__qlik__",
        arguments: '{"q":1}',
      });
      assert.equal(second.name, "conversation_files");
      assert.match(second.call_id, /^call_[0-9a-f]{32}$/);
      assert.equal(second.arguments, "{}");
      assert.deepEqual(decodeSignatures(reasoning.encrypted_content), {
        signatures: { g1: "SIG1" },
        textSignature: undefined,
      });
    },
  );
});

test("gemini: safety blocks, malformed calls and early stream ends fail the stream", async () => {
  const bodies = [
    sse({
      candidates: [
        { content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" },
      ],
    }),
    sse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }),
    sse({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }),
    sse({ candidates: [{ content: { parts: [{ text: "cut" }] } }] }),
  ];
  await withGateway(
    () => new Response(bodies.shift()!),
    async (post) => {
      const codes = [];
      for (let i = 0; i < 4; i++) {
        const last = (await events(await post())).at(-1);
        assert.equal(last.type, "response.failed");
        codes.push(last.response.error.code);
      }
      assert.deepEqual(codes, [
        "cyber_policy",
        "cyber_policy",
        "server_error",
        "server_error",
      ]);
    },
  );
});

test("gemini: HTTP errors keep status, retry hints and context overflow", async () => {
  const googleError = (
    code: number,
    status: string,
    message: string,
    details?: unknown[],
  ) => JSON.stringify({ error: { code, status, message, details } });
  const responses = [
    new Response(
      googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded", [
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "33.5s",
        },
      ]),
      { status: 429 },
    ),
    new Response(googleError(429, "RESOURCE_EXHAUSTED", "Slow"), {
      status: 429,
      headers: { "Retry-After": "7" },
    }),
    new Response(googleError(503, "UNAVAILABLE", "The model is overloaded."), {
      status: 503,
    }),
    new Response(
      googleError(
        400,
        "INVALID_ARGUMENT",
        "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
      ),
      { status: 400 },
    ),
    new Response(googleError(403, "PERMISSION_DENIED", "API key invalid"), {
      status: 403,
    }),
  ];
  await withGateway(
    () => responses.shift()!,
    async (post) => {
      const quota = await post();
      assert.equal(quota.status, 429);
      assert.equal(quota.headers.get("retry-after"), "34");
      assert.equal((await quota.json()).error.message, "Quota exceeded");
      const slow = await post();
      assert.equal(slow.status, 429);
      assert.equal(slow.headers.get("retry-after"), "7");
      const busy = await post();
      assert.equal(busy.status, 503);
      assert.equal((await busy.json()).error.code, "server_is_overloaded");
      const overflow = await post();
      assert.equal(overflow.status, 200);
      assert.equal(
        (await events(overflow)).at(-1).response.error.code,
        "context_length_exceeded",
      );
      const denied = await post();
      assert.equal(denied.status, 403);
      assert.doesNotMatch(await denied.text(), /gemini-secret/);
    },
  );
});

test("gemini: unreachable provider is a 502 and the default base URL is used", async () => {
  await withGateway(
    () => {
      throw new Error("connect ECONNREFUSED");
    },
    async (post, calls) => {
      const res = await post();
      assert.equal(res.status, 502);
      assert.doesNotMatch(await res.text(), /gemini-secret/);
      assert.equal(
        calls[0].url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      );
    },
    { ...gemini, baseUrl: "", modelName: "models/gemini-2.5-flash" },
  );
});

test("toGeminiRequest: an MCP server's namespace description reaches the system instruction", () => {
  const { body } = toGeminiRequest(
    {
      instructions: "Base",
      tools: [
        {
          type: "namespace",
          name: "mcp__sap__",
          description: "Use get_order for order lookups.",
          tools: [{ type: "function", name: "get_order" }],
        },
        {
          type: "namespace",
          name: "mcp__plain__",
          description: "  ",
          tools: [{ type: "function", name: "ping" }],
        },
      ],
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Dev" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hi" }],
        },
      ],
    },
    { modelName: "gemini-3-pro-preview", maxOutputTokens: 1000 },
  );
  assert.deepEqual(body.systemInstruction, {
    parts: [
      {
        text: "Base\n\nInstructions for the tools named mcp__sap__*:\nUse get_order for order lookups.\n\nDev",
      },
    ],
  });
});
