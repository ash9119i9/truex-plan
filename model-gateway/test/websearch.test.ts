import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createGateway, type GatewayProfile } from "../src/server";
import { signGatewayToken } from "../../shared/gateway-token";
import { webSearchTool, type WebSearchResult } from "../../shared/web-search";

const secret = "gateway-websearch-test-secret-32-chars";
const args = { query: "SearXNG documentation", limit: 3 };
const user = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Find the SearXNG documentation." }],
};
const nativeSearch = {
  type: "function",
  name: webSearchTool.name,
  description: webSearchTool.description,
  parameters: webSearchTool.inputSchema,
};
const searchResult: WebSearchResult = {
  provider: "searxng",
  query: args.query,
  searchedAt: "2026-10-04T00:00:00.000Z",
  results: [
    {
      sourceId: "source-search-1",
      url: "https://docs.searxng.org/",
      title: "SearXNG documentation",
      snippet: "Documentation for the search API.",
      engines: ["duckduckgo"],
    },
  ],
  warnings: [],
};

function sse(chunks: unknown[], anthropic = false) {
  return new Response(
    chunks
      .map(
        (chunk: any) =>
          `${anthropic ? `event: ${chunk.type}\n` : ""}data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function toolStream(wireApi: string) {
  if (wireApi === "chat")
    return sse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "search-call-1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    ]);
  if (wireApi === "gemini")
    return sse([
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "search-call-1",
                    name: "web_search",
                    args,
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ]);
  return sse(
    [
      {
        type: "message_start",
        message: {
          id: "msg_search",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "search-call-1",
          name: "web_search",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(args),
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: "message_stop" },
    ],
    true,
  );
}

for (const wireApi of ["chat", "anthropic", "gemini"] as const) {
  test(`${wireApi}: native web_search schema, call and results round-trip without hosted search`, async () => {
    const profile: GatewayProfile = {
      _id: "web-test",
      baseUrl: "https://provider.example/v1/",
      modelName: wireApi === "gemini" ? "gemini-3-pro" : "test-model",
      wireApi,
      apiKey: "fixture-provider-key",
      thinking: false,
    };
    const sent: any[] = [];
    const gateway = createGateway({
      secret,
      findProfile: async (id) => (id === "web-test" ? profile : null),
      fetch: (async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return toolStream(wireApi);
      }) as typeof fetch,
    });
    await new Promise<void>((resolve) =>
      gateway.listen(0, "127.0.0.1", resolve),
    );
    const address = gateway.address() as AddressInfo;
    const post = (input: unknown[]) =>
      fetch(`http://127.0.0.1:${address.port}/p/web-test/v1/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signGatewayToken("web-test", secret)}`,
        },
        body: JSON.stringify({
          tools: [
            nativeSearch,
            { type: "web_search", external_web_access: true },
          ],
          input,
        }),
      });
    try {
      const first = await post([user]);
      assert.equal(first.status, 200);
      const events = (await first.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      assert.equal(events.at(-1).type, "response.completed");
      const call = events.find(
        (event) =>
          event.type === "response.output_item.done" &&
          event.item.type === "function_call",
      )?.item;
      assert.ok(
        call,
        "The provider's search call must reach the native dispatcher.",
      );
      assert.equal(call.name, "web_search");
      assert.equal(call.namespace, undefined);
      assert.equal(call.call_id, "search-call-1");
      assert.deepEqual(JSON.parse(call.arguments), args);

      const second = await post([
        user,
        call,
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(searchResult),
        },
      ]);
      assert.equal(second.status, 200);
      await second.text();
      assert.equal(sent.length, 2);
      for (const body of sent) {
        if (wireApi === "chat") {
          assert.equal(body.tools.length, 1);
          assert.equal(body.tools[0].type, "function");
          assert.equal(body.tools[0].function.name, "web_search");
          assert.deepEqual(
            body.tools[0].function.parameters,
            nativeSearch.parameters,
          );
        } else if (wireApi === "anthropic") {
          assert.equal(body.tools.length, 1);
          assert.equal(body.tools[0].name, "web_search");
          assert.equal(body.tools[0].type, undefined);
          assert.deepEqual(body.tools[0].input_schema, nativeSearch.parameters);
        } else {
          assert.equal(body.tools.length, 1);
          assert.deepEqual(Object.keys(body.tools[0]), [
            "functionDeclarations",
          ]);
          assert.equal(body.tools[0].functionDeclarations.length, 1);
          assert.equal(
            body.tools[0].functionDeclarations[0].name,
            "web_search",
          );
          assert.deepEqual(
            body.tools[0].functionDeclarations[0].parametersJsonSchema,
            nativeSearch.parameters,
          );
        }
      }
      if (wireApi === "chat") {
        const result = sent[1].messages.find(
          (message: any) => message.role === "tool",
        );
        assert.equal(result.tool_call_id, call.call_id);
        assert.deepEqual(JSON.parse(result.content), searchResult);
      } else if (wireApi === "anthropic") {
        const result = sent[1].messages
          .flatMap((message: any) => message.content)
          .find((block: any) => block.type === "tool_result");
        assert.equal(result.tool_use_id, call.call_id);
        assert.deepEqual(JSON.parse(result.content), searchResult);
      } else {
        const result = sent[1].contents
          .flatMap((content: any) => content.parts)
          .find((part: any) => part.functionResponse)?.functionResponse;
        assert.equal(result.name, "web_search");
        assert.equal(result.id, call.call_id);
        assert.deepEqual(JSON.parse(result.response.output), searchResult);
      }
    } finally {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
}
