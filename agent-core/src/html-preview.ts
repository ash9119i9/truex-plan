import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { DynamicToolSpec } from "../../shared/protocol/v2/DynamicToolSpec";
import type { DynamicToolCallOutputContentItem } from "../../shared/protocol/v2/DynamicToolCallOutputContentItem";
import { HttpError } from "./errors";
import type { SpawnFn } from "./script-runner";
import { log } from "../../shared/logging";

export const htmlPreviewLimits = {
  htmlChars: 180_000,
  inputBytes: 1024 * 1024,
  pngBytes: 4 * 1024 * 1024,
  outputBytes: 6 * 1024 * 1024,
  timeoutMs: 20_000,
  waiting: 4,
};
export interface HtmlPreviewInput {
  html: string;
  width: number;
  appearance: "light" | "dark";
  signal?: AbortSignal;
  scope?: string;
}
export interface HtmlPreviewResult {
  width: number;
  contentHeight: number;
  capturedHeight: number;
  durationMs: number;
  consoleMessages: {
    level: "log" | "info" | "warning" | "error";
    text: string;
  }[];
  screenshot: {
    mimeType: "image/png";
    data: string;
    width: number;
    height: number;
  };
}
export interface HtmlPreviewRunner {
  readonly enabled: boolean;
  run(input: HtmlPreviewInput): Promise<HtmlPreviewResult>;
}
export const htmlPreviewTool: DynamicToolSpec = {
  type: "function",
  name: "html_preview",
  description:
    "Check a complete self-contained HTML visual before html_render. Runs isolated with no network or host files. Returns a PNG screenshot, content height and bounded console/error diagnostics. Use native HTML/SVG/canvas and inline data; remote libraries cannot load. Preview at about 390 pixels for phones. A preview failure does not prevent publishing a usable visual with an accurate validation note.",
  inputSchema: {
    type: "object",
    properties: {
      html: { type: "string", minLength: 1, maxLength: 180_000 },
      width: { type: "integer", minimum: 240, maximum: 1600 },
      appearance: { type: "string", enum: ["light", "dark"] },
    },
    required: ["html"],
    additionalProperties: false,
  },
};
export function validateHtmlPreviewArguments(value: unknown): {
  html: string;
  width: number;
  appearance: "light" | "dark";
} {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !["html", "width", "appearance"].includes(k)) ||
    typeof v.html !== "string" ||
    !v.html.trim() ||
    v.html.length > htmlPreviewLimits.htmlChars ||
    Buffer.byteLength(v.html) > 720_000 ||
    (v.width !== undefined &&
      (!Number.isInteger(v.width) ||
        (v.width as number) < 240 ||
        (v.width as number) > 1600)) ||
    (v.appearance !== undefined &&
      v.appearance !== "light" &&
      v.appearance !== "dark")
  )
    throw new HttpError(400, "Invalid HTML preview arguments");
  return {
    html: v.html,
    width: (v.width as number | undefined) ?? 728,
    appearance: (v.appearance as "light" | "dark" | undefined) ?? "dark",
  };
}
export function htmlPreviewContentItems(
  result: HtmlPreviewResult,
): DynamicToolCallOutputContentItem[] {
  const { screenshot, ...diagnostics } = result;
  return [
    { type: "inputText", text: JSON.stringify(diagnostics) },
    {
      type: "inputImage",
      imageUrl: `data:image/png;base64,${screenshot.data}`,
    },
  ];
}
function cancelled() {
  return new HttpError(499, "HTML preview was cancelled");
}
export class DisabledHtmlPreviewRunner implements HtmlPreviewRunner {
  readonly enabled = false;
  async run(): Promise<HtmlPreviewResult> {
    throw new HttpError(
      503,
      "HTML preview is not enabled. Publish with html_render and note that visual validation was unavailable.",
    );
  }
}
export function readHtmlPreviewResult(value: unknown): HtmlPreviewResult {
  const r = value as HtmlPreviewResult;
  if (
    !r ||
    !Number.isInteger(r.width) ||
    r.width < 240 ||
    r.width > 1600 ||
    !Number.isInteger(r.contentHeight) ||
    r.contentHeight < 1 ||
    r.contentHeight > 10_000_000 ||
    !Number.isInteger(r.capturedHeight) ||
    r.capturedHeight < 1 ||
    r.capturedHeight > 4000 ||
    !Number.isFinite(r.durationMs) ||
    r.durationMs < 0 ||
    !Array.isArray(r.consoleMessages) ||
    r.consoleMessages.length > 20 ||
    r.consoleMessages.some(
      (c) =>
        !c ||
        !["log", "info", "warning", "error"].includes(c.level) ||
        typeof c.text !== "string" ||
        c.text.length > 500,
    ) ||
    r.screenshot?.mimeType !== "image/png" ||
    typeof r.screenshot.data !== "string" ||
    r.screenshot.data.length > Math.ceil(htmlPreviewLimits.pngBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(r.screenshot.data)
  )
    throw new HttpError(502, "HTML preview returned invalid diagnostics");
  const png = Buffer.from(r.screenshot.data, "base64");
  if (
    png.length < 24 ||
    png.length > htmlPreviewLimits.pngBytes ||
    !png
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR" ||
    png.readUInt32BE(16) !== r.width ||
    png.readUInt32BE(20) !== r.capturedHeight ||
    r.screenshot.width !== r.width ||
    r.screenshot.height !== r.capturedHeight
  )
    throw new HttpError(502, "HTML preview returned an invalid screenshot");
  return {
    width: r.width,
    contentHeight: r.contentHeight,
    capturedHeight: r.capturedHeight,
    durationMs: r.durationMs,
    consoleMessages: r.consoleMessages.map((c) => ({
      level: c.level,
      text: c.text,
    })),
    screenshot: {
      mimeType: "image/png",
      data: r.screenshot.data,
      width: r.width,
      height: r.capturedHeight,
    },
  };
}
function inputPayload(input: HtmlPreviewInput): string {
  if (
    typeof input.html !== "string" ||
    !input.html ||
    !Number.isInteger(input.width) ||
    input.width < 240 ||
    input.width > 1600 ||
    !["light", "dark"].includes(input.appearance)
  )
    throw new HttpError(400, "Invalid prepared HTML preview input");
  const payload = JSON.stringify({
    html: input.html,
    width: input.width,
    appearance: input.appearance,
  });
  if (Buffer.byteLength(payload) > htmlPreviewLimits.inputBytes)
    throw new HttpError(413, "Prepared HTML preview is too large");
  return payload;
}

export class DockerHtmlPreviewRunner implements HtmlPreviewRunner {
  readonly enabled = true;
  private active = false;
  private unhealthy = false;
  private waiting: {
    input: HtmlPreviewInput;
    start: () => void;
    reject: (e: unknown) => void;
    abort: () => void;
  }[] = [];
  private scopes = new Map<string, number>();
  private readonly spawn: SpawnFn;
  private readonly timeoutMs: number;
  constructor(
    private readonly options: {
      image?: string;
      docker?: string;
      spawn?: SpawnFn;
      timeoutMs?: number;
    } = {},
  ) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.timeoutMs = options.timeoutMs ?? htmlPreviewLimits.timeoutMs;
  }
  get capacity() {
    return {
      active: this.active ? 1 : 0,
      waiting: this.waiting.length,
      healthy: !this.unhealthy,
    };
  }
  dockerArgs(name: string) {
    return [
      "run",
      "--rm",
      "-i",
      "--name",
      name,
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--user",
      "65534:65534",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--shm-size",
      "64m",
      this.options.image ?? "truex-html-preview:local",
    ];
  }
  run(input: HtmlPreviewInput): Promise<HtmlPreviewResult> {
    try {
      inputPayload(input);
    } catch (e) {
      return Promise.reject(e);
    }
    if (input.signal?.aborted) return Promise.reject(cancelled());
    if (this.unhealthy)
      return Promise.reject(
        new HttpError(
          503,
          "HTML preview cleanup failed; the renderer needs operator recovery",
        ),
      );
    const scope = input.scope ?? "internal";
    if (
      (this.scopes.get(scope) ?? 0) >= 2 ||
      (this.active && this.waiting.length >= htmlPreviewLimits.waiting)
    ) {
      log("warn", "html preview admission rejected", this.capacity);
      return Promise.reject(
        new HttpError(
          429,
          "HTML preview queue is full. Publish without preview or retry later.",
        ),
      );
    }
    this.scopes.set(scope, (this.scopes.get(scope) ?? 0) + 1);
    return new Promise((resolve, reject) => {
      const admittedAt = Date.now();
      const release = () => {
        const n = (this.scopes.get(scope) ?? 1) - 1;
        if (n) this.scopes.set(scope, n);
        else this.scopes.delete(scope);
      };
      const entry = { input, reject, abort: () => {}, start: () => {} };
      entry.abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          release();
          reject(cancelled());
        }
      };
      entry.start = () => {
        input.signal?.removeEventListener("abort", entry.abort);
        this.active = true;
        log("info", "html preview started", {
          queueWaitMs: Date.now() - admittedAt,
          ...this.capacity,
        });
        void this.execute(input)
          .then(resolve, reject)
          .finally(() => {
            release();
            this.active = false;
            if (this.unhealthy) {
              for (const pending of this.waiting.splice(0)) {
                pending.input.signal?.removeEventListener(
                  "abort",
                  pending.abort,
                );
                const key = pending.input.scope ?? "internal";
                this.scopes.delete(key);
                pending.reject(
                  new HttpError(
                    503,
                    "HTML preview renderer needs operator recovery",
                  ),
                );
              }
            } else this.waiting.shift()?.start();
          });
      };
      if (this.active) {
        this.waiting.push(entry);
        input.signal?.addEventListener("abort", entry.abort, { once: true });
      } else entry.start();
    });
  }
  private cleanup(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawn(
          this.options.docker ?? "docker",
          ["rm", "--force", name],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
      } catch {
        return reject(new Error("cleanup_unavailable"));
      }
      let stderr = "",
        settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ok ? resolve() : reject(new Error("cleanup_failed"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(false);
      }, 2000);
      child.stderr?.on("data", (b: Buffer) => {
        stderr = (stderr + b.toString()).slice(-1024);
      });
      child.on("error", () => finish(false));
      child.on("close", (code) =>
        finish(code === 0 || /No such container/i.test(stderr)),
      );
    });
  }
  private async execute(input: HtmlPreviewInput): Promise<HtmlPreviewResult> {
    if (input.signal?.aborted) throw cancelled();
    const name = `truex-preview-${randomUUID()}`,
      started = Date.now();
    let child: ChildProcess | undefined;
    try {
      return await new Promise<HtmlPreviewResult>((resolve, reject) => {
        let size = 0,
          settled = false;
        const chunks: Buffer[] = [];
        const finish = (error?: unknown, code?: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          log(error || code !== 0 ? "warn" : "info", "html preview finished", {
            jobId: name,
            durationMs: Date.now() - started,
            status:
              error instanceof HttpError
                ? error.status
                : error
                  ? 503
                  : code === 0
                    ? 200
                    : 503,
          });
          if (error) {
            child?.kill("SIGKILL");
            reject(error);
            return;
          }
          if (code === 124)
            return reject(
              new HttpError(
                504,
                "HTML preview exceeded its time limit. Simplify the visual before retrying.",
              ),
            );
          if (code !== 0)
            return reject(
              new HttpError(
                503,
                "HTML preview worker could not render the page. Simplify the page or publish with validation unavailable.",
              ),
            );
          try {
            const result = readHtmlPreviewResult({
              ...JSON.parse(Buffer.concat(chunks).toString("utf8")),
              durationMs: Date.now() - started,
            });
            if (result.width !== input.width) throw new Error();
            resolve(result);
          } catch {
            reject(new HttpError(502, "HTML preview returned invalid output"));
          }
        };
        const abort = () => finish(cancelled());
        const timer = setTimeout(
          () =>
            finish(
              new HttpError(
                504,
                "HTML preview exceeded its time limit. Simplify the visual before retrying.",
              ),
            ),
          this.timeoutMs,
        );
        try {
          child = this.spawn(
            this.options.docker ?? "docker",
            this.dockerArgs(name),
            { stdio: ["pipe", "pipe", "ignore"] },
          );
        } catch {
          return finish(
            new HttpError(503, "HTML preview runner is unavailable"),
          );
        }
        input.signal?.addEventListener("abort", abort, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > htmlPreviewLimits.outputBytes)
            finish(
              new HttpError(502, "HTML preview output exceeded its limit"),
            );
          else chunks.push(chunk);
        });
        child.on("error", () =>
          finish(new HttpError(503, "HTML preview runner is unavailable")),
        );
        child.on("close", (code) => finish(undefined, code));
        child.stdin?.on("error", () =>
          finish(
            new HttpError(503, "HTML preview worker stopped reading input"),
          ),
        );
        child.stdin?.end(inputPayload(input));
        if (input.signal?.aborted) abort();
      });
    } finally {
      // Stop the owned CLI before container cleanup so it cannot create/start
      // this named job after a removal request raced with cancellation.
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child?.kill("SIGKILL");
            resolve();
          }, 1000);
          child!.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          child!.kill("SIGKILL");
        });
      }
      try {
        await this.cleanup(name);
      } catch {
        this.unhealthy = true;
        log("error", "html preview cleanup failed", { jobId: name });
        throw new HttpError(
          503,
          "HTML preview cleanup failed; the renderer stopped accepting work",
        );
      }
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }
  }
}

export class HttpHtmlPreviewRunner implements HtmlPreviewRunner {
  readonly enabled = true;
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = new URL(url);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      secret.length < 32
    )
      throw new Error("Invalid private HTML preview configuration");
  }
  async run(input: HtmlPreviewInput): Promise<HtmlPreviewResult> {
    const payload = inputPayload(input),
      controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, htmlPreviewLimits.timeoutMs + 3000);
    try {
      const response = await this.fetcher(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-truex-preview-key": this.secret,
        },
        body: JSON.stringify({ ...JSON.parse(payload), scope: input.scope }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(
          [429, 503, 504].includes(response.status) ? response.status : 502,
          response.status === 429
            ? "HTML preview queue is full. Retry later."
            : "HTML preview service is unavailable. Publish with an accurate validation note.",
        );
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new HttpError(502, "HTML preview service returned no output");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > htmlPreviewLimits.outputBytes) {
          await reader.cancel();
          throw new HttpError(502, "HTML preview output exceeded its limit");
        }
        chunks.push(part.value);
      }
      const result = readHtmlPreviewResult(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (result.width !== input.width)
        throw new HttpError(502, "HTML preview returned the wrong viewport");
      return result;
    } catch (error) {
      if (input.signal?.aborted) throw cancelled();
      if (controller.signal.aborted)
        throw new HttpError(
          504,
          "HTML preview service exceeded its time limit",
        );
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "HTML preview service is unavailable");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}
export function htmlPreviewRunnerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HtmlPreviewRunner {
  if (env.HTML_PREVIEW_RUNNER === "docker")
    return new DockerHtmlPreviewRunner({ image: env.HTML_PREVIEW_IMAGE });
  if (
    env.HTML_PREVIEW_RUNNER === "http" &&
    env.HTML_PREVIEW_URL &&
    env.HTML_PREVIEW_SECRET
  )
    return new HttpHtmlPreviewRunner(
      env.HTML_PREVIEW_URL,
      env.HTML_PREVIEW_SECRET,
    );
  return new DisabledHtmlPreviewRunner();
}
