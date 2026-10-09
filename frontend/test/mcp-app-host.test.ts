import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpAppHost,
  mcpAppHeight,
  MCP_APP_PROTOCOL_VERSION,
  type McpAppHostContext,
} from "../lib/mcp-app-host.ts";

const baseContext = (
  over: Partial<McpAppHostContext> = {},
): McpAppHostContext => ({
  theme: "light",
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  containerDimensions: { width: 700, maxHeight: 2000 },
  platform: "web",
  styles: { variables: {} },
  ...over,
});

function setup(initial = baseContext()) {
  const sent: any[] = [];
  const sizes: any[] = [];
  let context = initial;
  let ready = 0;
  const host = createMcpAppHost({
    post: (m) => sent.push(m),
    hostContext: () => context,
    onSizeChanged: (s) => sizes.push(s),
    onReady: () => ready++,
  });
  return {
    host,
    sent,
    sizes,
    ready: () => ready,
    setContext: (next: McpAppHostContext) => (context = next),
  };
}
const init = { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} };
const initialized = { jsonrpc: "2.0", method: "ui/notifications/initialized" };
const result = {
  content: [{ type: "text", text: "Order 42" }],
  structuredContent: { id: "42" },
};

test("initialize answers with the version, only what Truex does, and the context", () => {
  const { host, sent } = setup();
  host.receive(init);
  assert.equal(sent.length, 1);
  const reply = sent[0];
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, MCP_APP_PROTOCOL_VERSION);
  assert.equal(reply.result.hostInfo.name, "truex");
  // Capabilities it does not have are not advertised.
  assert.deepEqual(Object.keys(reply.result.hostCapabilities).sort(), [
    "logging",
    "sandbox",
  ]);
  assert.equal(reply.result.hostContext.theme, "light");
  assert.deepEqual(reply.result.hostContext.availableDisplayModes, ["inline"]);
});

test("the tool call reaches the app once it is ready, whichever comes last, and only once", () => {
  for (const order of ["call-first", "ready-first"] as const) {
    const { host, sent, ready } = setup();
    host.receive(init);
    sent.length = 0;
    if (order === "call-first")
      host.setToolCall({ arguments: { id: "42" }, result });
    // Nothing is sent before the app says it is ready.
    assert.equal(sent.length, 0, order);
    host.receive(initialized);
    if (order === "ready-first")
      host.setToolCall({ arguments: { id: "42" }, result });
    assert.deepEqual(
      sent.map((m) => m.method),
      ["ui/notifications/tool-input", "ui/notifications/tool-result"],
      order,
    );
    assert.deepEqual(sent[0].params, { arguments: { id: "42" } });
    assert.deepEqual(sent[1].params, result);
    // A second ready, or the call set again, sends nothing more.
    host.receive(initialized);
    host.setToolCall({ arguments: { id: "43" }, result });
    assert.equal(sent.length, 2, order);
    assert.equal(ready(), 1, order);
  }
});

test("a call with no result sends only its input", () => {
  const { host, sent } = setup();
  host.receive(init);
  host.receive(initialized);
  host.setToolCall({ arguments: {}, result: null });
  assert.deepEqual(
    sent.slice(1).map((m) => m.method),
    ["ui/notifications/tool-input"],
  );
});

test("what Truex does not support is refused with an error, never silence", () => {
  const { host, sent } = setup();
  for (const [i, method] of [
    "tools/call",
    "resources/read",
    "ui/open-link",
    "ui/message",
    "ui/request-display-mode",
    "ui/update-model-context",
    "ui/download-file",
  ].entries()) {
    host.receive({
      jsonrpc: "2.0",
      id: 100 + i,
      method,
      params: { name: "x" },
    });
    const reply = sent.at(-1);
    assert.equal(reply.id, 100 + i, method);
    assert.equal(reply.error.code, -32000, method);
    assert.equal("result" in reply, false, method);
  }
  host.receive({ jsonrpc: "2.0", id: "s", method: "no/such/method" });
  assert.equal(sent.at(-1).error.code, -32601);
  host.receive({ jsonrpc: "2.0", id: 9, method: "ping" });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 9, result: {} });
});

test("malformed, oversized and unrelated messages do nothing harmful", () => {
  const { host, sent, sizes } = setup();
  for (const junk of [
    null,
    undefined,
    5,
    "x",
    [],
    {},
    { jsonrpc: "1.0", id: 1, method: "ping" },
    { id: 1, method: "ping" },
  ])
    host.receive(junk);
  // A response to something the host never asked is ignored.
  host.receive({ jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(sent.length, 0);
  // Too big: refused when it was a request, ignored when it was not.
  host.receive({
    jsonrpc: "2.0",
    id: 2,
    method: "ui/message",
    params: { text: "x".repeat(300_000) },
  });
  assert.equal(sent[0].error.code, -32600);
  host.receive({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: 1, pad: "x".repeat(300_000) },
  });
  assert.equal(sizes.length, 0);
  assert.equal(sent.length, 1);
  // Circular data cannot be measured and is refused.
  const loop: any = { jsonrpc: "2.0", id: 3, method: "ping" };
  loop.params = loop;
  host.receive(loop);
  assert.equal(sent.at(-1).error.code, -32600);
});

test("the app's size is followed, within bounds", () => {
  const { host, sizes } = setup();
  host.receive({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { width: 600, height: 412.2 },
  });
  host.receive({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: "tall" },
  });
  host.receive({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: {},
  });
  assert.deepEqual(sizes, [{ width: 600, height: 412.2 }]);
  assert.equal(mcpAppHeight(412.2), 413);
  assert.equal(mcpAppHeight(1), 80);
  assert.equal(mcpAppHeight(99999), 2000);
  for (const bad of ["x", NaN, Infinity, undefined, null])
    assert.equal(mcpAppHeight(bad), undefined, String(bad));
});

test("a theme change reaches a ready app as only what changed", () => {
  const { host, sent, setContext } = setup();
  // Not before the app is ready.
  setContext(baseContext({ theme: "dark" }));
  host.updateHostContext();
  assert.equal(sent.length, 0);
  host.receive(init);
  host.receive(initialized);
  sent.length = 0;
  // The initialize reply carried "dark" already, so there is nothing to say.
  host.updateHostContext();
  assert.equal(sent.length, 0);
  setContext(
    baseContext({
      theme: "light",
      containerDimensions: { width: 700, maxHeight: 2000 },
    }),
  );
  host.updateHostContext();
  assert.deepEqual(sent, [
    {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    },
  ]);
  host.updateHostContext();
  assert.equal(sent.length, 1);
});

test("a disposed host says nothing and hears nothing", () => {
  const { host, sent } = setup();
  host.dispose();
  host.receive(init);
  host.setToolCall({ arguments: {}, result: null });
  host.updateHostContext();
  assert.equal(sent.length, 0);
});
