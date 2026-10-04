import { boundedJson } from "../../shared/web-search";
import {
  webReadErrors,
  webReadLimits,
  type WebReadErrorCode,
  type WebReadInput,
  type WebReadResult,
} from "../../shared/web-read";
import {
  EgressDenied,
  publicUrl,
  vettedDestination,
  type Resolver,
} from "./egress-policy";

export class ReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: WebReadErrorCode,
    readonly retryable = false,
  ) {
    super(webReadErrors[code]);
  }
}
export interface WebReader {
  ready(): Promise<boolean>;
  read(input: WebReadInput, signal?: AbortSignal): Promise<WebReadResult>;
}
export interface CrawlPage extends WebReadResult {
  links: string[];
}
export interface CrawlPageReader {
  ready(): Promise<boolean>;
  crawlPage(
    input: WebReadInput,
    allowedHost: string,
    signal?: AbortSignal,
  ): Promise<CrawlPage>;
}
export class Crawl4aiRead implements WebReader, CrawlPageReader {
  private readonly base?: URL;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readiness?: Promise<boolean>;
  constructor(
    private readonly config: {
      url?: string;
      token?: string;
      timeoutMs?: number;
      resolver?: Resolver;
    },
  ) {
    this.timeoutMs = config.timeoutMs ?? 35_000;
    // Read configuration must not prevent the independently configured search from running.
    try {
      const base = new URL(config.url ?? "");
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.pathname !== "/" ||
        base.search ||
        base.hash ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(config.token ?? "") ||
        !Number.isInteger(this.timeoutMs) ||
        this.timeoutMs < 1 ||
        this.timeoutMs > 60_000
      )
        return;
      this.base = base;
      this.token = config.token;
    } catch {
      /* optional provider remains unavailable */
    }
  }
  ready(): Promise<boolean> {
    return (this.readiness ??= this.probe().finally(() => {
      this.readiness = undefined;
    }));
  }
  private async probe(): Promise<boolean> {
    if (!this.base) return false;
    try {
      const response = await fetch(new URL("/ready", this.base), {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const payload = (await boundedJson(response, 8192)) as any;
      return payload?.ok === true && payload?.provider === "crawl4ai";
    } catch {
      return false;
    }
  }
  async read(
    input: WebReadInput,
    signal?: AbortSignal,
  ): Promise<WebReadResult> {
    return this.fetchPage(input, signal);
  }
  async crawlPage(
    input: WebReadInput,
    allowedHost: string,
    signal?: AbortSignal,
  ): Promise<CrawlPage> {
    return this.fetchPage(input, signal, allowedHost) as Promise<CrawlPage>;
  }
  private async fetchPage(
    input: WebReadInput,
    signal?: AbortSignal,
    allowedHost?: string,
  ): Promise<WebReadResult | CrawlPage> {
    if (!this.base) throw new ReadError(503, "READ_CONFIGURATION");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const initial = publicUrl(input.url);
      if (allowedHost && initial.hostname !== allowedHost)
        throw new ReadError(403, "READ_BLOCKED");
      // Early classification is helpful, but the proxy independently repeats DNS at dial time.
      let stop: (() => void) | undefined;
      try {
        await Promise.race([
          vettedDestination(initial, this.config.resolver),
          new Promise<never>((_, reject) => {
            stop = () => reject(new Error("Stopped"));
            combined.addEventListener("abort", stop, { once: true });
            if (combined.aborted) stop();
          }),
        ]);
      } finally {
        if (stop) combined.removeEventListener("abort", stop);
      }
      combined.throwIfAborted();
      const response = await fetch(
        new URL(allowedHost ? "/crawl-page" : "/read", this.base),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: initial.href,
            maxChars: input.maxChars,
            ...(allowedHost ? { allowedHost } : {}),
          }),
          signal: combined,
          redirect: "error",
        },
      );
      if (!response.ok) {
        let code: WebReadErrorCode | undefined;
        try {
          const payload = (await boundedJson(response, 8192)) as any;
          if (
            [
              "READ_BLOCKED",
              "READ_NOT_FOUND",
              "READ_UNSUPPORTED",
              "READ_EMPTY",
              "READ_TIMEOUT",
              "READ_RATE_LIMITED",
            ].includes(payload?.code)
          )
            code = payload.code;
        } catch {
          /* Never disclose upstream diagnostics. */
        }
        if (response.status === 401 || (response.status === 403 && !code))
          throw new ReadError(503, "READ_CONFIGURATION");
        if (response.status === 429)
          throw new ReadError(429, "READ_RATE_LIMITED", true);
        if (code)
          throw new ReadError(
            code === "READ_TIMEOUT" ? 504 : response.status,
            code,
            ["READ_TIMEOUT", "READ_RATE_LIMITED"].includes(code),
          );
        throw new ReadError(503, "READ_UNAVAILABLE", true);
      }
      let payload: any;
      try {
        payload = await boundedJson(
          response,
          webReadLimits.vendorResponseBytes,
        );
      } catch {
        throw new ReadError(502, "READ_RESPONSE_INVALID");
      }
      let final: string;
      try {
        final = publicUrl(payload?.url).href;
      } catch {
        throw new ReadError(502, "READ_RESPONSE_INVALID");
      }
      if (
        payload?.provider !== "crawl4ai" ||
        payload?.requestedUrl !== initial.href ||
        !Number.isInteger(payload.statusCode) ||
        payload.statusCode < 200 ||
        payload.statusCode > 299 ||
        typeof payload.title !== "string" ||
        typeof payload.markdown !== "string" ||
        !payload.markdown.trim() ||
        payload.markdown.length > input.maxChars ||
        !Number.isInteger(payload.totalChars) ||
        payload.totalChars < payload.markdown.length ||
        payload.totalChars > webReadLimits.maxExtractedChars ||
        payload.truncated !== payload.totalChars > payload.markdown.length ||
        typeof payload.retrievedAt !== "string" ||
        !Number.isFinite(Date.parse(payload.retrievedAt)) ||
        !Array.isArray(payload.warnings) ||
        payload.warnings.some((w: unknown) => typeof w !== "string")
      )
        throw new ReadError(502, "READ_RESPONSE_INVALID");
      let links: string[] | undefined;
      if (allowedHost) {
        if (
          new URL(final).hostname !== allowedHost ||
          !Array.isArray(payload.links) ||
          payload.links.length > 1000
        )
          throw new ReadError(502, "READ_RESPONSE_INVALID");
        links = [
          ...new Set(
            payload.links.map((value: unknown) => {
              try {
                const url = publicUrl(value);
                if (url.hostname !== allowedHost) throw new Error();
                return url.href;
              } catch {
                throw new ReadError(502, "READ_RESPONSE_INVALID");
              }
            }),
          ),
        ] as string[];
      }
      return {
        ...(links ? { links } : {}),
        provider: "crawl4ai",
        requestedUrl: initial.href,
        url: final,
        title: payload.title
          .replace(/<[^>]*>/g, " ")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, webReadLimits.titleChars),
        retrievedAt: new Date(payload.retrievedAt).toISOString(),
        statusCode: payload.statusCode,
        markdown: payload.markdown.replace(
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
          " ",
        ),
        truncated: payload.truncated,
        totalChars: payload.totalChars,
        warnings: payload.warnings
          .slice(0, webReadLimits.maxWarnings)
          .map((w: string) =>
            w
              .replace(/[\u0000-\u001f\u007f]/g, " ")
              .slice(0, webReadLimits.warningChars),
          ),
      };
    } catch (error) {
      if (signal?.aborted) throw new ReadError(499, "READ_CANCELLED");
      if (timeout.aborted) throw new ReadError(504, "READ_TIMEOUT", true);
      if (error instanceof EgressDenied)
        throw new ReadError(403, "READ_BLOCKED");
      if (error instanceof ReadError) throw error;
      throw new ReadError(503, "READ_UNAVAILABLE", true);
    }
  }
}
