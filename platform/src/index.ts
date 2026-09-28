import { httpError } from "../../shared/errors";
import "reflect-metadata";
import "dotenv/config";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { json } from "express";
import { assistantCapabilities } from "../../shared/assistant-capabilities";
import {
  publicSession,
  publicTiming,
  PublicEventStream,
  POLICY_VERSION,
  relay,
} from "./public";
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
        .json({ ok: mongo && agentCore.ok });
    }),
  );
  http.use("/api", (_req: Request, _res: Response, next: NextFunction) => {
    if (!connected) return next(new ApiError(503, "MongoDB is unavailable"));
    next();
  });
  // Raw schema/configuration and host capabilities are not a product API.
  http.use("/api", (req: Request, _res: Response, next: NextFunction) => {
    if (/^\/(capabilities|schemas)(\/|$)/.test(req.path))
      return next(
        new ApiError(
          403,
          "This operation is not available in Truex",
          "CAPABILITY_DENIED",
        ),
      );
    next();
  });
  http.get(
    "/api/agents",
    route(async (_req, res) => res.json(await service.agents())),
  );
  http.get(
    "/api/assistant-capabilities",
    route((_req, res) => res.json(assistantCapabilities)),
  );
  http.get(
    "/api/sessions/:id/documents",
    route(async (req, res) =>
      res.json(
        await service.owned(
          await service.session(String(req.params.id)),
          "/documents",
        ),
      ),
    ),
  );
  http.post(
    "/api/sessions/:id/documents",
    route(async (req, res) =>
      res
        .status(201)
        .json(
          await service.owned(
            await service.session(String(req.params.id)),
            "/documents",
            "POST",
            { name: req.body.name, base64: req.body.base64 },
          ),
        ),
    ),
  );
  http.get(
    "/api/sessions/:id/documents/:fileId",
    route(async (req, res) => {
      const file = await service.owned(
        await service.session(String(req.params.id)),
        "/documents/" + encodeURIComponent(String(req.params.fileId)),
      );
      if (file.kind === "visualization")
        throw new ApiError(400, "Use Download HTML in the visual viewer");
      res.setHeader("Content-Type", file.mediaType);
      res.setHeader(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(file.base64, "base64"));
    }),
  );
  http.get(
    "/api/sessions/:id/visualizations/:fileId",
    route(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.json(
        await service.owned(
          await service.session(String(req.params.id)),
          "/visualizations/" + encodeURIComponent(String(req.params.fileId)),
        ),
      );
    }),
  );
  http.get(
    "/api/agents/:id/mcp",
    route(async (req, res) =>
      res.json(await service.agentMcp(String(req.params.id))),
    ),
  );
  http.post(
    "/api/agents/:id/mcp",
    route(async (req, res) =>
      res.json(
        await service.setAgentMcp(String(req.params.id), req.body.profileIds),
      ),
    ),
  );
  http.post(
    "/api/mcp",
    route(async (req, res) =>
      res.status(201).json(await service.createMcp(req.body)),
    ),
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
      res
        .status(201)
        .json(await service.create(req.body.agentId, req.body.subAgents)),
    ),
  );
  http.get(
    "/api/sessions",
    route(async (_req, res) => {
      const sessions = await store.sessions
        .find(
          { archived: { $ne: true }, runtimePolicyVersion: POLICY_VERSION },
          { projection: { approvals: 0, timings: 0 } },
        )
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();
      const untitled = sessions.filter((s) => !s.title).map((s) => s._id);
      if (untitled.length) {
        const firsts = await store.messages
          .aggregate<{ _id: string; text: string }>([
            { $match: { sessionId: { $in: untitled }, role: "user" } },
            { $sort: { at: 1, _id: 1 } },
            { $group: { _id: "$sessionId", text: { $first: "$text" } } },
          ])
          .toArray();
        const titles = new Map(firsts.map((f) => [f._id, f.text]));
        for (const s of sessions) {
          const first = titles.get(s._id)?.trim().replace(/\s+/g, " ");
          if (first)
            s.title =
              first.length > 80 ? first.slice(0, 79).trimEnd() + "…" : first;
        }
      }
      res.json(sessions.map(publicSession));
    }),
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
  http.get(
    "/api/sessions/:id/agents",
    route(async (req, res) =>
      res.json(await service.subAgents(String(req.params.id))),
    ),
  );
  http.get(
    "/api/sessions/:id/agents/:agentId",
    route(async (req, res) =>
      res.json(
        await service.subAgent(
          String(req.params.id),
          String(req.params.agentId),
        ),
      ),
    ),
  );
  http.post(
    "/api/sessions/:id/agents/:agentId/interrupt",
    route(async (req, res) =>
      res.json(
        await service.interruptAgent(
          String(req.params.id),
          String(req.params.agentId),
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
        await (req.body.command
          ? service.command(
              String(req.params.id),
              req.body.method,
              req.body.params || {},
              req.body.command,
            )
          : service.capability(
              String(req.params.id),
              req.body.method,
              req.body.params || {},
            )),
      ),
    ),
  );
  http.get(
    "/api/sessions/:id/goal/history",
    route(async (req, res) =>
      res.json(await service.goalHistory(String(req.params.id))),
    ),
  );
  http.post(
    "/api/sessions/:id/goal/review",
    route(async (req, res) =>
      res.json(await service.reviewGoal(String(req.params.id), req.body || {})),
    ),
  );
  http.get(
    "/api/sessions/:id/timings",
    route(async (req, res) => {
      const s = await service.session(String(req.params.id));
      await service.ingest(s);
      const rows = ((await service.session(s._id)).timings || []).map(
        publicTiming,
      );
      res.json({
        runtimeStartup: s.runtimeStartup
          ? {
              spawnMs: s.runtimeStartup.spawnMs,
              initializeMs: s.runtimeStartup.initializeMs,
            }
          : undefined,
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
        throw new ApiError(
          503,
          "Live updates cannot connect to the assistant service. Reopen the conversation when the service is available.",
          "OWNER_UNAVAILABLE",
        );
      }
      if (!upstream.ok) {
        const detail = await upstream.json().catch(() => null);
        throw new ApiError(
          upstream.status,
          typeof detail?.error === "string"
            ? detail.error
            : "Live updates are unavailable. Reopen the conversation to reconnect.",
          typeof detail?.code === "string" ? detail.code : "STREAM_UNAVAILABLE",
        );
      }
      if (!upstream.body)
        throw new ApiError(
          502,
          "The assistant service returned an empty live-update stream. Reopen the conversation to reconnect.",
          "STREAM_UNAVAILABLE",
        );
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      try {
        // Highest token count seen for the current goal on this stream, so a
        // restarted assistant service never shows a smaller count.
        let counted = s.goal ?? null;
        const remember = (goal: any, event?: { turnId?: string; at?: string }) => {
          if (goal) {
            const same =
              !!counted &&
              (counted.createdAt ?? null) === (goal.createdAt ?? null);
            goal.tokensObserved = Math.max(
              goal.tokensObserved ?? 0,
              same ? (counted?.tokensObserved ?? 0) : 0,
            );
          }
          counted = goal;
          void service
            .rememberGoal(s._id, goal, {
              turnId: event?.turnId,
              eventAt: event?.at,
            })
            .catch(() => {});
        };
        const stream = new PublicEventStream((event) => {
          if (event.type === "goal.updated") remember(event.data.goal, event);
          if (event.type === "goal.cleared") remember(null, event);
          if (event.type === "snapshot" && "goal" in event.data)
            remember(event.data.goal);
        });
        await relay(upstream.body as any, res, stream);
      } catch {
        if (!res.destroyed) res.end();
      } finally {
        abort.abort();
        if (!res.destroyed) res.end();
      }
    }),
  );
  http.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(error);
      const { status, ...body } = httpError(error, "platform");
      res.status(status).json(body);
    },
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
