import { createHash } from "node:crypto";
import { HttpError } from "./errors";
import { boundedJson } from "../../shared/web-search";
import {
  parseWebCrawlInput,
  webCrawlErrors,
  webCrawlLimits,
  WebCrawlInputError,
  type WebCrawlErrorCode,
  type WebCrawlInput,
  type WebCrawlJob,
  type WebCrawlPage,
  type WebCrawlResults,
  type WebCrawlJobs,
} from "../../shared/web-crawl";

export class WebCrawlError extends HttpError {}
export interface WebCrawlIdentity {
  tenantId: string;
  sessionId: string;
}
export interface WebCrawlConfig {
  url: string;
  token: string;
  timeoutMs?: number;
}

/** A request timeout or caller abort only stops this RPC; durable jobs continue. */
export class WebCrawlTools {
  readonly enabled = true;
  private readonly base: URL;
  private readonly timeoutMs: number;
  constructor(private readonly config: WebCrawlConfig) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error("Invalid WebCrawl service configuration");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(config.token)
    )
      throw new Error("Invalid WebCrawl service configuration");
    this.base = url;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000
    )
      throw new Error("Invalid WebCrawl timeout");
  }
  async execute(
    args: unknown,
    identity: WebCrawlIdentity,
    signal?: AbortSignal,
    callId?: string,
  ): Promise<WebCrawlJob | WebCrawlResults> {
    let input: WebCrawlInput;
    try {
      input = parseWebCrawlInput(args);
    } catch (error) {
      throw new WebCrawlError(
        400,
        error instanceof WebCrawlInputError
          ? error.message
          : webCrawlErrors.INVALID_ARGUMENT,
        "INVALID_ARGUMENT",
      );
    }
    const job =
      input.action === "start" ? "" : `/${encodeURIComponent(input.jobId)}`;
    const headers: Record<string, string> = {};
    if (input.action === "start") {
      if (
        typeof callId !== "string" ||
        !callId ||
        callId.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(callId)
      )
        throw new WebCrawlError(
          400,
          webCrawlErrors.INVALID_ARGUMENT,
          "INVALID_ARGUMENT",
        );
      headers["x-truex-idempotency-key"] = createHash("sha256")
        .update(
          JSON.stringify([
            identity.tenantId,
            identity.sessionId,
            callId,
            input,
          ]),
        )
        .digest("hex");
    }
    const query =
      input.action === "results"
        ? `?offset=${input.offset}&limit=${input.limit}&maxChars=${input.maxChars}`
        : "";
    const path = `/crawl/jobs${job}${input.action === "results" ? "/results" : input.action === "cancel" ? "/cancel" : ""}${query}`;
    return this.rpc(
      path,
      input.action === "start" || input.action === "cancel" ? "POST" : "GET",
      identity,
      signal,
      input.action === "start"
        ? { url: input.url, maxPages: input.maxPages, maxDepth: input.maxDepth }
        : undefined,
      headers,
      (raw) => projectResponse(raw, input),
    );
  }
  async list(identity: WebCrawlIdentity) {
    return this.rpc(
      "/crawl/jobs",
      "GET",
      identity,
      undefined,
      undefined,
      {},
      projectList,
    );
  }
  async purge(identity: WebCrawlIdentity) {
    return this.rpc(
      "/crawl/jobs",
      "DELETE",
      identity,
      undefined,
      undefined,
      {},
      (raw) => {
        if (!raw || typeof raw !== "object" || (raw as any).ok !== true)
          throw new Error("Invalid purge acknowledgement");
        return { ok: true as const };
      },
    );
  }
  private async rpc<T>(
    path: string,
    method: string,
    identity: WebCrawlIdentity,
    signal: AbortSignal | undefined,
    body: unknown,
    extra: Record<string, string>,
    project: (raw: unknown) => T,
  ) {
    if (
      !identity ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(identity.tenantId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(identity.sessionId)
    )
      throw new WebCrawlError(
        400,
        webCrawlErrors.INVALID_ARGUMENT,
        "INVALID_ARGUMENT",
      );
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(new URL(path, this.base), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-truex-tenant-id": identity.tenantId,
          "x-truex-session-id": identity.sessionId,
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: combined,
      });
      let raw: unknown;
      try {
        raw = await boundedJson(response, webCrawlLimits.responseBytes);
      } catch {
        const code = response.ok
          ? "CRAWL_RESPONSE_INVALID"
          : response.status === 401 || response.status === 403
            ? "CRAWL_CONFIGURATION"
            : "CRAWL_UNAVAILABLE";
        throw new WebCrawlError(
          response.ok ? 502 : response.status,
          webCrawlErrors[code],
          code,
        );
      }
      if (!response.ok) {
        const returned = (raw as any)?.code;
        const code: WebCrawlErrorCode =
          typeof returned === "string" &&
          Object.hasOwn(webCrawlErrors, returned)
            ? (returned as WebCrawlErrorCode)
            : response.status === 401 || response.status === 403
              ? "CRAWL_CONFIGURATION"
              : "CRAWL_UNAVAILABLE";
        throw new WebCrawlError(response.status, webCrawlErrors[code], code);
      }
      try {
        return project(raw);
      } catch {
        throw new WebCrawlError(
          502,
          webCrawlErrors.CRAWL_RESPONSE_INVALID,
          "CRAWL_RESPONSE_INVALID",
        );
      }
    } catch (error) {
      if (signal?.aborted)
        throw new WebCrawlError(
          499,
          webCrawlErrors.CRAWL_CANCELLED,
          "CRAWL_CANCELLED",
        );
      if (timeout.aborted)
        throw new WebCrawlError(
          504,
          webCrawlErrors.CRAWL_TIMEOUT,
          "CRAWL_TIMEOUT",
        );
      if (error instanceof WebCrawlError) throw error;
      throw new WebCrawlError(
        503,
        webCrawlErrors.CRAWL_UNAVAILABLE,
        "CRAWL_UNAVAILABLE",
      );
    }
  }
}

const states = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "partial",
  "failed",
  "cancelled",
];
const reasons = [
  "page_limit",
  "depth_limit",
  "frontier_limit",
  "byte_limit",
  "deadline",
  "queue_exhausted",
  "cancelled",
  "error",
];
function requireValid(value: unknown): asserts value {
  if (!value) throw new Error("Invalid crawl response");
}
function integer(value: unknown, min: number, max: number) {
  return (
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
  );
}
function date(value: unknown) {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
function publicUrl(value: unknown): string {
  requireValid(typeof value === "string");
  // Reuse the public/default-port syntactic boundary, including credentials.
  const input = parseWebCrawlInput({ action: "start", url: value });
  requireValid(input.action === "start" && input.url === value);
  return value as string;
}
function projectJob(
  raw: unknown,
  expectedId?: string,
  start?: Extract<WebCrawlInput, { action: "start" }>,
): WebCrawlJob {
  const r = raw as WebCrawlJob;
  requireValid(
    r &&
      typeof r === "object" &&
      r.provider === "crawlee" &&
      typeof r.jobId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        r.jobId,
      ) &&
      (!expectedId || r.jobId === expectedId),
  );
  publicUrl(r.seedUrl);
  requireValid(
    states.includes(r.state) &&
      (r.reason === null || reasons.includes(r.reason)) &&
      date(r.createdAt) &&
      date(r.updatedAt) &&
      date(r.expiresAt) &&
      (r.deadlineAt === null || date(r.deadlineAt)),
  );
  const l = r.limits,
    c = r.counts;
  requireValid(
    l &&
      integer(l.maxPages, 1, webCrawlLimits.maxPages) &&
      integer(l.maxDepth, 0, webCrawlLimits.maxDepth) &&
      integer(l.maxDurationMs, 1, webCrawlLimits.maxDurationMs) &&
      integer(l.maxBytes, 1, webCrawlLimits.maxBytes) &&
      integer(l.maxFrontier, 1, webCrawlLimits.maxFrontier),
  );
  requireValid(
    c &&
      integer(c.discovered, 0, l.maxFrontier) &&
      integer(c.attempted, 0, l.maxPages) &&
      integer(c.attempts, c.attempted, l.maxPages * 3) &&
      integer(c.succeeded, 0, c.attempted) &&
      integer(c.failed, 0, c.attempted) &&
      c.succeeded + c.failed <= c.attempted &&
      integer(c.pending, 0, c.discovered) &&
      c.attempted <= c.discovered &&
      integer(c.storedBytes, 0, l.maxBytes),
  );
  requireValid(
    Array.isArray(r.warnings) &&
      r.warnings.length <= 5 &&
      r.warnings.every((w) => typeof w === "string" && w.length <= 300),
  );
  requireValid(
    !start ||
      (r.seedUrl === start.url &&
        l.maxPages === start.maxPages &&
        l.maxDepth === start.maxDepth),
  );
  return {
    provider: "crawlee",
    jobId: r.jobId,
    seedUrl: r.seedUrl,
    state: r.state,
    reason: r.reason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
    deadlineAt: r.deadlineAt,
    limits: {
      maxPages: l.maxPages,
      maxDepth: l.maxDepth,
      maxDurationMs: l.maxDurationMs,
      maxBytes: l.maxBytes,
      maxFrontier: l.maxFrontier,
    },
    counts: {
      discovered: c.discovered,
      attempted: c.attempted,
      attempts: c.attempts,
      succeeded: c.succeeded,
      failed: c.failed,
      pending: c.pending,
      storedBytes: c.storedBytes,
    },
    warnings: [...r.warnings],
  };
}
function projectResponse(
  raw: unknown,
  input: WebCrawlInput,
): WebCrawlJob | WebCrawlResults {
  if (input.action !== "results")
    return projectJob(
      raw,
      input.action === "start" ? undefined : input.jobId,
      input.action === "start" ? input : undefined,
    );
  const r = raw as WebCrawlResults;
  requireValid(r && typeof r === "object");
  const job = projectJob(r.job, input.jobId);
  requireValid(
    r.offset === input.offset &&
      integer(r.totalPages, 0, job.limits.maxPages) &&
      r.totalPages === job.counts.succeeded &&
      Array.isArray(r.pages) &&
      r.pages.length <= input.limit &&
      r.pages.length <= Math.max(0, r.totalPages - input.offset),
  );
  const expectedNext =
    input.offset + r.pages.length < r.totalPages
      ? input.offset + r.pages.length
      : null;
  requireValid(
    r.nextOffset === expectedNext &&
      (r.nextOffset === null || r.pages.length > 0),
  );
  let chars = 0;
  const ids = new Set<string>(),
    urls = new Set<string>();
  const hostname = new URL(job.seedUrl).hostname;
  const pages = r.pages.map((p): WebCrawlPage => {
    requireValid(
      p &&
        typeof p === "object" &&
        typeof p.sourceId === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/.test(p.sourceId) &&
        !ids.has(p.sourceId),
    );
    publicUrl(p.requestedUrl);
    publicUrl(p.url);
    requireValid(
      new URL(p.requestedUrl).hostname === hostname &&
        new URL(p.url).hostname === hostname &&
        !urls.has(p.url),
    );
    requireValid(
      typeof p.title === "string" &&
        p.title.length <= 300 &&
        date(p.retrievedAt) &&
        integer(p.statusCode, 200, 299) &&
        integer(p.depth, 0, job.limits.maxDepth) &&
        typeof p.markdown === "string" &&
        p.markdown.length > 0 &&
        integer(p.totalChars, p.markdown.length, 2 * 1024 * 1024) &&
        typeof p.truncated === "boolean" &&
        p.truncated === p.totalChars > p.markdown.length,
    );
    chars += p.markdown.length;
    requireValid(chars <= input.maxChars);
    ids.add(p.sourceId);
    urls.add(p.url);
    return {
      sourceId: p.sourceId,
      requestedUrl: p.requestedUrl,
      url: p.url,
      title: p.title,
      retrievedAt: p.retrievedAt,
      statusCode: p.statusCode,
      depth: p.depth,
      markdown: p.markdown,
      totalChars: p.totalChars,
      truncated: p.truncated,
    };
  });
  requireValid(Array.isArray(r.failures) && r.failures.length <= input.limit);
  const failures = r.failures.map((f) => {
    requireValid(f && typeof f === "object");
    publicUrl(f.url);
    requireValid(
      new URL(f.url).hostname === hostname &&
        integer(f.depth, 0, job.limits.maxDepth) &&
        typeof f.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(f.code),
    );
    return { url: f.url, depth: f.depth, code: f.code };
  });
  return {
    job,
    pages,
    failures,
    offset: r.offset,
    nextOffset: r.nextOffset,
    totalPages: r.totalPages,
  };
}
function projectList(raw: unknown): WebCrawlJobs {
  const r = raw as WebCrawlJobs;
  requireValid(
    r && Array.isArray(r.jobs) && r.jobs.length <= webCrawlLimits.maxJobs,
  );
  const jobs = r.jobs.map((job) => projectJob(job));
  requireValid(new Set(jobs.map((job) => job.jobId)).size === jobs.length);
  return { jobs };
}

export function webCrawlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebCrawlTools | null {
  if (env.WEB_CRAWL?.trim().toLowerCase() !== "on") return null;
  if (!env.WEB_SERVICE_URL || !env.WEB_SERVICE_TOKEN)
    throw new Error(
      "WEB_CRAWL=on requires WEB_SERVICE_URL and WEB_SERVICE_TOKEN",
    );
  return new WebCrawlTools({
    url: env.WEB_SERVICE_URL,
    token: env.WEB_SERVICE_TOKEN,
    ...(env.WEB_CRAWL_TIMEOUT_MS
      ? { timeoutMs: Number(env.WEB_CRAWL_TIMEOUT_MS) }
      : {}),
  });
}
