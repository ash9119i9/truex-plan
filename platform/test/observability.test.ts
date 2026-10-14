import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { ApiError } from "../src/core/errors";
import { PlatformService } from "../src/app/platform-service";
import { PublicEventStream } from "../src/streaming/event-stream";
import { publicEvent } from "../src/public/events";
import {
  endedStream,
  errorHandler,
  failStream,
  requestIdMiddleware,
  route,
} from "../src/http/handlers";

const realFetch = globalThis.fetch;
async function serve(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

test("errors carry a request id in the body and header, reusing an inbound id", async (t) => {
  const app = express();
  app.use(requestIdMiddleware);
  // Every /api request has its user and tenant by the time it reaches a
  // route; route() refuses to run without them.
  app.use((_req, res, next) => {
    res.locals.user = { id: "u1", email: "u1@dev.local", role: "user" };
    res.locals.tenant = { id: "t1", dbName: "truex_t_t1" };
    next();
  });
  app.get(
    "/api/sessions/:id",
    route(() => {
      throw new ApiError(404, "Session not found", "SESSION_NOT_FOUND");
    }),
  );
  app.get(
    "/boom",
    route(() => {
      throw new Error("password=secret internal detail");
    }),
  );
  app.use(errorHandler);
  const server = await serve(app);
  t.after(server.close);

  const reused = await realFetch(`${server.url}/api/sessions/s1`, {
    headers: { "x-request-id": "req-abc.123" },
  });
  assert.equal(reused.status, 404);
  assert.equal(reused.headers.get("x-request-id"), "req-abc.123");
  assert.deepEqual(await reused.json(), {
    error: "Session not found",
    code: "SESSION_NOT_FOUND",
    requestId: "req-abc.123",
  });

  const minted = await realFetch(`${server.url}/boom`, {
    headers: { "x-request-id": "bad id with spaces" },
  });
  const body = await minted.json();
  assert.equal(minted.status, 500);
  assert.equal(body.code, "PLATFORM_INTERNAL");
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(minted.headers.get("x-request-id"), body.requestId);
  assert.doesNotMatch(JSON.stringify(body), /secret/);
});

test("the inbound request id is forwarded to agent-core", async (t) => {
  const service = new PlatformService({} as any, ["http://core"]);
  const seen: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    if (!String(input).startsWith("http://core")) return realFetch(input, init);
    seen.push(new Headers(init?.headers).get("x-request-id"));
    return new Response(JSON.stringify({ ok: true }));
  });
  const app = express();
  app.use(requestIdMiddleware);
  // Every /api request has its user and tenant by the time it reaches a
  // route; route() refuses to run without them.
  app.use((_req, res, next) => {
    res.locals.user = { id: "u1", email: "u1@dev.local", role: "user" };
    res.locals.tenant = { id: "t1", dbName: "truex_t_t1" };
    next();
  });
  app.use(express.json());
  app.post(
    "/api/ping",
    route(async (_req, res) =>
      res.json(await service.call("http://core", "/x")),
    ),
  );
  app.use(errorHandler);
  const server = await serve(app);
  t.after(server.close);
  const res = await realFetch(`${server.url}/api/ping`, {
    method: "POST",
    headers: { "x-request-id": "trace-42", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["trace-42"]);
  // Outside a request (background ingestion) no id is sent.
  await service.call("http://core", "/x");
  assert.deepEqual(seen, ["trace-42", null]);
});

test("unexpected agent-core 5xx becomes a bad gateway; owner codes and 4xx pass through", async (t) => {
  const service = new PlatformService({} as any, ["http://core"]);
  const fetchMock = t.mock.method(globalThis, "fetch");
  const reply = (status: number, body: object) =>
    fetchMock.mock.mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );
  reply(500, {
    error: "The assistant runtime failed",
    code: "RUNTIME_INTERNAL",
  });
  await assert.rejects(service.call("http://core", "/threads"), (e: any) => {
    assert.equal(e.status, 502);
    assert.equal(e.code, "UPSTREAM_FAILED");
    assert.equal(e.message, "The assistant runtime failed");
    assert.equal(e.cause.status, 500);
    assert.equal(e.cause.code, "RUNTIME_INTERNAL");
    return true;
  });
  for (const code of ["CAPACITY", "DRAINING", "RUNTIME_UNAVAILABLE"]) {
    reply(503, { error: "busy", code });
    await assert.rejects(service.call("http://core", "/threads"), {
      status: 503,
      code,
    });
  }
  reply(504, { error: "timed out", code: "RPC_TIMEOUT" });
  await assert.rejects(service.call("http://core", "/threads"), {
    status: 504,
    code: "RPC_TIMEOUT",
  });
  reply(410, { error: "gone", code: "THREAD_LOST" });
  await assert.rejects(service.call("http://core", "/threads"), {
    status: 410,
    code: "THREAD_LOST",
  });
});

test("a missing session has a named code", async () => {
  const service = new PlatformService({
    sessions: { findOne: async () => null },
  } as any);
  await assert.rejects(service.session("missing"), {
    status: 404,
    code: "SESSION_NOT_FOUND",
  });
});

test("a malformed live update is skipped and the stream continues", () => {
  const stream = new PublicEventStream();
  const out = stream.push(
    new TextEncoder().encode(
      'data: {not json\n\nid: c2\ndata: {"type":"turn.started","cursor":"c2","turnId":"t1"}\n\n',
    ),
  );
  assert.match(out, /^id: c2\ndata: /);
  assert.equal(JSON.parse(out.split("data: ")[1]).type, "turn.started");
});

test("a fatal stream failure writes a stream.error event", () => {
  const stream = new PublicEventStream();
  let failure: unknown;
  try {
    stream.push(new Uint8Array(4 * 1024 * 1024 + 1).fill(97));
  } catch (e) {
    failure = e;
  }
  assert.ok(failure);
  const written: string[] = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    write: (x: string) => written.push(x),
  };
  failStream(res, failure, { requestId: "req-1", sessionId: "s1" });
  assert.equal(written.length, 1);
  const [head, data] = written[0].split("\n");
  assert.equal(head, "event: stream.error");
  assert.deepEqual(Object.keys(JSON.parse(data.slice(6))).sort(), [
    "code",
    "error",
    "requestId",
  ]);
  assert.equal(JSON.parse(data.slice(6)).code, "STREAM_FAILED");
  assert.equal(JSON.parse(data.slice(6)).requestId, "req-1");
  assert.ok(written[0].endsWith("\n\n"));
  failStream({ ...res, destroyed: true }, failure, {});
  assert.equal(written.length, 1);
});

test("a clean upstream end writes a STREAM_ENDED stream.error event", () => {
  const written: string[] = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    write: (x: string) => written.push(x),
  };
  endedStream(res, { requestId: "req-2", sessionId: "s1" });
  assert.equal(written.length, 1);
  const [head, data] = written[0].split("\n");
  assert.equal(head, "event: stream.error");
  const body = JSON.parse(data.slice(6));
  assert.equal(body.code, "STREAM_ENDED");
  assert.equal(body.requestId, "req-2");
  assert.match(body.error, /restart/);
  endedStream({ ...res, destroyed: true }, {});
  assert.equal(written.length, 1);
});

test("public error events keep willRetry and turnId", () => {
  const event = publicEvent({
    type: "error",
    turnId: "t1",
    data: {
      error: { codexErrorInfo: "serverOverloaded", message: "private" },
      willRetry: true,
      turnId: "t1",
    },
  });
  assert.equal(event.data.code, "PROVIDER_UNAVAILABLE");
  assert.equal(event.data.willRetry, true);
  assert.equal(event.data.turnId, "t1");
  assert.doesNotMatch(JSON.stringify(event), /private/);
  const plain = publicEvent({
    type: "error",
    data: { code: "RUNTIME_UNAVAILABLE" },
  });
  assert.equal("willRetry" in plain.data, false);
});
