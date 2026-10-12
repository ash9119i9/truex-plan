import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AdaptiveMcpGatewayV2 } from "../src/adaptive-mcp-gateway-v2";
import type { ConnectorConfig } from "../src/omni-mcp-gateway";

const schema = (properties: any = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const appTool = {
  name: "get_apps",
  description: "List apps",
  annotations: { readOnlyHint: true },
  inputSchema: schema({ limit: { type: "integer" } }),
};
const appData = {
  apps: [
    {
      name: "App A",
      guid: "a",
      stream: "Operations",
      description: "Large omitted description",
      modified: "2026-10-03",
    },
  ],
  pagination: { total_found: 1000, has_more: true, next_offset: 1 },
};
const parse = (result: any) => JSON.parse(result.content[0].text);

test("hydrates mixed draft-07 and 2020-12 MCP schemas without weakening validation", async (t) => {
  const modern = {
    name: "open_session",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { target: { type: "string", minLength: 1 } },
      required: ["target"],
      unevaluatedProperties: false,
    },
  };
  const f = await fixture(t, { qlik: [appTool], e2e: [modern] });
  const tool = f.registry.find((tool) => tool.toolName === "open_session")!;
  assert.equal(tool.inputSchema.$schema, modern.inputSchema.$schema);
  f.gateway.setRouting({
    mode: "direct_tools",
    selected: [tool],
    query: "open session",
  });
  for (const args of [
    { target: "", fields: ["*"] },
    { target: "web", extra: true, fields: ["*"] },
    { target: "web" },
  ]) {
    const result = await f.invoke(tool.bindingName!, args);
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result),
      /Arguments do not match the exposed tool schema/,
    );
  }
  assert.equal(f.calls.length, 0);
  f.gateway.approveInvocation(tool.bindingName!, {
    target: "web",
    fields: ["*"],
  });
  await f.invoke(tool.bindingName!, { target: "web", fields: ["*"] });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].arguments, { target: "web" });
});
async function fixture(
  t: any,
  catalogs: Record<string, any[]> = { qlik: [appTool] },
  options: any = {},
  behavior: any = {},
) {
  const calls: any[] = [],
    initialize: any[] = [],
    requests: any[] = [];
  const server = createServer(async (req, res) => {
    // Fixture-only transport warm-up has no MCP side effects or request count.
    if (req.url === "/fixture-warmup") {
      res.writeHead(204).end();
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const rpc = JSON.parse(raw),
      name = req.url!.slice(1);
    requests.push({ server: name, method: rpc.method, name: rpc.params?.name });
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === "initialize" && behavior.hangInitializeAttempts > 0) {
      behavior.hangInitializeAttempts--;
      return;
    }
    if (rpc.method === "initialize" && behavior.initializeFailures > 0) {
      behavior.initializeFailures--;
      res.writeHead(503).end();
      return;
    }
    if (
      (rpc.method === "initialize" && behavior.failInitialize === name) ||
      (rpc.method === "tools/call" && behavior.failCall === name)
    ) {
      res.writeHead(503).end();
      return;
    }
    let result: any = {};
    if (rpc.method === "initialize") {
      initialize.push({ name, auth: req.headers["x-test-key"] });
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name, version: "1" },
      };
    } else if (rpc.method === "tools/list") {
      const offset = Number(rpc.params?.cursor || "0"),
        limit = behavior.pageSize || 70;
      result = {
        tools: catalogs[name].slice(offset, offset + limit),
        ...(offset + limit < catalogs[name].length
          ? { nextCursor: String(offset + limit) }
          : {}),
      };
    } else if (rpc.method === "tools/call") {
      calls.push({
        server: name,
        name: rpc.params.name,
        arguments: rpc.params.arguments,
        auth: req.headers["x-test-key"],
      });
      if (behavior.hangCall === rpc.params.name) return;
      if (behavior.rpcError) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: {
              code: -32602,
              message: "Original RPC error",
              data: { reason: "fixture" },
            },
          }),
        );
        return;
      }
      result = behavior.result || {
        content: [{ type: "text", text: JSON.stringify(appData) }],
        _meta: { fullDuplicate: appData },
      };
    }
    if (behavior.sse)
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`,
        );
    else
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const configs: Record<string, ConnectorConfig> = Object.fromEntries(
    Object.keys(catalogs).map((name) => [
      name,
      {
        url: `http://127.0.0.1:${(server.address() as any).port}/${name}`,
        http_headers: { "x-test-key": `SECRET_${name}_CANARY` },
        ...(behavior.toolTimeoutSec !== undefined
          ? { tool_timeout_sec: behavior.toolTimeoutSec }
          : {}),
      },
    ]),
  );
  if (behavior.warmTransport) {
    // The 20 ms retry test measures a received hung RPC, not first-fetch setup.
    // Without this, cold fetch can time out before the first initialize reaches
    // the fixture and consume one of the two attempts without exercising it.
    const origin = new URL(Object.values(configs)[0].url!).origin;
    const warm = await fetch(`${origin}/fixture-warmup`, {
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(warm.status, 204);
  }
  const events: any[] = [];
  const gateway = new AdaptiveMcpGatewayV2(
    configs,
    (event) => events.push(event),
    fetch,
    {
      scope: { tenantId: "tenant-a", userId: "user-a" },
      authorizeExposure: () => true,
      authorizeExecution: () => true,
      ...options,
    },
  );
  t.after(async () => {
    gateway.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const registry = await gateway.initializeRegistry(),
    endpoint = await gateway.start();
  let next = 0;
  const rpc = async (
    method: string,
    params: any = {},
    headers = endpoint.http_headers,
  ) => {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++next, method, params }),
    });
    return {
      status: response.status,
      value:
        response.status === 200 ? ((await response.json()) as any) : undefined,
    };
  };
  const invoke = async (name: string, args: any) =>
    (await rpc("tools/call", { name, arguments: args })).value.result;
  return {
    gateway,
    registry,
    configs,
    endpoint,
    events,
    calls,
    initialize,
    requests,
    rpc,
    invoke,
  };
}
const direct = (f: any, query = "list apps") =>
  f.gateway.setRouting({ mode: "direct_tools", selected: f.registry, query });
const discovery = (f: any) =>
  f.gateway.setRouting({ mode: "discovery", selected: [], query: "ambiguous" });

test("hydrates all paginated schemas outside model context and caches transport catalog", async (t) => {
  const tools = Array.from({ length: 140 }, (_, i) => ({
    name: `tool_${i}`,
    inputSchema: schema(),
    annotations: { readOnlyHint: true },
  }));
  const f = await fixture(t, { qlik: tools }, {}, { sse: true, pageSize: 30 });
  assert.equal(f.registry.length, 140);
  assert.equal((await f.gateway.initializeRegistry()).length, 140);
  assert.equal(f.initialize.length, 1);
  const catalog = (await f.rpc("tools/list")).value.result.tools;
  assert.equal(catalog.length, 144);
  assert.ok(
    f.registry.every(
      (tool) =>
        tool.tenantId === "tenant-a" &&
        tool.sourceType === "mcp" &&
        tool.bindingName,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(f.registry),
    /SECRET_qlik_CANARY|http_headers/,
  );
});

test("collision binding retains correct upstream server and logical tool", async (t) => {
  const f = await fixture(t, {
    "sap-a": [appTool],
    sap_a: [appTool],
    qlik: [appTool],
  });
  assert.equal(new Set(f.registry.map((tool) => tool.bindingName)).size, 3);
  direct(f);
  for (const tool of f.registry)
    await f.invoke(tool.bindingName!, { limit: 2 });
  assert.deepEqual(f.calls.map((call) => call.server).sort(), [
    "qlik",
    "sap-a",
    "sap_a",
  ]);
  assert.ok(
    f.calls.every(
      (call) => call.name === "get_apps" && call.arguments.limit === 2,
    ),
  );
});

test("known listing projection is deterministic and keeps identifiers and pagination before history", async (t) => {
  const f = await fixture(t);
  direct(f);
  const result = await f.invoke(f.registry[0].bindingName!, { limit: 1 });
  assert.deepEqual(parse(result), {
    apps: [{ name: "App A", guid: "a", stream: "Operations" }],
    pagination: appData.pagination,
  });
  assert.equal(result._meta, undefined);
  assert.deepEqual(f.calls[0].arguments, { limit: 1 });
  const event = f.events.find((event) => event.type === "invoke");
  assert.ok(event.inputBytes > event.outputBytes);
  assert.ok(event.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET_qlik_CANARY/);
});

test("per-turn execution rejects unexposed bindings and clears old write approvals", async (t) => {
  const write = {
    name: "update_apps",
    inputSchema: schema({ id: { type: "string" } }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
  };
  const f = await fixture(t, { qlik: [appTool, write] });
  const get = f.registry.find((tool) => tool.toolName === "get_apps")!,
    update = f.registry.find((tool) => tool.toolName === "update_apps")!;
  f.gateway.setRouting({
    mode: "direct_tools",
    selected: [get],
    query: "list",
  });
  assert.equal(
    (await f.invoke(update.bindingName!, { id: "a", fields: ["*"] })).isError,
    true,
  );
  assert.equal(f.calls.length, 0);
  f.gateway.setRouting({
    mode: "direct_tools",
    selected: [update],
    query: "update",
  });
  f.gateway.approveInvocation(update.bindingName!, { id: "a", fields: ["*"] });
  f.gateway.setRouting({
    mode: "direct_tools",
    selected: [update],
    query: "next turn",
  });
  assert.match(
    JSON.stringify(
      await f.invoke(update.bindingName!, { id: "a", fields: ["*"] }),
    ),
    /explicit approval/,
  );
  assert.equal(f.calls.length, 0);
});

test("write approvals are exact, single-use, and fail closed", async (t) => {
  const tool = {
    name: "update",
    inputSchema: schema({ id: { type: "string" } }, ["id"]),
    annotations: { destructiveHint: true },
  };
  const f = await fixture(t, { sap: [tool] });
  direct(f);
  const name = f.registry[0].bindingName!,
    args = { id: "one", fields: ["*"] };
  assert.equal((await f.invoke(name, args)).isError, true);
  f.gateway.approveInvocation(name, args);
  assert.equal((await f.invoke(name, { ...args, id: "two" })).isError, true);
  assert.equal(f.calls.length, 0);
  assert.notEqual((await f.invoke(name, args)).isError, true);
  assert.equal((await f.invoke(name, args)).isError, true);
  assert.equal(f.calls.length, 1);
});

test("execution and discovery re-check current permissions instead of reusing hydration grants", async (t) => {
  let allowed = true;
  const f = await fixture(t, undefined, {
    authorizeExposure: () => allowed,
    authorizeExecution: () => allowed,
  });
  direct(f);
  allowed = false;
  assert.equal((await f.invoke(f.registry[0].bindingName!, {})).isError, true);
  assert.equal(f.calls.length, 0);
  discovery(f);
  assert.deepEqual(
    parse(await f.invoke("discover_server", { query: "" })).servers,
    [],
  );
  assert.equal(
    (await f.invoke("get_tool_schema", { server: "qlik", tool: "get_apps" }))
      .isError,
    true,
  );
  assert.equal((await f.rpc("tools/list")).value.result.tools.length, 4);
});

test("fallback discovery includes pagination and invocations need their own receipt", async (t) => {
  const tools = Array.from({ length: 125 }, (_, i) => ({
    ...appTool,
    name: `app_${i}`,
  }));
  const f = await fixture(t, { qlik: tools });
  discovery(f);
  const first = parse(
    await f.invoke("discover_tools", { server: "qlik", limit: 100 }),
  );
  const second = parse(
    await f.invoke("discover_tools", {
      server: "qlik",
      cursor: first.nextCursor,
    }),
  );
  assert.equal(first.tools.length, 100);
  assert.equal(second.tools.length, 25);
  assert.equal(first.totalMatched, 125);
  const args = {
    server: "qlik",
    tool: "app_0",
    arguments: {},
    fields: ["apps.name"],
  };
  assert.equal((await f.invoke("invoke_tool", args)).isError, true);
  f.gateway.approveInvocation("invoke_tool", args);
  const result = await f.invoke("invoke_tool", args);
  assert.equal(parse(result).apps[0].name, "App A");
  assert.deepEqual(parse(result).pagination, appData.pagination);
  assert.equal(f.calls.length, 1);
});

test("projection property collision preserves downstream fields and explicit full escape", async (t) => {
  const tool = {
    name: "get_report",
    annotations: { readOnlyHint: true },
    inputSchema: schema(
      { fields: { type: "array", items: { type: "string" } } },
      ["fields"],
    ),
  };
  const f = await fixture(t, { sap: [tool] });
  direct(f);
  const property = f.gateway.projectionProperties.get(
    f.registry[0].bindingName!,
  );
  assert.equal(property, "_gatewayFields");
  const result = await f.invoke(f.registry[0].bindingName!, {
    fields: ["business_column"],
    _gatewayFields: ["*"],
  });
  assert.equal(
    result._meta.fullDuplicate.apps[0].description,
    "Large omitted description",
  );
  assert.deepEqual(f.calls[0].arguments, { fields: ["business_column"] });
  assert.equal(
    (
      await f.invoke(f.registry[0].bindingName!, {
        fields: [],
        _gatewayFields: ["*", "apps.name"],
      })
    ).isError,
    true,
  );
  assert.equal(f.calls.length, 1);
});

test("invalidation clears route and schemas, reconnects, and rehydrates enable changes", async (t) => {
  const f = await fixture(t);
  direct(f);
  f.gateway.invalidate("schema");
  assert.equal(f.gateway.exposedNames.size, 0);
  assert.equal((await f.invoke("get_apps", {})).isError, true);
  const refreshed = await f.gateway.initializeRegistry();
  assert.equal(f.initialize.length, 2);
  f.gateway.setRouting({
    mode: "direct_tools",
    selected: refreshed,
    query: "list apps",
  });
  assert.notEqual(
    (await f.invoke(refreshed[0].bindingName!, {})).isError,
    true,
  );
  f.gateway.invalidate("enable", {
    qlik: { ...f.configs.qlik, enabled: false },
  });
  assert.equal((await f.gateway.initializeRegistry()).length, 0);
});

test("loopback credentials are isolated per tenant and cannot be used on another gateway", async (t) => {
  const f = await fixture(t);
  const other = new AdaptiveMcpGatewayV2(f.configs, undefined, fetch, {
    scope: { tenantId: "tenant-b", userId: "user-b" },
  });
  t.after(() => other.close());
  const registry = await other.initializeRegistry(),
    endpoint = await other.start();
  assert.ok(registry.every((tool) => tool.tenantId === "tenant-b"));
  assert.notEqual(
    endpoint.http_headers.Authorization,
    f.endpoint.http_headers.Authorization,
  );
  assert.equal(
    (await f.rpc("tools/list", {}, endpoint.http_headers)).status,
    403,
  );
  assert.equal((await f.rpc("tools/list", {}, {})).status, 403);
  assert.equal(
    (
      await f.rpc(
        "tools/list",
        {},
        { ...f.endpoint.http_headers, Origin: "https://untrusted.example" },
      )
    ).status,
    403,
  );
  assert.deepEqual(f.gateway.scope, { tenantId: "tenant-a", userId: "user-a" });
  assert.equal(Object.isFrozen(f.gateway.scope), true);
  try {
    (f.gateway.scope as any).tenantId = "tenant-b";
  } catch {
    /* Strict runtimes reject frozen assignment. */
  }
  assert.equal(f.gateway.scope.tenantId, "tenant-a");
});

test("rate limits apply to fallback discovery as well as real invocations", async (t) => {
  const f = await fixture(t, undefined, { maxCallsPerMinute: 2 });
  discovery(f);
  assert.notEqual(
    (await f.invoke("discover_server", { query: "qlik" })).isError,
    true,
  );
  assert.notEqual(
    (await f.invoke("discover_server", { query: "qlik" })).isError,
    true,
  );
  assert.match(
    JSON.stringify(await f.invoke("discover_server", { query: "qlik" })),
    /rate limit/,
  );
  assert.equal(f.calls.length, 0);
});

test("preserves downstream tool/RPC errors and does not retry completed projection failures", async (t) => {
  const f = await fixture(
    t,
    undefined,
    {},
    { result: { content: [{ type: "text", text: "Non-JSON response" }] } },
  );
  direct(f);
  assert.match(
    JSON.stringify(await f.invoke("get_apps", {})),
    /action completed.*not projectable.*Do not repeat/,
  );
  assert.equal(f.calls.length, 1);
  const bad = await fixture(t, undefined, {}, { rpcError: true });
  direct(bad);
  const error = await bad.invoke("get_apps", {});
  assert.equal(error.isError, true);
  assert.equal(parse(error).error.code, -32602);
  assert.equal(bad.calls.length, 1);
  const toolError = await fixture(
    t,
    undefined,
    {},
    {
      result: {
        isError: true,
        content: [{ type: "text", text: "Business access denied" }],
      },
    },
  );
  direct(toolError);
  assert.deepEqual(await toolError.invoke("get_apps", {}), {
    isError: true,
    content: [{ type: "text", text: "Business access denied" }],
  });
});

test("one unavailable connector does not prevent hydration or routing of healthy connectors", async (t) => {
  const f = await fixture(
    t,
    { sap: [appTool], qlik: [appTool] },
    {},
    { failInitialize: "sap" },
  );
  assert.equal(f.registry.length, 1);
  assert.equal(f.registry[0].serverId, "qlik");
  assert.equal(f.gateway.hasUnavailable, true);
  assert.ok(f.gateway.unavailableServers.has("sap"));
  direct(f);
  assert.notEqual(
    (await f.invoke(f.registry[0].bindingName!, {})).isError,
    true,
  );
  assert.ok(
    f.events.some(
      (event) => event.type === "unavailable" && event.server === "sap",
    ),
  );
});

test("transport execution failure marks current metadata unavailable without another action retry", async (t) => {
  const behavior: any = {};
  const f = await fixture(t, { qlik: [appTool], sap: [appTool] }, {}, behavior);
  direct(f);
  behavior.failCall = "qlik";
  assert.equal((await f.invoke("qlik__get_apps", {})).isError, true);
  assert.ok(f.gateway.unavailableServers.has("qlik"));
  assert.equal(
    (await f.gateway.initializeRegistry()).find(
      (tool) => tool.serverId === "qlik",
    )!.available,
    false,
  );
  assert.equal((await f.invoke("qlik__get_apps", {})).isError, true);
  assert.notEqual((await f.invoke("sap__get_apps", {})).isError, true);
  assert.deepEqual(
    f.calls.map((call) => call.server),
    ["sap"],
  );
});

test("route rejects forged scope and clearRouting revokes execution without clearing hydrated metadata", async (t) => {
  const f = await fixture(t);
  direct(f);
  assert.throws(
    () =>
      f.gateway.setRouting({
        mode: "direct_tools",
        selected: [{ ...f.registry[0], tenantId: "tenant-b" }],
      }),
    /unavailable tool binding/,
  );
  assert.throws(
    () =>
      f.gateway.setRouting({
        mode: "direct_tools",
        selected: [{ ...f.registry[0], scope: "global" }],
      }),
    /unavailable tool binding/,
  );
  f.gateway.clearRouting();
  assert.equal(f.gateway.exposedNames.size, 1);
  assert.equal((await f.invoke("get_apps", {})).isError, true);
  assert.equal(f.calls.length, 0);
});

test("deterministic projection follows name/date intent and explicit fields retain nested pagination", async (t) => {
  const f = await fixture(
    t,
    undefined,
    {},
    {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...appData,
              apps: [{ ...appData.apps[0], modified_dttm: "2026-10-03" }],
              nextCursor: "cursor-2",
              meta: { pageInfo: { hasNextPage: true }, extra: "omit" },
            }),
          },
        ],
      },
    },
  );
  direct(f, "Give only app names");
  const names = parse(await f.invoke("get_apps", {}));
  assert.deepEqual(names.apps, [{ name: "App A" }]);
  assert.equal(names.nextCursor, "cursor-2");
  assert.deepEqual(names.meta, { pageInfo: { hasNextPage: true } });
  direct(f, "List recently modified apps");
  const dated = parse(await f.invoke("get_apps", {}));
  assert.equal(dated.apps[0].modified_dttm, "2026-10-03");
  assert.equal(dated.apps[0].description, undefined);
});

test("enabled tool filters and stable legal bindings are preserved across invalidation", async (t) => {
  const f = await fixture(t, {
    "1-qlik": [appTool, { ...appTool, name: "other" }],
  });
  f.gateway.invalidate("config", {
    "1-qlik": { ...f.configs["1-qlik"], enabled_tools: ["get_apps"] },
  });
  const first = await f.gateway.initializeRegistry();
  assert.equal(first.length, 1);
  assert.match(first[0].bindingName!, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  f.gateway.invalidate("reconnect");
  assert.equal(
    (await f.gateway.initializeRegistry())[0].bindingName,
    first[0].bindingName,
  );
  assert.deepEqual(f.registry.map((tool) => tool.toolName).sort(), [
    "get_apps",
    "other",
  ]);
});

test("approval receipts expire and execution re-checks permission after approval", async (t) => {
  let allowed = true;
  const f = await fixture(
    t,
    {
      sap: [
        {
          name: "update",
          inputSchema: schema(),
          annotations: { destructiveHint: true },
        },
      ],
    },
    { receiptTtlMs: 1, authorizeExecution: () => allowed },
  );
  direct(f);
  const name = f.registry[0].bindingName!,
    args = { fields: ["*"] };
  f.gateway.approveInvocation(name, args);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal((await f.invoke(name, args)).isError, true);
  f.gateway.approveInvocation(name, args);
  allowed = false;
  assert.equal((await f.invoke(name, args)).isError, true);
  assert.equal(f.calls.length, 0);
});

test("credential values returned by downstream do not reach model output or audit events", async (t) => {
  const f = await fixture(
    t,
    undefined,
    {},
    {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              apps: [{ name: "SECRET_qlik_CANARY" }],
              pagination: {},
            }),
          },
        ],
      },
    },
  );
  direct(f, "Give the full original response for apps");
  const result = await f.invoke("get_apps", { fields: ["*"] });
  assert.match(JSON.stringify(result), /REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_qlik_CANARY/);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET_qlik_CANARY/);
});

test("platform owns simple app-listing projection and a model wildcard cannot bypass it", async (t) => {
  const f = await fixture(t);
  direct(f, "Can you list down the apps in the qlik ?");
  const current = f.gateway.exposedNames.get("get_apps")!;
  assert.equal((current.inputSchema.properties as any).fields, undefined);
  assert.ok(
    f.registry[0].inputSchema.properties &&
      (f.registry[0].inputSchema.properties as any).fields,
    "Static runtime schema remains unchanged",
  );
  const result = parse(
    await f.invoke("get_apps", { limit: 50, fields: ["*"] }),
  );
  assert.equal(result.apps[0].description, undefined);
  assert.equal(result.apps[0].guid, "a");
  assert.deepEqual(result.pagination, appData.pagination);
  const policy = f.events.find((event) => event.type === "projection_policy");
  assert.equal(policy.policy, "platform");
  const audit = f.events.find((event) => event.type === "invoke");
  assert.deepEqual(audit.requestedFields, ["*"]);
  assert.deepEqual(audit.effectiveFields, [
    "apps.name",
    "apps.guid",
    "apps.stream",
    "pagination",
  ]);
  assert.equal(audit.projectionPolicy, "platform");
});

test("all apps is pagination intent; explicit raw or all fields preserves full-result escape", async (t) => {
  const f = await fixture(t);
  direct(f, "List all apps in qlik");
  assert.equal(
    (f.gateway.exposedNames.get("get_apps")!.inputSchema.properties as any)
      .fields,
    undefined,
  );
  assert.equal(
    parse(await f.invoke("get_apps", { fields: ["*"] })).apps[0].description,
    undefined,
  );
  for (const query of [
    "Give the raw response for apps",
    "List apps with all fields",
    "Give the full original output for apps",
  ]) {
    direct(f, query);
    assert.ok(
      (f.gateway.exposedNames.get("get_apps")!.inputSchema.properties as any)
        .fields,
    );
    assert.equal(
      parse(await f.invoke("get_apps", { fields: ["*"] })).apps[0].description,
      "Large omitted description",
    );
  }
});

test("unknown requested metadata stays model-selectable rather than being silently removed", async (t) => {
  const f = await fixture(
    t,
    undefined,
    {},
    {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              apps: [{ name: "App A", owner: "Ashok" }],
              pagination: {},
            }),
          },
        ],
      },
    },
  );
  direct(f, "List the apps with their owners");
  assert.ok(
    (f.gateway.exposedNames.get("get_apps")!.inputSchema.properties as any)
      .fields,
  );
  const result = parse(
    await f.invoke("get_apps", { fields: ["apps.name", "apps.owner"] }),
  );
  assert.equal(result.apps[0].owner, "Ashok");
  assert.equal(
    (await f.invoke("get_apps", {})).isError,
    true,
    "Unsupported intent requires explicit field selection",
  );
});

test("metadata timeout retries are bounded and failed hydration is never healthy empty discovery", async (t) => {
  const f = await fixture(
    t,
    undefined,
    { hydration: { maxAttempts: 2, retryDelayMs: 0, hydrationTimeoutMs: 15 } },
    { hangInitializeAttempts: 10 },
  );
  assert.equal(f.registry.length, 0);
  assert.equal(f.gateway.registryStatus.state, "failed");
  assert.equal(f.gateway.registryStatus.upstreamToolCount, 0);
  assert.equal(f.gateway.registryStatus.servers[0].attempts, 2);
  assert.equal(
    f.gateway.registryStatus.servers[0].lastError?.stage,
    "initialize",
  );
  assert.equal(f.gateway.registryStatus.servers[0].lastError?.kind, "timeout");
  assert.equal(
    f.requests.filter((request) => request.method === "initialize").length,
    2,
  );
  discovery(f);
  const servers = parse(await f.invoke("discover_server", { query: "qlik" }));
  assert.equal(servers.registryState, "failed");
  assert.equal(servers.unavailableServers[0].name, "qlik");
  assert.match(
    JSON.stringify(await f.invoke("discover_tools", { server: "qlik" })),
    /not an empty successful discovery/,
  );
  assert.equal(f.calls.length, 0);
});

test("transient metadata timeout recovers within the bounded read retry without a business call", async (t) => {
  const f = await fixture(
    t,
    undefined,
    { hydration: { maxAttempts: 2, retryDelayMs: 0, hydrationTimeoutMs: 20 } },
    { hangInitializeAttempts: 1, warmTransport: true },
  );
  assert.equal(
    f.gateway.registryStatus.state,
    "ready",
    JSON.stringify({
      requests: f.requests.map((r: { method: string }) => r.method),
      attempts: f.gateway.registryStatus.servers[0].attempts,
      failure: f.gateway.registryStatus.servers[0].lastError?.stage,
    }),
  );
  assert.equal(f.registry.length, 1);
  assert.equal(f.registry[0].bindingName, "get_apps");
  assert.equal(f.gateway.registryStatus.servers[0].attempts, 2);
  assert.equal(
    f.requests.filter((r: { method: string }) => r.method === "initialize")
      .length,
    2,
  );
  assert.equal(f.initialize.length, 1);
  assert.equal(f.calls.length, 0);
  assert.ok(f.events.some((event) => event.type === "metadata_retry"));
});

test("explicit recovery changes the catalog while preserving healthy servers and the endpoint", async (t) => {
  const behavior: any = { failInitialize: "sap" };
  const f = await fixture(
    t,
    { qlik: [appTool], sap: [appTool] },
    { hydration: { maxAttempts: 1 } },
    behavior,
  );
  assert.equal(f.gateway.registryStatus.state, "degraded");
  const qlikStarts = f.initialize.filter(
    (value) => value.name === "qlik",
  ).length;
  await f.rpc("tools/list");
  behavior.failInitialize = undefined;
  const recovered = await f.gateway.recover({
    serverIds: ["sap"],
    maxAttempts: 1,
  });
  assert.equal(recovered.status.state, "ready");
  assert.equal(recovered.registry.length, 2);
  assert.equal(recovered.catalogChanged, true);
  assert.equal((await f.gateway.start()).url, f.endpoint.url);
  assert.equal(
    f.initialize.filter((value) => value.name === "qlik").length,
    qlikStarts,
  );
  assert.equal(f.calls.length, 0);
});

test("permission denial is not a metadata cache entry and grant changes dispatch exposure", async (t) => {
  let permitted = false;
  const f = await fixture(t, undefined, { authorizeExposure: () => permitted });
  assert.equal(
    f.registry.length,
    1,
    "Full attached metadata is hydrated independently of permissions",
  );
  assert.equal(f.gateway.registryStatus.state, "ready");
  const first = (await f.rpc("tools/list")).value.result.tools;
  assert.equal(first.length, 4);
  assert.equal(
    f.events.find((event) => event.type === "registry").authorizedExposureCount,
    0,
  );
  const initializeCount = f.initialize.length;
  permitted = true;
  assert.equal(await f.gateway.dispatchCatalogChanged(), true);
  assert.equal(f.initialize.length, initializeCount);
  const refreshed = await f.gateway.recover({ serverIds: [] });
  assert.equal(
    refreshed.catalogChanged,
    true,
    "Existing Codex dispatch must reload newly permitted schemas",
  );
  assert.equal(
    f.initialize.length,
    initializeCount,
    "Permission changes do not refetch metadata",
  );
  assert.equal((await f.rpc("tools/list")).value.result.tools.length, 5);
  assert.equal(await f.gateway.dispatchCatalogChanged(), false);
  f.gateway.setRouting({
    mode: "direct_tools",
    selected: refreshed.registry,
    query: "what are the Qlik apps ?",
  });
  assert.equal(
    (f.gateway.exposedNames.get("get_apps")!.inputSchema.properties as any)
      .fields,
    undefined,
  );
  assert.notEqual((await f.invoke("get_apps", {})).isError, true);
});

test("empty configured catalog fails health while no attached servers are ready", async (t) => {
  const empty = await fixture(t, { qlik: [] });
  assert.equal(empty.gateway.registryStatus.state, "failed");
  assert.equal(empty.gateway.registryStatus.servers[0].state, "empty");
  const none = await fixture(t, {});
  assert.equal(none.gateway.registryStatus.state, "ready");
  assert.equal(none.gateway.registryStatus.configuredServerCount, 0);
});

test("one timed out action leaves other selected tools usable with separate approvals and no action retry", async (t) => {
  const tools = [
    { ...appTool, annotations: { readOnlyHint: false } },
    {
      name: "get_app_details",
      inputSchema: schema({ id: { type: "string" } }, ["id"]),
      annotations: { readOnlyHint: false },
    },
  ];
  const f = await fixture(
    t,
    { qlik: tools },
    {},
    { hangCall: "get_apps", toolTimeoutSec: 0.02 },
  );
  direct(f);
  f.gateway.approveInvocation("get_apps", {});
  assert.equal((await f.invoke("get_apps", {})).isError, true);
  assert.equal(f.gateway.registryStatus.state, "ready");
  assert.equal(f.gateway.hasUnavailable, false);
  const args = { id: "a", fields: ["apps.name"] };
  assert.equal(
    (await f.invoke("get_app_details", args)).isError,
    true,
    "First approval cannot cover another tool",
  );
  f.gateway.approveInvocation("get_app_details", args);
  assert.notEqual((await f.invoke("get_app_details", args)).isError, true);
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ["get_apps", "get_app_details"],
  );
  assert.equal(
    f.events.filter((event) => event.type === "metadata_retry").length,
    0,
  );
});

test("null structured content falls back to text JSON without dropping app data", async (t) => {
  const f = await fixture(
    t,
    undefined,
    {},
    {
      result: {
        structuredContent: null,
        content: [{ type: "text", text: JSON.stringify(appData) }],
      },
    },
  );
  direct(f, "what are the Qlik apps ?");
  const result = parse(await f.invoke("get_apps", {}));
  assert.equal(result.apps[0].name, "App A");
  assert.deepEqual(result.pagination, appData.pagination);
});
