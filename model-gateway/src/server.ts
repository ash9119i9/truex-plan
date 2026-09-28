import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { verifyGatewayToken } from "../../shared/gateway-token";
import { sendError } from "./responses";
import {
  accessLogLine,
  record,
  rateLimitHeaders,
  type RequestMeta,
} from "./logging";
import { withTimeouts } from "./upstream";
import type { Adapter, GatewayProfile } from "./adapter";
import { proxyChat } from "./adapters/chat";
import { proxyAnthropic } from "./adapters/anthropic";
import { proxyGemini } from "./adapters/gemini";
export type { GatewayProfile } from "./adapter";

export interface GatewayOptions {
  secret: string;
  findProfile: (id: string) => Promise<GatewayProfile | null>;
  fetch?: typeof fetch;
  maxBodyBytes?: number;
  log?: (line: string) => void;
  /** Readiness for GET /ready, e.g. a database ping. Liveness is /health. */
  ready?: () => Promise<boolean>;
  /**
   * Idle keep-alive timeout. Must exceed the load balancer's idle timeout
   * (ALB default 60s) so the balancer, not the gateway, closes idle
   * connections; otherwise it may reuse one the gateway just closed (502).
   */
  keepAliveTimeoutMs?: number;
  /** Max wait for the provider's first byte (default 60s, 0 disables). */
  upstreamFirstByteTimeoutMs?: number;
  /** Max silence mid-stream from the provider (default 120s, 0 disables). */
  upstreamIdleTimeoutMs?: number;
}

const ROUTE = /^\/p\/([^/]+)\/v1\/responses\/?$/;
const REQUEST_ID = /^[\w.-]{1,128}$/;
const draining = new WeakSet<Server>();

const ADAPTERS: Record<string, Adapter> = {
  chat: proxyChat,
  anthropic: proxyAnthropic,
  gemini: proxyGemini,
};

export function createGateway(options: GatewayOptions) {
  const baseFetch = options.fetch ?? fetch;
  const firstByteMs = options.upstreamFirstByteTimeoutMs ?? 60_000;
  const idleMs = options.upstreamIdleTimeoutMs ?? 120_000;
  const maxBody = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const log = options.log ?? (() => {});

  const server = createServer(async (req, res) => {
    // During a drain, finish this response but don't keep the connection.
    if (draining.has(server)) res.shouldKeepAlive = false;
    const url = new URL(req.url || "/", "http://gateway");
    if (req.method === "GET" && url.pathname === "/health")
      return json(res, 200, { status: "ok" });
    if (req.method === "GET" && url.pathname === "/ready") {
      const ready = await isReady();
      return json(res, ready ? 200 : 503, {
        status: ready ? "ok" : "unavailable",
      });
    }

    const incoming = req.headers["x-request-id"];
    const meta: RequestMeta = {
      requestId:
        typeof incoming === "string" && REQUEST_ID.test(incoming)
          ? incoming
          : randomUUID(),
    };
    res.setHeader("x-request-id", meta.requestId);
    const startedAt = performance.now();
    res.once("close", () => log(accessLogLine(meta, res, startedAt)));
    try {
      await handle(req, res, url, meta);
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      log(
        JSON.stringify({
          ts: new Date().toISOString(),
          type: "error",
          requestId: meta.requestId,
          profileId: meta.profileId,
          errorName: e.name,
          error: e.message.slice(0, 500),
          stack: e.stack?.slice(0, 4000),
        }),
      );
      if (!res.headersSent)
        sendError(res, 500, "The model gateway failed.", "server_error");
      else res.end();
    }
  });
  // Streams can run for minutes; only the header phase is time-limited.
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 75_000;
  server.headersTimeout = server.keepAliveTimeout + 5_000;
  server.requestTimeout = 0;
  return server;

  async function isReady() {
    if (draining.has(server)) return false;
    try {
      return options.ready ? await options.ready() : true;
    } catch {
      return false;
    }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    meta: RequestMeta,
  ) {
    const match = ROUTE.exec(url.pathname);
    if (!match) return sendError(res, 404, "Not found", "not_found");
    if (req.method !== "POST")
      return sendError(res, 405, "Method not allowed", "method_not_allowed");

    const profileId = decodeURIComponent(match[1]);
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
    const claims = token && verifyGatewayToken(token, options.secret);
    if (!claims || claims.profileId !== profileId)
      return sendError(res, 401, "Invalid gateway token.", "invalid_api_key");

    meta.profileId = profileId;
    const profile = await options.findProfile(profileId);
    meta.wireApi = profile?.wireApi;
    meta.model = profile?.modelName;
    const apiKey = profile?.apiKey || profile?.apikey;
    if (!profile || profile.enabled === false || !apiKey)
      return sendError(
        res,
        404,
        "Model profile unavailable.",
        "model_not_found",
      );

    let input: any;
    try {
      input = JSON.parse(await readBody(req, maxBody));
    } catch (error) {
      return sendError(
        res,
        400,
        (error as Error).message,
        "invalid_request_error",
      );
    }

    const adapter = profile.wireApi ? ADAPTERS[profile.wireApi] : undefined;
    if (!adapter)
      return sendError(
        res,
        501,
        `The gateway has no adapter for wireApi "${profile.wireApi ?? "responses"}".`,
        "unsupported_wire_api",
      );
    const abort = new AbortController();
    // Stop the upstream call when Codex disconnects (interrupt or timeout).
    res.on("close", () => abort.abort());
    await adapter({
      profile,
      apiKey,
      input,
      res,
      fetch: withRateLimits(
        withTimeouts(baseFetch, {
          firstByteMs: validMs(profile.firstByteTimeoutMs) ?? firstByteMs,
          idleMs,
        }),
        res,
      ),
      signal: abort.signal,
      log,
    });
  }
}

// Record the provider's rate-limit headers (never bodies) for the access log.
const withRateLimits =
  (base: typeof fetch, res: ServerResponse): typeof fetch =>
  async (input, init) => {
    const upstream = await base(input, init);
    const rateLimit = rateLimitHeaders(upstream.headers);
    if (rateLimit) record(res, { rateLimit });
    return upstream;
  };

const validMs = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Graceful shutdown: /ready turns 503 so the load balancer stops routing here,
 * new connections are refused, in-flight streams get up to `graceMs` to
 * finish, then any remaining connections are closed. Resolves once the server
 * has closed.
 */
export function drain(server: Server, graceMs: number): Promise<void> {
  draining.add(server);
  return new Promise<void>((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), graceMs);
    force.unref();
    // Connections become idle as their streams finish; close them then.
    const closeIdle = () => server.closeIdleConnections();
    const poll = setInterval(closeIdle, 100);
    poll.unref();
    server.close(() => {
      clearTimeout(force);
      clearInterval(poll);
      resolve();
    });
    closeIdle();
  });
}

async function readBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (
    req.headers["content-encoding"] &&
    req.headers["content-encoding"] !== "identity"
  )
    throw new Error("Compressed request bodies are not supported.");
  return Buffer.concat(chunks).toString("utf8");
}
