import type { ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { Usage } from "./responses";

// Facts recorded where a response is written (ResponsesStream, sendError), so
// the server logs one line per request without adapters reporting anything.
interface Recorded {
  firstByteAt?: number;
  outcome?: string;
  errorCode?: string;
  usage?: Usage;
  rateLimit?: RateLimit;
}

// Provider rate-limit headers and retry-after, e.g. x-ratelimit-remaining-tokens
// -> remainingTokens, anthropic-ratelimit-requests-limit ->
// anthropicRequestsLimit. Counts become numbers; reset values stay strings
// ("1s", "6m0s" or an RFC 3339 time) since providers disagree on the format.
export type RateLimit = Record<string, number | string>;
const RATE_HEADER = /^(x-ratelimit-|anthropic-ratelimit-)([a-z0-9-]{1,48})$/;
const camel = (s: string) =>
  s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

export function rateLimitHeaders(headers: Headers): RateLimit | undefined {
  const out: RateLimit = {};
  headers.forEach((value, name) => {
    const m = RATE_HEADER.exec(name.toLowerCase());
    if (!m && name.toLowerCase() !== "retry-after") return;
    const field = m
      ? camel((m[1] === "anthropic-ratelimit-" ? "anthropic-" : "") + m[2])
      : "retryAfter";
    const text = value.trim().slice(0, 64);
    const n = Number(text);
    out[field] =
      text !== "" && Number.isFinite(n) && !/reset/i.test(field) ? n : text;
  });
  return Object.keys(out).length ? out : undefined;
}

const recorded = new WeakMap<ServerResponse, Recorded>();

export function record(res: ServerResponse, facts: Recorded) {
  const current = recorded.get(res) ?? {};
  recorded.set(res, {
    ...current,
    ...facts,
    firstByteAt: current.firstByteAt ?? facts.firstByteAt,
  });
}

export interface RequestMeta {
  requestId: string;
  profileId?: string;
  // From the token, for per-tenant usage only; it grants nothing.
  tenantId?: string;
  wireApi?: string;
  model?: string;
}

// One JSON line per model request. Never includes bodies, prompts, tokens or
// provider keys: only ids, timings, status and token counts.
export function accessLogLine(
  meta: RequestMeta,
  res: ServerResponse,
  startedAt: number,
) {
  const r = recorded.get(res) ?? {};
  return JSON.stringify({
    ts: new Date().toISOString(),
    type: "access",
    requestId: meta.requestId,
    profileId: meta.profileId,
    tenantId: meta.tenantId,
    wireApi: meta.wireApi,
    model: meta.model,
    status: res.statusCode,
    // A response that never finished was cut off: Codex disconnected or the
    // connection was force-closed on shutdown.
    outcome: r.outcome ?? (res.writableFinished ? "unknown" : "client_closed"),
    errorCode: r.errorCode,
    durationMs: Math.round(performance.now() - startedAt),
    ttfbMs:
      r.firstByteAt === undefined
        ? undefined
        : Math.round(r.firstByteAt - startedAt),
    usage: r.usage && {
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      total_tokens: r.usage.total_tokens,
      ...(r.usage.cached_tokens !== undefined
        ? { cached_tokens: r.usage.cached_tokens }
        : {}),
      ...(r.usage.cache_write_tokens !== undefined
        ? { cache_write_tokens: r.usage.cache_write_tokens }
        : {}),
      ...(r.usage.cached_tokens !== undefined ||
      r.usage.cache_write_tokens !== undefined
        ? {
            uncached_input_tokens: Math.max(
              0,
              r.usage.input_tokens -
                (r.usage.cached_tokens ?? 0) -
                (r.usage.cache_write_tokens ?? 0),
            ),
          }
        : {}),
    },
    rateLimit: r.rateLimit,
  });
}
