import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Response } from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreApp } from "../../src/http/app";
import type { CoreDependencies } from "../../src/http/dependencies";
import { HttpError } from "../../src/errors";
import { Redactor } from "../../src/redact";

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "truex-http-"));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const result =
    (method: string, value: unknown = { ok: true }) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return value;
    };
  const client = {
    start: result("start", { userAgent: "fixture" }),
    spawnMs: 11,
    initializeMs: 12,
    documentToolsAvailable: () => true,
    visualizationToolsAvailable: () => true,
    files: {
      list: result("files.list", [{ id: "file" }]),
      upload: result("files.upload", { id: "uploaded" }),
      visualization: result("files.visualization", { html: "<p>fixture</p>" }),
      get: result("files.get", { id: "file", data: Buffer.from("hello") }),
    },
    request: result("request", { data: [{ text: "history" }] }),
  };
  const manager = {
    draining: false,
    threads: new Map([["thread", { state: { kind: "idle" } }]]),
    unknownMethods: [],
    redactor: new Redactor(),
    create: result("create", { threadId: "thread" }),
    resume: result("resume"),
    setApprovalMode: result("setApprovalMode"),
    message: result("message"),
    interrupt: result("interrupt"),
    snapshot: result("snapshot", { messages: [] }),
    subscribe: (
      id: string,
      res: Response,
      cursor: unknown,
      options: unknown,
    ) => {
      calls.push({ method: "subscribe", args: [id, cursor, options] });
      res.set("Content-Type", "text/event-stream");
      res.end('id: generation:1\ndata: {"type":"fixture"}\n\n');
    },
    records: result("records", [{ key: "record" }]),
    ack: result("ack"),
    answer: result("answer"),
    turnContext: result("turnContext"),
    agents: result("agents", []),
    agent: result("agent"),
    interruptAgent: result("interruptAgent"),
    capability: result("capability"),
  };
  const dependencies = { client, manager, home, pin: { revision: "fixture" } };
  const app = createCoreApp(dependencies as unknown as CoreDependencies);
  assert.deepEqual(calls, [], "constructing the app must not start services");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  const call = (path: string, body?: unknown, method = "POST") =>
    fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...dependencies, calls, url, call };
}

test("core HTTP app preserves health status, metadata and request IDs", async (t) => {
  const { url, manager, calls, home } = await fixture(t);
  const live = await fetch(url + "/livez", {
    headers: { "x-request-id": "fixture-request" },
  });
  assert.equal(live.headers.get("x-request-id"), "fixture-request");
  assert.equal(live.headers.get("x-powered-by"), null);
  assert.deepEqual(await live.json(), { ok: true });
  assert.deepEqual(calls, []);
  const health = await fetch(url + "/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    codex: "fixture",
    revision: "fixture",
    spawnMs: 11,
    initializeMs: 12,
    codexHome: home,
    codexHomeWritable: true,
    unknownMethods: [],
    threads: 1,
    activeThreads: 0,
  });
  manager.draining = true;
  assert.equal((await fetch(url + "/healthz")).status, 503);
});

test("core HTTP thread routes preserve statuses, arguments and default capability parameters", async (t) => {
  const { call, calls } = await fixture(t);
  const created = await call("/threads", { model: "fixture" });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    threadId: "thread",
    runtimeStartup: { spawnMs: 11, initializeMs: 12 },
  });
  await call("/threads/thread/resume", { response: "operational" });
  await call("/threads/thread/approval-mode", { mode: "ask" });
  assert.equal(
    (await call("/threads/thread/turns", { text: "message", clientId: "a" }))
      .status,
    202,
  );
  assert.equal(
    (await call("/threads/thread/steer", { text: "steer", clientId: "b" }))
      .status,
    202,
  );
  await call("/threads/thread/interrupt", {});
  await call("/threads/thread/approvals/request", {
    result: { decision: "accept" },
  });
  await call("/threads/thread/agents/agent/interrupt", {});
  await call("/threads/thread/capabilities", { method: "thread/read" });
  await call("/threads/thread", undefined, "DELETE");
  assert.deepEqual(calls, [
    { method: "create", args: [{ model: "fixture" }] },
    { method: "resume", args: ["thread", { response: "operational" }] },
    { method: "setApprovalMode", args: ["thread", "ask"] },
    { method: "message", args: ["thread", "message", "a"] },
    { method: "message", args: ["thread", "steer", "b", true] },
    { method: "interrupt", args: ["thread"] },
    { method: "answer", args: ["thread", "request", { decision: "accept" }] },
    { method: "interruptAgent", args: ["thread", "agent"] },
    { method: "capability", args: ["thread", "thread/read", {}] },
    { method: "capability", args: ["thread", "thread/delete", {}] },
  ]);
});

test("core HTTP document routes preserve availability, base64 and upload rejection", async (t) => {
  const { url, call, client } = await fixture(t);
  assert.deepEqual(
    await (await fetch(url + "/threads/thread/documents")).json(),
    {
      available: true,
      visualizationAvailable: true,
      files: [{ id: "file" }],
    },
  );
  const uploaded = await call("/threads/thread/documents", {
    name: "hello.txt",
    base64: "aGVsbG8=",
  });
  assert.equal(uploaded.status, 201);
  assert.deepEqual(await uploaded.json(), { id: "uploaded" });
  assert.deepEqual(
    await (await fetch(url + "/threads/thread/documents/file")).json(),
    {
      id: "file",
      base64: "aGVsbG8=",
    },
  );
  assert.deepEqual(
    await (await fetch(url + "/threads/thread/visualizations/file")).json(),
    {
      html: "<p>fixture</p>",
    },
  );
  client.documentToolsAvailable = () => false;
  const unavailable = await call("/threads/thread/documents", {
    name: "hello.txt",
    base64: "aGVsbG8=",
  });
  assert.equal(unavailable.status, 409);
  assert.equal(
    (await unavailable.json()).error,
    "Start a new conversation to use documents",
  );
});

test("core HTTP reads preserve history, acknowledgment validation and SSE cursor precedence", async (t) => {
  const { url, call, calls } = await fixture(t);
  assert.deepEqual(
    await (await fetch(url + "/threads/thread/snapshot?window=1")).json(),
    { messages: [] },
  );
  const events = await fetch(
    url + "/threads/thread/events?cursor=query&window=1&sync=v1",
    {
      headers: { "Last-Event-ID": "generation:0" },
    },
  );
  assert.match(events.headers.get("content-type") || "", /text\/event-stream/);
  assert.equal(
    await events.text(),
    'id: generation:1\ndata: {"type":"fixture"}\n\n',
  );
  assert.equal(
    (await fetch(url + "/threads/thread/events?sync=v2")).status,
    400,
  );
  assert.deepEqual(
    await (
      await fetch(url + "/threads/thread/items?cursor=history-cursor")
    ).json(),
    {
      data: [{ text: "history" }],
    },
  );
  await fetch(url + "/threads/thread/records");
  assert.equal(
    (await call("/threads/thread/records/ack", { keys: "invalid" })).status,
    400,
  );
  await call("/threads/thread/records/ack", { keys: ["record"] });
  await fetch(url + "/threads/thread/turns/turn/context");
  await fetch(url + "/threads/thread/agents");
  await fetch(url + "/threads/thread/agents/agent");
  assert.deepEqual(calls, [
    { method: "snapshot", args: ["thread", { window: true, sync: undefined }] },
    {
      method: "subscribe",
      args: ["thread", "generation:0", { window: true, sync: "v1" }],
    },
    {
      method: "request",
      args: [
        "thread/items/list",
        {
          threadId: "thread",
          limit: 100,
          cursor: "history-cursor",
          sortDirection: "asc",
        },
      ],
    },
    { method: "records", args: ["thread"] },
    { method: "ack", args: ["thread", ["record"]] },
    { method: "turnContext", args: ["thread", "turn"] },
    { method: "agents", args: ["thread"] },
    { method: "agent", args: ["thread", "agent"] },
  ]);
});

test("core HTTP error middleware retains JSON errors, request IDs and secret redaction", async (t) => {
  const { url, call, manager } = await fixture(t);
  const invalid = await fetch(url + "/threads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "invalid-json",
    },
    body: "{",
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "The request contains invalid JSON. Check the request format.",
    code: "INVALID_JSON",
    requestId: "invalid-json",
  });
  manager.redactor.remember({ api_key: "fixture-private-value" });
  manager.resume = () => {
    throw new HttpError(403, "Cannot read fixture-private-value", "DENIED");
  };
  const denied = await call("/threads/thread/resume", {});
  assert.equal(denied.status, 403);
  const body = await denied.json();
  assert.equal(body.error, "Cannot read [REDACTED]");
  assert.equal(body.code, "DENIED");
  assert.equal(body.requestId, denied.headers.get("x-request-id"));
});
