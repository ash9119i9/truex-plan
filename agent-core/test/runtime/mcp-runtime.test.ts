import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../../src/runtime/business-runtime";
import { ThreadManager } from "../../src/threads/manager";
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");

const serverInstructions = "Use get_order for SAP order lookups.";
const orderSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "SAP order number" },
    include: { type: "array", items: { type: "string" } },
  },
  required: ["id"],
  additionalProperties: false,
};

interface Options {
  annotations?: Record<string, unknown>;
  // Sent for every MCP request when set.
  mcpStatus?: number;
  callDelayMs?: number;
}

// One loopback server plays both the MCP connector (/mcp) and a Responses
// model (/v1/responses). The model calls get_order once, then answers.
async function fixture(t: any, options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), "truex-mcp-"));
  mkdirSync(join(home, "workspace"));
  const mcpRequests: { auth?: string; body: any }[] = [],
    modelRequests: { auth?: string; body: any }[] = [];
  let calls = 0;
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/mcp") {
      mcpRequests.push({ auth: req.headers.authorization, body });
      if (options.mcpStatus) {
        res.writeHead(options.mcpStatus).end("unavailable");
        return;
      }
      if (!("id" in body)) {
        res.writeHead(202).end();
        return;
      }
      let result: any = {};
      if (body.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "sap-fixture", version: "1.0" },
          instructions: serverInstructions,
        };
      else if (body.method === "tools/list")
        result = {
          tools: [
            {
              name: "get_order",
              description: "Read an SAP order",
              ...(options.annotations
                ? { annotations: options.annotations }
                : {}),
              inputSchema: orderSchema,
            },
          ],
        };
      else if (body.method === "tools/call") {
        calls++;
        if (options.callDelayMs)
          await new Promise((r) => setTimeout(r, options.callDelayMs));
        result = {
          content: [{ type: "text", text: "Order 42 status: shipped" }],
        };
      }
      if (!res.writableEnded)
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      return;
    }
    if (!req.url?.includes("/responses")) {
      res.writeHead(404).end();
      return;
    }
    modelRequests.push({ auth: req.headers.authorization, body });
    const tool = body.tools?.find((tool: any) =>
      tool.tools?.some((entry: any) => entry.name === "get_order"),
    );
    const answered = body.input?.at(-1)?.type === "function_call_output";
    const item =
      answered || !tool
        ? {
            type: "message",
            role: "assistant",
            id: "msg_final",
            content: [{ type: "output_text", text: "Order 42 has shipped." }],
          }
        : {
            type: "function_call",
            id: "fc_order",
            call_id: "call_order_" + modelRequests.length,
            name: "get_order",
            namespace: tool.name,
            arguments: JSON.stringify({ id: "42" }),
          };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (event: any) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const id = "resp_" + modelRequests.length;
    emit({ type: "response.created", response: { id } });
    emit({ type: "response.output_item.added", item });
    emit({ type: "response.output_item.done", item });
    emit({
      type: "response.completed",
      response: {
        id,
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
  const startup: any[] = [];
  client.on("notification", (msg: any) => {
    if (msg?.method === "mcpServer/startupStatus/updated")
      startup.push(msg.params);
  });
  await client.start();
  const configuration = (mcp: Record<string, unknown> = {}) => ({
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
        ...mcp,
      },
    },
  });
  const idle = async (threadId: string) => {
    const deadline = Date.now() + 20000;
    while (
      manager.snapshot(threadId).state.kind !== "idle" &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.snapshot(threadId).state.kind, "idle");
  };
  const pending = async (threadId: string) => {
    const deadline = Date.now() + 20000;
    while (
      !manager.snapshot(threadId).pending.length &&
      manager.snapshot(threadId).state.kind !== "idle" &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 30));
    return manager.snapshot(threadId).pending[0];
  };
  return {
    manager,
    startup,
    configuration,
    mcpRequests,
    modelRequests,
    idle,
    pending,
    calls: () => calls,
  };
}

const connectorTools = (body: any) =>
  (body.tools || []).filter((tool: any) => tool.name?.startsWith("mcp__"));

for (const scenario of ["read-only", "approve", "deny"] as const)
  test(
    `native Codex discovers and executes an MCP tool: ${scenario}`,
    { skip: !existsSync(binary), timeout: 45000 },
    async (t) => {
      const f = await fixture(t, {
        annotations: scenario === "read-only" ? { readOnlyHint: true } : {},
      });
      const { threadId } = await f.manager.create(f.configuration());
      await f.manager.message(
        threadId,
        "What is the status of order 42?",
        "order-question",
      );
      if (scenario !== "read-only") {
        const request = await f.pending(threadId);
        assert.ok(request, "An unannotated tool must request approval");
        assert.equal(f.calls(), 0, "Tool must not execute before approval");
        assert.equal(request.method, "item/tool/requestUserInput");
        const question = (request.detail as any).questions[0];
        const label =
          scenario === "approve"
            ? question.options[0].label
            : question.options.at(-1).label;
        f.manager.answer(threadId, request.requestId, {
          answers: { [question.id]: { answers: [label] } },
        });
      }
      await f.idle(threadId);
      if (scenario === "deny") {
        assert.equal(f.calls(), 0, "Rejected MCP tool must never execute");
        return;
      }
      assert.equal(f.calls(), 1, "Approved MCP tool executes exactly once");

      // The model sees the connector's own tool, schema and instructions.
      const first = f.modelRequests[0].body;
      const [namespace, ...others] = connectorTools(first);
      assert.equal(others.length, 0);
      assert.equal(namespace.name, "mcp__sap");
      assert.equal(namespace.description, serverInstructions);
      assert.deepEqual(
        namespace.tools.map((tool: any) => tool.name),
        ["get_order"],
      );
      assert.equal(namespace.tools[0].description, "Read an SAP order");
      assert.deepEqual(namespace.tools[0].parameters, orderSchema);
      // No wrapper, dispatcher or projection layer between Codex and the server.
      assert.doesNotMatch(
        JSON.stringify(first.tools),
        /discover_server|discover_tools|get_tool_schema|invoke_tool|mcp__omni|mcp__adaptive|"fields"/,
      );
      assert.doesNotMatch(
        JSON.stringify(first.tools),
        /"(?:shell_command|exec_command|apply_patch|view_image)"/,
      );

      // Codex talks to the connector and to the model directly.
      assert.ok(
        f.mcpRequests.every((r) => r.auth === "Bearer mcp-secret"),
        "connector credentials reach only the connector",
      );
      assert.ok(
        f.modelRequests.every((r) => r.auth === "Bearer provider-secret"),
        "model requests use the configured provider, with no relay",
      );
      const call = f.mcpRequests.find((r) => r.body.method === "tools/call")!;
      assert.equal(call.body.params.name, "get_order");
      assert.deepEqual(call.body.params.arguments, { id: "42" });
      assert.match(
        JSON.stringify(f.modelRequests.at(-1)!.body.input),
        /Order 42 status: shipped/,
      );
      assert.equal(
        f.manager.snapshot(threadId).messages.at(-1)?.text,
        "Order 42 has shipped.",
      );
    },
  );

test(
  "a changed connector configuration reaches an idle conversation on resume",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const f = await fixture(t, { annotations: { readOnlyHint: true } });
    const first = f.configuration();
    const { threadId } = await f.manager.create({
      ...first,
      mcpFingerprint: "one",
    });
    await f.manager.message(threadId, "Order 42?", "first");
    await f.idle(threadId);
    const before = f.mcpRequests.length;
    assert.ok(before > 0);

    // Rotated credential: the next turn must use it, not the old connection.
    const rotated = f.configuration({
      http_headers: { Authorization: "Bearer rotated-secret" },
    });
    await f.manager.resume(threadId, { ...rotated, mcpFingerprint: "two" });
    await f.manager.message(threadId, "Order 42 again?", "second");
    await f.idle(threadId);
    const after = f.mcpRequests.slice(before);
    assert.ok(after.length > 0);
    assert.ok(after.every((r) => r.auth === "Bearer rotated-secret"));
    assert.equal(f.calls(), 2);

    // Detached connector: the next refresh offers the model no connector tools.
    const detached = f.configuration();
    delete (detached.config as any)["mcp_servers.sap"];
    await f.manager.resume(threadId, { ...detached, mcpFingerprint: "three" });
    const requests = f.modelRequests.length;
    await f.manager.message(threadId, "Hello", "third");
    await f.idle(threadId);
    for (const request of f.modelRequests.slice(requests))
      assert.equal(connectorTools(request.body).length, 0);
  },
);

test(
  "an unreachable connector reports a startup failure and leaves the conversation working",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const f = await fixture(t, { mcpStatus: 503 });
    const { threadId } = await f.manager.create(
      f.configuration({ startup_timeout_sec: 5 }),
    );
    await f.manager.message(threadId, "What is order 42?", "down");
    await f.idle(threadId);
    assert.equal(f.calls(), 0);
    for (const request of f.modelRequests)
      assert.equal(connectorTools(request.body).length, 0);
    assert.equal(
      f.manager.snapshot(threadId).messages.at(-1)?.text,
      "Order 42 has shipped.",
    );
    const deadline = Date.now() + 15000;
    while (
      !f.startup.some((s) => s.status === "failed") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    const failed = f.startup.filter((s) => s.status === "failed");
    assert.ok(failed.length > 0, "Codex reports the failed initialization");
    assert.equal(failed[0].name, "sap");
    assert.doesNotMatch(JSON.stringify(f.startup), /mcp-secret/);
  },
);

test(
  "a tool call that exceeds tool_timeout_sec fails once and is not repeated",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const f = await fixture(t, {
      annotations: { readOnlyHint: true },
      callDelayMs: 4000,
    });
    const { threadId } = await f.manager.create(
      f.configuration({ tool_timeout_sec: 1 }),
    );
    await f.manager.message(threadId, "What is order 42?", "slow");
    await f.idle(threadId);
    assert.equal(f.calls(), 1, "a timed-out call is never replayed");
    assert.match(
      JSON.stringify(f.modelRequests.at(-1)!.body.input),
      /timed out/i,
    );
  },
);
