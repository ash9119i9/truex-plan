import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PublicEventStream,
  publicEvent,
  publicMcpApp,
  publicSnapshot,
} from "../src/public";

const id = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const app = { id, turnId: "t1", server: "sap", tool: "get_order" };

test("an app is described by a safe id and labels only", () => {
  assert.deepEqual(publicMcpApp(app), app);
  // Anything else upstream sent is dropped: the provider's call id, the page,
  // the tool's input and result.
  assert.deepEqual(
    publicMcpApp({
      ...app,
      callId: "call/order:1|weird id",
      html: "<script>1</script>",
      arguments: { id: "42" },
      result: { content: [{ text: "secret" }] },
      uri: "ui://sap/order.html",
    }),
    app,
  );
  assert.deepEqual(publicMcpApp({ id }), { id, server: "", tool: "" });
  assert.equal(
    publicMcpApp({ ...app, tool: "t".repeat(500) })!.tool.length,
    120,
  );
});

test("an app without a safe id is not shown", () => {
  for (const bad of [
    undefined,
    null,
    "x",
    {},
    { id: "" },
    { id: "short" },
    { id: "../../etc/passwd" },
    { id: "call/order:1|weird id" },
    { id: id + "!" },
    { id: 5 },
  ])
    assert.equal(publicMcpApp(bad), null, JSON.stringify(bad));
});

test("a live app event carries the app and nothing else", () => {
  const event = publicEvent({
    type: "mcp.app",
    seq: 3,
    cursor: "c:3",
    at: "2026-10-09T10:00:00.000Z",
    turnId: "t1",
    itemId: "call/order:1|weird id",
    data: {
      app: { ...app, callId: "call/order:1|weird id", html: "<b>x</b>" },
      arguments: { id: "42" },
    },
  });
  assert.deepEqual(event.data, { app });
  // The item id is the safe app id, not the provider's.
  assert.equal(event.itemId, id);
  assert.equal(JSON.stringify(event).includes("weird id"), false);
  assert.equal(JSON.stringify(event).includes("<b>"), false);
  assert.equal(
    publicEvent({ type: "mcp.app", data: { app: { id: "no" } } }),
    null,
  );
  assert.equal(publicEvent({ type: "mcp.app", data: {} }), null);
});

test("a snapshot lists the conversation's apps, and only valid ones", () => {
  const snapshot = publicSnapshot({
    cursor: "c",
    mcpApps: [
      { ...app, callId: "leak" },
      { id: "bad" },
      null,
      { ...app, id: "Z".repeat(32), tool: "other" },
    ],
  });
  assert.deepEqual(
    snapshot.mcpApps.map((a: any) => [a.id, a.tool]),
    [
      [id, "get_order"],
      ["Z".repeat(32), "other"],
    ],
  );
  assert.equal(JSON.stringify(snapshot).includes("leak"), false);
  assert.deepEqual(publicSnapshot({ cursor: "c" }).mcpApps, []);
  assert.deepEqual(publicSnapshot({ cursor: "c", mcpApps: "x" }).mcpApps, []);
});

test("the event stream passes an app through without its call id", () => {
  const stream = new PublicEventStream();
  const frame = `id: c:3\ndata: ${JSON.stringify({
    type: "mcp.app",
    seq: 3,
    cursor: "c:3",
    at: "2026-10-09T10:00:00.000Z",
    turnId: "t1",
    data: { app: { ...app, callId: "call/order:1|weird id" } },
  })}\n\n`;
  const out = stream.push(new TextEncoder().encode(frame));
  assert.match(out, /"type":"mcp.app"/);
  assert.equal(out.includes("weird id"), false);
  assert.ok(out.includes(`"id":"${id}"`));
});
