import type { ServerResponse } from "node:http";

export interface GatewayProfile {
  _id: unknown;
  baseUrl: string;
  modelName: string;
  wireApi?: string;
  apiKey?: string;
  apikey?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  /** Output cap sent to providers that require one (Anthropic, Gemini). */
  maxOutputTokens?: number;
  /**
   * false omits thinking/effort for models that reject it (e.g. claude-haiku-4-5,
   * non-thinking Gemini models). Gemini: true forces a thinking config on
   * models whose name doesn't contain "gemini".
   */
  thinking?: boolean;
  /**
   * Overrides the gateway's UPSTREAM_FIRST_BYTE_TIMEOUT_MS for this profile,
   * e.g. lower for a provider that stalls in a queue, higher for a model
   * that thinks for a long time before its first chunk. 0 disables.
   */
  firstByteTimeoutMs?: number;
  /** Operator-declared provider capabilities; ignored unless CACHE_PROVIDER_CONTROLS is enabled. */
  promptCache?: {
    /** Chat endpoint accepts prompt_cache_key. The gateway scopes the incoming key. */
    key?: boolean;
    /** Chat endpoint/model supports this specific retention value. */
    retention?: "in_memory" | "24h";
    /** Anthropic endpoint/model supports an explicit cache TTL. */
    ttl?: "5m" | "1h";
  };
}

// Everything an adapter needs for one Codex request. The adapter owns the
// response: it either streams Responses SSE via ResponsesStream or sends an
// error with sendError, never both.
export interface AdapterContext {
  profile: GatewayProfile;
  apiKey: string;
  /** The Responses API request body exactly as Codex sent it. */
  input: any;
  res: ServerResponse;
  fetch: typeof fetch;
  /** Aborted when Codex disconnects (interrupt, timeout). */
  signal: AbortSignal;
  log: (line: string) => void;
  providerCacheControls?: boolean;
  /** HMAC of verified tenant/profile and incoming key; never a raw prompt/key. */
  promptCacheKey?: string;
}

export type Adapter = (ctx: AdapterContext) => Promise<void>;
