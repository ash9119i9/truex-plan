import { HttpError } from "./errors";
import {
  normalizeWebReadUrl,
  parseWebReadInput,
  webReadErrors,
  webReadLimits,
  WebReadInputError,
  type WebReadErrorCode,
  type WebReadResult,
} from "../../shared/web-read";
import { boundedJson } from "../../shared/web-search";

export class WebReadError extends HttpError {}

export interface WebReadConfig {
  url: string;
  token: string;
  timeoutMs?: number;
}

export class WebReadTools {
  readonly enabled = true;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  constructor(private readonly config: WebReadConfig) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error("Invalid WebRead service configuration");
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
      throw new Error("Invalid WebRead service configuration");
    this.endpoint = new URL("/read", url);
    this.timeoutMs = config.timeoutMs ?? 50_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    )
      throw new Error("Invalid WebRead timeout");
  }

  async execute(args: unknown, signal?: AbortSignal): Promise<WebReadResult> {
    let input;
    try {
      input = parseWebReadInput(args);
    } catch (error) {
      throw new WebReadError(
        400,
        error instanceof WebReadInputError
          ? error.message
          : webReadErrors.INVALID_ARGUMENT,
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
        raw = await boundedJson(response, webReadLimits.responseBytes);
      } catch {
        const code = response.ok
          ? "READ_RESPONSE_INVALID"
          : response.status === 401 || response.status === 403
            ? "READ_CONFIGURATION"
            : "READ_UNAVAILABLE";
        throw new WebReadError(
          response.ok ? 502 : response.status,
          webReadErrors[code],
          code,
        );
      }
      if (!response.ok) {
        const returnedCode = (raw as any)?.code;
        const code: WebReadErrorCode =
          typeof returnedCode === "string" &&
          Object.hasOwn(webReadErrors, returnedCode)
            ? (returnedCode as WebReadErrorCode)
            : response.status === 401 || response.status === 403
              ? "READ_CONFIGURATION"
              : "READ_UNAVAILABLE";
        throw new WebReadError(response.status, webReadErrors[code], code);
      }
      if (!validResult(raw, input.url, input.maxChars))
        throw new WebReadError(
          502,
          webReadErrors.READ_RESPONSE_INVALID,
          "READ_RESPONSE_INVALID",
        );
      // Project just the contract: do not hand arbitrary service fields to a model.
      return {
        provider: "crawl4ai",
        requestedUrl: raw.requestedUrl,
        url: raw.url,
        title: raw.title,
        retrievedAt: raw.retrievedAt,
        statusCode: raw.statusCode,
        markdown: raw.markdown,
        truncated: raw.truncated,
        totalChars: raw.totalChars,
        warnings: raw.warnings,
      };
    } catch (error) {
      if (signal?.aborted)
        throw new WebReadError(
          499,
          webReadErrors.READ_CANCELLED,
          "READ_CANCELLED",
        );
      if (timeout.aborted)
        throw new WebReadError(504, webReadErrors.READ_TIMEOUT, "READ_TIMEOUT");
      if (error instanceof WebReadError) throw error;
      throw new WebReadError(
        503,
        webReadErrors.READ_UNAVAILABLE,
        "READ_UNAVAILABLE",
      );
    }
  }
}

function validResult(
  raw: unknown,
  requestedUrl: string,
  maxChars: number,
): raw is WebReadResult {
  const r = raw as WebReadResult | null;
  if (
    !r ||
    r.provider !== "crawl4ai" ||
    r.requestedUrl !== requestedUrl ||
    typeof r.url !== "string" ||
    typeof r.title !== "string" ||
    r.title.length > webReadLimits.titleChars ||
    typeof r.retrievedAt !== "string" ||
    Number.isNaN(Date.parse(r.retrievedAt)) ||
    !Number.isInteger(r.statusCode) ||
    r.statusCode < 200 ||
    r.statusCode > 299 ||
    typeof r.markdown !== "string" ||
    !r.markdown.trim() ||
    r.markdown.length > maxChars ||
    typeof r.truncated !== "boolean" ||
    !Number.isSafeInteger(r.totalChars) ||
    r.totalChars < r.markdown.length ||
    r.totalChars > webReadLimits.maxExtractedChars ||
    r.truncated !== r.totalChars > r.markdown.length ||
    !Array.isArray(r.warnings) ||
    r.warnings.length > webReadLimits.maxWarnings ||
    r.warnings.some(
      (w) => typeof w !== "string" || w.length > webReadLimits.warningChars,
    )
  )
    return false;
  try {
    return (
      normalizeWebReadUrl(r.requestedUrl) === r.requestedUrl &&
      normalizeWebReadUrl(r.url) === r.url
    );
  } catch {
    return false;
  }
}

export function webReadFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebReadTools | null {
  if (env.WEB_READ?.trim().toLowerCase() !== "on") return null;
  if (!env.WEB_SERVICE_URL || !env.WEB_SERVICE_TOKEN)
    throw new Error(
      "WEB_READ=on requires WEB_SERVICE_URL and WEB_SERVICE_TOKEN",
    );
  return new WebReadTools({
    url: env.WEB_SERVICE_URL,
    token: env.WEB_SERVICE_TOKEN,
    ...(env.WEB_READ_TIMEOUT_MS
      ? { timeoutMs: Number(env.WEB_READ_TIMEOUT_MS) }
      : {}),
  });
}
