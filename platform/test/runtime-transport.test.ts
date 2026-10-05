import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { sdkStreamMixin } from "@smithy/core/serde";
import { MongoMemoryServer } from "mongodb-memory-server";
import { RuntimeTransport, runtimeHosts } from "../src/runtime-transport";
import { PlatformService } from "../src/service";
import { Store } from "../src/store";
import { insertFixtures } from "./fixtures";

const owner =
  "arn:aws:bedrock-agentcore:us-east-1:502055890667:runtime/test_runtime";
const output = (
  body: unknown,
  contentType = "application/json",
  runtimeSessionId?: string,
) => ({
  $metadata: { httpStatusCode: 200 },
  statusCode: 200,
  contentType,
  runtimeSessionId,
  response: sdkStreamMixin(
    Readable.from(
      [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))],
      { objectMode: false },
    ),
  ),
});

test("AgentCore envelopes preserve errors and pagination; event streams retain cursor and abort signal", async () => {
  const sessionId = randomUUID();
  const controller = new AbortController();
  const calls: any[] = [];
  const transport = new RuntimeTransport(async (region, command, signal) => {
    const payload = JSON.parse(
      Buffer.from(command.input.payload as Uint8Array).toString(),
    );
    calls.push({ region, input: command.input, payload, signal });
    return payload.path.endsWith("/events")
      ? output(
          'id: g:2\ndata: {"type":"message.delta"}\n\n',
          "text/event-stream",
          sessionId,
        )
      : output(
          { status: 404, body: { code: "THREAD_LOST", error: "Thread lost" } },
          "application/json",
          sessionId,
        );
  });
  const missing = await transport.request({
    owner,
    sessionId,
    path: "/threads/t/items?cursor=g%3A1",
    requestId: "req-123",
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    code: "THREAD_LOST",
    error: "Thread lost",
  });
  assert.deepEqual(calls[0].payload, {
    method: "GET",
    path: "/threads/t/items",
    cursor: "g:1",
    requestId: "req-123",
  });
  const events = await transport.request({
    owner,
    sessionId,
    path: "/threads/t/events",
    cursor: "g:2",
    signal: controller.signal,
  });
  assert.equal(events.headers.get("content-type"), "text/event-stream");
  assert.match(await events.text(), /message.delta/);
  assert.equal(calls[1].signal, controller.signal);
  assert.equal(calls[1].input.runtimeSessionId, sessionId);
  assert.equal(calls[1].region, "us-east-1");
  assert.equal(calls[1].payload.cursor, "g:2");
});

test("health and schemas share a stable runtime session; thread calls require the persisted session", async () => {
  const sessions: string[] = [];
  const transport = new RuntimeTransport(async (_region, command) => {
    sessions.push(command.input.runtimeSessionId!);
    return output({ status: 200, body: { ok: true } });
  });
  await transport.request({ owner, path: "/healthz" });
  await transport.request({ owner, path: "/schemas/ThreadStartParams" });
  assert.equal(sessions[0], sessions[1]);
  assert.ok(sessions[0].length >= 33);
  await assert.rejects(
    transport.request({ owner, path: "/threads/t/snapshot" }),
    { code: "OWNER_SESSION_UNCONFIGURED" },
  );
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    runtimeHosts({
      AGENTCORE_RUNTIME_ARN: owner,
      AGENT_CORE_URL: "http://localhost:4100",
    }),
    [owner],
  );
  assert.throws(
    () => runtimeHosts({ AGENTCORE_RUNTIME_ARN: "invalid" }),
    /Invalid AGENTCORE/,
  );
});

test("HTTP transport keeps direct calls and Last-Event-ID behavior", async (t) => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({
      method: req.method,
      path: req.url,
      cursor: req.headers["last-event-id"],
      requestId: req.headers["x-request-id"],
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const transport = new RuntimeTransport();
  await transport.request({
    owner: url,
    path: "/threads",
    method: "POST",
    body: { model: "fixture" },
    requestId: "req-1",
  });
  await transport.request({
    owner: url,
    path: "/threads/t/events",
    cursor: "g:1",
  });
  assert.deepEqual(requests[0], {
    method: "POST",
    path: "/threads",
    body: { model: "fixture" },
    requestId: "req-1",
    cursor: undefined,
  });
  assert.equal(requests[1].cursor, "g:1");
});

test("source snapshot window is identical for HTTP and AgentCore and rejects invalid options", async (t) => {
  const received: string[] = [];
  const server = createServer((req, res) => {
    received.push(req.url!);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const local = `http://127.0.0.1:${(server.address() as any).port}`;
  const envelopes: any[] = [];
  const sessionId = randomUUID();
  const transport = new RuntimeTransport(async (_region, command) => {
    envelopes.push(
      JSON.parse(Buffer.from(command.input.payload as Uint8Array).toString()),
    );
    return output({ status: 200, body: {} }, "application/json", sessionId);
  });
  for (const runtimeOwner of [local, owner]) {
    await transport.request({
      owner: runtimeOwner,
      sessionId,
      path: "/threads/t/snapshot",
      window: true,
    });
    await transport.request({
      owner: runtimeOwner,
      sessionId,
      path: "/threads/t/events?cursor=g%3A1&window=1",
    });
    await transport.request({
      owner: runtimeOwner,
      sessionId,
      path: "/threads/t/events",
      window: true,
      sync: "v1",
      cursor: "g:1",
    });
    await transport.request({
      owner: runtimeOwner,
      sessionId,
      path: "/threads/t/events?sync=v1&window=1&cursor=g%3A1",
    });
    for (const input of [
      { path: "/threads/t/items", window: true },
      { path: "/threads/t/snapshot?window=1&window=1" },
      { path: "/threads/t/snapshot?window=0" },
      { path: "/threads/t/snapshot?window=1", window: false },
      { path: "/threads/t/snapshot", window: "1" },
      { path: "/threads/t/snapshot", window: null },
      { method: "POST", path: "/threads/t/resume", window: true },
      { path: "/threads/t/snapshot", sync: "v1" },
      { path: "/threads/t/events", sync: "v2" },
      { path: "/threads/t/events", sync: null },
      { path: "/threads/t/events?sync=v1&sync=v1" },
      { path: "/threads/t/events?sync=v2", sync: "v1" },
    ])
      await assert.rejects(
        transport.request({ owner: runtimeOwner, sessionId, ...input } as any),
        { code: "INVALID_INPUT" },
      );
  }
  assert.deepEqual(received, [
    "/threads/t/snapshot?window=1",
    "/threads/t/events?cursor=g%3A1&window=1",
    "/threads/t/events?window=1&sync=v1",
    "/threads/t/events?sync=v1&window=1&cursor=g%3A1",
  ]);
  assert.deepEqual(envelopes, [
    { method: "GET", path: "/threads/t/snapshot", window: true },
    { method: "GET", path: "/threads/t/events", cursor: "g:1", window: true },
    {
      method: "GET",
      path: "/threads/t/events",
      cursor: "g:1",
      window: true,
      sync: "v1",
    },
    {
      method: "GET",
      path: "/threads/t/events",
      cursor: "g:1",
      window: true,
      sync: "v1",
    },
  ]);
});

test(
  "conversation creation, restart, streaming and ingestion reuse the stored AgentCore session",
  { timeout: 120_000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "agentcore-transport-test",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const calls: any[] = [];
    const transport = new RuntimeTransport(async (_region, command) => {
      const payload = JSON.parse(
        Buffer.from(command.input.payload as Uint8Array).toString(),
      );
      calls.push({ sessionId: command.input.runtimeSessionId, payload });
      const body =
        payload.path === "/threads"
          ? { threadId: "t_1", threadStartMs: 1 }
          : payload.path.endsWith("/records")
            ? []
            : { ok: true };
      return output({ status: payload.path === "/threads" ? 201 : 200, body });
    });
    const service = new PlatformService(store, [owner], undefined, transport);
    const created = await service.create("assistant");
    const session = await store.sessions.findOne({ _id: created._id });
    assert.ok(session?.agentCoreSessionId);
    assert.equal("agentCoreSessionId" in created, false);
    const restarted = new PlatformService(store, [owner], undefined, transport);
    await restarted.owned(session!, "/resume", "POST", {});
    await restarted.events(session!, "g:1", new AbortController().signal);
    await restarted.ingest(session!);
    assert.deepEqual(
      calls.map((call) => call.payload.path),
      [
        "/threads",
        "/threads/t_1/resume",
        "/threads/t_1/events",
        "/threads/t_1/records",
      ],
    );
    assert.ok(
      calls.every((call) => call.sessionId === session!.agentCoreSessionId),
    );
    await store.sessions.insertOne({
      ...session!,
      _id: "sess_" + randomUUID(),
      agentCoreHost: "http://127.0.0.1:4100",
    });
    await restarted.poll();
    assert.equal(
      calls.length,
      5,
      "Polling must skip sessions belonging to unconfigured local runtimes",
    );
    assert.equal(calls.at(-1).sessionId, session!.agentCoreSessionId);

    const savedGateway = {
      url: process.env.MODEL_GATEWAY_URL,
      secret: process.env.MODEL_GATEWAY_SECRET,
    };
    t.after(() => {
      for (const [key, value] of [
        ["MODEL_GATEWAY_URL", savedGateway.url],
        ["MODEL_GATEWAY_SECRET", savedGateway.secret],
      ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }
    });
    process.env.MODEL_GATEWAY_URL = "http://127.0.0.1:4200";
    process.env.MODEL_GATEWAY_SECRET = "test-signing-secret".repeat(3);
    await store.profiles.updateOne(
      { _id: "default" },
      { $set: { wireApi: "anthropic" } },
    );
    await assert.rejects(service.create("assistant"), {
      code: "GATEWAY_UNREACHABLE",
    });
    assert.equal(
      calls.length,
      5,
      "An unreachable gateway must fail before creating an AWS thread",
    );
  },
);
