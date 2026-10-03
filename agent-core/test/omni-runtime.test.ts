import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { CodexClient } from "../src/client";
import { ThreadManager } from "../src/manager";

const connector = {
  url: "http://127.0.0.1:1/mcp",
  http_headers: { "x-connector-key": "UPSTREAM_SECRET_CANARY" },
  default_tools_approval_mode: "prompt",
};
function fixture(t: any, mode: string = "omni", projection = "optional") {
  const home = mkdtempSync(join(tmpdir(), "truex-omni-runtime-"));
  const previousMode = process.env.TRUEX_MCP_GATEWAY_MODE;
  const previousProjection = process.env.TRUEX_MCP_GATEWAY_PROJECTION;
  process.env.TRUEX_MCP_GATEWAY_MODE = mode;
  process.env.TRUEX_MCP_GATEWAY_PROJECTION = projection;
  const original = CodexClient.prototype.request;
  const sent: { method: string; params: any }[] = [];
  let next = 0,
    rejectNext = false;
  CodexClient.prototype.request = async function (method: string, params: any) {
    sent.push({ method, params });
    if (rejectNext) {
      rejectNext = false;
      throw new Error("Fixture failed start");
    }
    return {
      thread: {
        id: method === "thread/resume" ? params.threadId : `fixture_${++next}`,
      },
    };
  };
  const runtime = new BusinessRuntime("unused", home);
  t.after(async () => {
    await runtime.closeOmniGateways();
    CodexClient.prototype.request = original;
    if (previousMode === undefined) delete process.env.TRUEX_MCP_GATEWAY_MODE;
    else process.env.TRUEX_MCP_GATEWAY_MODE = previousMode;
    if (previousProjection === undefined)
      delete process.env.TRUEX_MCP_GATEWAY_PROJECTION;
    else process.env.TRUEX_MCP_GATEWAY_PROJECTION = previousProjection;
    rmSync(home, { recursive: true, force: true });
  });
  return {
    runtime,
    sent,
    failNext: () => {
      rejectNext = true;
    },
  };
}
async function tools(server: any) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.http_headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as any).result.tools;
}
const params = () => ({
  model: "fixture",
  config: { "mcp_servers.qlik": { ...connector } },
});

test("Omni hides connector credentials and exposes four fixed tools without user tool allowlists", async (t) => {
  const { runtime, sent } = fixture(t);
  const result = await runtime.request("thread/start", params());
  const start = sent[0].params;
  assert.equal(start.config["mcp_servers.qlik"], undefined);
  assert.doesNotMatch(JSON.stringify(start), /UPSTREAM_SECRET_CANARY/);
  assert.match(
    start.baseInstructions,
    /Logical connector names remain unchanged/,
  );
  assert.match(start.config["mcp_servers.omni"].url, /^http:\/\/127\.0\.0\.1:/);
  assert.ok(runtime.omniGateways.has(result.thread.id));
  const catalog = await tools(start.config["mcp_servers.omni"]);
  assert.deepEqual(
    catalog.map((tool: any) => tool.name),
    ["discover_server", "discover_tools", "get_tool_schema", "invoke_tool"],
  );
  assert.equal(catalog.at(-1).annotations.readOnlyHint, false);
  assert.equal(
    start.config["mcp_servers.omni"].tools.invoke_tool.approval_mode,
    "prompt",
  );
  assert.equal(start.config["features.shell_tool"], false);
  assert.equal(start.config["features.multi_agent"], true);
  assert.equal(start.config["features.goals"], true);
});

test("the platform can require explicit field selection without end-user configuration", async (t) => {
  const { runtime, sent } = fixture(t, "omni", "required");
  await runtime.request("thread/start", params());
  const start = sent[0].params;
  const catalog = await tools(start.config["mcp_servers.omni"]);
  assert.ok(
    catalog
      .find((tool: any) => tool.name === "invoke_tool")
      .inputSchema.required.includes("fields"),
  );
  assert.match(start.baseInstructions, /fields is required/);
  assert.equal(start.config["mcp_servers.qlik"], undefined);
});

test("optional projection retains the original schema for the controlled comparison", async (t) => {
  const { runtime, sent } = fixture(t);
  await runtime.request("thread/start", params());
  const catalog = await tools(sent[0].params.config["mcp_servers.omni"]);
  assert.ok(
    !catalog
      .find((tool: any) => tool.name === "invoke_tool")
      .inputSchema.required.includes("fields"),
  );
});

test("direct mode leaves attached connector config unchanged", async (t) => {
  const { runtime, sent } = fixture(t, "direct");
  await runtime.request("thread/start", params());
  assert.deepEqual(sent[0].params.config["mcp_servers.qlik"], connector);
  assert.equal(sent[0].params.config["mcp_servers.omni"], undefined);
  assert.equal(runtime.omniGateways.size, 0);
});

test("failed start closes the temporary gateway instead of retaining a listener", async (t) => {
  const { runtime, sent, failNext } = fixture(t);
  failNext();
  await assert.rejects(
    runtime.request("thread/start", params()),
    /Fixture failed start/,
  );
  assert.equal(runtime.omniGateways.size, 0);
  await assert.rejects(tools(sent[0].params.config["mcp_servers.omni"]));
});

test("conversation marker failure releases the gateway after Codex has started", async (t) => {
  const { runtime, sent } = fixture(t);
  writeFileSync(
    join(runtime.home, "business-threads"),
    "blocked marker directory",
  );
  await assert.rejects(runtime.request("thread/start", params()));
  assert.equal(runtime.omniGateways.size, 0);
  await assert.rejects(tools(sent[0].params.config["mcp_servers.omni"]));
});

test("fork shares gateway until final subscription releases it; resume gets a fresh attachment", async (t) => {
  const { runtime, sent } = fixture(t);
  const original = (await runtime.request("thread/start", params())).thread.id;
  const originalServer = sent[0].params.config["mcp_servers.omni"];
  const fork = (await runtime.request("thread/fork", { threadId: original }))
    .thread.id;
  assert.equal(
    runtime.omniGateways.get(original),
    runtime.omniGateways.get(fork),
  );
  await runtime.request("thread/unsubscribe", { threadId: original });
  assert.equal(runtime.omniGateways.size, 1);
  assert.equal((await tools(originalServer)).length, 4);
  await assert.rejects(
    runtime.request("thread/fork", { threadId: original }),
    /Resume the conversation before forking/,
  );
  await runtime.request("thread/delete", { threadId: fork });
  assert.equal(runtime.omniGateways.size, 0);
  await assert.rejects(tools(originalServer));
  await runtime.request("thread/resume", { ...params(), threadId: original });
  const resumedServer = sent.at(-1)!.params.config["mcp_servers.omni"];
  assert.notEqual(resumedServer.url, originalServer.url);
  assert.equal((await tools(resumedServer)).length, 4);
});

test("runtime exit closes attached gateways and telemetry omits upstream credentials", async (t) => {
  const { runtime, sent } = fixture(t);
  const events: any[] = [];
  runtime.on("omniGatewayEvent", (event) => events.push(event));
  const id = (await runtime.request("thread/start", params())).thread.id;
  const server = sent[0].params.config["mcp_servers.omni"];
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.http_headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "discover_server", arguments: { query: "qlik" } },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /qlik/);
  assert.deepEqual(events[0].threadIds, [id]);
  assert.doesNotMatch(JSON.stringify(events), /UPSTREAM_SECRET_CANARY/);
  runtime.emit("exit", new Error("fixture exit"));
  assert.equal(runtime.omniGateways.size, 0);
  await assert.rejects(tools(server));
});

const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
test(
  "pinned Codex consumes external Omni config and keeps native tools without upstream schemas",
  { skip: !existsSync(binary), timeout: 30000 },
  async (t) => {
    const previousMode = process.env.TRUEX_MCP_GATEWAY_MODE;
    process.env.TRUEX_MCP_GATEWAY_MODE = "omni";
    const home = mkdtempSync(join(tmpdir(), "truex-omni-pinned-"));
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "fixture_response" } },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "fixture_message",
            content: [{ type: "output_text", text: "Hello." }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "fixture_response",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const runtime = new BusinessRuntime(binary, home, 15000);
    const manager = new ThreadManager(runtime, home);
    t.after(async () => {
      manager.close();
      runtime.stop();
      await runtime.closeOmniGateways();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await new Promise((done) => setTimeout(done, 300));
      rmSync(home, { recursive: true, force: true });
      if (previousMode === undefined) delete process.env.TRUEX_MCP_GATEWAY_MODE;
      else process.env.TRUEX_MCP_GATEWAY_MODE = previousMode;
    });
    const { threadId } = await manager.create({
      ...params(),
      modelProvider: "fixture",
      config: {
        ...params().config,
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "fixture-model-key",
        },
      },
    });
    const status = await runtime.request("mcpServerStatus/list", { threadId });
    assert.equal(Object.keys(status.data[0].tools).length, 4);
    assert.equal(status.data[0].name, "omni");
    await manager.message(threadId, "Hi bro ?");
    const deadline = Date.now() + 20000;
    while (
      manager.snapshot(threadId).state.kind !== "idle" &&
      Date.now() < deadline
    )
      await new Promise((done) => setTimeout(done, 30));
    assert.equal(manager.snapshot(threadId).state.kind, "idle");
    assert.equal(requests.length, 1);
    const names = JSON.stringify(requests[0].tools);
    for (const name of [
      "discover_server",
      "discover_tools",
      "get_tool_schema",
      "invoke_tool",
      "spawn_agent",
      "create_goal",
      "update_plan",
      "conversation_files",
    ])
      assert.match(names, new RegExp(name));
    assert.doesNotMatch(names, /get_apps|shell_command|exec_command/);
    assert.doesNotMatch(JSON.stringify(requests), /UPSTREAM_SECRET_CANARY/);
  },
);

for (const decision of ["Allow", "Cancel"] as const)
  test(
    `pinned Codex Omni invocation ${decision} is scoped to one call and respects denial`,
    { skip: !existsSync(binary), timeout: 30000 },
    async (t) => {
      const previousMode = process.env.TRUEX_MCP_GATEWAY_MODE;
      process.env.TRUEX_MCP_GATEWAY_MODE = "omni";
      const home = mkdtempSync(join(tmpdir(), "truex-omni-approval-"));
      const modelRequests: any[] = [],
        downstreamCalls: any[] = [];
      const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (req.url === "/mcp") {
          if (body.id === undefined) {
            res.writeHead(202).end();
            return;
          }
          let result: any = {};
          if (body.method === "initialize")
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "sap", version: "1" },
            };
          else if (body.method === "tools/list")
            result = {
              tools: [
                {
                  name: "get_order",
                  annotations: { readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                    additionalProperties: false,
                  },
                },
              ],
            };
          else if (body.method === "tools/call") {
            downstreamCalls.push(body.params);
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    id: "42",
                    status: "shipped",
                    ignored: "Large omitted field",
                  }),
                },
              ],
            };
          }
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
          return;
        }
        modelRequests.push(body);
        const namespace = body.tools.find((tool: any) =>
          tool.tools?.some((entry: any) => entry.name === "invoke_tool"),
        )?.name;
        const item =
          modelRequests.length === 1
            ? {
                type: "function_call",
                id: "fc_order",
                call_id: "call_order",
                name: "invoke_tool",
                namespace,
                arguments: JSON.stringify({
                  server: "sap",
                  tool: "get_order",
                  arguments: { id: "42" },
                  fields: ["id", "status"],
                }),
              }
            : {
                type: "message",
                role: "assistant",
                id: "fixture_final",
                content: [
                  {
                    type: "output_text",
                    text:
                      decision === "Allow"
                        ? "Order 42 has shipped."
                        : "Cancelled.",
                  },
                ],
              };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          {
            type: "response.created",
            response: { id: `fixture_${modelRequests.length}` },
          },
          { type: "response.output_item.added", item },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              id: `fixture_${modelRequests.length}`,
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      const runtime = new BusinessRuntime(binary, home, 15000);
      const manager = new ThreadManager(runtime, home);
      t.after(async () => {
        manager.close();
        runtime.stop();
        await runtime.closeOmniGateways();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await new Promise((done) => setTimeout(done, 300));
        rmSync(home, { recursive: true, force: true });
        if (previousMode === undefined)
          delete process.env.TRUEX_MCP_GATEWAY_MODE;
        else process.env.TRUEX_MCP_GATEWAY_MODE = previousMode;
      });
      const { threadId } = await manager.create({
        model: "fixture",
        modelProvider: "fixture",
        approvalMode: "readOnly",
        approvalNameHeuristic: true,
        config: {
          "mcp_servers.sap": { url: `${url}/mcp` },
          "model_providers.fixture": {
            name: "fixture",
            base_url: `${url}/v1`,
            wire_api: "responses",
            experimental_bearer_token: "fixture-key",
          },
        },
      });
      await runtime.request("mcpServerStatus/list", { threadId });
      await manager.message(threadId, "Read order 42.");
      const deadline = Date.now() + 20000;
      while (
        !manager.snapshot(threadId).pending.length &&
        Date.now() < deadline
      )
        await new Promise((done) => setTimeout(done, 30));
      const pending = manager.snapshot(threadId).pending[0];
      assert.ok(
        pending,
        "Read-only approval mode cannot auto-allow generic invoke_tool",
      );
      assert.equal(
        downstreamCalls.length,
        0,
        "No downstream invocation before approval",
      );
      const question = (pending.detail as any).questions[0];
      assert.deepEqual(
        question.options.map((option: any) => option.label),
        ["Allow", "Cancel"],
      );
      assert.throws(
        () =>
          manager.answer(threadId, pending.requestId, {
            answers: { [question.id]: { answers: ["Allow for this session"] } },
          }),
        /this call only/,
      );
      manager.answer(threadId, pending.requestId, {
        answers: { [question.id]: { answers: [decision] } },
      });
      while (
        manager.snapshot(threadId).state.kind !== "idle" &&
        Date.now() < deadline
      )
        await new Promise((done) => setTimeout(done, 30));
      assert.equal(manager.snapshot(threadId).state.kind, "idle");
      assert.equal(downstreamCalls.length, decision === "Allow" ? 1 : 0);
      assert.equal(modelRequests.length, 2);
      if (decision === "Allow") {
        assert.deepEqual(downstreamCalls[0].arguments, { id: "42" });
        assert.match(JSON.stringify(modelRequests.at(-1).input), /shipped/);
        assert.doesNotMatch(
          JSON.stringify(modelRequests.at(-1).input),
          /Large omitted field/,
        );
      }
    },
  );
