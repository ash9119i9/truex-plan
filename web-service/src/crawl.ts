import { BasicCrawler } from "@crawlee/basic";
import { Configuration, RequestQueue, log, LogLevel } from "@crawlee/core";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { WebReadErrorCode } from "../../shared/web-read";
import { ReadError, type CrawlPageReader, type CrawlPage } from "./crawl4ai";
import { publicUrl } from "./egress-policy";
import {
  parseWebCrawlStartInput,
  type WebCrawlJob,
  type WebCrawlPage,
  webCrawlErrors,
} from "../../shared/web-crawl";

export type CrawlScope = { tenantId: string; sessionId: string };
export type CrawlInput = { url: string; maxPages: number; maxDepth: number };
type State =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
type Reason =
  | "page_limit"
  | "depth_limit"
  | "frontier_limit"
  | "byte_limit"
  | "deadline"
  | "queue_exhausted"
  | "cancelled"
  | "error";
type Entry = {
  url: string;
  depth: number;
  attempts: number;
  done: boolean;
  error?: WebReadErrorCode;
  saved?: boolean;
  finalUrl?: string;
};
type Manifest = {
  version: 1;
  jobId: string;
  scope: CrawlScope;
  key: string;
  fingerprint: string;
  input: CrawlInput;
  state: State;
  reason?: Reason;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  deadlineAt?: number;
  entries: Entry[];
  bytes: number;
  boundary?: Reason;
  generation: number;
};
const terminal = (state: State) =>
  ["completed", "partial", "failed", "cancelled"].includes(state);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: CrawlScope, b: CrawlScope) =>
  a.tenantId === b.tenantId && a.sessionId === b.sessionId;
const MAX_BYTES = 10 * 1024 * 1024;
const RETENTION = 7 * 24 * 60 * 60 * 1000;
log.setLevel(LogLevel.OFF);
const safeLog = log.child({ prefix: "WebCrawl" });
safeLog.setLevel(LogLevel.OFF);
export class CrawlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(
      webCrawlErrors[code as keyof typeof webCrawlErrors] ||
        webCrawlErrors.CRAWL_UNAVAILABLE,
    );
  }
}
export function parseCrawlInput(value: unknown): CrawlInput {
  const input = parseWebCrawlStartInput(value);
  try {
    input.url = publicUrl(input.url).href;
  } catch {
    throw new CrawlError(400, "INVALID_ARGUMENT");
  }
  return input;
}
function normalizedLink(value: string, host: string): string | undefined {
  try {
    const u = publicUrl(value);
    if (
      u.hostname !== host ||
      /\.(pdf|zip|gz|tar|rar|7z|exe|dmg|png|jpe?g|gif|webp|svg|ico|mp[34]|avi|mov|woff2?|ttf|css|js)$/i.test(
        u.pathname,
      )
    )
      return;
    return u.href;
  } catch {
    return;
  }
}
async function atomic(filename: string, data: unknown) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  const file = await fs.open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(temp, filename);
  const dir = await fs.open(path.dirname(filename), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** Single local owner. The OS releases flock on hard kill; no timed lease split brain. */
async function ownerLock(root: string): Promise<ChildProcess> {
  const child = spawn(
    "python3",
    [
      "-c",
      'import fcntl,sys\nf=open(sys.argv[1],"a")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)\nprint("locked",flush=True)\nsys.stdin.buffer.read()',
      path.join(root, "owner.lock"),
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    const fail = () =>
      reject(
        new Error(
          "WebCrawl storage already owned or advisory lock unavailable",
        ),
      );
    child.once("error", fail);
    child.once("exit", fail);
    child.stdout!.once("data", (data) => {
      if (String(data).trim() !== "locked") return fail();
      child.removeListener("error", fail);
      child.removeListener("exit", fail);
      resolve();
    });
  });
  return child;
}
export class CrawlJobs {
  private jobs = new Map<string, Manifest>();
  private lock?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private active?: {
    id: string;
    controller: AbortController;
    crawler?: BasicCrawler;
    promise: Promise<void>;
  };
  private stopped = false;
  private mutations = Promise.resolve();
  private writes = new Map<string, Promise<void>>();
  private ownerLost = false;
  private releasing = false;
  private constructor(
    readonly root: string,
    private reader: CrawlPageReader,
    private clock: () => number,
  ) {}
  static async open(
    root: string,
    reader: CrawlPageReader,
    clock: () => number = Date.now,
  ) {
    if (!path.isAbsolute(root))
      throw new Error("WEB_CRAWL_DATA_DIR must be absolute");
    const service = new CrawlJobs(root, reader, clock);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    service.lock = await ownerLock(root);
    service.lock.on("exit", () => {
      if (service.releasing) return;
      service.ownerLost = true;
      service.stopped = true;
      service.active?.controller.abort();
      service.active?.crawler?.stop("Storage owner lost");
    });
    try {
      await fs.mkdir(path.join(root, "jobs"), { recursive: true, mode: 0o700 });
      const dirs = await fs.readdir(path.join(root, "jobs"));
      if (dirs.length > 1000)
        throw new Error("WebCrawl storage exceeded recovery bound");
      for (const id of dirs) {
        if (!/^[a-f0-9-]{36}$/.test(id)) continue;
        // An uncommitted start has no manifest and was never acknowledged.
        let raw: string;
        try {
          raw = await fs.readFile(service.manifestPath(id), "utf8");
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
          await fs.rm(service.jobDir(id), { recursive: true, force: true });
          continue;
        }
        for (const directory of [
          service.jobDir(id),
          path.join(service.jobDir(id), "pages"),
        ]) {
          const files = await fs.readdir(directory);
          if (files.length > 2000)
            throw new Error("WebCrawl checkpoint directory exceeded bound");
          for (const file of files)
            if (/\.json\.[a-f0-9-]{36}\.tmp$/.test(file))
              await fs.unlink(path.join(directory, file));
        }
        const m = JSON.parse(raw) as Manifest;
        if (
          m.version !== 1 ||
          m.jobId !== id ||
          m.entries.length > 1000 ||
          m.entries.some((e) => e.attempts > 3)
        )
          throw new Error("Invalid WebCrawl checkpoint");
        if (m.state === "cancelling") {
          m.state = "cancelled";
          m.reason = "cancelled";
        } else if (!terminal(m.state)) m.state = "queued";
        service.jobs.set(id, m);
        await service.replay(m);
        await service.persist(m);
      }
      await service.cleanup();
      service.timer = setInterval(() => {
        void service.serialize(() => service.cleanup()).catch(() => {});
      }, 60_000);
      service.timer.unref();
      service.pump();
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }
  private jobDir(id: string) {
    return path.join(this.root, "jobs", id);
  }
  private manifestPath(id: string) {
    return path.join(this.jobDir(id), "manifest.json");
  }
  private pagePath(id: string, url: string) {
    return path.join(this.jobDir(id), "pages", `${hash(url)}.json`);
  }
  private async persist(m: Manifest) {
    const previous = this.writes.get(m.jobId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        if (this.ownerLost) throw new Error("Storage owner lost");
        m.updatedAt = new Date(this.clock()).toISOString();
        await atomic(this.manifestPath(m.jobId), m);
      });
    this.writes.set(m.jobId, current);
    try {
      await current;
    } finally {
      if (this.writes.get(m.jobId) === current) this.writes.delete(m.jobId);
    }
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(fn);
    this.mutations = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async ready() {
    return (
      !this.stopped &&
      !!this.lock &&
      this.lock.exitCode === null &&
      this.lock.signalCode === null &&
      (await this.reader.ready())
    );
  }
  private get(scope: CrawlScope, id: string) {
    const m = this.jobs.get(id);
    if (!m || !same(scope, m.scope) || Date.parse(m.expiresAt) <= this.clock())
      throw new CrawlError(404, "CRAWL_NOT_FOUND");
    return m;
  }
  status(scope: CrawlScope, id: string) {
    return this.summary(this.get(scope, id));
  }
  private summary(m: Manifest): WebCrawlJob {
    return {
      provider: "crawlee",
      jobId: m.jobId,
      seedUrl: m.input.url,
      state: m.state,
      reason: m.reason ?? null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      expiresAt: m.expiresAt,
      deadlineAt: m.deadlineAt ? new Date(m.deadlineAt).toISOString() : null,
      limits: {
        maxPages: m.input.maxPages,
        maxDepth: m.input.maxDepth,
        maxDurationMs: 300_000,
        maxBytes: MAX_BYTES,
        maxFrontier: 1000,
      },
      counts: {
        discovered: m.entries.length,
        attempted: m.entries.filter((e) => e.attempts > 0).length,
        attempts: m.entries.reduce((n, e) => n + e.attempts, 0),
        succeeded: m.entries.filter((e) => e.saved).length,
        failed: m.entries.filter((e) => e.error && e.done).length,
        pending: m.entries.filter((e) => !e.done).length,
        storedBytes: m.bytes,
      },
      warnings: [
        "Crawls are bounded and may omit pages. Browser fetches may repeat after interruption.",
      ],
    };
  }
  list(scope: CrawlScope) {
    return {
      jobs: [...this.jobs.values()]
        .filter(
          (m) => same(scope, m.scope) && Date.parse(m.expiresAt) > this.clock(),
        )
        .map((m) => this.summary(m)),
    };
  }
  async start(scope: CrawlScope, input: CrawlInput, key: string) {
    if (this.stopped) throw new CrawlError(503, "CRAWL_UNAVAILABLE", true);
    return this.serialize(async () => {
      await this.cleanup();
      const fingerprint = hash(JSON.stringify(input));
      const existing = [...this.jobs.values()].find(
        (m) => same(scope, m.scope) && m.key === key,
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new CrawlError(409, "CRAWL_CONFLICT");
        return this.summary(existing);
      }
      if (this.jobs.size >= 100)
        throw new CrawlError(429, "CRAWL_RATE_LIMITED", true);
      const now = this.clock(),
        jobId = randomUUID();
      const m: Manifest = {
        version: 1,
        jobId,
        scope,
        key,
        fingerprint,
        input,
        state: "queued",
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + RETENTION).toISOString(),
        entries: [{ url: input.url, depth: 0, attempts: 0, done: false }],
        bytes: 0,
        generation: 0,
        deadlineAt: now + 300_000,
      };
      await fs.mkdir(path.join(this.jobDir(jobId), "pages"), {
        recursive: true,
        mode: 0o700,
      });
      await this.persist(m);
      this.jobs.set(jobId, m);
      this.pump();
      return this.summary(m);
    });
  }
  async cancel(scope: CrawlScope, id: string) {
    if (this.ownerLost) throw new CrawlError(503, "CRAWL_UNAVAILABLE", true);
    const m = this.get(scope, id);
    if (!terminal(m.state)) {
      m.state = this.active?.id === id ? "cancelling" : "cancelled";
      m.reason = "cancelled";
      this.active?.id === id && this.active.controller.abort();
      this.active?.id === id && this.active.crawler?.stop("Cancelled");
      await this.persist(m);
    }
    return this.summary(m);
  }
  async purge(scope: CrawlScope) {
    if (this.ownerLost) throw new CrawlError(503, "CRAWL_UNAVAILABLE", true);
    for (const m of [...this.jobs.values()].filter((m) => same(scope, m.scope)))
      await this.cancel(scope, m.jobId);
    if (this.active && same(this.jobs.get(this.active.id)!.scope, scope))
      await this.active.promise;
    return this.serialize(async () => {
      for (const m of [...this.jobs.values()].filter((m) =>
        same(scope, m.scope),
      )) {
        this.jobs.delete(m.jobId);
        await fs.rm(this.jobDir(m.jobId), { recursive: true, force: true });
      }
      return { ok: true };
    });
  }
  async results(
    scope: CrawlScope,
    id: string,
    offset: number,
    limit: number,
    maxChars: number,
  ) {
    const m = this.get(scope, id),
      pages: WebCrawlPage[] = [];
    let remaining = maxChars;
    const saved = m.entries.filter((e) => e.saved),
      selected = saved.slice(offset, offset + limit);
    for (const e of selected) {
      if (remaining <= 0) break;
      const { links: _links, ...page } = JSON.parse(
        await fs.readFile(this.pagePath(id, e.url), "utf8"),
      ) as CrawlPage;
      let markdown = page.markdown.slice(0, remaining);
      // Do not split an astral code point at the UTF-16 budget boundary.
      if (/[\uD800-\uDBFF]$/.test(markdown)) markdown = markdown.slice(0, -1);
      if (!markdown.length) break;
      remaining -= markdown.length;
      pages.push({
        sourceId: `page_${hash(e.url).slice(0, 24)}`,
        requestedUrl: page.requestedUrl,
        url: page.url,
        title: page.title,
        retrievedAt: page.retrievedAt,
        statusCode: page.statusCode,
        depth: e.depth,
        markdown,
        totalChars: page.totalChars,
        truncated: page.truncated || markdown.length < page.markdown.length,
      });
    }
    if (selected.length && !pages.length)
      throw new CrawlError(400, "INVALID_ARGUMENT");
    return {
      job: this.summary(m),
      pages,
      failures: m.entries
        .filter((e) => e.done && e.error)
        .slice(offset, offset + limit)
        .map((e) => ({ url: e.url, depth: e.depth, code: e.error })),
      offset,
      nextOffset:
        offset + pages.length < saved.length ? offset + pages.length : null,
      totalPages: saved.length,
    };
  }
  private async cleanup() {
    for (const m of this.jobs.values())
      if (Date.parse(m.expiresAt) <= this.clock()) {
        if (this.active?.id === m.jobId) {
          this.active.controller.abort();
          continue;
        }
        this.jobs.delete(m.jobId);
        await fs.rm(this.jobDir(m.jobId), { recursive: true, force: true });
      }
  }
  private links(m: Manifest, e: Entry, page: CrawlPage) {
    const host = new URL(m.input.url).hostname;
    for (const candidate of page.links) {
      const url = normalizedLink(candidate, host);
      if (!url || m.entries.some((x) => x.url === url || x.finalUrl === url))
        continue;
      if (e.depth >= m.input.maxDepth) {
        m.boundary ??= "depth_limit";
        continue;
      }
      if (m.entries.length >= 1000) {
        m.boundary = "frontier_limit";
        break;
      }
      m.entries.push({ url, depth: e.depth + 1, attempts: 0, done: false });
    }
  }
  private async replay(m: Manifest) {
    m.bytes = 0;
    const expectedSaved = new Set(
      m.entries.filter((e) => e.saved).map((e) => e.url),
    );
    for (const e of m.entries) e.saved = false;
    for (const e of [...m.entries]) {
      try {
        const page = JSON.parse(
          await fs.readFile(this.pagePath(m.jobId, e.url), "utf8"),
        ) as CrawlPage;
        if (
          page.requestedUrl !== e.url ||
          typeof page.markdown !== "string" ||
          !Array.isArray(page.links)
        )
          throw new Error("Invalid durable page");
        e.finalUrl = page.url;
        if (
          m.entries.some(
            (other) =>
              other !== e && other.saved && other.finalUrl === page.url,
          )
        ) {
          e.saved = false;
          e.done = true;
          continue;
        }
        m.bytes += Buffer.byteLength(page.markdown);
        e.saved = true;
        e.done = true;
        delete e.error;
        this.links(m, e, page);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        if (expectedSaved.has(e.url)) throw new Error("Missing durable page");
      }
    }
  }
  private pump() {
    if (this.stopped || this.active) return;
    const m = [...this.jobs.values()].find((m) => m.state === "queued");
    if (!m) return;
    const controller = new AbortController();
    const active = {
      id: m.jobId,
      controller,
      promise: Promise.resolve(),
      crawler: undefined as BasicCrawler | undefined,
    };
    this.active = active;
    active.promise = this.run(m, active)
      .catch(async () => {
        m.state = m.entries.some((e) => e.saved) ? "partial" : "failed";
        m.reason = "error";
        if (!this.ownerLost) await this.persist(m);
      })
      .finally(() => {
        this.active = undefined;
        this.pump();
      });
  }
  private async run(
    m: Manifest,
    active: { controller: AbortController; crawler?: BasicCrawler },
  ) {
    m.state = "running";
    m.deadlineAt ??= this.clock() + 300_000;
    m.generation++;
    await this.persist(m);
    // The manifest is authoritative; discard older queue generations only after replay.
    await fs.rm(path.join(this.jobDir(m.jobId), "queue"), {
      recursive: true,
      force: true,
    });
    const config = new Configuration({
      purgeOnStart: false,
      persistStorage: true,
      storageClientOptions: {
        localDataDirectory: path.join(this.jobDir(m.jobId), "queue"),
      },
    });
    const queue = await RequestQueue.open(`job-${m.jobId}-${m.generation}`, {
      config,
    });
    const pending = m.entries.filter((e) => !e.done);
    for (const e of pending)
      await queue.addRequest({
        url: e.url,
        uniqueKey: e.url,
        userData: { depth: e.depth },
      });
    const stop = (reason: Reason) => {
      m.reason = reason;
      active.controller.abort();
      active.crawler?.stop("Bound reached");
    };
    const deadline = setTimeout(
      () => stop("deadline"),
      Math.max(1, m.deadlineAt - this.clock()),
    );
    deadline.unref();
    const crawler = new BasicCrawler(
      {
        requestQueue: queue,
        maxConcurrency: 1,
        minConcurrency: 1,
        maxRequestRetries: 0,
        requestHandlerTimeoutSecs: 120,
        useSessionPool: false,
        log: safeLog,
        requestHandler: async ({ request }) => {
          const e = m.entries.find((e) => e.url === request.url)!;
          if (e.done) return;
          if (active.controller.signal.aborted) return;
          if (this.clock() >= m.deadlineAt!) {
            stop("deadline");
            return;
          }
          if (
            e.attempts === 0 &&
            m.entries.filter((e) => e.attempts > 0).length >= m.input.maxPages
          ) {
            stop("page_limit");
            return;
          }
          while (
            e.attempts < 3 &&
            !e.done &&
            !active.controller.signal.aborted
          ) {
            e.attempts++;
            await this.persist(m); // Durable admission BEFORE browser fetch, including retries and restarts.
            try {
              const page = await this.reader.crawlPage(
                { url: e.url, maxChars: 50_000 },
                new URL(m.input.url).hostname,
                active.controller.signal,
              );
              if (active.controller.signal.aborted) break;
              e.finalUrl = page.url;
              if (
                m.entries.some(
                  (other) =>
                    other !== e && other.saved && other.finalUrl === page.url,
                )
              ) {
                e.done = true;
                delete e.error;
                await this.persist(m);
                continue;
              }
              const bytes = Buffer.byteLength(page.markdown);
              if (m.bytes + bytes > MAX_BYTES) {
                stop("byte_limit");
                break;
              }
              if (this.ownerLost) return;
              await atomic(this.pagePath(m.jobId, e.url), page); // Result+links survive crash before the checkpoint.
              m.bytes += bytes;
              e.saved = true;
              e.done = true;
              delete e.error;
              this.links(m, e, page);
              await this.persist(m); // Frontier is durable before enqueue / Crawlee markRequestHandled.
              for (const next of m.entries.filter((x) => !x.done))
                await queue.addRequest({
                  url: next.url,
                  uniqueKey: next.url,
                  userData: { depth: next.depth },
                });
            } catch (error) {
              if (active.controller.signal.aborted) break;
              const failure =
                error instanceof ReadError
                  ? error
                  : new ReadError(503, "READ_UNAVAILABLE", true);
              e.error = failure.code;
              if (!failure.retryable || e.attempts >= 3) e.done = true;
              await this.persist(m);
              if (!e.done)
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          if (e.attempts >= 3 && !e.saved) {
            e.done = true;
            e.error ??= "READ_UNAVAILABLE";
            await this.persist(m);
          }
        },
        failedRequestHandler: async ({ request }) => {
          const e = m.entries.find((e) => e.url === request.url)!;
          e.done = true;
          e.error = "READ_UNAVAILABLE";
          await this.persist(m);
        },
      },
      config,
    );
    active.crawler = crawler;
    try {
      await crawler.run();
    } finally {
      clearTimeout(deadline);
    }
    if (this.ownerLost) return;
    if (this.stopped) {
      if ((m.state as State) === "cancelling" || m.reason === "cancelled") {
        m.state = "cancelled";
        m.reason = "cancelled";
      } else m.state = "queued";
      await this.persist(m);
      return;
    }
    if ((m.state as State) === "cancelling" || m.reason === "cancelled") {
      m.state = "cancelled";
      m.reason = "cancelled";
    } else {
      m.reason ??= m.boundary ?? "queue_exhausted";
      const failures = m.entries.some((e) => e.error);
      m.state =
        m.reason === "queue_exhausted" && !failures
          ? "completed"
          : m.entries.some((e) => e.saved)
            ? "partial"
            : "failed";
    }
    await this.persist(m);
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.active?.controller.abort();
    this.active?.crawler?.stop("Shutdown");
    if (this.active) await this.active.promise;
    this.releasing = true;
    await Promise.allSettled([...this.writes.values()]);
    this.lock?.stdin?.end();
    if (this.lock)
      await new Promise<void>((resolve) => {
        if (this.lock!.exitCode !== null || this.lock!.signalCode !== null)
          resolve();
        else this.lock!.once("exit", () => resolve());
      });
    this.lock = undefined;
  }
}
