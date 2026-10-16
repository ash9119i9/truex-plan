import { AdapterError } from "./errors";
import type { RuntimeLimits } from "./config";

// Validates the platform's requests. Unknown fields are rejected so a typo or
// an attempt to pass raw Codex configuration fails loudly. Messages name the
// field and never echo the rejected value.

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Codex thread IDs are UUIDs; anything else is refused before it reaches RPC.
const THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
const MODEL_NAME = /^[A-Za-z0-9._:/@-]{1,128}$/;
const REASONING = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const MAX_TEXT = 32_000;
export const MAX_PROMPT = 40_000;

export interface ModelSettings {
  readonly modelName: string;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly contextWindow: number;
  readonly autoCompactTokenLimit: number;
  readonly reasoningEffort?: (typeof REASONING)[number];
}

export interface StartRunRequest {
  readonly runId: string;
  readonly tenantId: string;
  readonly chatId: string;
  readonly threadId: string | null;
  readonly input: { readonly text: string; readonly clientMessageId: string };
  readonly agentPrompt: string;
  readonly model: ModelSettings;
  readonly limits: {
    readonly firstResponseMs: number;
    readonly silenceMs: number;
  };
}

export interface ChatRef {
  readonly tenantId: string;
  readonly chatId: string;
}

function invalid(message: string): never {
  throw new AdapterError("INVALID_REQUEST", message);
}

function object(
  value: unknown,
  allowed: readonly string[],
  what: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${what} must be a JSON object.`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(`Unknown field "${key.slice(0, 64)}".`);
  return value as Record<string, unknown>;
}

export function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value))
    invalid(`${field} must be 1-64 letters, digits, "_" or "-".`);
  return value;
}

function text(value: unknown, field: string, max: number, trim: boolean) {
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  const normalized = value.normalize("NFC");
  const visible = trim ? normalized.trim() : normalized;
  if (visible.trim().length === 0 || visible.length > max)
    invalid(`${field} must be 1-${max} characters.`);
  return visible;
}

// Message text keeps newlines and tabs; other control and invisible format
// characters (bidi overrides and the like) are refused.
function messageText(value: unknown): string {
  const value_ = text(value, "input.text", MAX_TEXT, false);
  if (UNSAFE_TEXT.test(value_.replace(/[\n\r\t]/g, "")))
    invalid("input.text contains unsupported control characters.");
  return value_;
}

function integer(value: unknown, field: string, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    invalid(`${field} must be a whole number from ${min} to ${max}.`);
  return value;
}

function gatewayUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    invalid("model.gatewayUrl must be a URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("model.gatewayUrl must be a URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid(
      "model.gatewayUrl must be an http(s) URL without credentials or query.",
    );
  return value.replace(/\/+$/, "");
}

function model(value: unknown): ModelSettings {
  const m = object(
    value,
    [
      "modelName",
      "gatewayUrl",
      "gatewayToken",
      "contextWindow",
      "autoCompactTokenLimit",
      "reasoningEffort",
    ],
    "model",
  );
  if (typeof m.modelName !== "string" || !MODEL_NAME.test(m.modelName))
    invalid("model.modelName is invalid.");
  if (
    typeof m.gatewayToken !== "string" ||
    m.gatewayToken.length < 16 ||
    m.gatewayToken.length > 4096 ||
    /\s/.test(m.gatewayToken)
  )
    invalid("model.gatewayToken is invalid.");
  const contextWindow = integer(
    m.contextWindow,
    "model.contextWindow",
    1024,
    10_000_000,
  );
  const autoCompactTokenLimit = integer(
    m.autoCompactTokenLimit,
    "model.autoCompactTokenLimit",
    512,
    10_000_000,
  );
  if (autoCompactTokenLimit >= contextWindow)
    invalid("model.autoCompactTokenLimit must be below model.contextWindow.");
  let reasoningEffort: ModelSettings["reasoningEffort"];
  if (m.reasoningEffort !== undefined) {
    if (!REASONING.includes(m.reasoningEffort as never))
      invalid(`model.reasoningEffort must be one of: ${REASONING.join(", ")}.`);
    reasoningEffort = m.reasoningEffort as ModelSettings["reasoningEffort"];
  }
  return {
    modelName: m.modelName,
    gatewayUrl: gatewayUrl(m.gatewayUrl),
    gatewayToken: m.gatewayToken,
    contextWindow,
    autoCompactTokenLimit,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function parseStartRun(
  body: unknown,
  limits: RuntimeLimits,
): StartRunRequest {
  const b = object(
    body,
    [
      "runId",
      "tenantId",
      "chatId",
      "threadId",
      "input",
      "agentPrompt",
      "model",
      "limits",
    ],
    "Request body",
  );
  let threadId: string | null = null;
  if (b.threadId !== null && b.threadId !== undefined) {
    if (typeof b.threadId !== "string" || !THREAD_ID.test(b.threadId))
      invalid("threadId must be a Codex thread ID or null.");
    threadId = b.threadId;
  }
  const input = object(b.input, ["text", "clientMessageId"], "input");
  let firstResponseMs = limits.firstResponseMs;
  let silenceMs = limits.silenceMs;
  if (b.limits !== undefined) {
    const l = object(b.limits, ["firstResponseMs", "silenceMs"], "limits");
    if (l.firstResponseMs !== undefined)
      firstResponseMs = integer(
        l.firstResponseMs,
        "limits.firstResponseMs",
        1000,
        limits.firstResponseMs,
      );
    if (l.silenceMs !== undefined)
      silenceMs = integer(
        l.silenceMs,
        "limits.silenceMs",
        1000,
        limits.silenceMs,
      );
  }
  return {
    runId: id(b.runId, "runId"),
    tenantId: id(b.tenantId, "tenantId"),
    chatId: id(b.chatId, "chatId"),
    threadId,
    input: {
      text: messageText(input.text),
      clientMessageId: id(input.clientMessageId, "input.clientMessageId"),
    },
    agentPrompt: text(b.agentPrompt, "agentPrompt", MAX_PROMPT, true),
    model: model(b.model),
    limits: { firstResponseMs, silenceMs },
  };
}

export function parseChatRef(value: unknown): ChatRef {
  const b = object(value, ["tenantId", "chatId"], "Request");
  return {
    tenantId: id(b.tenantId, "tenantId"),
    chatId: id(b.chatId, "chatId"),
  };
}
