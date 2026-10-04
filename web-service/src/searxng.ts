import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import {
  boundedJson,
  type WebSearchInput,
  type WebSearchResult,
} from "../../shared/web-search";
import { SearchError } from "./errors";

export interface SearxngConfig {
  url: string;
  timeoutMs?: number;
}

const blocked4 = new BlockList();
for (const [ip, mask] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked4.addSubnet(ip, mask);
const blocked6 = new BlockList();
for (const [ip, mask] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(ip, mask, "ipv6");

/** No page fetch happens here; URLs are validated for safe citation links. */
export function resultUrl(value: unknown): URL | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    const host = url.hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !["80", "443"].includes(url.port)) ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      (!host.includes(".") && isIP(host) !== 6) ||
      (isIP(host) === 4 && blocked4.check(host, "ipv4")) ||
      (isIP(host) === 6 && blocked6.check(host, "ipv6"))
    )
      return null;
    url.hash = "";
    if (isIP(host) !== 6) url.hostname = host;
    if (url.href.length > 2048) return null;
    return url;
  } catch {
    return null;
  }
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .slice(0, max * 8)
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, entity: string) => {
        if (entity[0] !== "#") return entities[entity.toLowerCase()] ?? whole;
        const point =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : " ";
      },
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export class SearxngSearch {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readiness?: Promise<boolean>;
  constructor(config: SearxngConfig) {
    try {
      this.base = new URL(config.url);
    } catch {
      throw new Error("Invalid SEARXNG_URL; use a trusted HTTP(S) base URL");
    }
    if (
      !["http:", "https:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/"
    )
      throw new Error("Invalid SEARXNG_URL; use a trusted HTTP(S) base URL");
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000
    )
      throw new Error("Invalid SEARCH_TIMEOUT_MS");
  }

  ready(): Promise<boolean> {
    // Concurrent health probes share one bounded upstream request.
    return (this.readiness ??= this.probeReady().finally(() => {
      this.readiness = undefined;
    }));
  }

  private async probeReady(): Promise<boolean> {
    try {
      const response = await fetch(new URL("/config", this.base), {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const config = (await boundedJson(response, 256 * 1024)) as any;
      // /config reports engines/version, not enabled output formats. The real
      // JSON search contract is checked by the smoke test and every search.
      return (
        Array.isArray(config?.engines) && typeof config?.version === "string"
      );
    } catch {
      return false;
    }
  }

  async search(
    input: WebSearchInput,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const url = new URL("/search", this.base);
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    url.searchParams.set("pageno", "1");
    if (input.language) url.searchParams.set("language", input.language);
    if (input.timeRange) url.searchParams.set("time_range", input.timeRange);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403)
          throw new SearchError(503, "SEARCH_CONFIGURATION");
        if (response.status === 429)
          throw new SearchError(429, "SEARCH_RATE_LIMITED", true);
        throw new SearchError(503, "SEARCH_UNAVAILABLE", true);
      }
      let payload: any;
      try {
        payload = await boundedJson(response, 1024 * 1024);
      } catch {
        throw new SearchError(502, "SEARCH_RESPONSE_INVALID");
      }
      if (!payload || !Array.isArray(payload.results))
        throw new SearchError(502, "SEARCH_RESPONSE_INVALID");
      const results: WebSearchResult["results"] = [];
      const seen = new Set<string>();
      let omitted = false;
      for (const item of payload.results.slice(0, 500)) {
        const parsed = resultUrl(item?.url);
        if (!parsed) {
          omitted = true;
          continue;
        }
        if (
          input.domains?.length &&
          !input.domains.some(
            (domain) =>
              parsed.hostname === domain ||
              parsed.hostname.endsWith(`.${domain}`),
          )
        )
          continue;
        const normalized = parsed.href;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        results.push({
          sourceId: `search_${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`,
          url: normalized,
          title: text(item.title, 300) || parsed.hostname,
          snippet: text(item.content, 1500),
          engines: [
            ...new Set(
              (Array.isArray(item.engines) ? item.engines : [item.engine])
                .map((engine: unknown) => text(engine, 64))
                .filter(Boolean),
            ),
          ].slice(0, 10) as string[],
        });
        if (results.length >= input.limit) break;
      }
      const warnings: string[] = [];
      if (
        Array.isArray(payload.unresponsive_engines) &&
        payload.unresponsive_engines.length
      )
        warnings.push(
          "Some search engines did not respond. Results may be incomplete.",
        );
      if (omitted)
        warnings.push("Unsafe or malformed result URLs were omitted.");
      if (input.domains?.length && results.length < input.limit)
        warnings.push(
          "Domain filtering is applied to the first result page; fewer matching results may be available.",
        );
      return {
        provider: "searxng",
        query: input.query,
        searchedAt: new Date().toISOString(),
        results,
        warnings,
      };
    } catch (error) {
      if (signal?.aborted) throw new SearchError(499, "SEARCH_CANCELLED");
      if (timeout.aborted) throw new SearchError(504, "SEARCH_TIMEOUT", true);
      if (error instanceof SearchError) throw error;
      throw new SearchError(503, "SEARCH_UNAVAILABLE", true);
    }
  }
}
