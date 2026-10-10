import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveSessionV2 } from "../src/adaptive-session-v2";

const body = {
  input: [{ role: "user", content: "Hi" }],
  tools: [
    { type: "function", name: "update_plan", parameters: { type: "object" } },
    {
      type: "function",
      name: "request_user_input",
      parameters: { type: "object" },
    },
    {
      type: "function",
      name: "create_document",
      parameters: { type: "object" },
    },
  ],
};
const scope = { tenantId: "t1", userId: "u1" };

function recoveryFixture(t: any, withRefresh = true) {
  const events: any[] = [],
    requests: any[] = [];
  let unavailable = true,
    refreshes = 0,
    permitted = true;
  const apps = [
    {
      guid: "app-qvd",
      name: "T_DCF_BANKREC_P",
      stream: "QVD Generator",
      owner: "private-owner",
    },
    {
      guid: "app-test",
      name: "T_DCF_BANKREC_P",
      stream: "Test",
      owner: "private-owner",
    },
  ];
  const pagination = {
    page_size: 2,
    offset: 0,
    total_count: 2,
    has_more: false,
  };
  const tools = [
    "get_apps",
    "get_app_details",
    "get_app_script",
    "get_lineage",
    "get_app_sheets",
  ].map((name) => ({
    name,
    description:
      name === "get_apps"
        ? "List Qlik applications accessible to the user"
        : `Retrieve Qlik application ${name.replace(/_/g, " ")}`,
    inputSchema: {
      type: "object",
      properties:
        name === "get_apps"
          ? { name: { type: "string" } }
          : { app_id: { type: "string" } },
      ...(name !== "get_apps" ? { required: ["app_id"] } : {}),
      additionalProperties: false,
    },
    // Actual Qlik's missing read-only annotation must still require approval.
  }));
  const fetcher: typeof fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body));
    requests.push(rpc);
    if (rpc.method === "initialize" && unavailable)
      throw new DOMException("Fixture initialize timeout", "TimeoutError");
    if (rpc.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "qlik", version: "fixture" },
          }
        : rpc.method === "tools/list"
          ? { tools }
          : {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    rpc.params.name === "get_apps"
                      ? { apps, pagination }
                      : {
                          app_id: rpc.params.arguments.app_id,
                          name: "T_DCF_BANKREC_P",
                          verifiedMetadata: true,
                        },
                  ),
                },
              ],
            };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const session = new AdaptiveSessionV2(
    { qlik: { url: "https://qlik.invalid/mcp", startup_timeout_sec: 30 } },
    {
      scope,
      authorize: () => permitted,
      fetch: fetcher,
      hydration: { maxAttempts: 1, retryDelayMs: 0 },
      onEvent: (event) => events.push(event),
      ...(withRefresh
        ? {
            refreshDispatchCatalog: async () => {
              refreshes++;
            },
          }
        : {}),
    },
  );
  t.after(() => session.close());
  const exposedBody = () => ({
    ...body,
    tools: [
      ...body.tools,
      {
        type: "namespace",
        name: "mcp__adaptive",
        tools: [...session.gateway.exposedNames].map(([name, descriptor]) => ({
          type: "function",
          name,
          parameters: descriptor.inputSchema,
        })),
      },
    ],
  });
  return {
    session,
    events,
    requests,
    apps,
    pagination,
    exposedBody,
    restore() {
      unavailable = false;
    },
    permit(value: boolean) {
      permitted = value;
    },
    refreshes: () => refreshes,
  };
}

async function callGateway(config: any, name: string, args: any) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { ...config.http_headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return ((await response.json()) as any).result;
}
test("new external session requires platform authorization and authenticated scope", () => {
  assert.throws(
    () => new AdaptiveSessionV2({}, { scope, authorize: undefined as any }),
    /authorization/,
  );
  assert.throws(
    () =>
      new AdaptiveSessionV2(
        {},
        { scope: { tenantId: "", userId: "" }, authorize: () => true },
      ),
    /authenticated/,
  );
});
test("external session routes before provider request, filters native tools and guards actions", async () => {
  const events: any[] = [];
  const session = new AdaptiveSessionV2(
    {},
    { scope, authorize: () => true, onEvent: (e) => events.push(e) },
  );
  try {
    const config = await session.start();
    assert.equal(config.default_tools_approval_mode, "prompt");
    // Omni parity: metadata-only discovery is not prompted; invocation still is.
    for (const name of ["discover_server", "discover_tools", "get_tool_schema"])
      assert.equal(config.tools[name].approval_mode, "approve");
    assert.equal(config.tools.invoke_tool.approval_mode, "prompt");
    await assert.rejects(session.filterModelRequest(body), /Route a user turn/);
    const plan = await session.beforeTurn("Hi bro?");
    assert.equal(plan.mode, "no_tools");
    assert.deepEqual(plan.selected, []);
    const filtered = await session.filterModelRequest(body);
    assert.deepEqual(
      filtered.body.tools.map((t: any) => t.name),
      ["update_plan", "request_user_input"],
    );
    assert.deepEqual(filtered.body.input, body.input);
    assert.equal(session.registry.all().length, 3);
    await assert.rejects(
      session.beforeTurn("Another turn"),
      /Finish the current/,
    );
    const denied = new Response(
      JSON.stringify({
        output: [{ type: "function_call", name: "create_document" }],
      }),
      { headers: { "content-type": "application/json" } },
    );
    await assert.rejects(session.guardModelResponse(denied).text(), /outside/);
    session.finishTurn();
    await session.beforeTurn("Create a Word document");
    const native = await session.filterModelRequest(body);
    assert.equal(native.allowedNames.has("create_document"), true);
    assert.ok(
      events.some(
        (e) => e.type === "model_exposure" && e.exposedSchemaCount === 3,
      ),
    );
  } finally {
    session.close();
  }
});
test("session evaluates current native permissions for each model request", async () => {
  let allowed = true;
  const session = new AdaptiveSessionV2(
    {},
    { scope, authorize: () => allowed },
  );
  try {
    await session.start();
    await session.beforeTurn("Create a document");
    assert.equal(
      (await session.filterModelRequest(body)).allowedNames.has(
        "create_document",
      ),
      true,
    );
    allowed = false;
    assert.equal(
      (await session.filterModelRequest(body)).allowedNames.has(
        "create_document",
      ),
      false,
    );
    await session.invalidate("permission");
    await assert.rejects(session.filterModelRequest(body), /Route a user turn/);
    await session.beforeTurn("What is the capital of India?");
    assert.equal(
      (await session.filterModelRequest(body)).trace.exposedSchemaCount,
      2,
    );
  } finally {
    session.close();
  }
});
test("closed session cannot expose schemas or start model requests", async () => {
  const session = new AdaptiveSessionV2({}, { scope, authorize: () => true });
  await session.start();
  session.close();
  await assert.rejects(session.start(), /closed/);
  await assert.rejects(session.beforeTurn("Hi"), /closed/);
  await assert.rejects(session.filterModelRequest(body), /closed/);
});

test("failed catalog safely recovers before a business turn and refreshes dispatch exactly once", async (t) => {
  const f = recoveryFixture(t),
    config = await f.session.start();
  assert.equal(f.session.gateway.registryStatus.state, "failed");
  assert.equal(f.session.gateway.registryStatus.upstreamToolCount, 0);
  const greeting = await f.session.beforeTurn("hi this is ashok ?");
  assert.equal(greeting.mode, "no_tools");
  assert.deepEqual(
    [...(await f.session.filterModelRequest(body)).allowedNames],
    ["update_plan", "request_user_input"],
  );
  f.session.finishTurn();
  f.restore();
  const plan = await f.session.beforeTurn("what are the Qlik apps ?");
  assert.equal(f.session.gateway.registryStatus.state, "ready");
  assert.equal(plan.mode, "direct_tools");
  assert.deepEqual(
    plan.selected.map((tool) => tool.toolName),
    ["get_apps"],
  );
  assert.equal(f.refreshes(), 1);
  const filtered = await f.session.filterModelRequest(f.exposedBody());
  assert.deepEqual(
    [...filtered.allowedNames],
    ["update_plan", "request_user_input", "mcp__adaptive::get_apps"],
  );
  const args = {};
  f.session.approveInvocation("get_apps", args);
  const result = await callGateway(config, "get_apps", args);
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.deepEqual(data.pagination, f.pagination);
  assert.deepEqual(
    data.apps,
    f.apps.map(({ owner: _owner, ...app }) => app),
  );
  f.session.finishTurn();
  const capital = await f.session.beforeTurn(
    "What is the capital of tamilnadu ?",
  );
  assert.equal(capital.mode, "no_tools");
  f.session.finishTurn();
  const explanation = await f.session.beforeTurn("Explain T_DCF_BANKREC_P");
  assert.equal(explanation.mode, "direct_tools");
  assert.deepEqual(
    explanation.selected.map((tool) => tool.toolName).sort(),
    [
      "get_apps",
      "get_app_details",
      "get_app_script",
      "get_app_sheets",
      "get_lineage",
    ].sort(),
  );
  const expanded = await f.session.filterModelRequest(f.exposedBody());
  assert.equal(expanded.allowedNames.size, 7);
  assert.equal(
    [...expanded.allowedNames].some((name) => name.includes("discover_")),
    false,
  );
  const detailsArgs = { app_id: "app-qvd", fields: ["*"] };
  const denied = await callGateway(config, "get_app_details", detailsArgs);
  assert.equal(denied.isError, true);
  f.session.approveInvocation("get_app_details", detailsArgs);
  const details = await callGateway(config, "get_app_details", detailsArgs);
  assert.equal(JSON.parse(details.content[0].text).app_id, "app-qvd");
  assert.equal(
    f.requests.filter(
      (rpc) =>
        rpc.method === "tools/call" && rpc.params.name === "get_app_details",
    ).length,
    1,
  );
  assert.equal(
    f.requests.filter((rpc) => rpc.method === "tools/list").length,
    1,
  );
  assert.equal(f.refreshes(), 1);
  assert.equal(
    f.events.some(
      (event) =>
        event.type === "platform_routing" && event.registry.state === "ready",
    ),
    true,
  );
});

test("recovered schemas remain blocked until a host dispatch refresh succeeds", async (t) => {
  const f = recoveryFixture(t, false);
  await f.session.start();
  f.restore();
  await assert.rejects(
    f.session.beforeTurn("what are the Qlik apps ?"),
    /host dispatch refresh/,
  );
  await assert.rejects(
    f.session.beforeTurn("what are the Qlik apps ?"),
    /host dispatch refresh/,
  );
  await assert.rejects(
    f.session.filterModelRequest(f.exposedBody()),
    /Route a user turn/,
  );
  assert.equal(
    f.requests.some((rpc) => rpc.method === "tools/call"),
    false,
  );
});

test("session invalidation removes successful app routing hints before following up", async (t) => {
  const f = recoveryFixture(t);
  f.restore();
  const config = await f.session.start();
  await f.session.beforeTurn("What are the Qlik apps?");
  f.session.approveInvocation("get_apps", {});
  await callGateway(config, "get_apps", {});
  f.session.finishTurn();
  assert.equal((f.session as any).context.activeEntities.length, 2);
  assert.equal(
    (f.session as any).context.activeEntities[0].name,
    (f.session as any).context.activeEntities[1].name,
  );
  assert.notEqual(
    (f.session as any).context.activeEntities[0].guid,
    (f.session as any).context.activeEntities[1].guid,
  );
  await f.session.invalidate("permission");
  assert.deepEqual((f.session as any).context, {});
  assert.equal(f.refreshes(), 1);
});

test("a fresh permission grant refreshes the host dispatch catalog without rediscovering upstream schemas", async (t) => {
  const f = recoveryFixture(t);
  f.restore();
  f.permit(false);
  const config = await f.session.start();
  const list = async () => {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { ...config.http_headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 73, method: "tools/list" }),
    });
    return (await response.json()).result.tools;
  };
  const before = await list();
  assert.equal(
    before.some((tool: any) => tool.name === "get_apps"),
    false,
  );
  assert.equal(f.session.gateway.registryStatus.state, "ready");
  f.permit(true);
  const route = await f.session.beforeTurn("what are the Qlik apps ?");
  assert.equal(route.mode, "direct_tools");
  assert.equal(f.refreshes(), 1);
  const after = await list();
  assert.equal(
    after.some((tool: any) => tool.name === "get_apps"),
    true,
  );
  assert.equal(
    f.requests.filter((rpc) => rpc.method === "tools/list").length,
    1,
  );
  assert.equal(
    f.requests.some((rpc) => rpc.method === "tools/call"),
    false,
  );
});
