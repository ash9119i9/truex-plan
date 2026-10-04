import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { WebCrawlTools, webCrawlFromEnv } from "../src/web-crawl";
import { webCrawlLimits, type WebCrawlJob } from "../../shared/web-crawl";

export const crawlJobId = "11111111-1111-4111-8111-111111111111";
export const crawlJob: WebCrawlJob = {
  provider: "crawlee",
  jobId: crawlJobId,
  seedUrl: "https://example.com/",
  state: "running",
  reason: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  expiresAt: "2026-10-11T00:00:00.000Z",
  deadlineAt: "2026-10-04T00:05:00.000Z",
  limits: {
    maxPages: 25,
    maxDepth: 2,
    maxDurationMs: 300000,
    maxBytes: 10 * 1024 * 1024,
    maxFrontier: 1000,
  },
  counts: {
    discovered: 2,
    attempted: 1,
    attempts: 1,
    succeeded: 1,
    failed: 0,
    pending: 1,
    storedBytes: 100,
  },
  warnings: [],
};
export const crawlPage = {
  sourceId: "source_1",
  requestedUrl: "https://example.com/",
  url: "https://example.com/docs",
  title: "Docs",
  retrievedAt: "2026-10-04T00:00:00.000Z",
  statusCode: 200,
  depth: 0,
  markdown: "# Saved page",
  totalChars: 12,
  truncated: false,
};
const results = {
  job: crawlJob,
  pages: [crawlPage],
  failures: [],
  offset: 0,
  nextOffset: null,
  totalPages: 1,
};
const token = "c".repeat(32),
  identity = { tenantId: "acme", sessionId: "root_1" };
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

test("crawl client authenticates trusted scope, normalizes start, and uses stable internal idempotency", async (t) => {
  const keys: string[] = [],
    requests: any[] = [];
  const url = await fixture(t, async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers["x-truex-tenant-id"], "acme");
    assert.equal(req.headers["x-truex-session-id"], "root_1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw && JSON.parse(raw) });
    if (req.method === "POST" && req.url === "/crawl/jobs")
      keys.push(req.headers["x-truex-idempotency-key"] as string);
    res
      .writeHead(200)
      .end(
        JSON.stringify({ ...crawlJob, secret: "hidden", internal: { token } }),
      );
  });
  const client = new WebCrawlTools({ url, token });
  for (const args of [
    { action: "start", url: "https://example.com", tenantId: "other" },
    { action: "start", url: "https://example.com", maxPages: 101 },
    { action: "status", jobId: "bad" },
  ])
    await assert.rejects(client.execute(args, identity, undefined, "call_1"), {
      code: "INVALID_ARGUMENT",
    });
  await assert.rejects(
    client.execute({ action: "start", url: crawlJob.seedUrl }, identity),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(requests.length, 0);
  for (const callId of ["call_1", "call_1", "call_2"])
    assert.deepEqual(
      await client.execute(
        { action: "start", url: "https://example.com/#fragment" },
        identity,
        undefined,
        callId,
      ),
      crawlJob,
    );
  assert.deepEqual(requests[0].body, {
    url: crawlJob.seedUrl,
    maxPages: 25,
    maxDepth: 2,
  });
  assert.match(keys[0], /^[a-f0-9]{64}$/);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.deepEqual(
    await client.execute({ action: "status", jobId: crawlJobId }, identity),
    crawlJob,
  );
});

test("crawl results are aggregate-bounded, provenance checked and strictly projected", async (t) => {
  let payload: any = {
    ...results,
    pages: [{ ...crawlPage, links: ["secret"], secret: "hidden" }],
    secret: "hidden",
  };
  const url = await fixture(t, (req, res) => {
    assert.equal(
      req.url,
      `/crawl/jobs/${crawlJobId}/results?offset=0&limit=3&maxChars=20000`,
    );
    res.writeHead(200).end(JSON.stringify(payload));
  });
  const client = new WebCrawlTools({ url, token });
  assert.deepEqual(
    await client.execute({ action: "results", jobId: crawlJobId }, identity),
    results,
  );
  for (const patch of [
    { job: { ...crawlJob, jobId: "22222222-2222-4222-8222-222222222222" } },
    { pages: [{ ...crawlPage, url: "https://other.example.com/" }] },
    { pages: [{ ...crawlPage, requestedUrl: "http://localhost/" }] },
    { pages: [{ ...crawlPage, statusCode: 404 }] },
    { pages: [{ ...crawlPage, truncated: true }] },
    { pages: [{ ...crawlPage, retrievedAt: "not a date" }] },
    {
      pages: [{ ...crawlPage, markdown: "x".repeat(20001), totalChars: 20001 }],
    },
    { nextOffset: 0 },
    { offset: 1 },
    { totalPages: 2 },
    {
      failures: [
        { url: "https://evil.example.com/", depth: 0, code: "READ_BLOCKED" },
      ],
    },
    { job: { ...crawlJob, counts: { ...crawlJob.counts, attempted: 101 } } },
  ]) {
    payload = { ...results, ...patch };
    await assert.rejects(
      client.execute({ action: "results", jobId: crawlJobId }, identity),
      { code: "CRAWL_RESPONSE_INVALID" },
    );
  }
  payload = {
    ...results,
    pages: [
      crawlPage,
      { ...crawlPage, sourceId: "source_2", url: "https://example.com/next" },
    ],
    job: {
      ...crawlJob,
      counts: {
        ...crawlJob.counts,
        discovered: 2,
        attempted: 2,
        attempts: 2,
        succeeded: 2,
        pending: 0,
      },
    },
    totalPages: 2,
  };
  // Every page individually fits; the whole response budget must still fit.
  const url2 = await fixture(t, (_req, res) =>
    res.writeHead(200).end(JSON.stringify(payload)),
  );
  await assert.rejects(
    new WebCrawlTools({ url: url2, token }).execute(
      { action: "results", jobId: crawlJobId, maxChars: 20 },
      identity,
    ),
    { code: "CRAWL_RESPONSE_INVALID" },
  );
});

test("list, cancel and purge remain scoped and do not expose service errors", async (t) => {
  let status = 200,
    payload: any = { jobs: [{ ...crawlJob, secret: token }] };
  const url = await fixture(t, (req, res) => {
    assert.equal(req.headers["x-truex-session-id"], identity.sessionId);
    res.writeHead(status).end(JSON.stringify(payload));
  });
  const client = new WebCrawlTools({ url, token });
  assert.deepEqual(await client.list(identity), { jobs: [crawlJob] });
  payload = crawlJob;
  assert.deepEqual(
    await client.execute({ action: "cancel", jobId: crawlJobId }, identity),
    crawlJob,
  );
  payload = { ok: true, secret: token };
  assert.deepEqual(await client.purge(identity), { ok: true });
  payload = { ok: false };
  await assert.rejects(client.purge(identity), {
    code: "CRAWL_RESPONSE_INVALID",
  });
  status = 404;
  payload = { code: "CRAWL_NOT_FOUND", message: token };
  await assert.rejects(
    client.execute({ action: "status", jobId: crawlJobId }, identity),
    (e) =>
      (e as any).code === "CRAWL_NOT_FOUND" &&
      !(e as Error).message.includes(token),
  );
  status = 200;
  payload = { jobs: Array(101).fill(crawlJob) };
  await assert.rejects(client.list(identity), {
    code: "CRAWL_RESPONSE_INVALID",
  });
});

test("stream bounds, timeout and caller abort stop only RPC waits", async (t) => {
  const url = await fixture(t, (_req, res) =>
    res.writeHead(200).end("x".repeat(webCrawlLimits.responseBytes + 1)),
  );
  await assert.rejects(
    new WebCrawlTools({ url, token }).execute(
      { action: "status", jobId: crawlJobId },
      identity,
    ),
    { code: "CRAWL_RESPONSE_INVALID" },
  );
  const slow = await fixture(t, () => {});
  await assert.rejects(
    new WebCrawlTools({ url: slow, token, timeoutMs: 20 }).execute(
      { action: "status", jobId: crawlJobId },
      identity,
    ),
    { code: "CRAWL_TIMEOUT" },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new WebCrawlTools({ url: slow, token }).execute(
      { action: "status", jobId: crawlJobId },
      identity,
      controller.signal,
    ),
    (e) =>
      (e as any).code === "CRAWL_CANCELLED" &&
      /background jobs continue/.test((e as Error).message),
  );
});

test("crawl env is independent opt-in and API timeout stays capped", () => {
  assert.equal(webCrawlFromEnv({ WEB_READ: "on", WEB_SEARCH: "on" }), null);
  assert.throws(() => webCrawlFromEnv({ WEB_CRAWL: "on" }), /requires/);
  assert.equal(
    webCrawlFromEnv({
      WEB_CRAWL: " on ",
      WEB_SERVICE_URL: "http://127.0.0.1:4400",
      WEB_SERVICE_TOKEN: token,
    })?.enabled,
    true,
  );
  for (const timeoutMs of [0, -1, 60001, 1.5])
    assert.throws(
      () =>
        new WebCrawlTools({ url: "http://127.0.0.1:4400", token, timeoutMs }),
      /timeout/,
    );
  for (const url of [
    "https://user:secret@example.com",
    "https://example.com/path",
    "ftp://example.com",
  ])
    assert.throws(() => new WebCrawlTools({ url, token }), /configuration/);
});
