import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MAX_BODY_BYTES,
  forward,
  forwardedFor,
  isBlockedPath,
  safePath,
  safeSegment,
  type Prefix,
} from "../lib/forward.ts";

// A real upstream that records exactly what reached it.
async function upstream(
  handle: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
) {
  const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: body.toString() });
      handle(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const ECHO = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
};
const call = (
  up: { url: string },
  prefix: Prefix,
  path: string[] | undefined,
  init: RequestInit & { env?: Record<string, string> } = {},
  url = `http://app.test${prefix}/${(path ?? []).join("/")}`,
) => {
  const { env, ...rest } = init;
  return forward(new Request(url, rest), {
    prefix,
    path,
    env: { PLATFORM_INTERNAL_URL: up.url, ...env },
  });
};

test("only safe, non-admin paths are forwarded", async (t) => {
  const up = await upstream(ECHO);
  t.after(up.close);
  for (const bad of [
    undefined,
    [],
    [""],
    ["."],
    [".."],
    ["a", "..", "admin"],
    ["a/b"],
    ["..\\admin"],
    ["a\u0000b"],
    ["a\nb"],
    ["%2E%2E"], // arrives decoded once as "%2E%2E" from %252E%252E
    ["%2e%2e"],
    ["%2F"],
    ["%5C"],
    ["%zz"],
  ])
    assert.equal(
      (await call(up, "/api", bad as string[])).status,
      404,
      JSON.stringify(bad),
    );
  // The admin console is not on this origin, however it is spelled.
  for (const admin of [["admin"], ["Admin", "tenants"], ["ADMIN"], ["admin", "tenants", "x"]]) {
    assert.equal((await call(up, "/api", admin)).status, 404, admin.join("/"));
    assert.equal((await call(up, "/auth", admin)).status, 404, admin.join("/"));
  }
  assert.equal(up.seen.length, 0, "nothing unsafe reached the platform");
  assert.equal(isBlockedPath(["adminx"]), false);
  assert.equal(safeSegment("sess_4f1c-22"), true);
  assert.equal(safeSegment("100%25"), true);
  // A literal "%252E%252E" is only text: it is re-encoded and decoded once upstream.
  assert.equal(safeSegment("%252E%252E"), true);
  assert.equal(safePath(["sessions", "s1", "events"]), true);
  // The segments of an ordinary request keep their meaning, and are re-encoded.
  const ok = await call(up, "/api", ["sessions", "a b", "documents", "x?y"], {}, "http://app.test/api/sessions/a%20b/documents/x%3Fy?cursor=1:2");
  assert.equal(ok.status, 200);
  assert.equal(up.seen[0].url, "/api/sessions/a%20b/documents/x%3Fy?cursor=1:2");
});

test("methods, bodies and headers: only what the platform needs is forwarded", async (t) => {
  const up = await upstream(ECHO);
  t.after(up.close);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const hasBody = method !== "GET";
    const res = await call(up, "/api", ["mcp", "m1"], {
      method,
      headers: {
        cookie: "truex_session=abc",
        origin: "http://app.test",
        "content-type": "application/json",
        "x-request-id": "req-1",
        "last-event-id": "g:5",
        accept: "text/event-stream",
        // None of these may reach the platform.
        host: "evil.example",
        "x-truex-user": "admin",
        "x-truex-role": "admin",
        "x-truex-tenant": "other",
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-host": "evil.example",
        authorization: "Bearer stolen",
        connection: "keep-alive",
      },
      body: hasBody ? JSON.stringify({ n: 1 }) : undefined,
    });
    assert.equal(res.status, 200, method);
    const got = up.seen.at(-1)!;
    assert.equal(got.method, method);
    assert.equal(got.url, "/api/mcp/m1");
    assert.equal(got.headers.cookie, "truex_session=abc");
    assert.equal(got.headers.origin, "http://app.test");
    assert.equal(got.headers["content-type"], "application/json");
    assert.equal(got.headers["x-request-id"], "req-1");
    assert.equal(got.headers["last-event-id"], "g:5");
    assert.equal(got.body, hasBody ? '{"n":1}' : "");
    for (const forged of ["x-truex-user", "x-truex-role", "x-truex-tenant", "x-forwarded-for", "x-forwarded-host", "authorization"])
      assert.equal(got.headers[forged], undefined, `${method} ${forged}`);
    assert.notEqual(got.headers.host, "evil.example");
  }
  // OPTIONS and other verbs are not forwarded.
  assert.equal((await call(up, "/api", ["x"], { method: "OPTIONS" })).status, 405);
  // A bad request id is replaced, not passed on.
  await call(up, "/api", ["x"], { headers: { "x-request-id": "bad id with spaces" } });
  assert.match(String(up.seen.at(-1)!.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
});

test("client-supplied X-Forwarded-For is dropped unless a trusted proxy is configured", async (t) => {
  const up = await upstream(ECHO);
  t.after(up.close);
  const headers = { "x-forwarded-for": "203.0.113.9" };
  await call(up, "/auth", ["tenants"], { headers });
  assert.equal(up.seen.at(-1)!.headers["x-forwarded-for"], undefined);
  await call(up, "/auth", ["tenants"], { headers, env: { TRUST_FORWARDED_FOR: "on" } });
  assert.equal(up.seen.at(-1)!.headers["x-forwarded-for"], "203.0.113.9");
  assert.equal(forwardedFor("1.2.3.4", "off"), null);
  assert.equal(forwardedFor(null, "on"), null);
});

test("responses: separate Set-Cookie values, redirects, 204/304/HEAD, no-store and Vary", async (t) => {
  const up = await upstream((req, res) => {
    if (req.url === "/auth/google/callback") {
      res.writeHead(302, {
        location: "https://app.test/select-tenant",
        "set-cookie": ["__Host-truex_flow=; Path=/; Max-Age=0", "__Host-truex_session=tok; Path=/; HttpOnly; Secure"],
        "cache-control": "public, max-age=999",
      });
      return res.end();
    }
    if (req.url === "/api/none") return res.writeHead(204, { etag: "x" }).end();
    if (req.url === "/api/same") return res.writeHead(304, { etag: "x" }).end();
    if (req.url === "/api/file")
      return res
        .writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename*=UTF-8''a.txt",
          "x-content-type-options": "nosniff",
          vary: "Accept-Encoding",
        })
        .end("hello");
    if (req.url === "/api/vary") return res.writeHead(200, { "content-type": "application/json", vary: "cookie" }).end("{}");
    if (req.url === "/api/boom") return res.writeHead(500, { "content-type": "application/json" }).end('{"error":"x"}');
    ECHO(req, res);
  });
  t.after(up.close);

  const redirect = await call(up, "/auth", ["google", "callback"]);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://app.test/select-tenant");
  assert.deepEqual(redirect.headers.getSetCookie(), [
    "__Host-truex_flow=; Path=/; Max-Age=0",
    "__Host-truex_session=tok; Path=/; HttpOnly; Secure",
  ]);
  assert.equal(redirect.headers.get("cache-control"), "no-store", "an upstream public cache header is overridden");

  const none = await call(up, "/api", ["none"], { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(none.status, 204);
  assert.equal(await none.text(), "");
  const same = await call(up, "/api", ["same"]);
  assert.equal(same.status, 304);
  assert.equal(await same.text(), "");

  const head = await call(up, "/api", ["file"], { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-disposition"), "attachment; filename*=UTF-8''a.txt");
  assert.equal(up.seen.at(-1)!.method, "HEAD");

  const file = await call(up, "/api", ["file"]);
  assert.equal(await file.text(), "hello");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.equal(file.headers.get("cache-control"), "no-store");
  assert.match(file.headers.get("vary")!, /Accept-Encoding, Cookie/);
  // Already varying on Cookie: not repeated.
  const again = await call(up, "/api", ["vary"]);
  assert.equal(again.headers.get("vary"), "cookie", "upstream already varied on Cookie; not repeated");
  assert.equal(file.headers.get("vary")!.split(",").filter((v) => /cookie/i.test(v)).length, 1);
  // The body length is the new response's own; an upstream length is not copied.
  assert.equal(file.headers.get("content-encoding"), null);

  const boom = await call(up, "/api", ["boom"]);
  assert.equal(boom.status, 500, "an upstream error status is passed through, not rewritten");
  assert.equal((await boom.json()).error, "x");
  assert.ok(boom.headers.get("x-request-id"));
});

test("oversized requests are refused up front and cut off mid-stream", async (t) => {
  const up = await upstream(ECHO);
  t.after(up.close);
  const big = "x".repeat(MAX_BODY_BYTES + 10);
  const declared = await call(up, "/api", ["sessions", "s1", "documents"], {
    method: "POST",
    body: big,
    headers: { "content-type": "application/json" },
  });
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).code, "REQUEST_TOO_LARGE");
  assert.equal(up.seen.length, 0, "nothing was sent upstream");

  // No Content-Length: a chunked body is counted as it goes.
  const encoder = new TextEncoder();
  const chunk = encoder.encode("y".repeat(512 * 1024));
  let sent = 0;
  const chunked = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ < 8) c.enqueue(chunk);
      else c.close();
    },
  });
  const res = await forward(
    new Request("http://app.test/api/sessions/s1/documents", {
      method: "POST",
      body: chunked,
      headers: { "content-type": "application/json" },
      // @ts-expect-error duplex is required for a streamed body
      duplex: "half",
    }),
    { prefix: "/api", path: ["sessions", "s1", "documents"], env: { PLATFORM_INTERNAL_URL: up.url } },
  );
  assert.equal(res.status, 413);
  // A body at the limit is fine.
  const fine = await call(up, "/api", ["x"], { method: "POST", body: "z".repeat(1024 * 1024), headers: { "content-type": "application/json" } });
  assert.equal(fine.status, 200);
});

test("an unreachable or slow platform is an outage, never a sign-out", async (t) => {
  // Nothing listens here.
  const dead = await call({ url: "http://127.0.0.1:1" }, "/api", ["me"]);
  assert.equal(dead.status, 503);
  const body = await dead.json();
  assert.equal(body.code, "PLATFORM_UNAVAILABLE");
  assert.ok(body.requestId);
  assert.equal(dead.headers.get("cache-control"), "no-store");

  const slow = await upstream(() => {
    /* never answers */
  });
  t.after(slow.close);
  const aborter = new AbortController();
  const waiting = call(slow, "/api", ["me"], { signal: aborter.signal });
  setTimeout(() => aborter.abort(), 50);
  assert.equal((await waiting).status, 499, "a request the browser abandoned");
});

test("event streams pass through as they happen and end the upstream request when the browser leaves", async (t) => {
  let upstreamClosed: (() => void) | undefined;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const up = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
    res.write("event: first\ndata: 1\n\n");
    // The second event only comes after the test has already read the first:
    // a buffering forwarder would hold the first back until this one.
    setTimeout(() => res.write("event: second\ndata: 2\n\n"), 400);
    res.on("close", () => upstreamClosed!());
  });
  t.after(up.close);
  const aborter = new AbortController();
  const began = Date.now();
  const res = await call(up, "/api", ["sessions", "s1", "events"], {
    signal: aborter.signal,
    headers: { "last-event-id": "g:9", cookie: "truex_session=abc" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  const firstAt = Date.now() - began;
  assert.match(first, /event: first/);
  assert.ok(firstAt < 300, `first event took ${firstAt} ms; the stream is being buffered`);
  console.log(`# first SSE event reached the browser side ${firstAt} ms after the request (upstream's next event is at 400 ms)`);
  assert.equal(up.seen[0].headers["last-event-id"], "g:9");
  // The person closes the tab: the platform's stream is closed too.
  aborter.abort();
  await reader.cancel().catch(() => {});
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the upstream stream stayed open")), 3000)),
  ]);
});

test("a stream cancelled by the reader releases the upstream request", async (t) => {
  let upstreamClosed: (() => void) | undefined;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const up = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
    res.on("close", () => upstreamClosed!());
  });
  t.after(up.close);
  const res = await call(up, "/api", ["sessions", "s1", "events"]);
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the upstream stream stayed open")), 3000)),
  ]);
});
