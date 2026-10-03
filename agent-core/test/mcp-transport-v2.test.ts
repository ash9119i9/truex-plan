import { test } from "node:test";
import assert from "node:assert/strict";
import { McpTransportV2, McpTransportErrorV2 } from "../src/mcp-transport-v2";
const result = (id: number, value: any, session?: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result: value }), {
    headers: {
      "content-type": "application/json",
      ...(session ? { "mcp-session-id": session } : {}),
    },
  });
const catalog = [
  { name: "read_data", inputSchema: { type: "object", properties: {} } },
];

test("late invalidated metadata cannot replace a newer catalog/session or clear its cache", async () => {
  const stop = new AbortController();
  let releaseOld!: (response: Response) => void;
  let initialize = 0,
    oldId = 0;
  const calls: any[] = [];
  const fetcher: typeof fetch = (async (_url: any, init: any) => {
    const rpc = JSON.parse(init.body);
    calls.push({
      method: rpc.method,
      session: new Headers(init.headers).get("mcp-session-id"),
    });
    if (rpc.method === "initialize") {
      initialize++;
      if (initialize === 1) {
        oldId = rpc.id;
        return new Promise((resolve) => {
          releaseOld = resolve;
        });
      }
      return result(rpc.id, { protocolVersion: "2025-03-26" }, "new-session");
    }
    if (rpc.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    return result(rpc.id, { tools: catalog });
  }) as any;
  const transport = new McpTransportV2(
    { url: "https://fixture.invalid/mcp" },
    stop.signal,
    fetcher,
  );
  const first = transport.tools().then(
    () => undefined,
    (error) => error,
  );
  while (!releaseOld) await new Promise((resolve) => setTimeout(resolve, 0));
  transport.invalidate();
  assert.deepEqual(await transport.tools(), catalog);
  releaseOld(result(oldId, { protocolVersion: "2025-03-26" }, "old-session"));
  assert.ok((await first) instanceof McpTransportErrorV2);
  assert.deepEqual(await transport.tools(), catalog);
  assert.equal(initialize, 2);
  assert.equal(
    calls.find((call) => call.method === "tools/list").session,
    "new-session",
  );
  stop.abort();
});

test("notification timeout identifies its stage while initialization/catalog failures retain status", async () => {
  const stop = new AbortController();
  const events: any[] = [];
  const fetcher: typeof fetch = (async (_url: any, init: any) => {
    const rpc = JSON.parse(init.body);
    if (rpc.method === "initialize")
      return result(rpc.id, { protocolVersion: "2025-03-26" });
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      }),
    );
  }) as any;
  const transport = new McpTransportV2(
    { url: "https://fixture.invalid/mcp" },
    stop.signal,
    fetcher,
    (event) => events.push(event),
  );
  await assert.rejects(
    transport.tools(AbortSignal.timeout(15)),
    (error: any) =>
      error instanceof McpTransportErrorV2 &&
      error.stage === "notifications/initialized" &&
      error.kind === "timeout",
  );
  assert.ok(
    events.some(
      (event) =>
        event.stage === "initialize" &&
        event.phase === "completed" &&
        event.timeToHeadersMs >= 0,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    events.some(
      (event) =>
        event.stage === "notifications/initialized" && event.phase === "failed",
    ),
  );
  stop.abort();
  const auth = new McpTransportV2(
    { url: "https://fixture.invalid/mcp" },
    new AbortController().signal,
    (async () => new Response("unauthorized", { status: 401 })) as any,
  );
  await assert.rejects(
    auth.tools(),
    (error: any) =>
      error instanceof McpTransportErrorV2 &&
      error.stage === "initialize" &&
      error.kind === "http" &&
      error.status === 401 &&
      error.retryable === false,
  );
});
