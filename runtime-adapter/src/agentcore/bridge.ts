import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import type { AdapterConfig } from "../config";
import { AdapterError } from "../errors";
import { RuntimeManager, type Logger } from "../runtime/manager";
import { createAdapterServer } from "../server";
import {
  MAX_INVOCATION_BYTES,
  parseInvocation,
  type Invocation,
} from "./routes";
import { agentCoreSessionId, SESSION_HEADER } from "./session";

// RUNTIME_MODE=agentcore: the Bedrock AgentCore Runtime contract in front of
// the unchanged adapter.
//
//   GET  /ping         Healthy, or HealthyBusy while a run is active
//   POST /invocations  one adapter operation (routes.ts), forwarded to the
//                      adapter on loopback with a token made at start
//
// The adapter starts on the first invocation, not at boot: AgentCore mounts
// session storage (RUNTIME_STATE_DIR) only once a session exists. Event
// streams and file reads return as the adapter sent them; every other answer,
// errors included, is HTTP 200 with {status, body}, because AgentCore replaces
// a container's 4xx/5xx with its own error and the adapter's code is lost.

interface Adapter {
  readonly manager: RuntimeManager;
  readonly server: Server;
  readonly port: number;
  readonly token: string;
}

export interface AgentCoreBridge {
  readonly server: Server;
  readonly stats: {
    readonly started: boolean;
    readonly activeRuns: number;
    readonly processes: number;
    readonly stopping: boolean;
  };
  // Stops taking work, drains the adapter if it started, closes both servers.
  shutdown(): Promise<void>;
}

export function createAgentCoreBridge(
  config: AdapterConfig,
  log: Logger,
): AgentCoreBridge {
  let starting: Promise<Adapter> | undefined;
  let adapter: Adapter | undefined;
  // The first session this runtime served. AgentCore gives each session its
  // own microVM, so a second one here means misrouting; it is refused.
  let boundSession: string | undefined;
  let stopping = false;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const failure =
        error instanceof AdapterError ? error : new AdapterError("INTERNAL");
      if (!(error instanceof AdapterError))
        log("agentcore_error", {
          error: error instanceof Error ? error.name : typeof error,
        });
      if (res.headersSent) res.destroy();
      else sendEnvelope(res, failure.status, failure.toBody());
    });
  });
  server.requestTimeout = 0; // runs stream for minutes
  server.headersTimeout = 30_000;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://bridge").pathname;
    if (req.method === "GET" && path === "/ping") return ping(res);
    if (req.method !== "POST" || path !== "/invocations")
      return sendJson(
        res,
        404,
        new AdapterError("INVALID_REQUEST", "Unknown route.").toBody(),
      );
    if (stopping) throw new AdapterError("DRAINING");

    const invocation = parseInvocation(await readJson(req));
    bindSession(req.headers[SESSION_HEADER], invocation);
    const current = await start();
    await forward(current, invocation, res, log);
  }

  // Never sends time_of_last_update: a value that changes on every ping keeps
  // the session from ever going idle.
  function ping(res: ServerResponse) {
    if (stopping) return sendJson(res, 503, { status: "Unhealthy" });
    const busy = (adapter?.manager.stats.activeRuns ?? 0) > 0;
    sendJson(res, 200, { status: busy ? "HealthyBusy" : "Healthy" });
  }

  function bindSession(
    header: string | string[] | undefined,
    invocation: Invocation,
  ) {
    const { tenantId, chatId } = invocation.chat;
    const reason =
      typeof header !== "string"
        ? "missing"
        : header !== agentCoreSessionId(tenantId, chatId)
          ? "mismatch"
          : boundSession !== undefined && boundSession !== header
            ? "second_session"
            : undefined;
    if (reason) {
      log("agentcore_session_rejected", { reason });
      throw new AdapterError("SESSION_MISMATCH");
    }
    boundSession = header as string;
  }

  // Concurrent first invocations share one start. A failed start is
  // forgotten, so the next invocation tries again.
  function start(): Promise<Adapter> {
    // An invocation that read its body while shutdown began.
    if (stopping && !starting)
      return Promise.reject(new AdapterError("DRAINING"));
    starting ??= startAdapter(config, log).then(
      (started) => {
        adapter = started;
        return started;
      },
      (error: unknown) => {
        starting = undefined;
        log("agentcore_start_failed", {
          error: error instanceof Error ? error.name : typeof error,
        });
        throw new AdapterError("RUNTIME_UNAVAILABLE");
      },
    );
    return starting;
  }

  return {
    server,
    get stats() {
      const manager = adapter?.manager.stats;
      return {
        started: adapter !== undefined,
        activeRuns: manager?.activeRuns ?? 0,
        processes: manager?.processes ?? 0,
        stopping,
      };
    },
    async shutdown() {
      if (stopping) return;
      stopping = true;
      const current = await starting?.catch(() => undefined);
      if (current) {
        await current.manager.drain(config.drainMs);
        current.server.closeAllConnections();
        await new Promise((resolve) => current.server.close(resolve));
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startAdapter(
  config: AdapterConfig,
  log: Logger,
): Promise<Adapter> {
  const token = randomBytes(32).toString("base64url");
  const manager = new RuntimeManager(config, log);
  const server = createAdapterServer({
    token,
    limits: config.limits,
    manager,
    stateDir: config.stateDir,
    log,
    allowLoopbackMcp: config.allowLoopbackMcp,
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    await manager.drain(0);
    throw error;
  }
  const { port } = server.address() as AddressInfo;
  log("agentcore_adapter_started", { port });
  return { manager, server, port, token };
}

// Sends one invocation to the adapter. The caller going away aborts the
// request; for a run stream that only unsubscribes, the run keeps going.
function forward(
  adapter: Adapter,
  invocation: Invocation,
  res: ServerResponse,
  log: Logger,
): Promise<void> {
  const payload =
    invocation.json !== undefined
      ? Buffer.from(JSON.stringify(invocation.json))
      : invocation.bytes?.data;
  const headers: Record<string, string | number> = {
    authorization: `Bearer ${adapter.token}`,
  };
  if (payload) {
    headers["content-type"] =
      invocation.json !== undefined
        ? "application/json"
        : invocation.bytes!.contentType;
    headers["content-length"] = payload.length;
  }

  return new Promise((resolve) => {
    const upstream = request(
      {
        host: "127.0.0.1",
        port: adapter.port,
        method: invocation.method,
        path: invocation.target,
        headers,
      },
      (reply) => {
        void respond(reply, res).then(resolve, (error: unknown) => {
          log("agentcore_forward_failed", {
            error: error instanceof Error ? error.name : typeof error,
          });
          if (res.headersSent) res.destroy();
          else {
            const failure = new AdapterError("INTERNAL");
            sendEnvelope(res, failure.status, failure.toBody());
          }
          resolve();
        });
      },
    );
    upstream.on("error", (error) => {
      // The caller left first (res "close" destroyed the request).
      if (res.writableEnded || res.destroyed) return resolve();
      log("agentcore_forward_failed", { error: error.name });
      if (res.headersSent) res.destroy();
      else {
        const failure = new AdapterError("RUNTIME_UNAVAILABLE");
        sendEnvelope(res, failure.status, failure.toBody());
      }
      resolve();
    });
    res.on("close", () => upstream.destroy());
    upstream.end(payload);
  });
}

// A 200 event stream or file passes through; anything else is enveloped.
async function respond(reply: IncomingMessage, res: ServerResponse) {
  const type = String(reply.headers["content-type"] ?? "");
  const raw =
    reply.statusCode === 200 &&
    /^(text\/event-stream|application\/octet-stream)(\s*;|$)/i.test(type);
  if (raw) {
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      ...(reply.headers["content-length"]
        ? { "content-length": reply.headers["content-length"] }
        : { "x-accel-buffering": "no" }),
    });
    res.flushHeaders();
    await pipeline(reply, res).catch(() => undefined);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of reply as AsyncIterable<Buffer>) chunks.push(chunk);
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  sendEnvelope(res, reply.statusCode ?? 500, body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type))
    throw new AdapterError(
      "INVALID_REQUEST",
      "Content-Type must be application/json.",
    );
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_INVOCATION_BYTES)
    throw new AdapterError("PAYLOAD_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_INVOCATION_BYTES)
      throw new AdapterError("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AdapterError("INVALID_REQUEST", "Body must be valid JSON.");
  }
}

function sendEnvelope(res: ServerResponse, status: number, body: unknown) {
  sendJson(res, 200, { status, body });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}
