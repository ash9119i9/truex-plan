import test from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveModelBoundaryV2,
  flattenModelToolsV2,
  routingModeV2,
} from "../src/adaptive-model-boundary-v2";
import type { RegisteredTool } from "../src/tool-router-v2";

const fn = (name: string) => ({
  type: "function",
  name,
  parameters: { type: "object", properties: {} },
});
const app: RegisteredTool = {
  id: "qlik/get_apps",
  serverId: "qlik",
  serverName: "qlik",
  toolName: "get_apps",
  description: "List apps",
  inputSchema: { type: "object" },
  sourceType: "mcp",
  tenantId: "t1",
  enabled: true,
};
const bindings = new Map([["get_apps", app]]);
const source = () => ({
  input: [
    { type: "function_call_output", call_id: "old", output: "previous apps" },
  ],
  tools: [
    fn("update_plan"),
    fn("request_user_input"),
    fn("create_document"),
    fn("write_file"),
    fn("create_visualization"),
    fn("create_goal"),
    fn("list_mcp_resources"),
    {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [fn("spawn_agent"), fn("wait_agent")],
    },
    {
      type: "namespace",
      name: "mcp__adaptive",
      tools: [
        fn("get_apps"),
        ...[
          "discover_server",
          "discover_tools",
          "get_tool_schema",
          "invoke_tool",
        ].map(fn),
      ],
    },
    { type: "namespace", name: "mcp__unattached", tools: [fn("get_secret")] },
  ],
});
const boundary = () =>
  new AdaptiveModelBoundaryV2({ tenantId: "t1", userId: "u1" });
const plan = (
  query: string,
  mode: "no_tools" | "direct_tools" | "discovery" = "direct_tools",
  selected = [] as RegisteredTool[],
) => ({ query, mode, selected });

test("V2 flags preserve direct default and reject invalid mode", () => {
  assert.equal(routingModeV2(""), "direct");
  for (const mode of ["direct", "omni", "adaptive"] as const)
    assert.equal(routingModeV2(mode), mode);
  assert.throws(() => routingModeV2("mistyped"));
});
test("no_tools cannot accidentally expose an MCP binding even with a stale selected set", async () => {
  const result = await boundary().filter(
    source(),
    plan("What is the capital of India?", "no_tools", [app]),
    bindings,
  );
  assert.deepEqual(
    [...result.allowedNames],
    ["update_plan", "request_user_input"],
  );
});
test("Qlik fast path dynamically injects selected schema and control tools only", async () => {
  const raw = source(),
    before = JSON.stringify(raw);
  const result = await boundary().filter(
    raw,
    plan("List apps in Qlik", "direct_tools", [app]),
    bindings,
  );
  assert.deepEqual(
    [...result.allowedNames],
    ["update_plan", "request_user_input", "mcp__adaptive::get_apps"],
  );
  assert.equal(result.trace.exposedSchemaCount, 3);
  assert.equal(result.trace.beforeSchemaCount, 15);
  assert.ok(result.trace.schemaBytesAfter < result.trace.schemaBytesBefore);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(
    result.body.input,
    raw.input,
    "old result history retained with stable call IDs",
  );
});
test("greeting and general knowledge requests expose zero MCP schemas", async () => {
  for (const query of ["Hi bro?", "What is the capital of India?"]) {
    const r = await boundary().filter(source(), plan(query), bindings);
    assert.deepEqual(
      [...r.allowedNames],
      ["update_plan", "request_user_input"],
    );
    assert.equal(
      r.body.tools.some((t: any) => t.type === "namespace"),
      false,
    );
  }
});
test("discovery fallback exposes four Omni capabilities without business schemas", async () => {
  const r = await boundary().filter(
    source(),
    plan("Why have margins declined?", "discovery"),
    bindings,
  );
  assert.equal(r.trace.exposedSchemaCount, 6);
  assert.equal(r.allowedNames.has("mcp__adaptive::get_apps"), false);
  assert.equal(r.allowedNames.has("mcp__adaptive::invoke_tool"), true);
});
test("native task capabilities select only matching families", async () => {
  const r = await boundary().filter(
    source(),
    plan("Create a PDF document"),
    bindings,
  );
  assert.deepEqual(r.trace.selectedNativeTools, ["create_document"]);
  const delegated = await boundary().filter(
    source(),
    plan("Use parallel sub-agents"),
    bindings,
  );
  assert.equal(delegated.allowedNames.has("multi_agent_v1::spawn_agent"), true);
  assert.equal(delegated.allowedNames.has("create_goal"), false);
});
test("native authorization is evaluated anew each request before schema exposure", async () => {
  let allowed = true,
    checks = 0;
  const b = new AdaptiveModelBoundaryV2({
    tenantId: "t1",
    userId: "u1",
    authorizeNative: async () => {
      checks++;
      return allowed;
    },
  });
  assert.equal(
    (
      await b.filter(source(), plan("Create a document"), bindings)
    ).allowedNames.has("create_document"),
    true,
  );
  allowed = false;
  const r = await b.filter(source(), plan("Create a document"), bindings);
  assert.equal(r.allowedNames.has("create_document"), false);
  assert.deepEqual(r.trace.nativeAuthorizationRemoved, ["create_document"]);
  assert.equal(checks, 2);
});
test("unfamiliar runtime control tools are retained", async () => {
  const raw = source();
  raw.tools.push(fn("future_runtime_control"));
  const r = await boundary().filter(raw, plan("Hello"), bindings);
  assert.equal(r.allowedNames.has("future_runtime_control"), true);
});
test("MCP schemas are refreshed from current registry before provider exposure", async () => {
  const current = {
    ...app,
    inputSchema: { type: "object", properties: { cursor: { type: "string" } } },
  };
  const result = await boundary().filter(
    source(),
    plan("Qlik apps", "direct_tools", [current]),
    new Map([["get_apps", current]]),
  );
  const member = result.body.tools.find((t: any) => t.name === "mcp__adaptive")
    .tools[0];
  assert.deepEqual(member.parameters, current.inputSchema);
  assert.match(member.description, /^qlik:/);
});
test("forced tool outside route fails explicitly", async () => {
  await assert.rejects(
    boundary().filter(
      { ...source(), tool_choice: { type: "function", name: "write_file" } },
      plan("Hello"),
      bindings,
    ),
    /outside/,
  );
});
test("MCP scope and fresh authorization cannot be bypassed by a forged routing plan", async () => {
  const foreign = { ...app, tenantId: "other" };
  const b = new AdaptiveModelBoundaryV2({
    tenantId: "t1",
    userId: "u1",
    authorizeMcp: () => false,
  });
  assert.equal(
    (
      await b.filter(
        source(),
        plan("Qlik apps", "direct_tools", [app]),
        bindings,
      )
    ).allowedNames.has("mcp__adaptive::get_apps"),
    false,
  );
  assert.equal(
    (
      await boundary().filter(
        source(),
        plan("Qlik apps", "direct_tools", [foreign]),
        new Map([["get_apps", foreign]]),
      )
    ).allowedNames.has("mcp__adaptive::get_apps"),
    false,
  );
});
test("native registry includes normalized tenant-scoped schemas without MCP or secrets", () => {
  const catalog = boundary().nativeRegistry(source());
  assert.equal(catalog.length, 9);
  assert.ok(
    catalog.every(
      (t) =>
        t.sourceType === "native" &&
        t.tenantId === "t1" &&
        t.serverId === "native",
    ),
  );
  assert.equal(
    catalog.find((t) => t.toolName === "update_plan")?.mandatory,
    true,
  );
});
const event = (name: string, namespace?: string) =>
  `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", name, ...(namespace ? { namespace } : {}) } })}\n\n`;
test("stream guard passes authorized native-looking tool call with namespace", async () => {
  const response = new Response(event("get_apps", "mcp__adaptive"), {
    headers: { "content-type": "text/event-stream", "content-length": "999" },
  });
  const guarded = boundary().guard(
    response,
    new Set(["mcp__adaptive::get_apps"]),
  );
  assert.equal(guarded.headers.has("content-length"), false);
  assert.equal(await guarded.text(), event("get_apps", "mcp__adaptive"));
});
test("stream guard prevents hallucinated native actions from reaching runtime", async () => {
  const response = new Response(event("delete_file"), {
    headers: { "content-type": "text/event-stream" },
  });
  await assert.rejects(
    boundary()
      .guard(response, new Set(["update_plan"]))
      .text(),
    /outside/,
  );
});
test("stream guard handles fragmented frames and rejects final-only actions", async () => {
  const enc = new TextEncoder(),
    frame = event("get_apps", "mcp__adaptive");
  const stream = new ReadableStream({
    start(c) {
      for (const part of [
        frame.slice(0, 17),
        frame.slice(17, 70),
        frame.slice(70),
      ])
        c.enqueue(enc.encode(part));
      c.close();
    },
  });
  assert.equal(
    await boundary()
      .guard(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
        new Set(["mcp__adaptive::get_apps"]),
      )
      .text(),
    frame,
  );
  const completion = new Response(
    JSON.stringify({
      output: [{ type: "custom_tool_call", name: "delete_file" }],
    }),
    { headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    boundary().guard(completion, new Set()).text(),
    /outside/,
  );
});
test("control family and compact native follow-up retain expected schemas", async () => {
  const b = new AdaptiveModelBoundaryV2({
    tenantId: "t1",
    userId: "u1",
    recentNativeNames: ["write_file"],
  });
  const r = await b.filter(source(), plan("Continue it"), bindings);
  assert.equal(r.allowedNames.has("write_file"), true);
  assert.equal(r.allowedNames.has("create_document"), false);
  assert.equal(flattenModelToolsV2(r.body.tools).length, 3);
});
