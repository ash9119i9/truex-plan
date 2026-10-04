import { HttpError } from "./errors";
import {
  boundedJson,
  parseWebSearchInput,
  webSearchErrors,
  webSearchLimits,
  WebSearchInputError,
  type WebSearchErrorCode,
  type WebSearchResult,
} from "../../shared/web-search";

export class WebSearchError extends HttpError {}

export interface WebSearchConfig {
  url: string;
  token: string;
  timeoutMs?: number;
}

export class WebSearchTools {
  readonly enabled = true;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  constructor(private readonly config: WebSearchConfig) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error("Invalid WebSearch service configuration");
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
      throw new Error("Invalid WebSearch service configuration");
    this.endpoint = new URL("/search", url);
    this.timeoutMs = config.timeoutMs ?? 20_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000
    )
      throw new Error("Invalid WebSearch timeout");
  }

  async execute(args: unknown, signal?: AbortSignal): Promise<WebSearchResult> {
    let input;
    try {
      input = parseWebSearchInput(args);
    } catch (error) {
      throw new WebSearchError(
        400,
        error instanceof WebSearchInputError
          ? error.message
          : webSearchErrors.INVALID_ARGUMENT,
        "INVALID_ARGUMENT",
      );
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
        redirect: "error",
        signal: combined,
      });
      let raw: unknown;
      try {
        raw = await boundedJson(response, webSearchLimits.responseBytes);
      } catch {
        const code = response.ok
          ? "SEARCH_RESPONSE_INVALID"
          : response.status === 401 || response.status === 403
            ? "SEARCH_CONFIGURATION"
            : "SEARCH_UNAVAILABLE";
        throw new WebSearchError(
          response.ok ? 502 : response.status,
          webSearchErrors[code],
          code,
        );
      }
      if (!response.ok) {
        const returnedCode = (raw as any)?.code;
        const code: WebSearchErrorCode =
          typeof returnedCode === "string" &&
          Object.hasOwn(webSearchErrors, returnedCode)
            ? (returnedCode as WebSearchErrorCode)
            : response.status === 401 || response.status === 403
              ? "SEARCH_CONFIGURATION"
              : "SEARCH_UNAVAILABLE";
        throw new WebSearchError(response.status, webSearchErrors[code], code);
      }
      if (!validResult(raw, input.query, input.limit))
        throw new WebSearchError(
          502,
          webSearchErrors.SEARCH_RESPONSE_INVALID,
          "SEARCH_RESPONSE_INVALID",
        );
      // Project just the contract: do not hand arbitrary service fields to a model.
      return {
        provider: "searxng",
        query: raw.query,
        searchedAt: raw.searchedAt,
        results: raw.results.map(
          ({ sourceId, url, title, snippet, engines }) => ({
            sourceId,
            url,
            title,
            snippet,
            engines,
          }),
        ),
        warnings: raw.warnings,
      };
    } catch (error) {
      if (signal?.aborted)
        throw new WebSearchError(
          499,
          webSearchErrors.SEARCH_CANCELLED,
          "SEARCH_CANCELLED",
        );
      if (timeout.aborted)
        throw new WebSearchError(
          504,
          webSearchErrors.SEARCH_TIMEOUT,
          "SEARCH_TIMEOUT",
        );
      if (error instanceof WebSearchError) throw error;
      throw new WebSearchError(
        503,
        webSearchErrors.SEARCH_UNAVAILABLE,
        "SEARCH_UNAVAILABLE",
      );
    }
  }
}

function validResult(
  raw: unknown,
  query: string,
  limit: number,
): raw is WebSearchResult {
  const r = raw as WebSearchResult | null;
  return (
    !!r &&
    r.provider === "searxng" &&
    r.query === query &&
    typeof r.searchedAt === "string" &&
    !Number.isNaN(Date.parse(r.searchedAt)) &&
    Array.isArray(r.results) &&
    r.results.length <= limit &&
    r.results.every((s) => {
      if (
        !s ||
        typeof s.sourceId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(s.sourceId) ||
        typeof s.url !== "string" ||
        s.url.length > 2048 ||
        typeof s.title !== "string" ||
        s.title.length > 300 ||
        typeof s.snippet !== "string" ||
        s.snippet.length > 1500 ||
        !Array.isArray(s.engines) ||
        s.engines.length > 10 ||
        s.engines.some((e) => typeof e !== "string" || e.length > 64)
      )
        return false;
      try {
        const url = new URL(s.url);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    }) &&
    Array.isArray(r.warnings) &&
    r.warnings.length <= 5 &&
    r.warnings.every((w) => typeof w === "string" && w.length <= 300)
  );
}

export function webSearchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchTools | null {
  if (env.WEB_SEARCH?.trim().toLowerCase() !== "on") return null;
  if (!env.WEB_SERVICE_URL || !env.WEB_SERVICE_TOKEN)
    throw new Error(
      "WEB_SEARCH=on requires WEB_SERVICE_URL and WEB_SERVICE_TOKEN",
    );
  return new WebSearchTools({
    url: env.WEB_SERVICE_URL,
    token: env.WEB_SERVICE_TOKEN,
    ...(env.WEB_SEARCH_TIMEOUT_MS
      ? { timeoutMs: Number(env.WEB_SEARCH_TIMEOUT_MS) }
      : {}),
  });
}
