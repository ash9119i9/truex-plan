import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { WebReadTools, webReadFromEnv } from "../src/web-read";
import { webReadLimits } from "../../shared/web-read";

const token = "read-token-".padEnd(40, "x");
const result = {
  provider: "crawl4ai",
  requestedUrl: "https://example.com/docs",
  url: "https://example.com/docs/",
  title: "Docs",
  retrievedAt: new Date().toISOString(),
  statusCode: 200,
  markdown: "# Documentation\nVerified page detail.",
  truncated: false,
  totalChars: "# Documentation\nVerified page detail.".length,
  warnings: [],
};
async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("read client authenticates, normalizes input and projects only bounded contract fields", async (t) => {
  let requests = 0;
  const url = await fixture(t, async (req, res) => {
    requests++;
    assert.equal(req.url, "/read");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), {
      url: result.requestedUrl,
      maxChars: 20000,
    });
    res
      .writeHead(200)
      .end(
        JSON.stringify({ ...result, internal: "secret", links: ["internal"] }),
      );
  });
  const client = new WebReadTools({ url, token });
  for (const args of [
    { url: result.requestedUrl, tenantId: "other" },
    { url: "file:///private" },
    { url: "https://user:secret@example.com" },
    { url: result.requestedUrl, maxChars: null },
    { url: result.requestedUrl, maxChars: 50001 },
  ])
    await assert.rejects(client.execute(args), { code: "INVALID_ARGUMENT" });
  assert.equal(requests, 0);
  assert.deepEqual(
    await client.execute({ url: result.requestedUrl + "#fragment" }),
    result,
  );
});

test("read client rejects mismatched provenance, malformed status, unsafe URLs and output bounds", async (t) => {
  for (const payload of [
    { ...result, requestedUrl: "https://other.example.com/" },
    { ...result, url: "javascript:alert(1)" },
    { ...result, url: "https://user:secret@example.com/" },
    { ...result, statusCode: 404 },
    { ...result, markdown: "x".repeat(20001), totalChars: 20001 },
    { ...result, markdown: " " },
    { ...result, title: "x".repeat(webReadLimits.titleChars + 1) },
    { ...result, retrievedAt: "yesterday" },
    { ...result, totalChars: 1 },
    {
      ...result,
      totalChars: webReadLimits.maxExtractedChars + 1,
      truncated: true,
    },
    { ...result, truncated: true },
    { ...result, warnings: ["x".repeat(301)] },
  ])
    await t.test(JSON.stringify(payload).slice(0, 60), async (t) => {
      const url = await fixture(t, (_req, res) =>
        res.writeHead(200).end(JSON.stringify(payload)),
      );
      await assert.rejects(
        new WebReadTools({ url, token }).execute({ url: result.requestedUrl }),
        { code: "READ_RESPONSE_INVALID" },
      );
    });
  const truncated = { ...result, markdown: "# Doc", truncated: true };
  const url = await fixture(t, (_req, res) =>
    res.writeHead(200).end(JSON.stringify(truncated)),
  );
  assert.deepEqual(
    await new WebReadTools({ url, token }).execute({
      url: result.requestedUrl,
      maxChars: 5,
    }),
    truncated,
  );
});

test("read client sanitizes typed errors/auth failures and declines credential forwarding redirects", async (t) => {
  for (const [status, code] of [
    [401, "READ_CONFIGURATION"],
    [403, "READ_CONFIGURATION"],
    [404, "READ_NOT_FOUND"],
    [429, "READ_RATE_LIMITED"],
    [502, "READ_BLOCKED"],
  ] as const) {
    const url = await fixture(t, (_req, res) =>
      res
        .writeHead(status)
        .end(JSON.stringify({ code, message: "Bearer secret raw-host" })),
    );
    await assert.rejects(
      new WebReadTools({ url, token }).execute({ url: result.requestedUrl }),
      (error: any) =>
        error.code === code && !/secret|raw-host/.test(error.message),
    );
  }
  let forwarded = false;
  const target = await fixture(t, (_req, res) => {
    forwarded = true;
    res.writeHead(200).end(JSON.stringify(result));
  });
  const redirect = await fixture(t, (_req, res) =>
    res.writeHead(302, { Location: target }).end(),
  );
  await assert.rejects(
    new WebReadTools({ url: redirect, token }).execute({
      url: result.requestedUrl,
    }),
    { code: "READ_UNAVAILABLE" },
  );
  assert.equal(forwarded, false);
});

test("read client distinguishes cancellation/timeout and limits declared and streamed bodies", async (t) => {
  const slow = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write("{");
  });
  await assert.rejects(
    new WebReadTools({ url: slow, token, timeoutMs: 50 }).execute({
      url: result.requestedUrl,
    }),
    { code: "READ_TIMEOUT" },
  );
  const controller = new AbortController();
  const pending = new WebReadTools({ url: slow, token }).execute(
    { url: result.requestedUrl },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { code: "READ_CANCELLED" });
  for (const declared of [true, false]) {
    const url = await fixture(t, (_req, res) => {
      res.writeHead(
        200,
        declared ? { "Content-Length": webReadLimits.responseBytes + 1 } : {},
      );
      res.end(
        JSON.stringify({
          ...result,
          extra: "x".repeat(webReadLimits.responseBytes),
        }),
      );
    });
    await assert.rejects(
      new WebReadTools({ url, token }).execute({ url: result.requestedUrl }),
      { code: "READ_RESPONSE_INVALID" },
    );
  }
});

test("read feature has its own opt-in and validates shared service/timeout configuration", () => {
  assert.equal(webReadFromEnv({}), null);
  assert.equal(
    webReadFromEnv({ WEB_SEARCH: "on", WEB_SERVICE_URL: "bad" }),
    null,
  );
  assert.equal(
    webReadFromEnv({ WEB_READ: "off", WEB_SERVICE_URL: "bad" }),
    null,
  );
  assert.throws(() => webReadFromEnv({ WEB_READ: "on" }), /requires/);
  assert.ok(
    webReadFromEnv({
      WEB_READ: "on",
      WEB_SEARCH: "off",
      WEB_SERVICE_URL: "http://localhost:4400",
      WEB_SERVICE_TOKEN: token,
    }),
  );
  for (const url of [
    "file:///tmp/service",
    "http://user:pass@localhost",
    "http://localhost?token=secret",
    "http://localhost#fragment",
    "http://localhost/other",
  ])
    assert.throws(() => new WebReadTools({ url, token }));
  assert.throws(
    () => new WebReadTools({ url: "http://localhost", token: "short" }),
  );
  for (const timeoutMs of [0, 120001, NaN, 1.5])
    assert.throws(
      () => new WebReadTools({ url: "http://localhost", token, timeoutMs }),
    );
  assert.doesNotThrow(
    () =>
      new WebReadTools({ url: "http://localhost", token, timeoutMs: 120000 }),
  );
});
