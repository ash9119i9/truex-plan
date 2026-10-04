import express, { type ErrorRequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  parseWebSearchInput,
  WebSearchInputError,
} from "../../shared/web-search";
import { SearchError } from "./errors";
import type { SearxngSearch } from "./searxng";
import { parseWebReadInput, WebReadInputError } from "../../shared/web-read";
import { ReadError, type WebReader } from "./crawl4ai";
import {
  CrawlError,
  CrawlJobs,
  parseCrawlInput,
  type CrawlScope,
} from "./crawl";
import {
  WebCrawlInputError,
  parseWebCrawlResultsQuery,
} from "../../shared/web-crawl";

export function createWebService(
  search: SearxngSearch,
  token: string,
  maxConcurrent = 4,
  reader?: WebReader,
  maxReadConcurrent = 2,
  crawls?: CrawlJobs,
) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
    throw new Error(
      "WEB_SERVICE_TOKEN must contain 32–256 URL-safe characters",
    );
  if (
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 100
  )
    throw new Error("Invalid SEARCH_MAX_CONCURRENT");
  if (
    !Number.isInteger(maxReadConcurrent) ||
    maxReadConcurrent < 1 ||
    maxReadConcurrent > 16
  )
    throw new Error("Invalid READ_MAX_CONCURRENT");
  const expected = Buffer.from(`Bearer ${token}`);
  const app = express();
  app.disable("x-powered-by");
  let active = 0;
  let activeReads = 0;
  let draining = false;
  const pending = new Set<AbortController>();
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/ready", async (_req, res) => {
    const ok = !draining && (await search.ready());
    res.status(ok ? 200 : 503).json({ ok });
  });
  app.get("/crawl/ready", async (_req, res) => {
    const ok = !draining && !!crawls && (await crawls.ready());
    res.status(ok ? 200 : 503).json({ ok });
  });
  app.get("/read/ready", async (_req, res) => {
    const ok = !draining && !!reader && (await reader.ready());
    res.status(ok ? 200 : 503).json({ ok });
  });
  // Authenticate before parsing a request body. No queries or credentials in logs.
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const supplied = Buffer.from(req.get("Authorization") ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.status(401).json({
        code: req.path.startsWith("/crawl")
          ? "CRAWL_CONFIGURATION"
          : req.path.startsWith("/read")
            ? "READ_CONFIGURATION"
            : "SEARCH_CONFIGURATION",
        message: "Web service authentication failed.",
        retryable: false,
      });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "8kb", strict: true }));
  app.post("/search", async (req, res) => {
    if (draining) throw new SearchError(503, "SEARCH_UNAVAILABLE", true);
    const input = parseWebSearchInput(req.body);
    if (active >= maxConcurrent) {
      res.setHeader("Retry-After", "2");
      throw new SearchError(429, "SEARCH_RATE_LIMITED", true);
    }
    const controller = new AbortController();
    pending.add(controller);
    active++;
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abort);
    try {
      const result = await search.search(input, controller.signal);
      if (!res.destroyed) res.json(result);
    } finally {
      res.off("close", abort);
      pending.delete(controller);
      active--;
    }
  });
  app.post("/read", async (req, res) => {
    if (draining) throw new ReadError(503, "READ_UNAVAILABLE", true);
    const input = parseWebReadInput(req.body);
    if (!reader) throw new ReadError(503, "READ_CONFIGURATION");
    if (activeReads >= maxReadConcurrent) {
      res.setHeader("Retry-After", "2");
      throw new ReadError(429, "READ_RATE_LIMITED", true);
    }
    const controller = new AbortController();
    pending.add(controller);
    activeReads++;
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abort);
    try {
      const result = await reader.read(input, controller.signal);
      if (!res.destroyed) res.json(result);
    } finally {
      res.off("close", abort);
      pending.delete(controller);
      activeReads--;
    }
  });
  const scope = (req: express.Request): CrawlScope => {
    const tenantId = req.get("x-truex-tenant-id"),
      sessionId = req.get("x-truex-session-id");
    if (
      !tenantId ||
      !sessionId ||
      ![tenantId, sessionId].every((v) => /^[A-Za-z0-9_.:@-]{1,256}$/.test(v))
    )
      throw new CrawlError(400, "INVALID_ARGUMENT");
    return { tenantId, sessionId };
  };
  const crawlService = () => {
    if (draining || !crawls)
      throw new CrawlError(503, "CRAWL_UNAVAILABLE", true);
    return crawls;
  };
  app.post("/crawl/jobs", async (req, res) => {
    const owner = scope(req),
      input = parseCrawlInput(req.body),
      key = req.get("x-truex-idempotency-key");
    if (!key || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(key))
      throw new CrawlError(400, "INVALID_ARGUMENT");
    res.status(202).json(await crawlService().start(owner, input, key));
  });
  app.get("/crawl/jobs", (req, res) =>
    res.json(crawlService().list(scope(req))),
  );
  app.get("/crawl/jobs/:id", (req, res) =>
    res.json(crawlService().status(scope(req), String(req.params.id))),
  );
  app.get("/crawl/jobs/:id/results", async (req, res) => {
    const input = parseWebCrawlResultsQuery(req.query);
    res.json(
      await crawlService().results(
        scope(req),
        String(req.params.id),
        input.offset,
        input.limit,
        input.maxChars,
      ),
    );
  });
  app.post("/crawl/jobs/:id/cancel", async (req, res) => {
    if (
      req.body !== undefined &&
      (!req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length)
    )
      throw new CrawlError(400, "INVALID_ARGUMENT");
    res.json(await crawlService().cancel(scope(req), String(req.params.id)));
  });
  app.delete("/crawl/jobs", async (req, res) =>
    res.json(await crawlService().purge(scope(req))),
  );
  app.use((_req, res) =>
    res.status(404).json({ code: "NOT_FOUND", message: "Not found" }),
  );
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.destroyed || res.headersSent) return;
    if (
      error instanceof SearchError ||
      error instanceof ReadError ||
      error instanceof CrawlError
    ) {
      res.status(error.status).json({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    } else if (
      error instanceof WebSearchInputError ||
      error instanceof WebReadInputError ||
      error instanceof WebCrawlInputError ||
      error?.type === "entity.parse.failed" ||
      error?.type === "entity.too.large"
    ) {
      res.status(error?.type === "entity.too.large" ? 413 : 400).json({
        code: "INVALID_ARGUMENT",
        message: req.path.startsWith("/crawl")
          ? "Check the WebCrawl arguments and try again."
          : req.path.startsWith("/read")
            ? "Check the WebRead arguments and try again."
            : "Check the WebSearch arguments and try again.",
        retryable: false,
      });
    } else {
      res.status(503).json({
        code: req.path.startsWith("/crawl")
          ? "CRAWL_UNAVAILABLE"
          : req.path.startsWith("/read")
            ? "READ_UNAVAILABLE"
            : "SEARCH_UNAVAILABLE",
        message: req.path.startsWith("/crawl")
          ? "Web crawling is unavailable. Try again later."
          : req.path.startsWith("/read")
            ? "Web reading is unavailable. Try again later."
            : "Web search is unavailable. Try again later.",
        retryable: true,
      });
    }
  };
  app.use(errors);
  return {
    app,
    drain() {
      draining = true;
      for (const controller of pending) controller.abort();
      return crawls?.close();
    },
  };
}
