import "dotenv/config";
import express, { type Express } from "express";
import { once } from "node:events";
import { log } from "../../shared/logging";
import { AgentCoreServices } from "./agentcore-services";

type Method = "GET" | "POST" | "DELETE";
type Invocation = {
  method: Method;
  path: string;
  body?: unknown;
  cursor?: string;
  requestId?: string;
};

const segment = "[A-Za-z0-9_-]+";
const thread = `/threads/${segment}`;
const routes: ReadonlyArray<[Method, RegExp]> = [
  ["GET", /^\/(?:livez|healthz|capabilities)$/],
  ["GET", /^\/schemas\/[A-Za-z0-9_]+$/],
  ["POST", /^\/threads$/],
  ["DELETE", new RegExp(`^${thread}$`)],
  [
    "POST",
    new RegExp(
      `^${thread}/(?:resume|approval-mode|turns|steer|interrupt|capabilities)$`,
    ),
  ],
  ["POST", new RegExp(`^${thread}/records/ack$`)],
  ["POST", new RegExp(`^${thread}/approvals/${segment}$`)],
  ["POST", new RegExp(`^${thread}/agents/${segment}/interrupt$`)],
  [
    "GET",
    new RegExp(
      `^${thread}/(?:snapshot|records|items|agents|events|documents)$`,
    ),
  ],
  ["GET", new RegExp(`^${thread}/agents/${segment}$`)],
  ["GET", new RegExp(`^${thread}/turns/${segment}/context$`)],
  ["GET", new RegExp(`^${thread}/(?:documents|visualizations)/${segment}$`)],
  ["POST", new RegExp(`^${thread}/documents$`)],
];

const maxStreamMs = 55 * 60 * 1000;

function parseInvocation(value: unknown): Invocation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invocation must be a JSON object");
  const input = value as Record<string, unknown>;
  const method = input.method;
  const path = input.path;
  const cursor = input.cursor;
  const requestId = input.requestId;
  if (method !== "GET" && method !== "POST" && method !== "DELETE")
    throw new Error("Unsupported invocation method");
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    !path.startsWith("/") ||
    path.includes("?")
  )
    throw new Error("Invalid invocation path");
  if (
    !routes.some(
      ([allowedMethod, allowedPath]) =>
        allowedMethod === method && allowedPath.test(path),
    )
  )
    throw new Error("Unsupported invocation path");
  if (
    cursor !== undefined &&
    (method !== "GET" ||
      !/\/threads\/[A-Za-z0-9_-]+\/(?:items|events)$/.test(path) ||
      typeof cursor !== "string" ||
      cursor.length > 128)
  )
    throw new Error("Invalid event cursor");
  if (input.body !== undefined && method !== "POST")
    throw new Error("Only POST invocations can have a body");
  if (
    requestId !== undefined &&
    (typeof requestId !== "string" || !/^[\w.-]{1,128}$/.test(requestId))
  )
    throw new Error("Invalid request ID");
  return {
    method,
    path,
    body: input.body,
    cursor: cursor as string | undefined,
    requestId: requestId as string | undefined,
  };
}

export interface AgentCoreOptions {
  coreUrl?: string;
  fetch?: typeof fetch;
  streamMs?: number;
  ensureServices?: () => Promise<void>;
  serviceState?: () => "cold" | "starting" | "ready" | "stopping";
}

export function createAgentCoreApp(options: AgentCoreOptions = {}): Express {
  const app = express();
  const call = options.fetch ?? fetch;
  const coreUrl = options.coreUrl ?? "http://127.0.0.1:4100";
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/ping", async (_req, res) => {
    const state = options.serviceState?.() ?? "ready";
    if (state === "cold" || state === "starting") {
      res.json({ status: state === "cold" ? "Healthy" : "HealthyBusy" });
      return;
    }
    if (state === "stopping") {
      res.status(503).json({ status: "Unhealthy" });
      return;
    }
    try {
      const core = await call(`${coreUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!core.ok) throw new Error("The local core is unavailable");
      const health = (await core.json()) as { activeThreads?: number };
      res.json({
        status: (health.activeThreads ?? 0) > 0 ? "HealthyBusy" : "Healthy",
      });
    } catch (error) {
      log("warn", "AgentCore readiness failed", { error: String(error) });
      res.status(503).json({ status: "Unhealthy" });
    }
  });

  app.post("/invocations", async (req, res) => {
    let invocation: Invocation;
    try {
      invocation = parseInvocation(req.body);
    } catch (error) {
      res.status(400).json({ error: String(error) });
      return;
    }
    const controller = new AbortController();
    const isEvents =
      invocation.method === "GET" && invocation.path.endsWith("/events");
    const url = new URL(invocation.path, coreUrl);
    if (invocation.cursor !== undefined)
      url.searchParams.set("cursor", invocation.cursor);
    try {
      await options.ensureServices?.();
      if (res.destroyed) return;
      const timer = setTimeout(
        () => controller.abort(),
        isEvents ? (options.streamMs ?? maxStreamMs) : 120_000,
      );
      res.once("close", () => {
        clearTimeout(timer);
        controller.abort();
      });
      const upstream = await call(url, {
        method: invocation.method,
        headers: {
          ...(invocation.requestId === undefined
            ? {}
            : { "x-request-id": invocation.requestId }),
          ...(invocation.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body:
          invocation.body === undefined
            ? undefined
            : JSON.stringify(invocation.body),
        signal: controller.signal,
      });
      if (isEvents && upstream.ok && upstream.body) {
        res.set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
        });
        res.flushHeaders();
        try {
          for await (const chunk of upstream.body) {
            if (res.destroyed || !res.write(chunk)) {
              if (res.destroyed) break;
              await once(res, "drain", { signal: controller.signal });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted)
            log("warn", "AgentCore event stream failed", {
              error: String(error),
            });
        } finally {
          clearTimeout(timer);
          controller.abort();
          if (!res.destroyed) res.end();
        }
        return;
      }
      const data = await upstream
        .json()
        .catch(() => ({ error: "Invalid runtime response" }));
      // AgentCore can translate a container 4xx/5xx into its own error. Keep the
      // original service status in a JSON envelope for the platform adapter.
      res.json({ status: upstream.status, body: data });
    } catch (error) {
      log("warn", "AgentCore invocation failed", { error: String(error) });
      if (!res.headersSent)
        res.status(503).json({ error: "Assistant runtime is unavailable" });
      else if (!res.destroyed) res.end();
    }
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log("warn", "Invalid AgentCore request", { error: String(error) });
      res.status(400).json({ error: "Invalid JSON invocation" });
    },
  );
  return app;
}

if (require.main === module) {
  const services = new AgentCoreServices();
  const port = Number(process.env.PORT || 8080);
  const server = createAgentCoreApp({
    ensureServices: () => services.start(),
    serviceState: () => services.state,
  }).listen(port, process.env.HOST || "0.0.0.0", () =>
    log("info", "AgentCore entrypoint listening", { port }),
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await services.stop();
      server.closeAllConnections();
      process.exit(0);
    });
}
