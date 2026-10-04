import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { test, type TestContext } from "node:test";
import {
  parseWebSearchInput,
  WebSearchInputError,
} from "../../shared/web-search";
import { SearxngSearch, resultUrl } from "../src/searxng";
import { createWebService } from "../src/server";

const token = "fixture-token-".padEnd(40, "x");
async function listen(t: TestContext, handler: RequestListener) {
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
function json(
  res: Parameters<RequestListener>[1],
  value: unknown,
  status = 200,
) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(value));
}

test("arguments reject invalid inputs rather than coercing limits or unknown scope", () => {
  assert.deepEqual(
    parseWebSearchInput({
      query: " docs ",
      domains: ["EXAMPLE.COM", "example.com"],
    }),
    { query: "docs", limit: 10, domains: ["example.com"] },
  );
  for (const value of [
    null,
    [],
    {},
    { query: " " },
    { query: "x\nsecret" },
    { query: "x".repeat(1001) },
    { query: "docs", limit: null },
    { query: "docs", limit: "10" },
    { query: "docs", limit: 21 },
    { query: "docs", limit: 1.5 },
    { query: "docs", language: "en&format=html" },
    { query: "docs", timeRange: "week" },
    { query: "docs", domains: ["https://example.com"] },
    { query: "docs", domains: Array(6).fill("example.com") },
    { query: "docs", tenantId: "other" },
    { query: "docs", url: "http://localhost" },
  ])
    assert.throws(() => parseWebSearchInput(value), WebSearchInputError);
});

test("citation URLs exclude unsafe schemes, credentials and literal private addresses", () => {
  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "https://name:secret@example.com",
    "http://localhost/x",
    "http://test.local",
    "http://test.internal",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://10.0.0.1",
    "http://169.254.169.254",
    "http://100.64.0.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[fe80::1]",
    "https://example.com:444",
    "https://example.com/\nsecret",
    "https://example.com/" + "é".repeat(500),
  ])
    assert.equal(resultUrl(value), null, value);
  assert.equal(
    resultUrl("https://EXAMPLE.com:443/docs#section")?.href,
    "https://example.com/docs",
  );
  assert.equal(
    resultUrl("https://example.com./docs")?.href,
    "https://example.com/docs",
  );
});

test("SearXNG normalization preserves ranking, bounds text, removes duplicates and reports partial search", async (t) => {
  let requested: URL | undefined;
  const base = await listen(t, (req, res) => {
    requested = new URL(req.url!, "http://fixture");
    json(res, {
      results: [
        { url: "javascript:alert(1)", title: "bad" },
        {
          url: "https://example.com/a#section",
          title: "<b>Docs &amp; API</b>",
          content: "<em>Clean</em> &#x1F680; &#39;text&#39;",
          engines: ["bing", "bing", "duckduckgo"],
        },
        { url: "https://example.com/a", title: "duplicate" },
        {
          url: "https://example.com/b",
          title: "x".repeat(2000),
          content: "y".repeat(4000),
          engine: "bing",
        },
        { url: "https://example.com/c", title: "third" },
      ],
      unresponsive_engines: [["brave", "raw-private-backend-error"]],
      raw: "secret-config",
    });
  });
  const result = await new SearxngSearch({ url: base }).search(
    parseWebSearchInput({
      query: "current API",
      limit: 2,
      language: "en-US",
      timeRange: "month",
    }),
  );
  assert.equal(requested?.pathname, "/search");
  assert.equal(requested?.searchParams.get("format"), "json");
  assert.equal(requested?.searchParams.get("q"), "current API");
  assert.equal(requested?.searchParams.get("time_range"), "month");
  assert.equal(requested?.searchParams.get("language"), "en-US");
  assert.deepEqual(
    result.results.map((r) => r.url),
    ["https://example.com/a", "https://example.com/b"],
  );
  assert.equal(result.results[0].title, "Docs & API");
  assert.equal(result.results[0].snippet, "Clean 🚀 'text'");
  assert.deepEqual(result.results[0].engines, ["bing", "duckduckgo"]);
  assert.equal(result.results[1].title.length, 300);
  assert.equal(result.results[1].snippet.length, 1500);
  assert.equal(result.warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /raw-private|secret-config/);
});

test("domain filters are enforced on returned hostnames and fewer matches are disclosed", async (t) => {
  const base = await listen(t, (_req, res) =>
    json(res, {
      results: [
        { url: "https://example.com/a" },
        { url: "https://docs.example.com/b" },
        { url: "https://evilexample.com/x" },
        { url: "https://example.com.attacker.org/y" },
      ],
    }),
  );
  const result = await new SearxngSearch({ url: base }).search(
    parseWebSearchInput({ query: "docs", domains: ["example.com"] }),
  );
  assert.equal(result.results.length, 2);
  assert.ok(result.warnings.some((w) => w.includes("Domain filtering")));
});

test("zero results succeeds without inventing sources", async (t) => {
  const base = await listen(t, (_req, res) => json(res, { results: [] }));
  const result = await new SearxngSearch({ url: base }).search(
    parseWebSearchInput({ query: "not found" }),
  );
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.warnings, []);
});

test("upstream HTTP failures, invalid JSON and oversized bodies return safe typed failures", async (t) => {
  for (const [status, body, code] of [
    [403, "private-diagnostic", "SEARCH_CONFIGURATION"],
    [429, "private-diagnostic", "SEARCH_RATE_LIMITED"],
    [500, "private-diagnostic", "SEARCH_UNAVAILABLE"],
    [200, "not json", "SEARCH_RESPONSE_INVALID"],
    [200, JSON.stringify({ html: "x" }), "SEARCH_RESPONSE_INVALID"],
    [
      200,
      JSON.stringify({ results: [], excess: "x".repeat(1024 * 1024) }),
      "SEARCH_RESPONSE_INVALID",
    ],
  ] as const) {
    await t.test(String(status) + " " + code + " " + body.length, async (t) => {
      const base = await listen(t, (_req, res) =>
        res.writeHead(status).end(body),
      );
      await assert.rejects(
        new SearxngSearch({ url: base }).search(
          parseWebSearchInput({ query: "docs" }),
        ),
        (error: any) =>
          error.code === code && !error.message.includes("private-diagnostic"),
      );
    });
  }
});

test("deadline covers slow response bodies, and explicit cancellation stops the fetch", async (t) => {
  const base = await listen(t, (_req, res) => {
    res.writeHead(200);
    res.write('{"results":[');
  });
  await assert.rejects(
    new SearxngSearch({ url: base, timeoutMs: 50 }).search(
      parseWebSearchInput({ query: "docs" }),
    ),
    { code: "SEARCH_TIMEOUT" },
  );
  const controller = new AbortController();
  const search = new SearxngSearch({ url: base }).search(
    parseWebSearchInput({ query: "docs" }),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(search, { code: "SEARCH_CANCELLED" });
});

test("readiness probes current /config schema instead of assuming a formats field", async (t) => {
  const base = await listen(t, (req, res) =>
    req.url === "/config"
      ? json(res, { version: "fixture", engines: [{ name: "bing" }] })
      : res.writeHead(404).end(),
  );
  assert.equal(await new SearxngSearch({ url: base }).ready(), true);
});

test("concurrent readiness probes share one upstream request", async (t) => {
  let probes = 0;
  const base = await listen(t, (_req, res) => {
    probes++;
    setTimeout(() => json(res, { version: "fixture", engines: [] }), 20);
  });
  const search = new SearxngSearch({ url: base });
  assert.deepEqual(
    await Promise.all(Array.from({ length: 10 }, () => search.ready())),
    Array(10).fill(true),
  );
  assert.equal(probes, 1);
});

test("upstream redirects are not followed", async (t) => {
  let hits = 0;
  const target = await listen(t, (_req, res) => {
    hits++;
    json(res, { results: [] });
  });
  const base = await listen(t, (_req, res) =>
    res.writeHead(302, { Location: target }).end(),
  );
  await assert.rejects(
    new SearxngSearch({ url: base }).search(
      parseWebSearchInput({ query: "docs" }),
    ),
    { code: "SEARCH_UNAVAILABLE" },
  );
  assert.equal(hits, 0);
});

test("HTTP service authenticates before body parsing and never forwards unsupported arguments", async (t) => {
  let hits = 0;
  const vendor = await listen(t, (_req, res) => {
    hits++;
    json(res, { results: [{ url: "https://example.com" }] });
  });
  const service = createWebService(new SearxngSearch({ url: vendor }), token);
  const base = await listen(t, service.app);
  const request = (body: string, auth?: string) =>
    fetch(base + "/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
      },
      body,
    });
  assert.equal((await request("not json")).status, 401);
  assert.equal(
    (
      await request(
        JSON.stringify({ query: "docs", url: "http://localhost" }),
        `Bearer ${token}`,
      )
    ).status,
    400,
  );
  assert.equal((await request("not json", `Bearer ${token}`)).status, 400);
  assert.equal(
    (
      await request(
        JSON.stringify({ query: "x".repeat(9000) }),
        `Bearer ${token}`,
      )
    ).status,
    413,
  );
  assert.equal(hits, 0);
  const response = await request(
    JSON.stringify({ query: "docs" }),
    `Bearer ${token}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).results[0].url, "https://example.com/");
  assert.equal(hits, 1);
});

test("service rejects saturation, aborts upstream work on disconnect and stops admission while draining", async (t) => {
  let started!: () => void;
  let disconnected!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const vendor = await listen(t, (_req, res) => {
    res.on("close", disconnected);
    res.writeHead(200);
    res.write('{"results":[');
    started();
  });
  const service = createWebService(
    new SearxngSearch({ url: vendor }),
    token,
    1,
  );
  const base = await listen(t, service.app);
  const controller = new AbortController();
  const request = (signal?: AbortSignal) =>
    fetch(base + "/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: "docs" }),
      signal,
    });
  const pending = request(controller.signal).catch(() => null);
  await waiting;
  const busy = await request();
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).code, "SEARCH_RATE_LIMITED");
  controller.abort();
  await pending;
  await Promise.race([
    closed,
    new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Upstream did not disconnect")),
        1000,
      );
      timer.unref();
    }),
  ]);
  service.drain();
  assert.equal((await request()).status, 503);
  assert.equal((await fetch(base + "/ready")).status, 503);
});
