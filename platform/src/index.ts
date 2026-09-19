import "reflect-metadata";
import "dotenv/config";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { json } from "express";
import { Store } from "./store";
import { PlatformService, ApiError } from "./service";
@Module({})
class AppModule {}
async function main() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  });
  const http = app.getHttpAdapter().getInstance();
  http.disable("x-powered-by");
  http.use(json({ limit: "2mb" }));
  const store = new Store();
  let connected = false;
  const connect = async () => {
    try {
      await store.connect();
      connected = true;
    } catch {
      connected = false;
    }
  };
  await connect();
  const service = new PlatformService(store);
  service.startIngestion();
  const route =
    (fn: (req: Request, res: Response) => Promise<any> | any) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next);
  http.get("/livez", (_req: Request, res: Response) => res.json({ ok: true }));
  http.get(
    "/healthz",
    route(async (_req, res) => {
      if (!connected) await connect();
      let mongo = false,
        agentCore: any;
      try {
        await store.db.command({ ping: 1 });
        mongo = true;
      } catch {
        connected = false;
      }
      try {
        agentCore = await service.call(service.hosts[0], "/healthz");
      } catch (e) {
        agentCore = { ok: false, error: (e as Error).message };
      }
      res
        .status(mongo && agentCore.ok ? 200 : 503)
        .json({ ok: mongo && agentCore.ok, mongo, agentCore });
    }),
  );
  http.use("/api", (_req: Request, _res: Response, next: NextFunction) => {
    if (!connected) return next(new ApiError(503, "MongoDB is unavailable"));
    next();
  });
  http.get(
    "/api/agents",
    route(async (_req, res) => res.json(await service.agents())),
  );
  http.get(
    "/api/capabilities",
    route(async (_req, res) =>
      res.json(await service.call(service.hosts[0], "/capabilities")),
    ),
  );
  http.get(
    "/api/schemas/:name",
    route(async (req, res) =>
      res.json(
        await service.call(
          service.hosts[0],
          "/schemas/" + encodeURIComponent(String(req.params.name)),
        ),
      ),
    ),
  );
  http.post(
    "/api/sessions",
    route(async (req, res) =>
      res.status(201).json(await service.create(req.body.agentId)),
    ),
  );
  http.get(
    "/api/sessions",
    route(async (_req, res) =>
      res.json(
        await store.sessions
          .find(
            { archived: { $ne: true } },
            { projection: { approvals: 0, timings: 0 } },
          )
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray(),
      ),
    ),
  );
  http.get(
    "/api/sessions/:id",
    route(async (req, res) =>
      res.json(await service.history(String(req.params.id))),
    ),
  );
  http.post(
    "/api/sessions/:id/messages",
    route(async (req, res) =>
      res
        .status(202)
        .json(
          await service.message(
            String(req.params.id),
            req.body.text,
            req.body.clientId,
          ),
        ),
    ),
  );
  http.post(
    "/api/sessions/:id/interrupt",
    route(async (req, res) =>
      res.json(
        await service.owned(
          await service.session(String(req.params.id)),
          "/interrupt",
          "POST",
          {},
        ),
      ),
    ),
  );
  http.post(
    "/api/sessions/:id/approvals/:requestId",
    route(async (req, res) =>
      res.json(
        await service.owned(
          await service.session(String(req.params.id)),
          "/approvals/" + encodeURIComponent(String(req.params.requestId)),
          "POST",
          { result: req.body.result },
        ),
      ),
    ),
  );
  http.post(
    "/api/sessions/:id/capabilities",
    route(async (req, res) =>
      res.json(
        await service.capability(
          String(req.params.id),
          req.body.method,
          req.body.params || {},
        ),
      ),
    ),
  );
  http.get(
    "/api/sessions/:id/timings",
    route(async (req, res) => {
      const s = await service.session(String(req.params.id));
      await service.ingest(s);
      const rows = (await service.session(s._id)).timings || [];
      res.json({
        runtimeStartup: s.runtimeStartup,
        threadStartMs: s.threadStartMs,
        turns: rows,
        averages: {
          totalMs: rows.length
            ? rows.reduce((a, b) => a + b.totalMs, 0) / rows.length
            : 0,
          ttftMs:
            rows
              .filter((x) => x.ttftMs !== null)
              .reduce((a, b) => a + (b.ttftMs || 0), 0) /
            Math.max(1, rows.filter((x) => x.ttftMs !== null).length),
        },
      });
    }),
  );
  http.get(
    "/api/sessions/:id/events",
    route(async (req, res) => {
      const s = await service.session(String(req.params.id));
      if (!service.hosts.includes(s.agentCoreHost))
        throw new ApiError(503, "Session owner is not configured");
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(
          `${s.agentCoreHost}/threads/${s.threadId}/events`,
          {
            signal: abort.signal,
            headers: {
              "Last-Event-ID":
                req.get("Last-Event-ID") || String(req.query.cursor || ""),
            },
          },
        );
      } catch {
        throw new ApiError(503, "Session owner unavailable");
      }
      if (!upstream.ok || !upstream.body)
        throw new ApiError(upstream.status, "Upstream stream unavailable");
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      try {
        for await (const chunk of upstream.body as any) {
          if (!res.write(Buffer.from(chunk))) {
            abort.abort();
            res.destroy();
            break;
          }
        }
      } catch {
        if (!res.destroyed) res.end();
      } finally {
        abort.abort();
        if (!res.destroyed) res.end();
      }
    }),
  );
  http.use((error: any, _req: Request, res: Response, _next: NextFunction) =>
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Internal platform error",
      code: error.code || "INTERNAL",
    }),
  );
  await app.listen(
    Number(process.env.PORT || 4000),
    process.env.HOST || "127.0.0.1",
  );
  console.log(`platform listening on ${process.env.PORT || 4000}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      service.stop();
      void store.client
        .close()
        .then(() => app.close())
        .then(() => process.exit(0));
    });
}
void main();
