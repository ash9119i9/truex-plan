import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run the actual service entrypoint: a route typo must fail at the HTTP boundary.
test(
  "core HTTP crawl status and results paths match the platform API and carry trusted scope",
  { timeout: 15000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "crawl-http-")),
      token = "h".repeat(32),
      threadId = "root_1",
      jobId = "11111111-1111-4111-8111-111111111111";
    const job = {
      provider: "crawlee",
      jobId,
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
        maxBytes: 10485760,
        maxFrontier: 1000,
      },
      counts: {
        discovered: 1,
        attempted: 1,
        attempts: 1,
        succeeded: 1,
        failed: 0,
        pending: 0,
        storedBytes: 12,
      },
      warnings: [],
    };
    const page = {
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
    const downstream: string[] = [];
    const service = createServer((req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.headers["x-truex-tenant-id"], "acme");
      assert.equal(req.headers["x-truex-session-id"], threadId);
      downstream.push(`${req.method} ${req.url}`);
      const result =
        req.url === "/crawl/jobs"
          ? { jobs: [job] }
          : req.url?.includes("/results")
            ? {
                job,
                pages: [page],
                failures: [],
                offset: 0,
                nextOffset: null,
                totalPages: 1,
              }
            : req.url?.endsWith("/cancel")
              ? { ...job, state: "cancelled", reason: "cancelled" }
              : job;
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
    });
    await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
    const serviceUrl = `http://127.0.0.1:${(service.address() as any).port}`;
    const reservation = createServer();
    await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
    const port = (reservation.address() as any).port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const markerDir = join(home, "business-v1", "business-threads"),
      cwd = join(home, "workspace");
    mkdirSync(markerDir, { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      join(markerDir, threadId + ".json"),
      JSON.stringify({
        cwd,
        tenantId: "acme",
        webCrawlTools: 1,
        webCrawlEnabled: false,
        crawlSessionId: threadId,
      }),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: resolve("."),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        CODEX_HOME: home,
        PROJECT_ROOT: resolve(".."),
        WEB_SEARCH: "",
        WEB_READ: "",
        WEB_CRAWL: "on",
        WEB_SERVICE_URL: serviceUrl,
        WEB_SERVICE_TOKEN: token,
        DRAIN_TIMEOUT_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(async () => {
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        if (child.exitCode !== null) r();
        else {
          child.once("exit", () => r());
          setTimeout(() => {
            child.kill("SIGKILL");
            r();
          }, 1500).unref();
        }
      });
      service.closeAllConnections();
      await new Promise<void>((r) => service.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    });
    await new Promise<void>((r, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Core HTTP fixture did not start")),
        5000,
      );
      child.stderr.on("data", (chunk) => {
        if (String(chunk).includes("agent-core listening")) {
          clearTimeout(timeout);
          r();
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Core HTTP fixture exited before listening"));
      });
    });
    const base = `http://127.0.0.1:${port}/threads/${threadId}/crawls`;
    const list = await fetch(base);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { jobs: [job] });
    const status = await fetch(`${base}/${jobId}`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), job);
    const result = await fetch(
      `${base}/${jobId}/results?offset=0&limit=1&maxChars=12`,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      job,
      pages: [page],
      failures: [],
      offset: 0,
      nextOffset: null,
      totalPages: 1,
    });
    const cancel = await fetch(`${base}/${jobId}/cancel`, { method: "POST" });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).state, "cancelled");
    assert.deepEqual(downstream, [
      "GET /crawl/jobs",
      `GET /crawl/jobs/${jobId}`,
      `GET /crawl/jobs/${jobId}/results?offset=0&limit=1&maxChars=12`,
      `POST /crawl/jobs/${jobId}/cancel`,
    ]);
    for (const query of [
      "limit=1&limit=2",
      "limit=01",
      "tenantId=victim",
      "maxChars=50001",
    ]) {
      const invalid = await fetch(`${base}/${jobId}/results?${query}`);
      assert.equal(invalid.status, 400);
    }
    assert.equal(
      downstream.length,
      4,
      "invalid query never reaches the crawl service",
    );
  },
);
