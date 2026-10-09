import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
import { MCP_APP_MIME, mcpAppIdPattern } from "../../shared/mcp-apps";

const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
const PAGE =
  "<!doctype html><html><body><div id=app>Order 42</div></body></html>";

interface Options {
  // Whether the tool declares a page.
  ui?: boolean;
  mime?: string;
  page?: string;
  // How the tool result reports `structuredContent` and `_meta`.
  result?: Record<string, unknown>;
  // Extra input the model sends the tool.
  args?: Record<string, unknown>;
}

// A model that calls the connector's tool once, and a connector that serves a
// page for it, both on the real pinned runtime.
async function start(options: Options = {}) {
  const {
    ui = true,
    mime = MCP_APP_MIME,
    page = PAGE,
    args = {},
    result = {
      content: [{ type: "text", text: "Order 42 status: shipped" }],
      structuredContent: { id: "42", status: "shipped" },
    },
  } = options;
  const home = mkdtempSync(join(tmpdir(), "truex-mcpapp-"));
  mkdirSync(join(home, "workspace"));
  const mcp: string[] = [];
  let modelCalls = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (req.url === "/mcp") {
      mcp.push(body.method);
      if (!("id" in body)) {
        res.writeHead(202).end();
        return;
      }
      let out: any = {};
      if (body.method === "initialize")
        out = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "sap-fixture", version: "1.0" },
        };
      else if (body.method === "tools/list")
        out = {
          tools: [
            {
              name: "get_order",
              description: "Read an SAP order",
              annotations: { readOnlyHint: true },
              ...(ui
                ? { _meta: { ui: { resourceUri: "ui://sap/order.html" } } }
                : {}),
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          ],
        };
      else if (body.method === "tools/call") out = result;
      else if (body.method === "resources/list")
        out = {
          resources: [
            { uri: "ui://sap/order.html", name: "Order", mimeType: mime },
          ],
        };
      else if (body.method === "resources/read")
        out = {
          contents: [
            { uri: "ui://sap/order.html", mimeType: mime, text: page },
          ],
        };
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: out }));
      return;
    }
    if (!req.url?.includes("/responses")) {
      res.writeHead(404).end();
      return;
    }
    modelCalls++;
    const tool = body.tools?.find((t: any) =>
      t.tools?.some((e: any) => e.name === "get_order"),
    );
    const item =
      modelCalls > 1
        ? {
            type: "message",
            role: "assistant",
            id: "msg_final",
            content: [{ type: "output_text", text: "Order 42 has shipped." }],
          }
        : {
            type: "function_call",
            id: "fc_order",
            call_id: "call/order:1|weird id",
            name: "get_order",
            namespace: tool?.name,
            arguments: JSON.stringify({ id: "42", ...args }),
          };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (event: any) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: "response.created", response: { id: "resp_" + modelCalls } });
    emit({ type: "response.output_item.added", item });
    emit({ type: "response.output_item.done", item });
    emit({
      type: "response.completed",
      response: {
        id: "resp_" + modelCalls,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const config = {
    "model_providers.fixture": {
      name: "fixture",
      base_url: `http://127.0.0.1:${port}/v1`,
      wire_api: "responses",
      experimental_bearer_token: "provider-secret",
    },
    "mcp_servers.sap": { url: `http://127.0.0.1:${port}/mcp` },
  };
  let client = new BusinessRuntime(binary, home, 15000);
  let manager = new ThreadManager(client, home);
  await client.start();
  const { threadId } = await manager.create({
    model: "gpt-5",
    modelProvider: "fixture",
    cwd: join(home, "workspace"),
    sandbox: "read-only",
    approvalPolicy: "never",
    config,
  });
  await manager.message(threadId, "What is the status of order 42?", "q1");
  const deadline = Date.now() + 25000;
  while (
    manager.snapshot(threadId).state.kind !== "idle" &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 30));
  assert.equal(manager.snapshot(threadId).state.kind, "idle");
  return {
    threadId,
    mcp,
    get client() {
      return client;
    },
    get manager() {
      return manager;
    },
    async restart() {
      manager.close();
      client.stop();
      await new Promise((r) => setTimeout(r, 500));
      client = new BusinessRuntime(binary, home, 15000);
      manager = new ThreadManager(client, home);
      await manager.resume(threadId, {
        model: "gpt-5",
        modelProvider: "fixture",
        cwd: join(home, "workspace"),
        sandbox: "read-only",
        approvalPolicy: "never",
        config,
      });
    },
    async stop() {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const opts = { skip: !existsSync(binary), timeout: 60000 };

test(
  "pinned runtime: a tool that declares a page is offered as an app, with its page and data",
  opts,
  async (t) => {
    const run = await start();
    t.after(() => run.stop());
    const apps = run.manager.snapshot(run.threadId).mcpApps!;
    assert.equal(apps.length, 1);
    const [ref] = apps;
    // The browser gets a safe id and labels, never the provider's call id.
    assert.match(ref.id, mcpAppIdPattern);
    assert.deepEqual(Object.keys(ref).sort(), [
      "id",
      "server",
      "tool",
      "turnId",
    ]);
    assert.equal(ref.server, "sap");
    assert.equal(ref.tool, "get_order");
    assert.equal(JSON.stringify(apps).includes("weird id"), false);
    // It was announced live, once.
    const announced = run.manager
      .records(run.threadId)
      .filter((r) => r.event.type === "mcp.app");
    assert.ok(announced.length <= 1);

    const app = await run.manager.mcpApp(run.threadId, ref.id);
    assert.equal(app.html, PAGE);
    assert.deepEqual(app.arguments, { id: "42" });
    assert.equal(app.result?.structuredContent?.status, "shipped");
    assert.equal(app.result?.content.length, 1);
    // The runtime reports `_meta: null`, which an MCP App cannot be given.
    assert.equal("_meta" in (app.result as object), false);
    assert.equal(JSON.stringify(app).includes("weird id"), false);
    // The page was read from the connector, with the connector's own tool call.
    assert.ok(run.mcp.includes("resources/read"));
  },
);

test(
  "pinned runtime: a restarted conversation still has its apps",
  opts,
  async (t) => {
    const run = await start();
    t.after(() => run.stop());
    const before = run.manager.snapshot(run.threadId).mcpApps!;
    assert.equal(before.length, 1);
    await run.restart();
    const after = run.manager.snapshot(run.threadId).mcpApps!;
    assert.deepEqual(after, before);
    assert.equal(
      (await run.manager.mcpApp(run.threadId, after[0].id)).html,
      PAGE,
    );
  },
);

test(
  "pinned runtime: only apps of this conversation can be read",
  opts,
  async (t) => {
    const run = await start();
    t.after(() => run.stop());
    const [ref] = run.manager.snapshot(run.threadId).mcpApps!;
    for (const id of [
      "",
      "short",
      "../../etc/passwd",
      ref.id + "x",
      ref.id.slice(0, -1) + (ref.id.endsWith("a") ? "b" : "a"),
      "a".repeat(32),
      "weird id".padEnd(32, "x"),
    ])
      await assert.rejects(
        run.manager.mcpApp(run.threadId, id),
        /App not found/,
        id,
      );
    // The runtime gate only opens for conversations Truex started.
    await assert.rejects(
      run.client.request("mcpServer/resource/read", {
        threadId: "not-a-truex-thread",
        server: "sap",
        uri: "ui://sap/order.html",
      }),
    );
    // And other methods stay closed.
    await assert.rejects(
      run.client.request("mcpServer/tool/call", { threadId: run.threadId }),
      /not available in Truex/,
    );
  },
);

test(
  "pinned runtime: a tool with no page declared is not an app",
  opts,
  async (t) => {
    const run = await start({ ui: false });
    t.after(() => run.stop());
    assert.deepEqual(run.manager.snapshot(run.threadId).mcpApps, []);
    assert.equal(run.mcp.includes("resources/read"), false);
  },
);

test(
  "pinned runtime: a page that is not an MCP App page is refused",
  opts,
  async (t) => {
    for (const mime of ["text/html", "text/plain", "application/json"]) {
      const run = await start({ mime });
      try {
        const [ref] = run.manager.snapshot(run.threadId).mcpApps!;
        await assert.rejects(
          run.manager.mcpApp(run.threadId, ref.id),
          { code: "MCP_APP_UNSUPPORTED" },
          mime,
        );
      } finally {
        await run.stop();
      }
    }
  },
);

test(
  "pinned runtime: an empty or oversized page, or too much data, is refused",
  opts,
  async (t) => {
    const cases: [string, Options][] = [
      ["empty", { page: "   " }],
      ["oversized page", { page: "x".repeat(1_048_577) }],
      // The runtime already shortens a large result (to about 64 KiB), so the
      // input is what can exceed the bound.
      ["oversized input", { args: { pad: "y".repeat(300_000) } }],
    ];
    for (const [name, options] of cases) {
      const run = await start(options);
      try {
        const [ref] = run.manager.snapshot(run.threadId).mcpApps!;
        await assert.rejects(
          run.manager.mcpApp(run.threadId, ref.id),
          { code: "MCP_APP_UNSUPPORTED" },
          name,
        );
      } finally {
        await run.stop();
      }
    }
  },
);
