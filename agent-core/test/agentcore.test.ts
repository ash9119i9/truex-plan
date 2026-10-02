import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createAgentCoreApp } from "../src/agentcore";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("AgentCore invocations preserve local operations and event streams", async (t) => {
  let activeThreads = 0;
  let gatewayReady = true;
  const received: Array<{
    method: string;
    path: string;
    body: unknown;
    requestId?: string;
  }> = [];
  const core = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, activeThreads }));
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    received.push({
      method: req.method || "",
      path: req.url || "",
      body: raw ? JSON.parse(raw) : null,
      requestId: req.headers["x-request-id"] as string | undefined,
    });
    if (req.url?.startsWith("/threads/thread_1/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'id: generation:2\ndata: {"type":"message.delta","cursor":"generation:2"}\n\n',
      );
      return;
    }
    const status = req.url === "/threads/thread_1/snapshot" ? 404 : 201;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        status === 404 ? { code: "THREAD_LOST" } : { threadId: "thread_1" },
      ),
    );
  });
  const gateway = createServer((_req, res) => {
    res.writeHead(gatewayReady ? 200 : 503, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ status: gatewayReady ? "ok" : "unavailable" }));
  });
  const coreUrl = await listen(core);
  const gatewayUrl = await listen(gateway);
  const app = createAgentCoreApp({ coreUrl, gatewayUrl });
  const runtime = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => runtime.once("listening", resolve));
  const runtimeUrl = `http://127.0.0.1:${(runtime.address() as { port: number }).port}`;
  t.after(async () => {
    await close(runtime);
    await close(gateway);
    await close(core);
  });

  const invoke = async (payload: unknown) =>
    fetch(`${runtimeUrl}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const created = await invoke({
    method: "POST",
    path: "/threads",
    body: { model: "fixture" },
    requestId: "req-123",
  });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), {
    status: 201,
    body: { threadId: "thread_1" },
  });
  assert.deepEqual(received[0], {
    method: "POST",
    path: "/threads",
    body: { model: "fixture" },
    requestId: "req-123",
  });

  const error = await invoke({
    method: "GET",
    path: "/threads/thread_1/snapshot",
  });
  assert.deepEqual(await error.json(), {
    status: 404,
    body: { code: "THREAD_LOST" },
  });

  const stream = await invoke({
    method: "GET",
    path: "/threads/thread_1/events",
    cursor: "generation:1",
  });
  assert.equal(
    stream.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.match(await stream.text(), /message\.delta/);
  assert.equal(
    received.at(-1)?.path,
    "/threads/thread_1/events?cursor=generation%3A1",
  );

  const badPath = await invoke({
    method: "POST",
    path: "http://example.com/threads",
    body: {},
  });
  assert.equal(badPath.status, 400);
  const blocked = await invoke({
    method: "GET",
    path: "/threads/thread_1/../../healthz",
  });
  assert.equal(blocked.status, 400);
  assert.equal(received.length, 3);

  assert.deepEqual(await (await fetch(`${runtimeUrl}/ping`)).json(), {
    status: "Healthy",
  });
  activeThreads = 1;
  assert.deepEqual(await (await fetch(`${runtimeUrl}/ping`)).json(), {
    status: "HealthyBusy",
  });
  gatewayReady = false;
  assert.equal((await fetch(`${runtimeUrl}/ping`)).status, 503);
});

test("cold runtime stays healthy without touching storage; invalid invocations do not start services", async (t) => {
  let starts = 0;
  let state: "cold" | "starting" | "ready" | "stopping" = "cold";
  const app = createAgentCoreApp({
    gatewayUrl: null,
    serviceState: () => state,
    ensureServices: async () => {
      starts++;
      state = "ready";
    },
    fetch: (async () =>
      new Response(JSON.stringify({ activeThreads: 0 }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  const runtime = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => runtime.once("listening", resolve));
  const url = `http://127.0.0.1:${(runtime.address() as { port: number }).port}`;
  t.after(() => close(runtime));
  assert.deepEqual(await (await fetch(`${url}/ping`)).json(), {
    status: "Healthy",
  });
  assert.equal(starts, 0);
  const invoke = (body: unknown) =>
    fetch(`${url}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await invoke({ method: "GET", path: "/../../healthz" })).status,
    400,
  );
  assert.equal(starts, 0);
  assert.deepEqual(
    await (await invoke({ method: "GET", path: "/healthz" })).json(),
    {
      status: 200,
      body: { activeThreads: 0 },
    },
  );
  assert.equal(starts, 1);
  state = "starting";
  assert.deepEqual(await (await fetch(`${url}/ping`)).json(), {
    status: "HealthyBusy",
  });
  state = "stopping";
  assert.equal((await fetch(`${url}/ping`)).status, 503);
});
