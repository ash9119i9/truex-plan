import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { parseWebReadInput } from "../../shared/web-read";
import { Crawl4aiRead, ReadError } from "../src/crawl4ai";
import { SearxngSearch } from "../src/searxng";
import { createWebService } from "../src/server";

const token = "reader-fixture-token-".padEnd(40, "x");
const resolver = async () => [{ address: "93.184.215.14", family: 4 }];
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
const payload = (extra = {}) => ({
  provider: "crawl4ai",
  requestedUrl: "https://example.com/",
  url: "https://example.com/final",
  title: "Example",
  retrievedAt: new Date().toISOString(),
  statusCode: 200,
  markdown: "# Hello\n\n🌍 page",
  truncated: false,
  totalChars: "# Hello\n\n🌍 page".length,
  warnings: [],
  ...extra,
});
function json(
  res: Parameters<RequestListener>[1],
  value: unknown,
  status = 200,
) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(value));
}

test("read adapter sends only narrow inputs and returns final URL + bounded normalized metadata", async (t) => {
  let seen: any;
  const base = await listen(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen = JSON.parse(raw);
      json(
        res,
        payload({
          title: "<b>Example</b>\u0000" + "x".repeat(400),
          extra: "private diagnostic",
          warnings: ["a".repeat(400), "b", "c", "d", "e", "f"],
        }),
      );
    });
  });
  const result = await new Crawl4aiRead({ url: base, token, resolver }).read(
    parseWebReadInput({ url: "https://example.com/#hash" }),
  );
  assert.deepEqual(seen, { url: "https://example.com/", maxChars: 20000 });
  assert.equal(result.url, "https://example.com/final");
  assert.equal(result.title.length, 300);
  assert.equal(result.warnings.length, 5);
  assert.equal(result.warnings[0].length, 300);
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic|\u0000/);
});

test("adapter distinguishes safe provider failures and rejects invalid or unbounded results", async (t) => {
  for (const [status, value, code] of [
    [401, { error: "secret" }, "READ_CONFIGURATION"],
    [429, { error: "secret" }, "READ_RATE_LIMITED"],
    [500, { error: "secret" }, "READ_UNAVAILABLE"],
    [403, { code: "READ_BLOCKED" }, "READ_BLOCKED"],
    [404, { code: "READ_NOT_FOUND" }, "READ_NOT_FOUND"],
    [415, { code: "READ_UNSUPPORTED" }, "READ_UNSUPPORTED"],
    [200, payload({ markdown: "" }), "READ_RESPONSE_INVALID"],
    [200, payload({ url: "http://127.0.0.1/" }), "READ_RESPONSE_INVALID"],
    [200, payload({ totalChars: 3 }), "READ_RESPONSE_INVALID"],
    [200, payload({ totalChars: 3 * 1024 * 1024 }), "READ_RESPONSE_INVALID"],
    [
      200,
      payload({ markdown: "x".repeat(50001), totalChars: 50001 }),
      "READ_RESPONSE_INVALID",
    ],
    [200, payload({ statusCode: 301 }), "READ_RESPONSE_INVALID"],
    [
      200,
      payload({ excess: "x".repeat(4 * 1024 * 1024) }),
      "READ_RESPONSE_INVALID",
    ],
  ] as const) {
    await t.test(`${status} ${code}`, async (t) => {
      const base = await listen(t, (_req, res) => json(res, value, status));
      await assert.rejects(
        new Crawl4aiRead({ url: base, token, resolver }).read(
          parseWebReadInput({ url: "https://example.com" }),
        ),
        (error: any) =>
          error.code === code && !error.message.includes("secret"),
      );
    });
  }
});

test("unsafe literal and mixed public/private DNS destinations never reach adapter upstream", async (t) => {
  let hits = 0;
  const base = await listen(t, (_req, res) => {
    hits++;
    json(res, payload());
  });
  for (const url of [
    "http://127.0.0.1",
    "http://[::ffff:8.8.8.8]",
    "http://192.0.2.1",
  ]) {
    await assert.rejects(
      new Crawl4aiRead({ url: base, token, resolver }).read(
        parseWebReadInput({ url }),
      ),
      { code: "READ_BLOCKED" },
    );
  }
  const mixed = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "::1", family: 6 },
  ];
  await assert.rejects(
    new Crawl4aiRead({ url: base, token, resolver: mixed }).read(
      parseWebReadInput({ url: "https://example.com" }),
    ),
    { code: "READ_BLOCKED" },
  );
  assert.equal(hits, 0);
});

test("deadline and cancellation cover hanging DNS and slow provider response bodies", async (t) => {
  const base = await listen(t, (_req, res) => {
    res.writeHead(200);
    res.write('{"provider":');
  });
  const input = parseWebReadInput({ url: "https://example.com" });
  for (const resolve of [resolver, async () => new Promise<never>(() => {})]) {
    await assert.rejects(
      new Crawl4aiRead({
        url: base,
        token,
        timeoutMs: 40,
        resolver: resolve,
      }).read(input),
      { code: "READ_TIMEOUT" },
    );
    const abort = new AbortController();
    const pending = new Crawl4aiRead({
      url: base,
      token,
      resolver: resolve,
    }).read(input, abort.signal);
    setTimeout(() => abort.abort(), 10);
    await assert.rejects(pending, { code: "READ_CANCELLED" });
  }
});

test("unconfigured Read and failed read readiness leave Search available; auth precedes read JSON", async (t) => {
  const vendor = await listen(t, (req, res) =>
    json(
      res,
      req.url === "/config"
        ? { version: "fixture", engines: [] }
        : { results: [] },
    ),
  );
  const reader = new Crawl4aiRead({});
  const service = createWebService(
    new SearxngSearch({ url: vendor }),
    token,
    4,
    reader,
  );
  const base = await listen(t, service.app);
  assert.equal((await fetch(base + "/ready")).status, 200);
  assert.equal((await fetch(base + "/read/ready")).status, 503);
  const send = (body: string, authorization?: string) =>
    fetch(base + "/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body,
    });
  assert.equal((await send("not json")).status, 401);
  assert.equal((await send("not json", `Bearer ${token}`)).status, 400);
  assert.equal(
    (
      await send(
        JSON.stringify({ url: "https://example.com", js_code: "alert(1)" }),
        `Bearer ${token}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await send(
        JSON.stringify({ url: "https://example.com" }),
        `Bearer ${token}`,
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await fetch(base + "/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "docs" }),
      })
    ).status,
    200,
  );
});

test("read capacity is independent of search, and client disconnect/drain cancel admitted reads", async (t) => {
  let started!: () => void, cancelled!: () => void;
  let waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let stopped = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const reader = {
    ready: async () => true,
    read: async (_input: any, signal?: AbortSignal): Promise<never> => {
      started();
      return new Promise((_, reject) =>
        signal!.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(new ReadError(499, "READ_CANCELLED"));
          },
          { once: true },
        ),
      );
    },
  };
  const vendor = await listen(t, (req, res) =>
    json(
      res,
      req.url === "/config"
        ? { version: "fixture", engines: [] }
        : { results: [] },
    ),
  );
  const service = createWebService(
    new SearxngSearch({ url: vendor }),
    token,
    1,
    reader,
    1,
  );
  const base = await listen(t, service.app);
  const read = (signal?: AbortSignal) =>
    fetch(base + "/read", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com" }),
      signal,
    });
  const abort = new AbortController();
  const pending = read(abort.signal).catch(() => null);
  await waiting;
  const busy = await read();
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).code, "READ_RATE_LIMITED");
  assert.equal(
    (
      await fetch(base + "/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "docs" }),
      })
    ).status,
    200,
  );
  abort.abort();
  await pending;
  await stopped;
  waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  stopped = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const admitted = read();
  await waiting;
  service.drain();
  await stopped;
  assert.equal((await admitted).status, 499);
  assert.equal((await read()).status, 503);
  assert.equal((await fetch(base + "/read/ready")).status, 503);
});

test("private crawl adapter sends only server-owned host and returns actual normalized DOM links", async (t) => {
  let seen: any;
  const base = await listen(t, (req, res) => {
    assert.equal(req.url, "/crawl-page");
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen = JSON.parse(raw);
      json(
        res,
        payload({
          links: [
            "https://example.com/a#first",
            "https://example.com/a#second",
          ],
        }),
      );
    });
  });
  const result = await new Crawl4aiRead({
    url: base,
    token,
    resolver,
  }).crawlPage({ url: "https://example.com/", maxChars: 20000 }, "example.com");
  assert.deepEqual(seen, {
    url: "https://example.com/",
    maxChars: 20000,
    allowedHost: "example.com",
  });
  assert.deepEqual(result.links, ["https://example.com/a"]);
});
test("private crawl adapter rejects cross-host redirects and unsafe/unbounded link results", async (t) => {
  for (const value of [
    payload({ url: "https://other.com/final", links: [] }),
    payload({ links: ["https://other.com/"] }),
    payload({ links: ["http://127.0.0.1/"] }),
    payload({ links: Array(1001).fill("https://example.com/") }),
    payload({ links: ["javascript:alert(1)"] }),
  ]) {
    const base = await listen(t, (_req, res) => json(res, value));
    await assert.rejects(
      new Crawl4aiRead({ url: base, token, resolver }).crawlPage(
        { url: "https://example.com/", maxChars: 20000 },
        "example.com",
      ),
      { code: "READ_RESPONSE_INVALID" },
    );
  }
});
