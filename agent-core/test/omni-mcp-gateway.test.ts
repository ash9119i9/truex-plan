import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OmniMcpGateway,
  omniTools,
  projectFields,
  type ConnectorConfig,
  type OmniMcpGatewayOptions,
} from "../src/omni-mcp-gateway";

const tool = {
  name: "get_apps",
  description: "List apps",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1 } },
    required: ["limit"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const result = (data: any) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});
type Rpc = { id?: number; method: string; params?: any };
function downstream(handler?: (rpc: Rpc, init: RequestInit) => any) {
  const requests: { rpc: Rpc; headers: Headers }[] = [];
  const fetcher = (async (_url: any, init: RequestInit) => {
    const rpc = JSON.parse(String(init.body));
    requests.push({ rpc, headers: new Headers(init.headers) });
    const custom = await handler?.(rpc, init);
    if (custom instanceof Response) return custom;
    if (rpc.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const value =
      custom ??
      (rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "qlik", version: "1" },
          }
        : rpc.method === "tools/list"
          ? { tools: [tool] }
          : result({
              apps: [
                { name: "Sales", id: "1", description: "large unused field" },
              ],
            }));
    return Response.json(
      { jsonrpc: "2.0", id: rpc.id, result: value },
      {
        headers:
          rpc.method === "initialize" ? { "Mcp-Session-Id": "session-1" } : {},
      },
    );
  }) as typeof fetch;
  return { requests, fetcher };
}
async function fixture(
  t: any,
  native = downstream(),
  configs: Record<string, ConnectorConfig> = {
    qlik: {
      url: "https://example.test/mcp",
      http_headers: { "x-api-qlik-key": "private-header-key" },
    },
  },
  onEvent?: any,
  options: OmniMcpGatewayOptions = {},
) {
  const gateway = new OmniMcpGateway(configs, onEvent, native.fetcher, options);
  t.after(() => gateway.close());
  const config = await gateway.start();
  let nextId = 0;
  async function rpc(method: string, params?: any, signal?: AbortSignal) {
    const response = await fetch(config.url, {
      method: "POST",
      headers: config.http_headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
      signal,
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  const call = (name: string, args: any, signal?: AbortSignal) =>
    rpc("tools/call", { name, arguments: args }, signal);
  const invoke = (args: any = {}, signal?: AbortSignal) =>
    call(
      "invoke_tool",
      { server: "qlik", tool: "get_apps", arguments: { limit: 50 }, ...args },
      signal,
    );
  return { ...native, gateway, config, rpc, call, invoke };
}
const data = (r: any) => JSON.parse(r.content[0].text);

test("four Omni definitions and per-tool approval policy preserve a prompt for generic invocation", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    (await f.rpc("tools/list")).tools.map((x: any) => x.name),
    ["discover_server", "discover_tools", "get_tool_schema", "invoke_tool"],
  );
  assert.equal(f.config.default_tools_approval_mode, "prompt");
  for (const x of omniTools)
    assert.equal(
      f.config.tools[x.name].approval_mode,
      x.name === "invoke_tool" ? "prompt" : "approve",
    );
  assert.equal(omniTools[3].annotations.readOnlyHint, false);
  assert.equal(
    f.requests.length,
    0,
    "listing gateway tools must not load connector schemas",
  );
  assert.equal(
    (await fetch(f.config.url, { method: "POST", body: "{}" })).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.config.url, {
        method: "POST",
        headers: { ...f.config.http_headers, Origin: "https://untrusted.test" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(f.config.url, { headers: f.config.http_headers })).status,
    405,
  );
});

test("JSON/SSE pagination caches concurrent discovery and propagates header auth and session", async (t) => {
  const native = downstream((rpc) => {
    if (rpc.method !== "tools/list") return;
    if (!rpc.params.cursor) return { tools: [tool], nextCursor: "second" };
    const text = `: keepalive\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ ...tool, name: "get_details", description: "Résumé details" }] } })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 3)
            controller.enqueue(bytes.slice(i, i + 3));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const f = await fixture(t, native);
  const answers = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.call("discover_tools", { server: "qlik" }),
    ),
  );
  assert.deepEqual(
    data(answers[0]).tools.map((x: any) => x.name),
    ["get_apps", "get_details"],
  );
  assert.equal(
    native.requests.filter((x) => x.rpc.method === "initialize").length,
    1,
  );
  assert.equal(
    native.requests.filter((x) => x.rpc.method === "tools/list").length,
    2,
  );
  await f.call("get_tool_schema", { server: "qlik", tool: "get_apps" });
  assert.equal(native.requests.length, 4);
  for (const req of native.requests) {
    assert.equal(req.headers.get("x-api-qlik-key"), "private-header-key");
    if (req.rpc.method !== "initialize")
      assert.equal(req.headers.get("mcp-session-id"), "session-1");
  }
});

test("agent registry and connector allow/deny lists isolate reachable tools", async (t) => {
  const f = await fixture(
    t,
    downstream((rpc) =>
      rpc.method === "tools/list"
        ? {
            tools: [
              tool,
              { ...tool, name: "write_apps" },
              { ...tool, name: "secret_tool" },
            ],
          }
        : undefined,
    ),
    {
      qlik: {
        url: "https://example.test/mcp",
        enabled_tools: ["get_apps", "write_apps"],
        disabled_tools: ["write_apps"],
      },
      other: { url: "https://other.test/mcp", enabled: false },
    },
  );
  assert.deepEqual(
    data(await f.call("discover_server", { query: "" })).servers,
    [{ name: "qlik" }],
  );
  assert.equal(
    (await f.call("discover_tools", { server: "other" })).isError,
    true,
  );
  assert.deepEqual(
    data(await f.call("discover_tools", { server: "qlik" })).tools.map(
      (x: any) => x.name,
    ),
    ["get_apps"],
  );
  assert.equal((await f.invoke({ tool: "write_apps" })).isError, true);
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "tools/call").length,
    0,
  );
});

test("downstream argument and projection validation occurs before execution", async (t) => {
  const f = await fixture(t);
  for (const args of [
    { arguments: { limit: "50" } },
    { arguments: { limit: 0 } },
    { arguments: { limit: 5, extra: true } },
    { fields: ["apps.__proto__"] },
    { fields: ["constructor"] },
    { fields: [] },
  ])
    assert.equal((await f.invoke(args)).isError, true);
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "tools/call").length,
    0,
  );
  assert.equal(
    (await f.call("discover_tools", { server: "qlik", extra: true })).isError,
    true,
  );
});

test("projection keeps nested arrays, false and null, while removing full-payload metadata and other carriers", async (t) => {
  const full = {
    apps: [
      {
        id: "1",
        name: "Sales",
        enabled: false,
        owner: null,
        nested: [{ flag: false, ignored: "secret" }],
        description: "large-unused",
      },
    ],
    pagination: { total: 1 },
    unused: "not selected",
  };
  const f = await fixture(
    t,
    downstream((rpc) =>
      rpc.method === "tools/call"
        ? {
            ...result(full),
            structuredContent: full,
            _meta: { raw: full },
            extraCarrier: full,
          }
        : undefined,
    ),
  );
  const expected = {
    apps: [
      { name: "Sales", enabled: false, owner: null, nested: [{ flag: false }] },
    ],
    pagination: { total: 1 },
  };
  const reply = await f.invoke({
    fields: [
      "apps.name",
      "apps.enabled",
      "apps.owner",
      "apps.nested.flag",
      "pagination",
    ],
  });
  assert.deepEqual(data(reply), expected);
  assert.deepEqual(reply.structuredContent, expected);
  assert.deepEqual(Object.keys(reply).sort(), ["content", "structuredContent"]);
  assert.ok(!JSON.stringify(reply).includes("large-unused"));
  assert.deepEqual(projectFields([{ id: "1", discarded: 1 }], ["id"]), [
    { id: "1" },
  ]);
});

test("missing paths after execution do not encourage replay; empty results and selected null remain valid", async (t) => {
  let apps: any = [{ name: "Sales" }];
  const f = await fixture(
    t,
    downstream((rpc) =>
      rpc.method === "tools/call" ? result({ apps, nil: null }) : undefined,
    ),
  );
  const missing = await f.invoke({ fields: ["apps.does_not_exist"] });
  assert.equal(missing.isError, true);
  assert.match(data(missing).error, /completed.*Do not repeat/);
  assert.deepEqual(data(await f.invoke({ fields: ["nil"] })), { nil: null });
  apps = [];
  assert.deepEqual(data(await f.invoke({ fields: ["apps.name"] })), {
    apps: [],
  });
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "tools/call").length,
    3,
  );
});

test("unprojectable text reports execution outcome without telling the model to repeat", async (t) => {
  const f = await fixture(
    t,
    downstream((rpc) =>
      rpc.method === "tools/call"
        ? { content: [{ type: "text", text: "Done" }] }
        : undefined,
    ),
  );
  const reply = await f.invoke({ fields: ["apps.name"] });
  assert.equal(reply.isError, true);
  assert.match(data(reply).error, /completed.*Do not repeat/);
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "tools/call").length,
    1,
  );
});

test("original tool errors and JSON-RPC code/data survive invocation", async (t) => {
  const failure = {
    content: [{ type: "text", text: "No permission" }],
    isError: true,
    structuredContent: { status: 403 },
  };
  let rpcError = false;
  const f = await fixture(
    t,
    downstream((rpc) =>
      rpc.method === "tools/call"
        ? rpcError
          ? Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              error: {
                code: -32002,
                message: "Original error",
                data: { reason: "forbidden" },
              },
            })
          : failure
        : undefined,
    ),
  );
  assert.deepEqual(await f.invoke({ fields: ["apps.name"] }), failure);
  rpcError = true;
  assert.deepEqual(data(await f.invoke()).error, {
    code: -32002,
    message: "Original error",
    data: { reason: "forbidden" },
  });
});

test("observers cannot change remote success and diagnostics redact header credentials", async (t) => {
  const events: any[] = [];
  const f = await fixture(t, downstream(), undefined, (event: any) => {
    events.push(event);
    throw new Error("observer failed");
  });
  assert.ok(!(await f.invoke()).isError);
  assert.equal(events.filter((e) => e.type === "invoke").length, 1);
  const bad = await fixture(
    t,
    downstream((rpc) => {
      if (rpc.method === "tools/call")
        throw new Error("private-header-key rejected");
    }),
    undefined,
    (event: any) => events.push(event),
  );
  assert.equal((await bad.invoke()).isError, true);
  assert.ok(!JSON.stringify(events).includes("private-header-key"));
});

test("discovery failures reset initialization and pagination loops are bounded", async (t) => {
  let broken = true;
  const f = await fixture(
    t,
    downstream((rpc) => {
      if (rpc.method === "tools/list" && broken)
        return { tools: [], nextCursor: "repeat" };
    }),
  );
  assert.equal(
    (await f.call("discover_tools", { server: "qlik" })).isError,
    true,
  );
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "tools/list").length,
    2,
  );
  broken = false;
  assert.ok(!(await f.call("discover_tools", { server: "qlik" })).isError);
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "initialize").length,
    2,
  );
});

test("failed initialization can recover; failed tools/call is never automatically replayed", async (t) => {
  let initialized = 0;
  const f = await fixture(
    t,
    downstream((rpc) => {
      if (rpc.method === "initialize" && initialized++ === 0)
        return new Response(null, { status: 503 });
      if (rpc.method === "tools/call")
        return new Response(null, { status: 404 });
    }),
  );
  assert.equal(
    (await f.call("discover_tools", { server: "qlik" })).isError,
    true,
  );
  assert.ok(!(await f.call("discover_tools", { server: "qlik" })).isError);
  assert.equal((await f.invoke()).isError, true);
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "tools/call").length,
    1,
  );
  assert.ok(
    !(await f.call("get_tool_schema", { server: "qlik", tool: "get_apps" }))
      .isError,
  );
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "initialize").length,
    3,
  );
});

test("request timeout, cancellation and gateway shutdown abort downstream work", async (t) => {
  let announce: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let aborted = 0;
  const native = downstream(async (rpc, init) => {
    if (rpc.method !== "tools/call") return;
    announce();
    return new Promise((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener(
        "abort",
        () => {
          aborted++;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  const f = await fixture(t, native, {
    qlik: { url: "https://example.test/mcp", tool_timeout_sec: 0.02 },
  });
  assert.equal((await f.invoke()).isError, true);
  assert.equal(aborted, 1);
  const f2 = await fixture(t, native);
  const controller = new AbortController();
  const call = f2.invoke({}, controller.signal);
  await started;
  // Ensure the second downstream call has started, then cancel the client connection.
  while (
    native.requests.filter((x) => x.rpc.method === "tools/call").length < 2
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(call, /abort/i);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(aborted, 2);
  const call3 = f2.invoke();
  while (
    native.requests.filter((x) => x.rpc.method === "tools/call").length < 3
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  f2.gateway.close();
  await assert.rejects(call3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, 3);
});

test("concurrent starts return one endpoint and closed gateways cannot restart", async (t) => {
  const g = new OmniMcpGateway({});
  t.after(() => g.close());
  const [a, b] = await Promise.all([g.start(), g.start()]);
  assert.equal(a.url, b.url);
  assert.ok(a.url.startsWith("http://127.0.0.1:"));
  g.close();
  await assert.rejects(g.start(), /closed/);
});

test("credential URLs and command transports are rejected without contacting servers", () => {
  for (const config of [
    { url: "file:///tmp/mcp" },
    { url: "https://user:password@example.test/" },
    { url: "https://example.test/#fragment" },
    { url: "https://example.test/", command: "malicious" },
  ])
    assert.throws(() => new OmniMcpGateway({ qlik: config }));
});

test("MCP cancellation notification aborts the matching request only", async (t) => {
  let announce: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const native = downstream((rpc, init) => {
    if (rpc.method !== "tools/call") return;
    announce();
    return new Promise((_resolve, reject) =>
      init.signal!.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      ),
    );
  });
  const f = await fixture(t, native);
  const pending = f.invoke(); // First inbound request has id 1.
  await started;
  const response = await fetch(f.config.url, {
    method: "POST",
    headers: f.config.http_headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    }),
  });
  assert.equal(response.status, 202);
  assert.match(data(await pending).error, /cancelled/);
  assert.equal(
    native.requests.filter((x) => x.rpc.method === "tools/call").length,
    1,
  );
});

test("bounded payloads reject oversized inbound requests and downstream responses", async (t) => {
  const f = await fixture(
    t,
    downstream((rpc) =>
      rpc.method === "tools/list"
        ? new Response("x".repeat(8 * 1024 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          })
        : undefined,
    ),
  );
  const reply = await f.call("discover_tools", { server: "qlik" });
  assert.equal(reply.isError, true);
  assert.match(data(reply).error, /exceeds 8 MiB/);
  const response = await fetch(f.config.url, {
    method: "POST",
    headers: f.config.http_headers,
    body: "x".repeat(8 * 1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
});

test("refreshed downstream catalog also refreshes compiled argument validation", async (t) => {
  let schema = tool.inputSchema;
  const f = await fixture(
    t,
    downstream((rpc) => {
      if (rpc.method === "tools/list")
        return { tools: [{ ...tool, inputSchema: schema }] };
      if (rpc.method === "tools/call")
        return new Response(null, { status: 404 });
    }),
  );
  assert.equal((await f.invoke()).isError, true);
  schema = {
    type: "object",
    properties: { limit: { type: "integer", minimum: 100 } },
    required: ["limit"],
    additionalProperties: false,
  };
  const reply = await f.invoke();
  assert.match(data(reply).error, /schema/);
  assert.equal(
    f.requests.filter((x) => x.rpc.method === "tools/call").length,
    1,
  );
});

test("required projection mode exposes its contract without changing legacy definitions", async (t) => {
  const original = structuredClone(omniTools);
  const f = await fixture(t, downstream(), undefined, undefined, {
    requireProjection: true,
  });
  const definitions = (await f.rpc("tools/list")).tools;
  const invoke = definitions.find((tool: any) => tool.name === "invoke_tool");
  assert.ok(invoke.inputSchema.required.includes("fields"));
  assert.match(invoke.description, /Required fields/);
  assert.equal(f.config.tools.invoke_tool.approval_mode, "prompt");
  assert.equal(invoke.annotations.readOnlyHint, false);
  assert.deepEqual(omniTools, original);
  const legacy = await fixture(t);
  assert.deepEqual((await legacy.rpc("tools/list")).tools, original);
  const schema = data(
    await f.call("get_tool_schema", { server: "qlik", tool: "get_apps" }),
  );
  assert.match(schema.responseProjection, /required/);
});

test("required projection rejects missing fields and mixed wildcards before any action", async (t) => {
  const f = await fixture(t, downstream(), undefined, undefined, {
    requireProjection: true,
  });
  for (const args of [
    {},
    { fields: [] },
    { fields: ["*", "apps.name"] },
    { fields: ["apps.*"] },
    { fields: ["*"], arguments: { limit: 0 } },
  ])
    assert.equal((await f.invoke(args)).isError, true);
  assert.equal(
    f.requests.filter((request) => request.rpc.method === "tools/call").length,
    0,
  );
});

test("required projection keeps selected false/null and nested arrays while explicit wildcard preserves the original", async (t) => {
  const full = {
    apps: [
      {
        name: "Sales",
        enabled: false,
        owner: null,
        nested: [{ id: "item1", ignored: "unused" }],
        discarded: "unused",
      },
    ],
    pagination: { total: 1 },
  };
  const original = {
    ...result(full),
    structuredContent: full,
    _meta: { full },
    extraCarrier: full,
  };
  const f = await fixture(
    t,
    downstream((rpc) => (rpc.method === "tools/call" ? original : undefined)),
    undefined,
    undefined,
    { requireProjection: true },
  );
  const selected = await f.invoke({
    fields: [
      "apps.name",
      "apps.enabled",
      "apps.owner",
      "apps.nested.id",
      "pagination",
    ],
  });
  const expected = {
    apps: [
      { name: "Sales", enabled: false, owner: null, nested: [{ id: "item1" }] },
    ],
    pagination: { total: 1 },
  };
  assert.deepEqual(data(selected), expected);
  assert.deepEqual(selected.structuredContent, expected);
  assert.ok(!Object.hasOwn(selected, "_meta"));
  assert.ok(!Object.hasOwn(selected, "extraCarrier"));
  assert.deepEqual(await f.invoke({ fields: ["*"] }), original);
  assert.equal(
    f.requests.filter((request) => request.rpc.method === "tools/call").length,
    2,
  );
});

test("explicit wildcard permits non-JSON original responses; errors retain their original content", async (t) => {
  let response: any = {
    content: [{ type: "text", text: "Completed" }],
    _meta: { trace: "original" },
  };
  const f = await fixture(
    t,
    downstream((rpc) => (rpc.method === "tools/call" ? response : undefined)),
    undefined,
    undefined,
    { requireProjection: true },
  );
  assert.deepEqual(await f.invoke({ fields: ["*"] }), response);
  response = { content: [{ type: "text", text: "Denied" }], isError: true };
  assert.deepEqual(await f.invoke({ fields: ["apps.name"] }), response);
});
