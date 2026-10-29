import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  verifyMcpCallerToken,
  type McpCallerClaims,
} from "../../shared/mcp-caller-token";
import type { ArgumentChecker } from "./arguments";
import type { ConnectionRow, Credentials } from "./credentials";
import { EgressBlockedError, type Egress } from "./egress";
import { callVerdict, filterToolList, type ToolPolicy } from "./policy";
import {
  protectMessage,
  redactText,
  ResultTooLargeError,
  rewriteSse,
} from "./results";
import type { CallerResolution } from "./revocation";

// The MCP gateway's HTTP surface: `/mcp/<connector>`, speaking streamable
// HTTP to Codex on one side and to the provider's MCP server on the other.
// Every request is checked before anything reaches the provider: a valid
// caller token, the path naming the token's connector, and a revocation check
// against the platform's records. What passes is forwarded with the member's
// provider token, renewed first when it is near expiry: SSE streamed without
// buffering, the MCP session header kept, redirects never followed. Codex
// never sees a provider 401 (it would start its own OAuth flow); the gateway
// renews the token and, for a request that is safe to repeat, retries once.
// Tool policy (policy.ts) is enforced here too: a tools/call the chat may not
// make is refused before the provider is contacted, and every tools/list
// answer is filtered to the allowed, reviewed tools. Later tasks add limits.

const ROUTE = /^\/mcp\/([a-z][a-z0-9_]{1,30})$/;
const MAX_BODY_BYTES = 1024 * 1024;
// A provider answer is read up to this much; Codex gets at most
// MAX_RESULT_BYTES of it (results.ts cuts the rest with a note).
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
// MCP session IDs are visible ASCII (MCP spec, streamable HTTP).
const SESSION_ID = /^[\x21-\x7e]{1,256}$/;
const MAX_METHOD_IN_ERROR = 64;
// Longer than any catalog tool name (platform-next allows 64).
const MAX_TOOL_NAME = 128;
// A tools/list answer is read whole to filter it. GitHub's full list is
// about 100 KB.
const MAX_TOOL_LIST_BYTES = 4 * 1024 * 1024;
// Requests with no side effect at the provider, so a 401 may be retried once
// with a renewed token. Never tools/call: the provider may have acted.
const RETRYABLE = new Set(["initialize", "tools/list", "ping"]);

// The requests and notifications the pinned Codex sends that the provider
// must see (vendor/codex/codex-rs/rmcp-client). Anything else is refused here.
const FORWARDED_REQUESTS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
]);
const FORWARDED_NOTIFICATIONS = new Set([
  "notifications/initialized",
  "notifications/cancelled",
]);
// Resources are outside the tool allowlist, so the gateway offers none.
// Codex's built-in resource tools still get a valid, empty answer.
const LOCAL_RESULTS: Readonly<Record<string, unknown>> = {
  "resources/list": { resources: [] },
  "resources/templates/list": { resourceTemplates: [] },
};
// Never the caller's Authorization, cookies or anything else.
const REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;
// Never the provider's WWW-Authenticate: Codex must not start an OAuth flow
// against the provider's authorization server.
const RESPONSE_HEADERS = ["content-type", "mcp-session-id"] as const;

export interface GatewayOptions {
  readonly secret: string;
  // Throws when the records can't be read (answered 503).
  readonly resolveCaller: (
    claims: McpCallerClaims,
  ) => Promise<CallerResolution>;
  // Opens and renews the member's provider token.
  readonly credentials: Pick<
    Credentials,
    "usableTokens" | "tokenRejected" | "needsReconnect"
  >;
  // Every request to a provider goes through it (egress.ts).
  readonly egress: Pick<Egress, "fetch">;
  // Checks tools/call arguments against the reviewed schema (arguments.ts).
  readonly argumentChecker: ArgumentChecker;
  // Time allowed for the provider's response headers. A stream that has
  // started isn't limited: Codex's own tool timeout governs it.
  readonly upstreamTimeoutMs?: number;
  // Fields never include a token, a request body or a response body.
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

type JsonRpcId = string | number;

type Verdict =
  // `id` and `method` are set for a request, so a failure can answer it in
  // JSON-RPC and a 401 can be retried when that is safe.
  | {
      readonly kind: "forward";
      readonly id?: JsonRpcId;
      readonly method?: string;
      // The tool a tools/call names, and its arguments as sent.
      readonly tool?: string;
      readonly args?: unknown;
    }
  | { readonly kind: "reply"; readonly status: number; readonly body: unknown };

interface Caller {
  readonly tenantId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly connector: string;
}

export function createMcpGateway(options: GatewayOptions): Server {
  if (options.secret.length < 32)
    throw new Error("The MCP gateway secret must be at least 32 characters.");
  const log = options.log ?? (() => {});
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log("mcp_gateway_error", { message: messageOf(error) });
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    const match = ROUTE.exec(path);
    if (!match) return void res.writeHead(404).end();
    const connector = match[1]!;
    if (
      req.method !== "POST" &&
      req.method !== "GET" &&
      req.method !== "DELETE"
    )
      return void res.writeHead(405, { allow: "GET, POST, DELETE" }).end();

    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const claims = token ? verifyMcpCallerToken(token, options.secret) : null;
    if (!claims) {
      log("mcp_refused", { connector, reason: "token" });
      return unauthorized(res);
    }
    const caller: Caller = {
      tenantId: claims.tenantId,
      userId: claims.userId,
      chatId: claims.chatId,
      connector,
    };
    if (claims.connector !== connector) {
      log("mcp_refused", { ...caller, reason: "connector_mismatch" });
      return void res.writeHead(403).end();
    }
    let resolution: CallerResolution;
    try {
      resolution = await options.resolveCaller(claims);
    } catch (error) {
      log("mcp_caller_check_failed", { ...caller, message: messageOf(error) });
      return void res.writeHead(503, { "retry-after": "1" }).end();
    }
    if (!resolution.ok) {
      log("mcp_refused", { ...caller, reason: resolution.reason });
      return unauthorized(res);
    }

    const sessionId = req.headers["mcp-session-id"];
    if (
      sessionId !== undefined &&
      !(typeof sessionId === "string" && SESSION_ID.test(sessionId))
    )
      return sendJson(
        res,
        400,
        rpcError(null, -32600, "Invalid MCP session ID."),
      );

    let body: string | undefined;
    let id: JsonRpcId | undefined;
    let method: string | undefined;
    let tool: string | undefined;
    let args: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null)
        return void res.writeHead(413, { connection: "close" }).end();
      const verdict = classify(raw);
      if (verdict.kind === "reply")
        return sendJson(res, verdict.status, verdict.body);
      body = raw;
      id = verdict.id;
      method = verdict.method;
      tool = verdict.tool;
      args = verdict.args;
    }
    if (tool !== undefined) {
      const allowed = callVerdict(resolution.policy, connector, tool);
      if (!allowed.ok) {
        log("mcp_tool_refused", { ...caller, tool, reason: allowed.reason });
        return sendJson(
          res,
          200,
          rpcError(id ?? null, -32602, allowed.message),
        );
      }
      // callVerdict passed, so the policy holds this tool's reviewed hash.
      const hash = resolution.policy.tools.get(tool)!;
      const checked = await options.argumentChecker.check(tool, hash, args);
      if (!checked.ok) {
        log("mcp_arguments_refused", {
          ...caller,
          tool,
          reason: checked.reason,
        });
        return sendJson(
          res,
          200,
          rpcError(id ?? null, -32602, checked.message),
        );
      }
    }
    await deliver(req, res, resolution, body, id, method, caller);
  }

  // Sends the request with the member's token. On a provider 401 the token
  // is marked rejected (credentials.tokenRejected); a retryable request goes
  // once more with the renewed token, anything else fails with a message the
  // model can act on. A second 401 means only a new sign-in helps.
  async function deliver(
    req: IncomingMessage,
    res: ServerResponse,
    resolution: Extract<CallerResolution, { ok: true }>,
    body: string | undefined,
    id: JsonRpcId | undefined,
    method: string | undefined,
    caller: Caller,
  ) {
    const { credentials } = options;
    const { dbName } = resolution;
    let row: ConnectionRow = resolution.connection;
    for (let attempt = 0; ; attempt++) {
      const usable = await credentials.usableTokens(dbName, row);
      if (!usable.ok) {
        log("mcp_credentials_failed", { ...caller, reason: usable.reason });
        return upstreamFailed(
          res,
          id,
          usable.reason === "needs_reconnect"
            ? reconnectMessage(caller.connector)
            : `${caller.connector} could not renew the member's sign-in. Try again shortly.`,
        );
      }
      const upstream = await send(
        req,
        res,
        resolution.upstreamUrl,
        body,
        id,
        caller,
        usable.tokens.accessToken,
      );
      if (!upstream) return;
      if (upstream.status !== 401)
        return method === "tools/list" && id !== undefined
          ? relayToolList(
              res,
              upstream,
              id,
              resolution.policy,
              caller,
              secretsOf(usable.tokens),
            )
          : relay(
              res,
              upstream,
              id,
              secretsOf(usable.tokens),
              method === "tools/call",
              caller,
            );
      await upstream.body?.cancel();
      log("mcp_upstream_unauthorized", { ...caller, method, attempt });
      if (attempt > 0) {
        await credentials.needsReconnect(dbName, row);
        return upstreamFailed(res, id, reconnectMessage(caller.connector));
      }
      const current = await credentials.tokenRejected(dbName, row);
      if (!current)
        return upstreamFailed(res, id, reconnectMessage(caller.connector));
      if (!method || !RETRYABLE.has(method))
        return upstreamFailed(
          res,
          id,
          `${caller.connector} refused the member's sign-in, so the call did not run. The sign-in is renewed on the next call; try the call again.`,
        );
      row = current;
    }
  }

  // Sends one request upstream. Returns the response, or undefined when the
  // caller has already been answered (failure) or has gone away.
  async function send(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamUrl: string,
    body: string | undefined,
    id: JsonRpcId | undefined,
    caller: Caller,
    accessToken: string,
  ): Promise<Response | undefined> {
    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    headers.authorization = `Bearer ${accessToken}`;
    const controller = new AbortController();
    let timedOut = false;
    let clientGone = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Codex closing its side (a GET stream it no longer needs, a cancelled
    // call) closes ours to the provider.
    res.on("close", () => {
      clientGone = !res.writableFinished;
      controller.abort();
    });

    let upstream: Response;
    try {
      // Checks and pins the provider's address; never follows a redirect.
      upstream = await options.egress.fetch(upstreamUrl, {
        method: req.method ?? "GET",
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (clientGone) return undefined;
      const blocked = error instanceof EgressBlockedError;
      const reason = blocked
        ? "egress_blocked"
        : timedOut
          ? "timeout"
          : "unreachable";
      log("mcp_upstream_failed", {
        ...caller,
        reason,
        ...(blocked ? { detail: error.reason } : {}),
      });
      upstreamFailed(
        res,
        id,
        blocked
          ? `${caller.connector} isn't reachable through the Truex gateway.`
          : timedOut
            ? `${caller.connector} did not respond in time.`
            : `${caller.connector} could not be reached.`,
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      log("mcp_upstream_failed", {
        ...caller,
        reason: "redirect",
        status: upstream.status,
      });
      upstreamFailed(
        res,
        id,
        `${caller.connector} answered with a redirect, which the Truex gateway does not follow.`,
      );
      return undefined;
    }
    return upstream;
  }

  // A tools/list answer, read whole and filtered to the chat's allowed and
  // reviewed tools (policy.ts), then sent as one JSON response. In an SSE
  // answer, only the response to this request is kept; notifications the
  // provider sent alongside it are dropped (Codex re-lists on its own).
  async function relayToolList(
    res: ServerResponse,
    upstream: Response,
    id: JsonRpcId,
    policy: ToolPolicy,
    caller: Caller,
    secrets: readonly string[],
  ) {
    const failed = (reason: string, message: string) => {
      log("mcp_upstream_failed", {
        ...caller,
        reason,
        status: upstream.status,
      });
      upstreamFailed(res, id, message);
    };
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return failed(
        "tools_list_status",
        `${caller.connector} couldn't list its tools.`,
      );
    }
    const text = await readLimited(upstream, MAX_TOOL_LIST_BYTES);
    if (text === null)
      return failed(
        "tools_list_too_large",
        `${caller.connector} sent a tool list larger than the Truex gateway accepts.`,
      );
    const isSse = (upstream.headers.get("content-type") ?? "").includes(
      "text/event-stream",
    );
    const answer = (isSse ? sseMessages(text) : [parseJson(text)]).find(
      (m): m is Record<string, unknown> =>
        isRecord(m) &&
        m.id === id &&
        (Object.hasOwn(m, "result") || Object.hasOwn(m, "error")),
    );
    const invalid = `${caller.connector} answered tools/list with something that isn't a tool list.`;
    if (!answer) return failed("tools_list_invalid", invalid);
    const sessionId = upstream.headers.get("mcp-session-id");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(sessionId !== null ? { "mcp-session-id": sessionId } : {}),
    };
    if (!Object.hasOwn(answer, "result")) {
      const error = isRecord(answer.error) ? answer.error : {};
      return void res
        .writeHead(200, headers)
        .end(
          JSON.stringify(
            rpcError(
              id,
              typeof error.code === "number" ? error.code : -32000,
              typeof error.message === "string"
                ? redactText(error.message, secrets).slice(0, 500)
                : `${caller.connector} couldn't list its tools.`,
            ),
          ),
        );
    }
    const filtered = filterToolList(policy, answer.result);
    if (!filtered.result) return failed("tools_list_invalid", invalid);
    for (const change of filtered.changed)
      log("tool_definition_changed", {
        ...caller,
        tool: change.tool,
        expected: change.expected.slice(0, 12),
        actual: change.actual.slice(0, 12),
      });
    // Keep each offered definition, so a later tools/call (on any instance)
    // is checked against the schema that was reviewed. A failed write only
    // costs other instances: this one has it in memory already.
    await Promise.all(
      (filtered.result.tools as Array<Record<string, unknown>>).map((tool) => {
        const hash = policy.tools.get(tool.name as string);
        return hash
          ? options.argumentChecker.remember(hash, tool).catch(() =>
              log("tool_definition_store_failed", {
                ...caller,
                tool: tool.name,
              }),
            )
          : undefined;
      }),
    );
    if (filtered.hidden > 0)
      log("mcp_tools_hidden", {
        ...caller,
        offered: (filtered.result.tools as unknown[]).length,
        hidden: filtered.hidden,
      });
    res
      .writeHead(200, headers)
      .end(JSON.stringify({ jsonrpc: "2.0", id, result: filtered.result }));
  }

  // Every provider answer is cleaned before Codex sees it (results.ts):
  // known token values redacted, oversized results cut, tool results marked
  // untrusted. JSON is read whole (bounded); an SSE stream is rewritten
  // event by event, so it still reaches Codex as it arrives.
  async function relay(
    res: ServerResponse,
    upstream: Response,
    id: JsonRpcId | undefined,
    secrets: readonly string[],
    toolCall: boolean,
    caller: Caller,
  ) {
    const out: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out[name] = value;
    }
    const protect = (message: unknown) => {
      const cleaned = protectMessage(message, secrets, MAX_RESULT_BYTES, {
        markUntrusted: toolCall,
      });
      if (cleaned.redacted) log("mcp_result_redacted", { ...caller });
      if (cleaned.truncated) log("mcp_result_truncated", { ...caller });
      return cleaned.message;
    };
    const tooLarge = () => {
      log("mcp_result_too_large", { ...caller });
      upstreamFailed(
        res,
        id,
        `${caller.connector} sent a result larger than the Truex gateway accepts.`,
      );
    };
    if (!upstream.body) return void res.writeHead(upstream.status, out).end();
    const type = upstream.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      res.writeHead(upstream.status, out);
      // An SSE stream's first event must reach Codex now, not when it ends.
      res.flushHeaders();
      try {
        for await (const event of rewriteSse(
          Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>),
          protect,
          MAX_UPSTREAM_BYTES,
        )) {
          if (res.destroyed) break;
          res.write(event);
        }
      } catch (error) {
        if (error instanceof ResultTooLargeError)
          log("mcp_result_too_large", { ...caller });
        // Otherwise Codex or the provider closed the stream mid-way.
      }
      return void res.end();
    }
    const text = await readLimited(upstream, MAX_UPSTREAM_BYTES);
    if (text === null) return tooLarge();
    if (type.includes("application/json")) {
      const parsed = parseJson(text);
      if (parsed !== undefined) {
        let cleaned: unknown;
        try {
          cleaned = protect(parsed);
        } catch (error) {
          if (error instanceof ResultTooLargeError) return tooLarge();
          throw error;
        }
        return void res
          .writeHead(upstream.status, {
            ...out,
            "content-type": "application/json",
          })
          .end(JSON.stringify(cleaned));
      }
    }
    // Anything else goes on as text, with known token values removed.
    res.writeHead(upstream.status, out).end(redactText(text, secrets));
  }
}

// What Codex may send, decided before the provider sees it. MCP 2025-06-18
// removed JSON-RPC batches, so an array is refused.
function classify(raw: string): Verdict {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return reply(400, rpcError(null, -32700, "Parse error."));
  }
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return reply(
      400,
      rpcError(null, -32600, "Send one JSON-RPC message per request."),
    );
  const m = message as Record<string, unknown>;
  if (m.jsonrpc !== "2.0")
    return reply(400, rpcError(null, -32600, "Not a JSON-RPC 2.0 message."));
  const hasId = Object.hasOwn(m, "id");
  if (hasId && typeof m.id !== "string" && typeof m.id !== "number")
    return reply(400, rpcError(null, -32600, "Invalid JSON-RPC id."));
  const id = m.id as JsonRpcId;

  if (typeof m.method === "string") {
    const shown = m.method.slice(0, MAX_METHOD_IN_ERROR);
    if (!hasId)
      return FORWARDED_NOTIFICATIONS.has(m.method)
        ? { kind: "forward" }
        : reply(
            400,
            rpcError(
              null,
              -32601,
              `The Truex gateway doesn't accept ${shown}.`,
            ),
          );
    if (m.method === "tools/call") {
      const name = isRecord(m.params) ? m.params.name : undefined;
      if (typeof name !== "string" || !name || name.length > MAX_TOOL_NAME)
        return reply(
          200,
          rpcError(id, -32602, "tools/call needs a tool name."),
        );
      return {
        kind: "forward",
        id,
        method: m.method,
        tool: name,
        args: (m.params as Record<string, unknown>).arguments,
      };
    }
    if (FORWARDED_REQUESTS.has(m.method))
      return { kind: "forward", id, method: m.method };
    if (Object.hasOwn(LOCAL_RESULTS, m.method))
      return reply(200, {
        jsonrpc: "2.0",
        id,
        result: LOCAL_RESULTS[m.method],
      });
    return reply(
      200,
      rpcError(
        id,
        -32601,
        `${shown} isn't available through the Truex gateway.`,
      ),
    );
  }
  // Codex answering a request the server sent it (a ping, an elicitation).
  if (
    m.method === undefined &&
    hasId &&
    Object.hasOwn(m, "result") !== Object.hasOwn(m, "error")
  )
    return { kind: "forward" };
  return reply(400, rpcError(null, -32600, "Invalid JSON-RPC message."));
}

function reply(status: number, body: unknown): Verdict {
  return { kind: "reply", status, body };
}

function secretsOf(tokens: {
  accessToken: string;
  refreshToken?: string;
}): string[] {
  return tokens.refreshToken
    ? [tokens.accessToken, tokens.refreshToken]
    : [tokens.accessToken];
}

function rpcError(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// A failed request is answered in JSON-RPC so the model reads the reason as
// the tool's error. A notification or response has no id to answer.
function upstreamFailed(
  res: ServerResponse,
  id: JsonRpcId | undefined,
  message: string,
) {
  if (id === undefined) return void res.writeHead(502).end();
  sendJson(res, 200, rpcError(id, -32000, message));
}

function reconnectMessage(connector: string): string {
  return `${connector} needs to be reconnected: ask the member to reconnect it in Connected tools.`;
}

function unauthorized(res: ServerResponse) {
  res
    .writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' })
    .end();
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The JSON-RPC messages in an SSE body: each event's `data:` lines joined.
// Events that aren't JSON are skipped.
function sseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) messages.push(parseJson(data));
  }
  return messages;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The whole body as text, or null (body cancelled) past `limit` bytes.
async function readLimited(
  upstream: Response,
  limit: number,
): Promise<string | null> {
  if (!upstream.body) return "";
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
