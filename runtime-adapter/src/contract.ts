import { AdapterError } from "./errors";
import type { RuntimeLimits } from "./config";

// Validates the platform's requests. Unknown fields are rejected so a typo or
// an attempt to pass raw Codex configuration fails loudly. Messages name the
// field and never echo the rejected value.

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Codex thread IDs are UUIDs; anything else is refused before it reaches RPC.
const THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Control characters and the bidi embedding/override/isolate controls. Other
// format characters stay: emoji sequences and many scripts need them.
const UNSAFE_TEXT = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const MODEL_NAME = /^[A-Za-z0-9._:/@-]{1,128}$/;
// An MCP server name is the connector slug; it becomes Codex's server name.
const MCP_NAME = /^[a-z][a-z0-9_]{1,30}$/;
// HTTP header name token (RFC 7230 subset the platform allows).
const MCP_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// A header value must be a single line with no NUL; CR/LF would split headers.
const MCP_HEADER_VALUE_UNSAFE = /[\r\n\u0000]/;
// A tool name the caller may allow-list (defence in depth over the server).
const MCP_TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
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
export const MAX_MCP_SERVERS = 3;
export const MAX_MCP_HEADERS = 16;
export const MAX_MCP_HEADER_VALUE = 8192;
export const MAX_MCP_ENABLED_TOOLS = 200;

export interface ModelSettings {
  readonly modelName: string;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly contextWindow: number;
  readonly autoCompactTokenLimit: number;
  readonly reasoningEffort?: (typeof REASONING)[number];
}

// One directory connector for a run. The platform resolves the user's token
// into `headers` (an `Authorization: Bearer …` value in v1); the adapter never
// sees a provider URL beyond this and never logs the header values. The
// adapter always forces Codex's `default_tools_approval_mode = "auto"`, so a
// tool not marked read-only asks for approval. `approvedTools` are the ones
// the member allowed for this chat: the adapter answers their approval
// requests itself. It can only skip a question, never widen `enabledTools`.
export interface McpServerSpec {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabledTools?: readonly string[];
  readonly approvedTools?: readonly string[];
  readonly toolTimeoutSec: number;
  readonly startupTimeoutSec: number;
}

// Parse-time options the server supplies from startup configuration, so a
// per-request body can never relax them.
export interface ParseOptions {
  readonly allowLoopbackMcp?: boolean;
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
    // How long a tool approval waits for the member before it is declined.
    readonly approvalMs: number;
  };
  // Absent or empty means today's text-only behaviour, byte for byte.
  readonly mcp?: readonly McpServerSpec[];
}

export interface ChatRef {
  readonly tenantId: string;
  readonly chatId: string;
}

export type ApprovalAnswer = "allow" | "allow_for_chat" | "deny";
const APPROVAL_ANSWERS: readonly ApprovalAnswer[] = [
  "allow",
  "allow_for_chat",
  "deny",
];

export interface ApprovalRequest {
  readonly tenantId: string;
  readonly chatId: string;
  readonly decision: ApprovalAnswer;
}

export interface SteerRequest {
  readonly tenantId: string;
  readonly chatId: string;
  readonly input: { readonly text: string; readonly clientMessageId: string };
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

// Message text keeps newlines and tabs; other control characters and bidi
// overrides are refused.
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

// An MCP server URL is stricter than the gateway URL: https only, and never
// with credentials, a query or a fragment. http is accepted only for a
// loopback host and only when the operator set the test flag. The value is
// never echoed in an error.
function mcpUrl(value: unknown, field: string, allowLoopback: boolean): string {
  if (typeof value !== "string" || value.length > 2048)
    invalid(`${field} must be an https URL.`);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return invalid(`${field} must be an https URL.`);
  }
  if (url.username || url.password || url.search || url.hash)
    invalid(`${field} must have no credentials, query or fragment.`);
  if (url.protocol === "https:") return value as string;
  if (url.protocol === "http:" && allowLoopback && isLoopbackHost(url.hostname))
    return value as string;
  return invalid(`${field} must be an https URL.`);
}

// 127.0.0.0/8, ::1 and localhost. A bracketed IPv6 literal arrives without its
// brackets in `hostname`.
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function mcpHeaders(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${field} must be a JSON object.`);
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length > MAX_MCP_HEADERS)
    invalid(`${field} must have at most ${MAX_MCP_HEADERS} entries.`);
  const headers: Record<string, string> = {};
  for (const name of keys) {
    if (!MCP_HEADER_NAME.test(name))
      invalid(`${field} has an invalid header name.`);
    const headerValue = raw[name];
    if (
      typeof headerValue !== "string" ||
      headerValue.length < 1 ||
      headerValue.length > MAX_MCP_HEADER_VALUE ||
      MCP_HEADER_VALUE_UNSAFE.test(headerValue)
    )
      invalid(`${field} has an invalid value for header "${name}".`);
    headers[name] = headerValue;
  }
  return headers;
}

function mcpEnabledTools(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    invalid(`${field} must be an array of tool names.`);
  if (value.length > MAX_MCP_ENABLED_TOOLS)
    invalid(`${field} must have at most ${MAX_MCP_ENABLED_TOOLS} entries.`);
  const tools: string[] = [];
  for (const tool of value) {
    if (typeof tool !== "string" || !MCP_TOOL.test(tool))
      invalid(`${field} has an invalid tool name.`);
    tools.push(tool);
  }
  return tools;
}

function mcpServer(
  value: unknown,
  field: string,
  allowLoopback: boolean,
): McpServerSpec {
  const s = object(
    value,
    [
      "name",
      "url",
      "headers",
      "enabledTools",
      "approvedTools",
      "toolTimeoutSec",
      "startupTimeoutSec",
    ],
    field,
  );
  if (typeof s.name !== "string" || !MCP_NAME.test(s.name))
    invalid(`${field}.name is invalid.`);
  const url = mcpUrl(s.url, `${field}.url`, allowLoopback);
  const headers = mcpHeaders(s.headers, `${field}.headers`);
  let enabledTools: string[] | undefined;
  if (s.enabledTools !== undefined)
    enabledTools = mcpEnabledTools(s.enabledTools, `${field}.enabledTools`);
  let approvedTools: string[] | undefined;
  if (s.approvedTools !== undefined)
    approvedTools = mcpEnabledTools(s.approvedTools, `${field}.approvedTools`);
  const toolTimeoutSec = integer(
    s.toolTimeoutSec,
    `${field}.toolTimeoutSec`,
    1,
    300,
  );
  const startupTimeoutSec = integer(
    s.startupTimeoutSec,
    `${field}.startupTimeoutSec`,
    1,
    60,
  );
  return {
    name: s.name,
    url,
    headers,
    ...(enabledTools ? { enabledTools } : {}),
    ...(approvedTools && approvedTools.length > 0 ? { approvedTools } : {}),
    toolTimeoutSec,
    startupTimeoutSec,
  };
}

function mcp(value: unknown, allowLoopback: boolean): McpServerSpec[] {
  if (!Array.isArray(value)) invalid("mcp must be an array of servers.");
  if (value.length > MAX_MCP_SERVERS)
    invalid(`mcp must have at most ${MAX_MCP_SERVERS} servers.`);
  const servers: McpServerSpec[] = [];
  const names = new Set<string>();
  value.forEach((entry, index) => {
    const server = mcpServer(entry, `mcp[${index}]`, allowLoopback);
    if (names.has(server.name)) invalid("mcp server names must be unique.");
    names.add(server.name);
    servers.push(server);
  });
  return servers;
}

export function parseStartRun(
  body: unknown,
  limits: RuntimeLimits,
  options: ParseOptions = {},
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
      "mcp",
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
  let approvalMs = limits.approvalMs;
  if (b.limits !== undefined) {
    const l = object(
      b.limits,
      ["firstResponseMs", "silenceMs", "approvalMs"],
      "limits",
    );
    if (l.approvalMs !== undefined)
      approvalMs = integer(
        l.approvalMs,
        "limits.approvalMs",
        10_000,
        limits.approvalMs,
      );
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
    limits: { firstResponseMs, silenceMs, approvalMs },
    ...(b.mcp !== undefined && b.mcp !== null
      ? { mcp: mcp(b.mcp, options.allowLoopbackMcp === true) }
      : {}),
  };
}

export function parseChatRef(value: unknown): ChatRef {
  const b = object(value, ["tenantId", "chatId"], "Request");
  return {
    tenantId: id(b.tenantId, "tenantId"),
    chatId: id(b.chatId, "chatId"),
  };
}

export function parseApproval(body: unknown): ApprovalRequest {
  const b = object(body, ["tenantId", "chatId", "decision"], "Request body");
  if (!APPROVAL_ANSWERS.includes(b.decision as ApprovalAnswer))
    invalid(`decision must be one of: ${APPROVAL_ANSWERS.join(", ")}.`);
  return {
    tenantId: id(b.tenantId, "tenantId"),
    chatId: id(b.chatId, "chatId"),
    decision: b.decision as ApprovalAnswer,
  };
}

// A steer carries a chat reference plus one input message, validated exactly
// like a run's start input (same text rules, `clientMessageId` an ID).
export function parseSteer(body: unknown): SteerRequest {
  const b = object(body, ["tenantId", "chatId", "input"], "Request body");
  const input = object(b.input, ["text", "clientMessageId"], "input");
  return {
    tenantId: id(b.tenantId, "tenantId"),
    chatId: id(b.chatId, "chatId"),
    input: {
      text: messageText(input.text),
      clientMessageId: id(input.clientMessageId, "input.clientMessageId"),
    },
  };
}
