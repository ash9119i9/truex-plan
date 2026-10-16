import type { ObjectId } from "mongodb";
import {
  cleanText,
  integer,
  invalid,
  objectWith,
  oneOf,
} from "../../common/validation";

// A model profile in the catalog's `truex_models`, written only by the product
// team through the operator CLI. The model gateway reads the same document on
// every request (`model-gateway/src/adapter.ts` GatewayProfile), so the
// gateway's fields keep its names. Users only ever see ModelView.
export const MODELS_COLLECTION = "truex_models";

// Routes the gateway can translate. Codex speaks only the Responses API, so
// every platform-next model goes through the gateway.
export const WIRE_APIS = ["anthropic", "gemini", "chat"] as const;
export type WireApi = (typeof WIRE_APIS)[number];

export const MODEL_FAMILIES = [
  "anthropic",
  "google",
  "openai",
  "other",
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// Mirrors the gateway's validation in model-gateway/src/prompt-cache.ts, so a
// bad policy is refused when it is saved rather than on a user's request.
export type PromptCachePolicy =
  | {
      type: "anthropic";
      enabled?: boolean;
      ttl?: "5m" | "1h";
      conversationBreakpoint?: boolean;
    }
  | {
      type: "chat";
      keyScope?: "session" | "prefix";
      retention?: "in_memory" | "24h";
    };

// Everything the product team supplies for one model.
export interface ModelSpec {
  slug: string;
  displayName: string;
  shortLabel: string;
  family: ModelFamily;
  wireApi: WireApi;
  baseUrl: string;
  modelName: string;
  apiKeySecretArn?: string;
  // Development only: a plaintext key, accepted with an explicit flag.
  apiKey?: string;
  maxOutputTokens: number;
  contextWindow: number;
  autoCompactTokenLimit: number;
  thinking?: boolean;
  firstByteTimeoutMs?: number;
  // Not read by the gateway: the platform passes it to Codex per thread
  // (with contextWindow and autoCompactTokenLimit).
  reasoningEffort?: ReasoningEffort;
  promptCache?: PromptCachePolicy;
  sortOrder: number;
}

export interface ModelDoc extends ModelSpec {
  _id: ObjectId;
  // Soft delete: chats pin a model's ID, so documents are never removed.
  enabled: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

// Changing any of these would silently switch existing chats to a different
// model. A different model is a new profile.
export const MODEL_IDENTITY_FIELDS = [
  "wireApi",
  "baseUrl",
  "modelName",
] as const;

// What a member may see. No URLs, credentials or limits.
export interface ModelView {
  id: string;
  displayName: string;
  shortLabel: string;
  family: ModelFamily;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const MODEL_NAME = /^[\x21-\x7e]{1,200}$/;
const SECRET_ARN =
  /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const SPEC_FIELDS = [
  "slug",
  "displayName",
  "shortLabel",
  "family",
  "wireApi",
  "baseUrl",
  "modelName",
  "apiKeySecretArn",
  "apiKey",
  "maxOutputTokens",
  "contextWindow",
  "autoCompactTokenLimit",
  "thinking",
  "firstByteTimeoutMs",
  "reasoningEffort",
  "promptCache",
  "sortOrder",
];

export interface ParseModelOptions {
  // Allows a plaintext `apiKey` and an http loopback `baseUrl`, for local
  // development against a fixture provider.
  allowDevCredentials?: boolean;
}

function optional<T>(value: unknown, parse: (v: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function baseUrlOf(value: unknown, allowDev: boolean): string {
  if (typeof value !== "string" || value.length > 2048)
    invalid("baseUrl must be a URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("baseUrl must be a URL.");
  }
  const loopbackHttp =
    allowDev && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp)
    invalid("baseUrl must use https.");
  if (url.username || url.password || url.search || url.hash)
    invalid("baseUrl must not contain credentials, a query or a fragment.");
  // The gateway appends its own paths; keep exactly what was given, minus a
  // trailing slash, so comparisons are stable.
  return url.href.replace(/\/+$/, "");
}

function promptCacheOf(value: unknown, wireApi: WireApi): PromptCachePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("promptCache must be an object.");
  const p = value as Record<string, unknown>;
  if (p.type !== wireApi || (p.type !== "anthropic" && p.type !== "chat"))
    invalid("promptCache.type must match an anthropic or chat wireApi.");
  const allowed =
    p.type === "anthropic"
      ? ["type", "enabled", "ttl", "conversationBreakpoint"]
      : ["type", "keyScope", "retention"];
  for (const key of Object.keys(p))
    if (!allowed.includes(key)) invalid(`promptCache.${key} is not supported.`);
  const bool = (key: string) => {
    if (p[key] !== undefined && typeof p[key] !== "boolean")
      invalid(`promptCache.${key} must be true or false.`);
  };
  if (p.type === "anthropic") {
    if (p.ttl !== undefined && p.ttl !== "5m" && p.ttl !== "1h")
      invalid("promptCache.ttl must be 5m or 1h.");
    bool("enabled");
    bool("conversationBreakpoint");
  } else {
    if (
      p.keyScope !== undefined &&
      p.keyScope !== "session" &&
      p.keyScope !== "prefix"
    )
      invalid("promptCache.keyScope must be session or prefix.");
    if (
      p.retention !== undefined &&
      p.retention !== "in_memory" &&
      p.retention !== "24h"
    )
      invalid("promptCache.retention must be in_memory or 24h.");
  }
  return { ...p } as PromptCachePolicy;
}

// Validates one model definition. Unknown fields are refused, so a typo can
// never be stored as a setting nobody reads.
export function parseModelSpec(
  input: unknown,
  options: ParseModelOptions = {},
): ModelSpec {
  const raw = objectWith(input, SPEC_FIELDS, "The model definition");
  const allowDev = options.allowDevCredentials === true;

  if (typeof raw.slug !== "string" || !SLUG.test(raw.slug))
    invalid(
      "slug must be 1-48 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
    );
  const wireApi = oneOf(raw.wireApi, "wireApi", WIRE_APIS);
  if (typeof raw.modelName !== "string" || !MODEL_NAME.test(raw.modelName))
    invalid("modelName must be 1-200 visible characters with no spaces.");

  if (raw.apiKey !== undefined) {
    if (!allowDev)
      invalid(
        "apiKey is for local development only; store the key in Secrets Manager and set apiKeySecretArn.",
      );
    if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0)
      invalid("apiKey must be a non-empty string.");
  }
  if (raw.apiKeySecretArn !== undefined) {
    if (
      typeof raw.apiKeySecretArn !== "string" ||
      !SECRET_ARN.test(raw.apiKeySecretArn)
    )
      invalid("apiKeySecretArn must be a Secrets Manager secret ARN.");
  }
  if ((raw.apiKey === undefined) === (raw.apiKeySecretArn === undefined))
    invalid("Set exactly one of apiKeySecretArn or apiKey.");

  const contextWindow = integer(
    raw.contextWindow,
    "contextWindow",
    1_000,
    10_000_000,
  );
  const autoCompactTokenLimit = integer(
    raw.autoCompactTokenLimit,
    "autoCompactTokenLimit",
    500,
    10_000_000,
  );
  if (autoCompactTokenLimit >= contextWindow)
    invalid("autoCompactTokenLimit must be smaller than contextWindow.");
  const maxOutputTokens = integer(
    raw.maxOutputTokens,
    "maxOutputTokens",
    1,
    1_000_000,
  );
  if (maxOutputTokens >= contextWindow)
    invalid("maxOutputTokens must be smaller than contextWindow.");

  const spec: ModelSpec = {
    slug: raw.slug,
    displayName: cleanText(raw.displayName, "displayName", 60),
    shortLabel: cleanText(raw.shortLabel, "shortLabel", 24),
    family: oneOf(raw.family, "family", MODEL_FAMILIES),
    wireApi,
    baseUrl: baseUrlOf(raw.baseUrl, allowDev),
    modelName: raw.modelName,
    maxOutputTokens,
    contextWindow,
    autoCompactTokenLimit,
    sortOrder: integer(raw.sortOrder ?? 100, "sortOrder", 0, 100_000),
  };
  if (typeof raw.apiKeySecretArn === "string")
    spec.apiKeySecretArn = raw.apiKeySecretArn;
  if (typeof raw.apiKey === "string") spec.apiKey = raw.apiKey;
  const thinking = optional(raw.thinking, (v) => {
    if (typeof v !== "boolean") invalid("thinking must be true or false.");
    return v;
  });
  if (thinking !== undefined) spec.thinking = thinking;
  const firstByte = optional(raw.firstByteTimeoutMs, (v) =>
    integer(v, "firstByteTimeoutMs", 0, 600_000),
  );
  if (firstByte !== undefined) spec.firstByteTimeoutMs = firstByte;
  const effort = optional(raw.reasoningEffort, (v) =>
    oneOf(v, "reasoningEffort", REASONING_EFFORTS),
  );
  if (effort !== undefined) spec.reasoningEffort = effort;
  const cache = optional(raw.promptCache, (v) => promptCacheOf(v, wireApi));
  if (cache !== undefined) spec.promptCache = cache;
  return spec;
}

export function modelView(model: ModelDoc): ModelView {
  return {
    id: model._id.toHexString(),
    displayName: model.displayName,
    shortLabel: model.shortLabel,
    family: model.family,
  };
}
