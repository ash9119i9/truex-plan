import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMcpAppMime,
  jsonBytes,
  mcpAppCall,
  mcpAppIdPattern,
  mcpAppResourceUri,
  mcpAppToolResult,
  validCallId,
} from "../../shared/mcp-apps";

const call = (over: Record<string, unknown> = {}) => ({
  type: "mcpToolCall",
  id: "call_1",
  server: "sap",
  tool: "get_order",
  status: "completed",
  mcpAppResourceUri: "ui://sap/order.html",
  mcpAppUi: null,
  appContext: null,
  ...over,
});

test("the page a call declared is found in any of the places the runtime reports it", () => {
  assert.equal(mcpAppResourceUri(call()), "ui://sap/order.html");
  assert.equal(
    mcpAppResourceUri(
      call({
        mcpAppResourceUri: undefined,
        mcpAppUi: {
          resourceUri: "ui://a/b",
          preferredModelDisplayMode: "inline",
        },
      }),
    ),
    "ui://a/b",
  );
  assert.equal(
    mcpAppResourceUri(
      call({
        mcpAppResourceUri: undefined,
        appContext: { resourceUri: "ui://ctx/page" },
      }),
    ),
    "ui://ctx/page",
  );
  // The newer field wins over the older one.
  assert.equal(
    mcpAppResourceUri(call({ mcpAppUi: { resourceUri: "ui://new/page" } })),
    "ui://new/page",
  );
});

test("only a ui:// address counts as a page", () => {
  for (const bad of [
    "http://evil.example/x",
    "https://evil.example/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "UI://upper",
    "ui://",
    "ui://has space",
    "ui://new\nline",
    "ui://" + "a".repeat(2050),
    "",
    null,
    42,
    {},
  ])
    assert.equal(
      mcpAppResourceUri(call({ mcpAppResourceUri: bad })),
      null,
      String(bad),
    );
  // A bad newer field does not hide a good older one, and not the reverse.
  assert.equal(
    mcpAppResourceUri(
      call({
        mcpAppUi: { resourceUri: "http://x" },
        mcpAppResourceUri: "ui://ok/p",
      }),
    ),
    "ui://ok/p",
  );
  // Only tool calls have pages.
  assert.equal(mcpAppResourceUri({ ...call(), type: "dynamicToolCall" }), null);
  for (const junk of [null, undefined, "x", 1, [], {}])
    assert.equal(mcpAppResourceUri(junk), null);
});

test("an app is a finished call with a page and a usable id", () => {
  assert.deepEqual(mcpAppCall(call(), "t1"), {
    callId: "call_1",
    turnId: "t1",
    server: "sap",
    tool: "get_order",
  });
  assert.equal("turnId" in mcpAppCall(call())!, false);
  for (const status of ["inProgress", "failed", undefined])
    assert.equal(mcpAppCall(call({ status }), "t"), null, String(status));
  assert.equal(mcpAppCall(call({ mcpAppResourceUri: null }), "t"), null);
  for (const id of ["", undefined, 5, "x".repeat(257), "a\nb", "a\u0000b"])
    assert.equal(mcpAppCall(call({ id }), "t"), null, String(id));
  // Provider-chosen ids may contain characters a path cannot.
  assert.ok(mcpAppCall(call({ id: "call/order:1|weird id" }), "t"));
  // Names are bounded.
  assert.equal(
    mcpAppCall(call({ tool: "t".repeat(500) }), "t")!.tool.length,
    120,
  );
});

test("call ids and app ids are told apart", () => {
  assert.ok(validCallId("toolu_01ABC"));
  assert.ok(!validCallId(""));
  assert.ok(mcpAppIdPattern.test("A".repeat(32)));
  assert.ok(mcpAppIdPattern.test("abc_DEF-123456789"));
  for (const id of [
    "",
    "short",
    "../../x",
    "a".repeat(65),
    "has space 123456789012",
    "a/b_____________",
  ])
    assert.ok(!mcpAppIdPattern.test(id), id);
});

test("only an MCP App page type is a page", () => {
  assert.ok(isMcpAppMime("text/html;profile=mcp-app"));
  assert.ok(isMcpAppMime("text/html; profile=mcp-app"));
  assert.ok(isMcpAppMime("TEXT/HTML ; Profile=MCP-App"));
  assert.ok(isMcpAppMime("text/html;charset=utf-8;profile=mcp-app"));
  for (const bad of [
    "text/html",
    "text/plain;profile=mcp-app",
    "text/html;profile=other",
    "application/json",
    "",
    undefined,
    null,
    5,
  ])
    assert.ok(!isMcpAppMime(bad), String(bad));
});

test("a tool result is given to an app in the shape the SDK accepts", () => {
  // The runtime reports `_meta: null`.
  assert.deepEqual(
    mcpAppToolResult({
      content: [{ type: "text", text: "hi" }],
      structuredContent: { a: 1 },
      _meta: null,
    }),
    { content: [{ type: "text", text: "hi" }], structuredContent: { a: 1 } },
  );
  assert.deepEqual(
    mcpAppToolResult({
      content: "not an array",
      isError: true,
      _meta: { k: 1 },
    }),
    {
      content: [],
      isError: true,
      _meta: { k: 1 },
    },
  );
  assert.deepEqual(
    mcpAppToolResult({ structuredContent: [1, 2], isError: false }),
    {
      content: [],
    },
  );
  for (const junk of [null, undefined, "x", 3, []])
    assert.equal(mcpAppToolResult(junk), null);
});

test("size is measured as bytes, and what cannot be measured is too big", () => {
  assert.equal(jsonBytes({ a: "é" }), 10);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(jsonBytes(cycle), Number.POSITIVE_INFINITY);
  assert.equal(jsonBytes(undefined), 0);
});
