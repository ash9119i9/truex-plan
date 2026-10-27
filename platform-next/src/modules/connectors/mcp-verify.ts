import type { FetchLike } from "./oauth-discovery";

// Verifies a connection by driving the MCP streamable-HTTP handshake with the
// user's access token: initialize → notifications/initialized → tools/list,
// honouring Mcp-Session-Id and accepting both application/json and
// text/event-stream responses. Counts the tools; when the connector names an
// accountTool, calls it and reads the account field. A 401 means the token is
// not (or no longer) valid and nothing should be stored.

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";

// The token the server rejected (HTTP 401). The caller stores nothing.
export class VerifyUnauthorizedError extends Error {
  constructor() {
    super("the MCP server rejected the access token");
    this.name = "VerifyUnauthorizedError";
  }
}

// The server could not be verified for a reason other than auth: it was
// unreachable, timed out, or spoke the protocol wrong. A fixed reason; no
// provider text.
export class VerifyFailedError extends Error {
  constructor(reason: string) {
    super(`MCP verify failed: ${reason}`);
    this.name = "VerifyFailedError";
  }
}

export interface VerifyResult {
  toolCount: number;
  account?: { login: string };
}

export interface VerifyOptions {
  url: string;
  accessToken: string;
  fixedHeaders: Record<string, string>;
  accountTool?: { name: string; field: string };
  // Name the account from the authorization server's userinfo endpoint
  // instead of a tool. Also proves the token, which matters for servers that
  // answer tools/list without one (Google's Gmail MCP).
  userinfo?: { url: string; field: string };
  fetchImpl?: FetchLike;
}

interface McpResponse {
  sessionId: string | undefined;
  result: Record<string, unknown> | undefined;
  status: number;
}

function headersFor(
  options: VerifyOptions,
  sessionId?: string,
): Record<string, string> {
  return {
    ...options.fixedHeaders,
    authorization: `Bearer ${options.accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

// Reads a JSON-RPC result from either a plain JSON body or an SSE stream (one
// or more `data:` lines carrying the JSON-RPC message). Size-bounded.
function resultFromText(text: string): Record<string, unknown> | undefined {
  const direct = tryParse(text);
  if (direct) return direct;
  // SSE: find the first data line that parses to a JSON-RPC response.
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const parsed = tryParse(line.slice("data:".length).trim());
    if (parsed) return parsed;
  }
  return undefined;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Not JSON.
  }
  return undefined;
}

async function send(
  options: VerifyOptions,
  body: Record<string, unknown>,
  sessionId: string | undefined,
  expectResult: boolean,
): Promise<McpResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(options.url, {
      method: "POST",
      headers: headersFor(options, sessionId),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new VerifyFailedError("unreachable");
  }
  if (res.status === 401) throw new VerifyUnauthorizedError();
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new VerifyFailedError("response too large");
  const nextSession = res.headers.get("mcp-session-id") ?? sessionId;
  // A notification (no id) gets 202 with no body; nothing to parse.
  if (!expectResult)
    return { sessionId: nextSession, result: undefined, status: res.status };
  if (res.status < 200 || res.status >= 300)
    throw new VerifyFailedError(`status ${res.status}`);
  const text = Buffer.from(bytes).toString("utf8");
  const message = resultFromText(text);
  if (!message) throw new VerifyFailedError("unparseable response");
  if (message.error !== undefined)
    throw new VerifyFailedError("server returned an error");
  const result =
    message.result && typeof message.result === "object"
      ? (message.result as Record<string, unknown>)
      : undefined;
  return { sessionId: nextSession, result, status: res.status };
}

// Pulls the account field out of a tools/call result's JSON text content, the
// MCP convention: result.content[].type === "text" carries JSON text.
function accountFrom(
  result: Record<string, unknown> | undefined,
  field: string,
): { login: string } | undefined {
  const content = result?.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (
      !part ||
      typeof part !== "object" ||
      (part as { type?: unknown }).type !== "text"
    )
      continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const parsed = tryParse(text);
    const value = parsed?.[field];
    if (typeof value === "string" && value.length > 0 && value.length <= 256)
      return { login: value };
  }
  return undefined;
}

export async function verifyConnection(
  options: VerifyOptions,
): Promise<VerifyResult> {
  // 1. initialize.
  const init = await send(
    options,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "truex", version: "1" },
      },
    },
    undefined,
    true,
  );
  const sessionId = init.sessionId;

  // 2. notifications/initialized (no id, no result expected).
  await send(
    options,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    false,
  );

  // 3. tools/list.
  const list = await send(
    options,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    sessionId,
    true,
  );
  const tools = list.result?.tools;
  if (!Array.isArray(tools))
    throw new VerifyFailedError("tools/list did not return a list");
  const result: VerifyResult = { toolCount: tools.length };

  // 4. accountTool, when the connector defines one.
  if (options.accountTool) {
    const call = await send(
      options,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: options.accountTool.name, arguments: {} },
      },
      sessionId,
      true,
    );
    const account = accountFrom(call.result, options.accountTool.field);
    if (account) result.account = account;
  }
  // 5. userinfo, when the connector names the account that way.
  if (options.userinfo) {
    const account = await userinfoAccount(options, options.userinfo);
    if (account) result.account = account;
  }
  return result;
}

// GETs the OpenID Connect userinfo endpoint with the access token and reads
// one string claim. 401 means the token is not valid; any other failure is a
// verify failure, since this call is also the token's proof.
async function userinfoAccount(
  options: VerifyOptions,
  userinfo: { url: string; field: string },
): Promise<{ login: string } | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(userinfo.url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new VerifyFailedError("userinfo unreachable");
  }
  if (res.status === 401) throw new VerifyUnauthorizedError();
  const bytes = await res.arrayBuffer();
  if (res.status !== 200 || bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new VerifyFailedError(`userinfo status ${res.status}`);
  const value = tryParse(Buffer.from(bytes).toString("utf8"))?.[userinfo.field];
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? { login: value }
    : undefined;
}
