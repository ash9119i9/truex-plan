import { AdapterError } from "./errors";
import type { RuntimeLimits } from "./config";
import { SKILL_SHA256, SKILL_SLUG } from "./runtime/skills";
import { checkedUploadName, UPLOADS_DIR } from "./runtime/uploads";

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

// The platform's 32,000-character messages plus its note listing attached
// files (at most ten paths).
export const MAX_TEXT = 40_000;
export const MAX_PROMPT = 40_000;
export const MAX_MCP_SERVERS = 3;
export const MAX_MCP_HEADERS = 16;
export const MAX_MCP_HEADER_VALUE = 8192;
export const MAX_MCP_ENABLED_TOOLS = 200;
export const MAX_APPROVED_COMMANDS = 50;
// The platform caps an agent at ten skills.
export const MAX_SKILLS = 10;
// A command's Allow-for-this-chat key: the sha256 of the exact command.
const COMMAND_SCOPE = /^[0-9a-f]{64}$/;

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
// `criticalTools` (deletes, sends outside the company, sharing changes) ask
// every time: their card offers no Allow for this chat, and approvedTools
// never covers them.
export interface McpServerSpec {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabledTools?: readonly string[];
  readonly approvedTools?: readonly string[];
  readonly criticalTools?: readonly string[];
  readonly toolTimeoutSec: number;
  readonly startupTimeoutSec: number;
}

// One skill version the chat uses, by the digest of the archive the platform
// pushed (PUT /v1/chats/:id/skills/:sha256) and the directory inside it. The
// adapter refuses a run whose skills it does not hold (SKILLS_MISSING), so
// the platform pushes them and starts the run again.
export interface SkillSpec {
  readonly sha256: string;
  readonly slug: string;
}

// What sandbox commands may reach in a run, built by the platform from the
// baseline registries, the tenant's allowed sites and the chat owner's
// connections (platform-next src/modules/network/network-policy.ts, which
// must match). `hosts` need no token and get no method check; a connector's
// hosts carry its request rules and, with `credential`, the member's token,
// which only the proxy ever sees. Used only with coding on.
export const NETWORK_METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type NetworkMethod = (typeof NETWORK_METHODS)[number];
export const NETWORK_AUTH = ["bearer", "token", "basic"] as const;

export interface NetworkRule {
  readonly methods: readonly NetworkMethod[];
  readonly hosts?: readonly string[];
  readonly paths?: readonly string[];
}

export interface NetworkConnector {
  readonly name: string;
  readonly displayName: string;
  readonly account?: string;
  readonly access: "read_only" | "read_write";
  readonly hosts: readonly string[];
  readonly reads: readonly NetworkRule[];
  readonly critical: readonly NetworkRule[];
  readonly credential?: {
    readonly auth: readonly (typeof NETWORK_AUTH)[number][];
    readonly urlPrefixes: readonly string[];
    readonly tokenPattern: string;
    readonly token: string;
  };
}

export interface NetworkPolicy {
  readonly hosts: readonly string[];
  readonly connectors: readonly NetworkConnector[];
}

export const MAX_NETWORK_HOSTS = 100;
const MAX_CONNECTOR_HOSTS = 20;
const MAX_NETWORK_RULES = 20;
const MAX_RULE_PATHS = 20;
const MAX_URL_PREFIXES = 10;
const MAX_TOKEN_PATTERN = 256;
const MAX_TOKEN = 8192;

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
  readonly input: {
    readonly text: string;
    readonly clientMessageId: string;
    // Attached images the model sees as images, as well as files it can
    // open: workspace-relative `uploads/<name>` paths the platform wrote
    // before the run. Absent when the message has none.
    readonly images?: readonly string[];
  };
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
  // What the member allowed for this chat on coding approval cards: command
  // scopes, each re-allowing that exact command. Used only when the operator
  // turned coding on; it can skip a question, never widen the sandbox. Push
  // always asks. File changes never ask (see coding.ts).
  readonly codingApprovals?: {
    readonly commands: readonly string[];
  };
  // The chat's skills, the same list on every run: Codex reads them only
  // when the thread starts, and a resumed thread needs their files still on
  // disk. Absent or empty means no skills.
  readonly skills?: readonly SkillSpec[];
  // The sandbox network policy. Absent means no network, as before.
  readonly network?: NetworkPolicy;
  // Helper agents (Codex multi-agent V2): how many may run at once. Absent
  // means no helpers, byte for byte today's params. Not with coding.
  readonly subAgents?: { readonly maxConcurrent: number };
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

// The image types every gateway provider takes; the platform refuses any
// other content behind these names.
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const MAX_IMAGES = 10;

function images(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGES)
    invalid(`input.images must be a list of at most ${MAX_IMAGES} paths.`);
  const paths = value.map((path: unknown) => {
    const name =
      typeof path === "string" && path.startsWith(`${UPLOADS_DIR}/`)
        ? path.slice(UPLOADS_DIR.length + 1)
        : "";
    if (!IMAGE_NAME.test(name))
      invalid("input.images must be uploads/<name> image paths.");
    return `${UPLOADS_DIR}/${checkedUploadName(name)}`;
  });
  if (new Set(paths).size !== paths.length)
    invalid("input.images lists a path twice.");
  return paths;
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
  if (url.protocol === "http:" && allowLoopback && isLoopbackHost(url.hostname))
    return value as string;
  if (url.protocol !== "https:")
    return invalid(`${field} must be an https URL.`);
  // Codex connects outside the sandbox, so no proxy refuses a private
  // address here: refuse address literals and local or metadata names.
  if (!allowLoopback && privateMcpHost(url.hostname))
    invalid(`${field} must not name a private or local address.`);
  return value as string;
}

// An IP literal (private or not: a connector is reached by name), a local
// name, or a cloud metadata name. Names that resolve to a private address
// are not caught here; MCP URLs come only from the operator's catalog.
function privateMcpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.includes(":") || /^[0-9.]+$/.test(host) || /^0x/i.test(host))
    return true;
  return /(^|\.)(localhost|local|localdomain|internal|arpa)$/.test(host);
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
      "criticalTools",
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
  let criticalTools: string[] | undefined;
  if (s.criticalTools !== undefined)
    criticalTools = mcpEnabledTools(s.criticalTools, `${field}.criticalTools`);
  // A critical tool is never allowed for the chat, whatever the list says.
  if (approvedTools && criticalTools)
    approvedTools = approvedTools.filter((t) => !criticalTools!.includes(t));
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
    ...(criticalTools && criticalTools.length > 0 ? { criticalTools } : {}),
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
      "codingApprovals",
      "skills",
      "network",
      "subAgents",
    ],
    "Request body",
  );
  let threadId: string | null = null;
  if (b.threadId !== null && b.threadId !== undefined) {
    if (typeof b.threadId !== "string" || !THREAD_ID.test(b.threadId))
      invalid("threadId must be a Codex thread ID or null.");
    threadId = b.threadId;
  }
  const input = object(b.input, ["text", "clientMessageId", "images"], "input");
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
      ...(input.images !== undefined && input.images !== null
        ? { images: images(input.images) }
        : {}),
    },
    agentPrompt: text(b.agentPrompt, "agentPrompt", MAX_PROMPT, true),
    model: model(b.model),
    limits: { firstResponseMs, silenceMs, approvalMs },
    ...(b.mcp !== undefined && b.mcp !== null
      ? { mcp: mcp(b.mcp, options.allowLoopbackMcp === true) }
      : {}),
    ...(b.codingApprovals !== undefined && b.codingApprovals !== null
      ? { codingApprovals: codingApprovals(b.codingApprovals) }
      : {}),
    ...(b.skills !== undefined && b.skills !== null
      ? { skills: skills(b.skills) }
      : {}),
    ...(b.network !== undefined && b.network !== null
      ? { network: network(b.network) }
      : {}),
    ...(b.subAgents !== undefined && b.subAgents !== null
      ? { subAgents: subAgents(b.subAgents) }
      : {}),
  };
}

// At most this many helpers at once; the lead is not counted.
export const MAX_SUB_AGENTS = 3;

function subAgents(value: unknown): { maxConcurrent: number } {
  const s = object(value, ["maxConcurrent"], "subAgents");
  return {
    maxConcurrent: integer(
      s.maxConcurrent,
      "subAgents.maxConcurrent",
      1,
      MAX_SUB_AGENTS,
    ),
  };
}

// The same host rule as the platform's (network-host.ts), checked again here
// because the proxy lets an allowlisted IP literal through even when it is
// private: exact DNS names only, no literals, wildcards or local zones.
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "example",
  "onion",
];
const RULE_PATH = /^\/[A-Za-z0-9._~\-/*%@:+]{0,255}$/;
const DISPLAY_NAME = /^[^\p{Cc}\p{Cf}]{1,60}$/u;
const ACCOUNT = /^[\x21-\x7e]{1,100}$/;
const TOKEN = /^[\x21-\x7e]+$/;

export function networkHost(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 253)
    invalid(`${field} must be a host name.`);
  const labels = value.split(".");
  if (
    labels.length < 2 ||
    !labels.every((label) => HOST_LABEL.test(label)) ||
    !HOST_TLD.test(labels[labels.length - 1]!) ||
    PRIVATE_SUFFIXES.some(
      (suffix) => value === suffix || value.endsWith(`.${suffix}`),
    )
  )
    invalid(`${field} must be a public host name.`);
  return value;
}

function networkHosts(
  value: unknown,
  field: string,
  max: number,
  min: number,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(`${field} must be a list of ${min}-${max} hosts.`);
  const hosts = value.map((host, index) =>
    networkHost(host, `${field}[${index}]`),
  );
  if (new Set(hosts).size !== hosts.length)
    invalid(`${field} lists a host twice.`);
  return hosts;
}

function networkRules(
  value: unknown,
  field: string,
  own: ReadonlySet<string>,
): NetworkRule[] {
  if (!Array.isArray(value) || value.length > MAX_NETWORK_RULES)
    invalid(`${field} must be a list of at most ${MAX_NETWORK_RULES} rules.`);
  return value.map((entry, index) => {
    const at = `${field}[${index}]`;
    const r = object(entry, ["methods", "hosts", "paths"], at);
    if (
      !Array.isArray(r.methods) ||
      r.methods.length === 0 ||
      !r.methods.every((m) => NETWORK_METHODS.includes(m as never)) ||
      new Set(r.methods).size !== r.methods.length
    )
      invalid(`${at}.methods must list HTTP methods.`);
    const rule: {
      methods: NetworkMethod[];
      hosts?: string[];
      paths?: string[];
    } = { methods: r.methods as NetworkMethod[] };
    if (r.hosts !== undefined) {
      rule.hosts = networkHosts(r.hosts, `${at}.hosts`, MAX_CONNECTOR_HOSTS, 1);
      if (!rule.hosts.every((host) => own.has(host)))
        invalid(`${at}.hosts must be some of the connector's hosts.`);
    }
    if (r.paths !== undefined) {
      if (
        !Array.isArray(r.paths) ||
        r.paths.length === 0 ||
        r.paths.length > MAX_RULE_PATHS ||
        !r.paths.every(
          (p) =>
            typeof p === "string" && RULE_PATH.test(p) && !p.includes("***"),
        )
      )
        invalid(`${at}.paths must be 1-${MAX_RULE_PATHS} path prefixes.`);
      rule.paths = r.paths as string[];
    }
    return rule;
  });
}

function networkCredential(
  value: unknown,
  field: string,
  own: ReadonlySet<string>,
): NonNullable<NetworkConnector["credential"]> {
  const c = object(
    value,
    ["auth", "urlPrefixes", "tokenPattern", "token"],
    field,
  );
  if (
    !Array.isArray(c.auth) ||
    c.auth.length === 0 ||
    !c.auth.every((a) => NETWORK_AUTH.includes(a as never)) ||
    new Set(c.auth).size !== c.auth.length
  )
    invalid(`${field}.auth must list ${NETWORK_AUTH.join(", ")}.`);
  if (
    !Array.isArray(c.urlPrefixes) ||
    c.urlPrefixes.length === 0 ||
    c.urlPrefixes.length > MAX_URL_PREFIXES
  )
    invalid(`${field}.urlPrefixes must have 1-${MAX_URL_PREFIXES} entries.`);
  const urlPrefixes = c.urlPrefixes.map((prefix, index) => {
    const at = `${field}.urlPrefixes[${index}]`;
    let url: URL | undefined;
    try {
      url = typeof prefix === "string" ? new URL(prefix) : undefined;
    } catch {
      url = undefined;
    }
    if (
      !url ||
      url.href !== prefix ||
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/") ||
      !own.has(url.hostname)
    )
      invalid(`${at} must be an https prefix on one of the connector's hosts.`);
    return url.href;
  });
  if (
    typeof c.tokenPattern !== "string" ||
    c.tokenPattern.length < 4 ||
    c.tokenPattern.length > MAX_TOKEN_PATTERN ||
    /[\p{Cc}\s]/u.test(c.tokenPattern)
  )
    invalid(`${field}.tokenPattern is invalid.`);
  if (
    typeof c.token !== "string" ||
    c.token.length > MAX_TOKEN ||
    !TOKEN.test(c.token)
  )
    invalid(`${field}.token is invalid.`);
  return {
    auth: c.auth as NonNullable<NetworkConnector["credential"]>["auth"],
    urlPrefixes,
    tokenPattern: c.tokenPattern,
    token: c.token,
  };
}

function network(value: unknown): NetworkPolicy {
  const n = object(value, ["hosts", "connectors"], "network");
  const hosts = networkHosts(n.hosts, "network.hosts", MAX_NETWORK_HOSTS, 0);
  if (!Array.isArray(n.connectors) || n.connectors.length > MAX_MCP_SERVERS)
    invalid(
      `network.connectors must be a list of at most ${MAX_MCP_SERVERS} connectors.`,
    );
  const names = new Set<string>();
  const plain = new Set(hosts);
  const connectors = n.connectors.map((entry, index): NetworkConnector => {
    const at = `network.connectors[${index}]`;
    const c = object(
      entry,
      [
        "name",
        "displayName",
        "account",
        "access",
        "hosts",
        "reads",
        "critical",
        "credential",
      ],
      at,
    );
    if (typeof c.name !== "string" || !MCP_NAME.test(c.name))
      invalid(`${at}.name is invalid.`);
    if (names.has(c.name)) invalid("network.connectors names must be unique.");
    names.add(c.name);
    if (typeof c.displayName !== "string" || !DISPLAY_NAME.test(c.displayName))
      invalid(`${at}.displayName is invalid.`);
    if (
      c.account !== undefined &&
      (typeof c.account !== "string" || !ACCOUNT.test(c.account))
    )
      invalid(`${at}.account is invalid.`);
    if (c.access !== "read_only" && c.access !== "read_write")
      invalid(`${at}.access must be read_only or read_write.`);
    const own = networkHosts(c.hosts, `${at}.hosts`, MAX_CONNECTOR_HOSTS, 1);
    // A host is either plain (no token, no method check) or a connection's.
    if (own.some((host) => plain.has(host)))
      invalid(`${at}.hosts must not repeat network.hosts.`);
    const ownSet = new Set(own);
    return {
      name: c.name,
      displayName: c.displayName,
      ...(c.account !== undefined ? { account: c.account as string } : {}),
      access: c.access,
      hosts: own,
      reads: networkRules(c.reads, `${at}.reads`, ownSet),
      critical: networkRules(c.critical, `${at}.critical`, ownSet),
      ...(c.credential !== undefined
        ? {
            credential: networkCredential(
              c.credential,
              `${at}.credential`,
              ownSet,
            ),
          }
        : {}),
    };
  });
  return { hosts, connectors };
}

function skills(value: unknown): SkillSpec[] {
  if (!Array.isArray(value) || value.length > MAX_SKILLS)
    invalid(`skills must be a list of at most ${MAX_SKILLS} skills.`);
  const specs = value.map((entry: unknown, index: number) => {
    const s = object(entry, ["sha256", "slug"], `skills[${index}]`);
    if (typeof s.sha256 !== "string" || !SKILL_SHA256.test(s.sha256))
      invalid(`skills[${index}].sha256 must be a hex digest.`);
    if (typeof s.slug !== "string" || !SKILL_SLUG.test(s.slug))
      invalid(`skills[${index}].slug is invalid.`);
    return { sha256: s.sha256, slug: s.slug };
  });
  // Each slug becomes a capability root's ID, so it names one skill.
  if (new Set(specs.map((s) => s.slug)).size !== specs.length)
    invalid("skills lists a slug twice.");
  return specs;
}

function codingApprovals(
  value: unknown,
): NonNullable<StartRunRequest["codingApprovals"]> {
  const c = object(value, ["commands"], "codingApprovals");
  if (!Array.isArray(c.commands))
    invalid("codingApprovals.commands must be an array.");
  if (c.commands.length > MAX_APPROVED_COMMANDS)
    invalid(
      `codingApprovals.commands must have at most ${MAX_APPROVED_COMMANDS} entries.`,
    );
  for (const scope of c.commands)
    if (typeof scope !== "string" || !COMMAND_SCOPE.test(scope))
      invalid("codingApprovals.commands has an invalid entry.");
  return { commands: [...c.commands] };
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
