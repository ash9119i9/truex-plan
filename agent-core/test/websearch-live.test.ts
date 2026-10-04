import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
import { WebSearchTools } from "../src/web-search";

// Explicit opt-in: real pinned runtime and real search engines; the model is
// simulated so this test requires no model/provider credentials.
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
const enabled =
  !!process.env.WEB_SERVICE_URL && !!process.env.WEB_SERVICE_TOKEN;
test(
  "live WebSearch runs through the pinned harness and returns real sources",
  {
    skip: process.env.WEBSEARCH_LIVE_TEST !== "on",
    timeout: 60_000,
  },
  async (t) => {
    assert.ok(
      enabled,
      "Live test requires WEB_SERVICE_URL and WEB_SERVICE_TOKEN",
    );
    assert.ok(
      existsSync(binary),
      "Build the project-local pinned runtime before the live test",
    );
    const home = mkdtempSync(join(tmpdir(), "websearch-live-"));
    const requests: any[] = [];
    const provider = createServer(async (req, res) => {
      if (!req.url?.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const item =
        requests.length === 1
          ? {
              type: "function_call",
              id: "fc_live",
              call_id: "search_live",
              name: "web_search",
              arguments: JSON.stringify({
                query:
                  process.env.WEB_SEARCH_SMOKE_QUERY ||
                  "SearXNG documentation search API",
                limit: 5,
              }),
            }
          : {
              type: "message",
              id: "msg_live",
              role: "assistant",
              content: [{ type: "output_text", text: "Live search finished." }],
            };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `r_${requests.length}` } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: `r_${requests.length}`,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const client = new BusinessRuntime(
      binary,
      home,
      15000,
      undefined,
      new WebSearchTools({
        url: process.env.WEB_SERVICE_URL!,
        token: process.env.WEB_SERVICE_TOKEN!,
      }),
      null,
    );
    const manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const { threadId } = await manager.create({
      model: "gpt-5",
      modelProvider: "fixture",
      config: {
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "fixture-key",
        },
      },
    });
    await manager.message(threadId, "Search for SearXNG documentation.");
    const deadline = Date.now() + 45_000;
    while (manager.snapshot(threadId).state.kind !== "idle") {
      if (Date.now() > deadline)
        throw new Error("Live WebSearch did not finish");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(requests.length, 2);
    assert.ok(
      requests[0].tools.some(
        (tool: any) => tool.type === "function" && tool.name === "web_search",
      ),
    );
    assert.ok(
      !requests[0].tools.some((tool: any) => tool.type === "web_search"),
    );
    const output = requests[1].input.find(
      (item: any) =>
        item.type === "function_call_output" && item.call_id === "search_live",
    );
    assert.ok(output, "Search output must return to the model");
    const serialized =
      typeof output.output === "string"
        ? output.output
        : output.output.map((part: any) => part.text ?? "").join("");
    const result = JSON.parse(serialized);
    assert.equal(result.provider, "searxng");
    assert.ok(result.results.length > 0 && result.results.length <= 5);
    assert.ok(
      result.results.every(
        (source: any) =>
          source.url.startsWith("https://") || source.url.startsWith("http://"),
      ),
    );
    assert.ok(Array.isArray(result.warnings));
    t.diagnostic(
      `Real SearXNG returned ${result.results.length} sources to the pinned runtime; ${result.warnings.length} warning(s). Model responses were simulated.`,
    );
  },
);
