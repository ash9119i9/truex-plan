import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");

test(
  "pinned runtime discovers MCP tools, calls with auth, and returns results to the model",
  { skip: !existsSync(binary), timeout: 45000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-mcp-"));
    mkdirSync(join(home, "workspace"));
    const mcpRequests: any[] = [],
      modelRequests: any[] = [];
    let called = false;
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (req.url === "/mcp") {
        mcpRequests.push({ auth: req.headers.authorization, body });
        if (!("id" in body)) {
          res.writeHead(202).end();
          return;
        }
        let result: any;
        if (body.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "sap-fixture", version: "1.0" },
          };
        else if (body.method === "tools/list")
          result = {
            tools: [
              {
                name: "get_order",
                description: "Read an SAP order",
                annotations: { readOnlyHint: true },
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
              },
            ],
          };
        else if (body.method === "tools/call") {
          called = true;
          result = {
            content: [{ type: "text", text: "Order 42 status: shipped" }],
          };
        } else result = {};
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      modelRequests.push(body);
      const tool = body.tools?.find((tool: any) =>
        tool.tools?.some((entry: any) => entry.name === "get_order"),
      );
      const item =
        called || modelRequests.length > 1
          ? {
              type: "message",
              role: "assistant",
              id: "msg_final",
              content: [{ type: "output_text", text: "Order 42 has shipped." }],
            }
          : {
              type: "function_call",
              id: "fc_order",
              call_id: "call_order",
              name: "get_order",
              namespace: tool?.name,
              arguments: JSON.stringify({ id: "42" }),
            };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (event: any) =>
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      emit({
        type: "response.created",
        response: { id: "resp_" + modelRequests.length },
      });
      emit({ type: "response.output_item.added", item });
      emit({ type: "response.output_item.done", item });
      emit({
        type: "response.completed",
        response: {
          id: "resp_" + modelRequests.length,
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const client = new BusinessRuntime(binary, home, 15000);
    const manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    });
    await client.start();
    const { threadId } = await manager.create({
      model: "gpt-5",
      modelProvider: "fixture",
      cwd: join(home, "workspace"),
      sandbox: "read-only",
      approvalPolicy: "never",
      config: {
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "provider-secret",
        },
        "mcp_servers.sap": {
          url: `http://127.0.0.1:${port}/mcp`,
          http_headers: { Authorization: "Bearer mcp-secret" },
        },
      },
    });
    await manager.message(
      threadId,
      "What is the status of order 42?",
      "order-question",
    );
    const deadline = Date.now() + 20000;
    while (
      manager.snapshot(threadId).state.kind !== "idle" &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.snapshot(threadId).state.kind, "idle");
    assert.ok(called, "MCP tool must be invoked");
    assert.doesNotMatch(
      JSON.stringify(modelRequests[0].tools),
      /"(?:shell_command|exec_command|apply_patch|view_image)"/,
    );
    assert.ok(
      modelRequests[0].tools.some((tool: any) =>
        tool.tools?.some((entry: any) => entry.name === "get_order"),
      ),
      "Tool schema must reach model",
    );
    assert.match(
      JSON.stringify(modelRequests.at(-1).input),
      /Order 42 status: shipped/,
    );
    assert.equal(
      manager.snapshot(threadId).messages.at(-1)?.text,
      "Order 42 has shipped.",
    );
    assert.ok(mcpRequests.every((r) => r.auth === "Bearer mcp-secret"));
    assert.deepEqual(
      mcpRequests.find((r) => r.body.method === "tools/call").body.params
        .arguments,
      { id: "42" },
    );
  },
);
