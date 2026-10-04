import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { WebSearchTools, webSearchFromEnv } from "../src/web-search";

const token = "test-token-".padEnd(40, "x");
const result = {
  provider: "searxng",
  query: "docs",
  searchedAt: new Date().toISOString(),
  results: [
    {
      sourceId: "search_fixture",
      url: "https://example.com/docs",
      title: "Docs",
      snippet: "Documentation",
      engines: ["bing"],
    },
  ],
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

test("client validates inputs, authenticates, normalizes query and projects bounded results", async (t) => {
  let requests = 0;
  const url = await fixture(t, async (req, res) => {
    requests++;
    assert.equal(req.url, "/search");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { query: "docs", limit: 10 });
    res
      .writeHead(200)
      .end(JSON.stringify({ ...result, internal: "private-settings" }));
  });
  const client = new WebSearchTools({ url, token });
  await assert.rejects(client.execute({ query: "docs", tenantId: "other" }), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(requests, 0);
  assert.deepEqual(await client.execute({ query: " docs " }), result);
});

test("client rejects malformed success responses and unsafe citation links", async (t) => {
  for (const payload of [
    { ...result, query: "other" },
    { ...result, results: Array(21).fill(result.results[0]) },
    {
      ...result,
      results: [{ ...result.results[0], url: "javascript:alert(1)" }],
    },
    {
      ...result,
      results: [{ ...result.results[0], snippet: "x".repeat(1501) }],
    },
    { ...result, warnings: ["x".repeat(301)] },
  ]) {
    await t.test(JSON.stringify(payload).slice(0, 60), async (t) => {
      const url = await fixture(t, (_req, res) =>
        res.writeHead(200).end(JSON.stringify(payload)),
      );
      await assert.rejects(
        new WebSearchTools({ url, token }).execute({ query: "docs" }),
        { code: "SEARCH_RESPONSE_INVALID" },
      );
    });
  }
});

test("client discards untrusted error messages and does not follow authenticated redirects", async (t) => {
  const url = await fixture(t, (_req, res) =>
    res.writeHead(503).end(
      JSON.stringify({
        code: "SEARCH_UNAVAILABLE",
        message: "Bearer secret raw-service-location",
      }),
    ),
  );
  await assert.rejects(
    new WebSearchTools({ url, token }).execute({ query: "docs" }),
    (error: any) =>
      error.code === "SEARCH_UNAVAILABLE" &&
      !/secret|raw-service/.test(error.message),
  );
  let forwarded = false;
  const target = await fixture(t, (_req, res) => {
    forwarded = true;
    res.writeHead(200).end(JSON.stringify(result));
  });
  const redirect = await fixture(t, (_req, res) =>
    res.writeHead(302, { Location: target }).end(),
  );
  await assert.rejects(
    new WebSearchTools({ url: redirect, token }).execute({ query: "docs" }),
    { code: "SEARCH_UNAVAILABLE" },
  );
  assert.equal(forwarded, false);
});

test("client distinguishes timeout from user cancellation and bounds streamed response bodies", async (t) => {
  const slow = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write("{");
  });
  await assert.rejects(
    new WebSearchTools({ url: slow, token, timeoutMs: 50 }).execute({
      query: "docs",
    }),
    { code: "SEARCH_TIMEOUT" },
  );
  const controller = new AbortController();
  const search = new WebSearchTools({ url: slow, token }).execute(
    { query: "docs" },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(search, { code: "SEARCH_CANCELLED" });
  const oversized = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ ...result, extra: "x".repeat(300 * 1024) }));
  });
  await assert.rejects(
    new WebSearchTools({ url: oversized, token }).execute({ query: "docs" }),
    { code: "SEARCH_RESPONSE_INVALID" },
  );
});

test("feature is off by default and enabled configuration fails closed", () => {
  assert.equal(webSearchFromEnv({}), null);
  assert.equal(
    webSearchFromEnv({ WEB_SEARCH: "off", WEB_SERVICE_URL: "invalid" }),
    null,
  );
  assert.throws(() => webSearchFromEnv({ WEB_SEARCH: "on" }), /requires/);
  for (const url of [
    "file:///tmp/service",
    "http://user:pass@localhost",
    "http://localhost?token=secret",
    "http://localhost#fragment",
    "http://localhost/other",
  ])
    assert.throws(() => new WebSearchTools({ url, token }));
  assert.throws(
    () => new WebSearchTools({ url: "http://localhost", token: "short" }),
  );
  assert.throws(
    () => new WebSearchTools({ url: "http://localhost", token, timeoutMs: 0 }),
  );
});
