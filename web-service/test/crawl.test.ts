import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CrawlJobs, parseCrawlInput } from "../src/crawl";
import {
  ReadError,
  type CrawlPageReader,
  type CrawlPage,
} from "../src/crawl4ai";
import { createWebService } from "../src/server";
import type { SearxngSearch } from "../src/searxng";
const owner = { tenantId: "tenant", sessionId: "session" };
const page = (
  url: string,
  links: string[] = [],
  markdown = "Content",
): CrawlPage => ({
  provider: "crawl4ai",
  requestedUrl: url,
  url,
  title: "Fixture",
  retrievedAt: new Date().toISOString(),
  statusCode: 200,
  markdown,
  totalChars: markdown.length,
  truncated: false,
  warnings: [],
  links,
});
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "webcrawl-"));
async function until<T>(
  fn: () => Promise<T> | T,
  predicate: (v: T) => boolean,
  ms = 15000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Condition not reached");
}
async function done(jobs: CrawlJobs, id: string) {
  return until(
    () => jobs.status(owner, id),
    (v) => ["completed", "partial", "failed", "cancelled"].includes(v.state),
  );
}

test("real BasicCrawler queue walks same-host DOM frontier once, removes cycles/fragments/binary/private links and respects depth", async () => {
  const root = await tmp(),
    calls: string[] = [];
  const graph: Record<string, string[]> = {
    "https://example.com/": [
      "https://example.com/a#one",
      "https://example.com/a#two",
      "https://other.com/x",
      "http://127.0.0.1/",
      "https://example.com/file.pdf",
      "https://u:p@example.com/",
    ],
    "https://example.com/a": ["https://example.com/", "https://example.com/b"],
    "https://example.com/b": ["https://example.com/c"],
  };
  const jobs = await CrawlJobs.open(root, {
    ready: async () => true,
    crawlPage: async (i) => {
      calls.push(i.url);
      return page(i.url, graph[i.url]);
    },
  });
  try {
    const job = await jobs.start(
      owner,
      parseCrawlInput({ url: "https://example.com/", maxDepth: 2 }),
      "key",
    );
    const final = await done(jobs, job.jobId);
    assert.deepEqual(calls, [
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
    ]);
    assert.equal(final.reason, "depth_limit");
    assert.equal(final.state, "partial");
    assert.equal(final.counts.succeeded, 3);
    const result = await jobs.results(owner, job.jobId, 0, 10, 5);
    assert.equal(
      result.pages.reduce((n, p) => n + p.markdown.length, 0),
      5,
    );
    assert.equal(result.pages[0].sourceId.length, 29);
    assert.equal(result.nextOffset, 1);
    assert.equal("links" in result.pages[0], false);
    assert.equal("provider" in result.pages[0], false);
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("durable page admission prevents page and attempt overshoot; retries only transient safe errors", async () => {
  const root = await tmp(),
    calls: string[] = [];
  const jobs = await CrawlJobs.open(root, {
    ready: async () => true,
    crawlPage: async (i) => {
      calls.push(i.url);
      if (i.url.endsWith("/bad")) throw new ReadError(403, "READ_BLOCKED");
      if (i.url.endsWith("/retry"))
        throw new ReadError(504, "READ_TIMEOUT", true);
      return page(i.url, [
        "https://example.com/bad",
        "https://example.com/retry",
        "https://example.com/excess",
      ]);
    },
  });
  try {
    const job = await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 3, maxDepth: 2 },
      "key",
    );
    const final = await done(jobs, job.jobId);
    assert.equal(final.reason, "page_limit");
    assert.equal(final.counts.attempted, 3);
    assert.equal(final.counts.attempts, 5);
    assert.equal(final.counts.failed, 2);
    assert.equal(calls.filter((u) => u.endsWith("/bad")).length, 1);
    assert.equal(calls.filter((u) => u.endsWith("/retry")).length, 3);
    assert.equal(calls.includes("https://example.com/excess"), false);
    const result = await jobs.results(owner, job.jobId, 0, 10, 100);
    assert.deepEqual(
      result.failures.map((f) => f.code),
      ["READ_BLOCKED", "READ_TIMEOUT"],
    );
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("cancel aborts browser and keeps saved pages; idempotency and owner isolation survive restart", async () => {
  const root = await tmp();
  let started!: () => void;
  const inflight = new Promise<void>((r) => (started = r));
  let aborted = false;
  const reader: CrawlPageReader = {
    ready: async () => true,
    crawlPage: async (i, _h, signal) => {
      if (i.url.endsWith("/slow")) {
        started();
        await new Promise((_, reject) =>
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new ReadError(499, "READ_CANCELLED"));
            },
            { once: true },
          ),
        );
      }
      return page(i.url, ["https://example.com/slow"]);
    },
  };
  let jobs = await CrawlJobs.open(root, reader);
  try {
    const input = { url: "https://example.com/", maxPages: 4, maxDepth: 2 };
    const job = await jobs.start(owner, input, "key");
    await inflight;
    assert.equal((await jobs.start(owner, input, "key")).jobId, job.jobId);
    await assert.rejects(
      () => jobs.start(owner, { ...input, maxPages: 5 }, "key"),
      { status: 409 },
    );
    assert.throws(
      () => jobs.status({ ...owner, sessionId: "foreign" }, job.jobId),
      { status: 404 },
    );
    assert.throws(
      () => jobs.status({ ...owner, tenantId: "foreign" }, job.jobId),
      { status: 404 },
    );
    await jobs.cancel(owner, job.jobId);
    const final = await done(jobs, job.jobId);
    assert.equal(final.state, "cancelled");
    assert.equal(aborted, true);
    assert.equal(final.counts.succeeded, 1);
    await jobs.close();
    jobs = await CrawlJobs.open(root, reader);
    assert.equal((await jobs.start(owner, input, "key")).jobId, job.jobId);
    assert.equal(jobs.status(owner, job.jobId).state, "cancelled");
    assert.equal(
      (await jobs.results(owner, job.jobId, 0, 10, 100)).pages.length,
      1,
    );
    await jobs.purge(owner);
    assert.deepEqual(jobs.list(owner), { jobs: [] });
    assert.throws(() => jobs.status(owner, job.jobId), { status: 404 });
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("OS advisory lock rejects second writer; seven day startup cleanup purges expired jobs", async () => {
  const root = await tmp();
  let now = Date.now();
  const reader = {
    ready: async () => true,
    crawlPage: async (i: { url: string }) => page(i.url),
  };
  let jobs = await CrawlJobs.open(root, reader, () => now);
  try {
    await assert.rejects(
      () => CrawlJobs.open(root, reader),
      /storage already owned/,
    );
    const job = await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 1, maxDepth: 0 },
      "key",
    );
    await done(jobs, job.jobId);
    await jobs.close();
    now += 7 * 24 * 3600000 + 1;
    jobs = await CrawlJobs.open(root, reader, () => now);
    assert.deepEqual(jobs.list(owner), { jobs: [] });
    assert.deepEqual(await fs.readdir(path.join(root, "jobs")), []);
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("deadline and frontier stop work without fetching omitted URLs", async () => {
  const root = await tmp();
  let now = Date.now(),
    calls = 0;
  const jobs = await CrawlJobs.open(
    root,
    {
      ready: async () => true,
      crawlPage: async (i) => {
        calls++;
        now += 300001;
        return page(
          i.url,
          Array.from(
            { length: 1010 },
            (_, n) => `https://example.com/page-${n}`,
          ),
        );
      },
    },
    () => now,
  );
  try {
    const job = await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 100, maxDepth: 3 },
      "key",
    );
    const final = await done(jobs, job.jobId);
    assert.equal(final.reason, "deadline");
    assert.equal(final.counts.discovered, 1000);
    assert.equal(calls, 1);
    assert.ok(final.counts.attempts <= 300);
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("actual worker SIGKILL mid-page and fresh restart retains pages and frontier without duplicate results", async () => {
  const root = await tmp(),
    fixture = await tmp();
  const launch = (phase: string) =>
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(__dirname, "crawl-process.ts"),
        root,
        fixture,
        phase,
      ],
      { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
  const first = launch("first");
  let stderr = "";
  first.stderr.on("data", (d) => (stderr += d));
  let second: ReturnType<typeof launch> | undefined;
  try {
    await until(
      async () =>
        fs.access(path.join(fixture, "in-flight")).then(
          () => true,
          () => false,
        ),
      Boolean,
    );
    first.kill("SIGKILL");
    await new Promise((r) => first.once("exit", r));
    second = launch("second");
    second.stderr.on("data", (d) => (stderr += d));
    const exit = new Promise((r) => second!.once("exit", r));
    await until(
      async () =>
        fs.access(path.join(fixture, "result")).then(
          () => true,
          () => false,
        ),
      Boolean,
    );
    await exit;
    assert.equal(second.exitCode, 0, stderr);
    const result = JSON.parse(
      await fs.readFile(path.join(fixture, "result"), "utf8"),
    );
    assert.equal(result.job.state, "completed");
    assert.equal(result.pages.length, 3);
    assert.equal(new Set(result.pages.map((p: any) => p.requestedUrl)).size, 3);
    assert.equal(result.job.counts.attempts, 4);
    const calls = (await fs.readFile(path.join(fixture, "fetches"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(calls.filter((u) => u === "https://example.com/").length, 1);
    assert.equal(calls.filter((u) => u.endsWith("/slow")).length, 2);
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
test("HTTP auth precedes parsing; tenant/session identity, bounded results and independent readiness", async () => {
  const root = await tmp();
  const jobs = await CrawlJobs.open(root, {
    ready: async () => true,
    crawlPage: async (i) => page(i.url),
  });
  const service = createWebService(
    { ready: async () => true } as SearxngSearch,
    "x".repeat(40),
    4,
    undefined,
    2,
    jobs,
  );
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`,
    headers = {
      Authorization: `Bearer ${"x".repeat(40)}`,
      "Content-Type": "application/json",
      "x-truex-tenant-id": "tenant",
      "x-truex-session-id": "session",
      "x-truex-idempotency-key": "key",
    };
  try {
    assert.equal(
      (await fetch(url + "/crawl/jobs", { method: "POST", body: "{" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(url + "/crawl/jobs", {
          method: "POST",
          headers: {
            Authorization: headers.Authorization,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      400,
    );
    const r = await fetch(url + "/crawl/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    assert.equal(r.status, 202);
    const job = (await r.json()) as any;
    await done(jobs, job.jobId);
    assert.equal(
      (
        await fetch(url + `/crawl/jobs/${job.jobId}`, {
          headers: { ...headers, "x-truex-session-id": "foreign" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(url + `/crawl/jobs/${job.jobId}/results?limit=11`, {
          headers,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + `/crawl/jobs/${job.jobId}/results?maxChars=50001`, {
          headers,
        })
      ).status,
      400,
    );
    assert.equal((await fetch(url + "/ready")).status, 200);
    assert.equal((await fetch(url + "/read/ready")).status, 503);
    assert.equal((await fetch(url + "/crawl/ready")).status, 200);
  } finally {
    await service.drain();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("redirect aliases produce one final snapshot and final URL links are not fetched twice", async () => {
  const root = await tmp(),
    calls: string[] = [];
  const jobs = await CrawlJobs.open(root, {
    ready: async () => true,
    crawlPage: async (i) => {
      calls.push(i.url);
      return {
        ...page(
          i.url,
          i.url.endsWith("/")
            ? ["https://example.com/canonical", "https://example.com/alias"]
            : [],
        ),
        url: "https://example.com/canonical",
      };
    },
  });
  try {
    const job = await jobs.start(
      owner,
      { url: "http://example.com/", maxPages: 5, maxDepth: 2 },
      "key",
    );
    await done(jobs, job.jobId);
    const result = await jobs.results(owner, job.jobId, 0, 10, 50000);
    assert.equal(result.pages.length, 1);
    assert.equal(result.job.counts.attempted, 2);
    assert.deepEqual(calls, [
      "http://example.com/",
      "https://example.com/alias",
    ]);
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("10MB stored Markdown limit is admitted before saving an oversized next page", async () => {
  const root = await tmp(),
    links = Array.from({ length: 99 }, (_, n) => `https://example.com/p-${n}`);
  const jobs = await CrawlJobs.open(root, {
    ready: async () => true,
    crawlPage: async (i) =>
      page(i.url, i.url.endsWith("/") ? links : [], "€".repeat(50000)),
  });
  try {
    const job = await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 100, maxDepth: 1 },
      "key",
    );
    const final = await done(jobs, job.jobId);
    assert.equal(final.reason, "byte_limit");
    assert.equal(final.state, "partial");
    assert.ok(final.counts.storedBytes <= 10 * 1024 * 1024);
    assert.equal(final.counts.succeeded, 69);
    assert.equal(final.counts.attempted, 70);
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("UTF16 result budget never splits an astral code point", async () => {
  const root = await tmp(),
    jobs = await CrawlJobs.open(root, {
      ready: async () => true,
      crawlPage: async (i) => page(i.url, [], "a😀z"),
    });
  try {
    const job = await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 1, maxDepth: 0 },
      "key",
    );
    await done(jobs, job.jobId);
    const result = await jobs.results(owner, job.jobId, 0, 1, 2);
    assert.equal(result.pages[0].markdown, "a");
    assert.equal(result.pages[0].truncated, true);
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an insufficient UTF16 budget returns a safe argument error instead of a nonprogress cursor", async () => {
  const root = await tmp(),
    jobs = await CrawlJobs.open(root, {
      ready: async () => true,
      crawlPage: async (i) => page(i.url, [], "😀x"),
    });
  try {
    const job = await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 1, maxDepth: 0 },
      "key",
    );
    await done(jobs, job.jobId);
    await assert.rejects(() => jobs.results(owner, job.jobId, 0, 1, 1), {
      status: 400,
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unexpected advisory helper exit fences admission and aborts the active fetch", async () => {
  const root = await tmp();
  let started!: () => void,
    aborted = false;
  const inflight = new Promise<void>((r) => (started = r));
  const jobs = await CrawlJobs.open(root, {
    ready: async () => true,
    crawlPage: async (_i, _h, signal) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new ReadError(499, "READ_CANCELLED"));
          },
          { once: true },
        ),
      );
      throw new Error();
    },
  });
  try {
    await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 1, maxDepth: 0 },
      "key",
    );
    await inflight;
    (jobs as any).lock.kill("SIGKILL");
    await until(() => aborted, Boolean);
    assert.equal(await jobs.ready(), false);
    await assert.rejects(
      () =>
        jobs.start(
          owner,
          { url: "https://example.com/", maxPages: 1, maxDepth: 0 },
          "second",
        ),
      { status: 503 },
    );
    await assert.rejects(() => jobs.purge(owner), { status: 503 });
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("startup removes unacknowledged starts and unfinished atomic files", async () => {
  const root = await tmp(),
    reader = {
      ready: async () => true,
      crawlPage: async (i: { url: string }) => page(i.url),
    };
  let jobs = await CrawlJobs.open(root, reader);
  try {
    const job = await jobs.start(
      owner,
      { url: "https://example.com/", maxPages: 1, maxDepth: 0 },
      "key",
    );
    await done(jobs, job.jobId);
    await jobs.close();
    const orphan = "00000000-0000-0000-0000-000000000000";
    await fs.mkdir(path.join(root, "jobs", orphan, "pages"), {
      recursive: true,
    });
    const partial = path.join(
      root,
      "jobs",
      job.jobId,
      "manifest.json.00000000-0000-0000-0000-000000000000.tmp",
    );
    await fs.writeFile(partial, "partial");
    jobs = await CrawlJobs.open(root, reader);
    assert.equal(jobs.list(owner).jobs.length, 1);
    assert.equal(
      await fs.access(partial).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await fs.access(path.join(root, "jobs", orphan)).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await jobs.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
