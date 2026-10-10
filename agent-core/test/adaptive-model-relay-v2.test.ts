import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { AdaptiveSessionV2 } from "../src/adaptive-session-v2";
import { AdaptiveModelRelayV2 } from "../src/adaptive-model-relay-v2";

async function fixture(t: any) {
  const requests: any[] = [];
  let returnedTool = "get_order";
  let responseGate: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({
      body: JSON.parse(raw),
      auth: req.headers.authorization,
      headers: req.headers,
      url: req.url,
    });
    await responseGate;
    if (req.url?.startsWith("/v1/responses/compact")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-codex-turn-state": "compact-state",
      });
      res.end(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              name: "historical_tool",
              call_id: "old",
              arguments: "{}",
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const item = {
      type: "function_call",
      name: returnedTool,
      namespace: "mcp__adaptive",
      call_id: "call_order",
      arguments: JSON.stringify({ id: "42", fields: ["*"] }),
    };
    res.end(
      `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const session = new AdaptiveSessionV2(
    { sap: { url: "https://sap.invalid/mcp" } },
    {
      scope: { tenantId: "t1", userId: "u1" },
      authorize: () => true,
      fetch: async (_url, init) => {
        const rpc = JSON.parse(String(init?.body));
        if (!rpc.id) return new Response(null, { status: 202 });
        const result =
          rpc.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "sap", version: "1" },
              }
            : {
                tools: [
                  {
                    name: "get_order",
                    description: "Get SAP order status",
                    inputSchema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                      required: ["id"],
                    },
                  },
                  {
                    name: "delete_customer",
                    description: "Delete a customer account",
                    inputSchema: { type: "object" },
                  },
                ],
              };
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  await session.start();
  await session.beforeTurn("Get SAP order 42 status");
  const relay = new AdaptiveModelRelayV2(session, {
    name: "fixture",
    wire_api: "responses",
    base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    experimental_bearer_token: "UPSTREAM_CANARY",
    http_headers: { "x-provider-key": "HEADER_CANARY" },
    query_params: { "api-version": "fixture" },
    supports_websockets: true,
  });
  const profile = await relay.start();
  t.after(async () => {
    relay.close();
    session.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const body = {
    input: [],
    tools: [
      {
        type: "namespace",
        name: "mcp__adaptive",
        tools: [...session.gateway.exposedNames].map(([name, tool]) => ({
          type: "function",
          name,
          parameters: tool.inputSchema,
        })),
      },
    ],
  };
  const send = (token = profile.experimental_bearer_token) =>
    fetch(profile.base_url + "/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return {
    session,
    relay,
    profile,
    requests,
    send,
    returnTool(name: string) {
      returnedTool = name;
    },
    holdResponse() {
      let release!: () => void;
      responseGate = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
  };
}

test("adaptive model relay protects provider credentials, filters schemas and ties approval to exact emitted arguments", async (t) => {
  const f = await fixture(t);
  assert.doesNotMatch(
    JSON.stringify(f.profile),
    /UPSTREAM_CANARY|HEADER_CANARY/,
  );
  assert.equal(f.profile.supports_websockets, false);
  assert.equal((await f.send("wrong")).status, 401);
  assert.equal(f.requests.length, 0);
  const response = await f.send();
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(f.requests[0].auth, "Bearer UPSTREAM_CANARY");
  assert.equal(f.requests[0].headers["x-provider-key"], "HEADER_CANARY");
  assert.match(f.requests[0].url, /api-version=fixture/);
  assert.deepEqual(
    f.requests[0].body.tools[0].tools.map((tool: any) => tool.name),
    ["get_order"],
  );
  const approval = t.mock.method(f.session, "approveInvocation");
  assert.throws(
    () =>
      f.relay.approve("mcp_tool_call_approval_call_order", "delete_customer"),
    /does not match/,
  );
  f.relay.approve("mcp_tool_call_approval_call_order", "get_order");
  assert.deepEqual(approval.mock.calls[0].arguments, [
    "get_order",
    { id: "42", fields: ["*"] },
  ]);
  await (await f.send()).text();
  assert.throws(
    () => f.relay.approve("mcp_tool_call_approval_call_order", "get_order"),
    /does not match/,
  );
  f.relay.finishTurn();
  assert.equal((await f.send()).status, 502);
});

test("a response arriving after a turn finishes cannot recreate an approval", async (t) => {
  const f = await fixture(t);
  const release = f.holdResponse();
  const pending = f.send();
  while (!f.requests.length) await new Promise((r) => setImmediate(r));
  f.relay.finishTurn();
  release();
  assert.equal((await pending).status, 502);
  assert.throws(
    () => f.relay.approve("mcp_tool_call_approval_call_order", "get_order"),
    /does not match/,
  );
});

test("runtime-owned goal continuations establish a fresh route", async (t) => {
  const f = await fixture(t);
  f.relay.finishTurn();
  await f.relay.beforeTurn("Get SAP order 42 status");
  await (await f.send()).text();
  f.relay.finishTurn();
  f.relay.continueTurn();
  await (await f.send()).text();
  assert.match(JSON.stringify(f.requests.at(-1).body.tools), /get_order/);
});

test("adaptive model relay preserves remote compaction history and continuation headers", async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.profile.base_url + "/responses/compact", {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.profile.experimental_bearer_token}`,
      "content-type": "application/json",
      "x-codex-turn-state": "previous-state",
    },
    body: JSON.stringify({
      input: [{ role: "user", content: "Compact this history" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-codex-turn-state"), "compact-state");
  assert.equal((await response.json()).output[0].name, "historical_tool");
  assert.equal(f.requests[0].headers["x-codex-turn-state"], "previous-state");
  assert.throws(
    () => f.relay.approve("mcp_tool_call_approval_old", "historical_tool"),
    /does not match/,
  );
});

test("adaptive model relay blocks calls outside the route and rejects stale approvals", async (t) => {
  const f = await fixture(t);
  f.returnTool("delete_customer");
  await assert.rejects(async () => (await f.send()).text());
  assert.throws(
    () =>
      f.relay.approve("mcp_tool_call_approval_call_order", "delete_customer"),
    /does not match/,
  );
  f.returnTool("get_order");
  await (await f.send()).text();
  f.relay.finishTurn();
  assert.throws(
    () => f.relay.approve("mcp_tool_call_approval_call_order", "get_order"),
    /does not match/,
  );
});
