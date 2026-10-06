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
  publicTrace,
  PublicEventStream,
  withPlanFallback,
  POLICY_VERSION,
  relay,
} from "./public";
import { Store } from "./store";
import { sessionTraces } from "./traces";
import { usageRange } from "./costs";
import type { TurnTrace } from "../../shared/contracts";
import { PlatformService, ApiError, upstreamError } from "./service";
import { errorFields, log, REQUEST_ID_HEADER } from "../../shared/logging";
import {
  endedStream,
  errorHandler,
  failStream,
  requestIdMiddleware,
  route,
  tenantMiddleware,
  userMiddleware,
} from "./http";
import { currentTenant, devTenantResolver, pocTenantResolver } from "./tenant";
import {
  authMode,
  currentUser,
  devUserResolver,
  pocUserResolver,
} from "./user";
import { googleRoutes } from "./google";
import { adminApiRoutes, adminAuthRoutes, adminGate } from "./admin";
import { inviteLookupRoutes, inviteMailer } from "./invites";
import {
  authMiddleware,
  authRoutes,
  csrfMiddleware,
  rateLimit,
  userTenants,
} from "./auth";
@Module({})
class AppModule {}
async function main() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  const http = app.getHttpAdapter().getInstance();
  http.use(requestIdMiddleware);
  // Refuses an unknown mode, or google without its keys, before anything
  // else is built.
  const mode = authMode();
  // POC mode does not register invitation routes or initialize email delivery.
  const mailer = mode === "poc" ? undefined : inviteMailer();
  const origins = [
    process.env.FRONTEND_ORIGIN || "http://localhost:3000",
    process.env.ADMIN_ORIGIN,
  ].filter((origin): origin is string => !!origin);
  app.enableCors({
    origin: origins,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  http.disable("x-powered-by");
  // Unset by default. Set when a forwarder adds X-Forwarded-For, so req.ip
  // (and the /auth rate limit) sees the browser's address.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy)
    http.set(
      "trust proxy",
      /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy,
    );
  http.use(json({ limit: "2mb" }));
  const store = new Store();
  let connected = false;
  const connect = async () => {
    try {
      await store.connect();
      connected = true;
    } catch (error) {
      connected = false;
      log("warn", "storage connection failed", {
        op: "connect",
        ...errorFields(error),
      });
    }
  };
  await connect();
  const service = new PlatformService(store);
  service.startIngestion();
  http.get("/livez", (_req: Request, res: Response) => res.json({ ok: true }));
  http.get(
    "/healthz",
    route(async (_req, res) => {
      if (!connected) await connect();
      // May be unauthenticated: report only booleans and codes.
      let mongo = false,
        agentCore: { ok: boolean; code?: string };
      try {
        await store.catalog.command({ ping: 1 });
        mongo = true;
      } catch (error) {
        connected = false;
        log("warn", "health check failed", {
          op: "mongo",
          ...errorFields(error),
        });
      }
      try {
        agentCore = {
          ok: (await service.call(service.hosts[0], "/healthz")).ok === true,
        };
      } catch (error) {
        agentCore = {
          ok: false,
          code: error instanceof ApiError ? error.code : "UNAVAILABLE",
        };
        log("warn", "health check failed", {
          op: "agentCore",
          ...errorFields(error),
        });
      }
      const ok = mongo && agentCore.ok;
      res.status(ok ? 200 : 503).json({ ok, mongo, agentCore });
    }),
  );
  http.use(
    ["/api", "/auth"],
    (_req: Request, _res: Response, next: NextFunction) => {
      if (!connected)
        return next(
          new ApiError(503, "MongoDB is unavailable", "STORAGE_UNAVAILABLE"),
        );
      next();
    },
  );
  if (mode === "poc") {
    log("info", "POC mode: shared identity; sign-in and invitations disabled");
    http.use(["/auth", "/api/admin"], (_req: Request, res: Response) =>
      res.status(404).json({
        error: "Sign-in and invitations are disabled for this POC.",
        code: "AUTH_DISABLED",
      }),
    );
  }
  // State-changing requests need a known Origin and JSON. Dev and POC
  // modes also let a request without any Origin through, so curl and the
  // test suite work; a foreign Origin is refused in every mode.
  http.use(
    ["/api", "/auth"],
    csrfMiddleware({ origins, allowMissingOrigin: mode !== "google" }),
  );
  // Per req.ip; see TRUST_PROXY above.
  http.use("/auth", rateLimit({ windowMs: 60_000, max: 60 }));
  // Admin login, the admin API and the public invite lookup work the same in
  // dev and Google modes. The admin gate needs
  // an admin session cookie and never reads the dev tenant or user headers;
  // the admin router answers every /api/admin request (404 for unknown
  // paths), so the dev resolvers and authMiddleware below never see one.
  if (mode !== "poc") {
    http.use("/auth/admin", adminAuthRoutes(store));
    http.use("/auth/invites", inviteLookupRoutes(store));
    http.use(
      "/api/admin",
      adminGate(store),
      adminApiRoutes(store, service, mailer!),
    );
  }
  if (mode === "google") {
    // Every API request resolves its tenant and user from the session
    // cookie. The dev resolvers are never built in this mode.
    http.use("/api", authMiddleware(store));
    http.use("/auth", authRoutes(store));
    http.use("/auth", googleRoutes(store));
  } else {
    // Every API request works on exactly one tenant's database.
    http.use(
      "/api",
      tenantMiddleware(
        mode === "poc" ? pocTenantResolver() : devTenantResolver(),
        (id) => store.resolveTenant(id),
      ),
    );
    // Every API request also has exactly one user in dev and POC modes.
    http.use(
      "/api",
      userMiddleware(mode === "poc" ? pocUserResolver() : devUserResolver()),
    );
  }
  http.get(
    "/api/me",
    route(async (_req, res) => {
      const user = currentUser()!;
      const tenant = currentTenant()!;
      const tenants =
        mode === "google"
          ? await userTenants(store, user.id)
          : [{ id: tenant.id, name: tenant.id, role: user.role }];
      const current = tenants.find((t) => t.id === tenant.id);
      res.json({
        user: {
          id: user.id,
          email: user.email,
          ...(mode === "google" ? res.locals.profile : {}),
        },
        tenant: { id: tenant.id, name: current?.name ?? tenant.id },
        role: user.role,
        tenants,
      });
    }),
  );
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
  // No role check yet: any user of the tenant may create agents (alpha).
  http.post(
    "/api/agents",
    route(async (req, res) =>
      res.status(201).json(await service.createAgent(req.body)),
    ),
  );
  http.get(
    "/api/models",
    route(async (_req, res) => res.json(await service.models())),
  );
  http.get(
    "/api/features",
    route((_req, res) => res.json({ approvalModes: service.approvalModes })),
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
          await service.sessionFor(String(req.params.id), "read"),
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
            await service.sessionFor(String(req.params.id), "write"),
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
        await service.sessionFor(String(req.params.id), "read"),
        "/documents/" + encodeURIComponent(String(req.params.fileId)),
      );
      if (file.kind === "visualization")
        throw new ApiError(
          400,
          "Use Download HTML in the visual viewer",
          "INVALID_INPUT",
        );
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
          await service.sessionFor(String(req.params.id), "read"),
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
  // MCP servers. /api/mcp is the caller's own (user scope) plus a read-only
  // view of the tenant's; /api/tenant/mcp* and /api/agents/:id/tenant-mcp
  // manage tenant servers and answer 403 to anyone but a tenant admin.
  http.get(
    "/api/mcp",
    route(async (_req, res) => res.json(await service.listMcp())),
  );
  http.post(
    "/api/mcp",
    route(async (req, res) =>
      res.status(201).json(await service.createMcp(req.body)),
    ),
  );
  http.patch(
    "/api/mcp/:id",
    route(async (req, res) =>
      res.json(await service.updateMcp(String(req.params.id), req.body)),
    ),
  );
  http.delete(
    "/api/mcp/:id",
    route(async (req, res) =>
      res.json(await service.deleteMcp(String(req.params.id))),
    ),
  );
  http.get(
    "/api/tenant/mcp",
    route(async (_req, res) => res.json(await service.listTenantMcp())),
  );
  http.post(
    "/api/tenant/mcp",
    route(async (req, res) =>
      res.status(201).json(await service.createTenantMcp(req.body)),
    ),
  );
  http.patch(
    "/api/tenant/mcp/:id",
    route(async (req, res) =>
      res.json(await service.updateTenantMcp(String(req.params.id), req.body)),
    ),
  );
  http.delete(
    "/api/tenant/mcp/:id",
    route(async (req, res) =>
      res.json(await service.deleteTenantMcp(String(req.params.id))),
    ),
  );
  http.get(
    "/api/agents/:id/tenant-mcp",
    route(async (req, res) =>
      res.json(await service.agentTenantMcp(String(req.params.id))),
    ),
  );
  http.post(
    "/api/agents/:id/tenant-mcp",
    route(async (req, res) =>
      res.json(
        await service.setAgentTenantMcp(
          String(req.params.id),
          req.body?.profileIds,
        ),
      ),
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
        .json(
          await service.create(
            req.body.agentId,
            req.body.subAgents,
            req.body.projectId,
          ),
        ),
    ),
  );
  http.get(
    "/api/sessions",
    route(async (req, res) =>
      res.json(await service.sessions(req.query.projectId)),
    ),
  );
  http.post(
    "/api/sessions/:id/project",
    route(async (req, res) =>
      res.json(
        await service.setSessionProject(
          String(req.params.id),
          req.body?.projectId,
        ),
      ),
    ),
  );
  http.get(
    "/api/projects",
    route(async (_req, res) => res.json(await service.projects())),
  );
  http.post(
    "/api/projects",
    route(async (req, res) =>
      res.status(201).json(await service.createProject(req.body?.name)),
    ),
  );
  http.post(
    "/api/projects/:id",
    route(async (req, res) =>
      res.json(
        await service.renameProject(String(req.params.id), req.body?.name),
      ),
    ),
  );
  http.post(
    "/api/projects/:id/delete",
    route(async (req, res) =>
      res.json(await service.deleteProject(String(req.params.id))),
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
          await service.sessionFor(String(req.params.id), "write"),
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
          await service.sessionFor(String(req.params.id), "write"),
          "/approvals/" + encodeURIComponent(String(req.params.requestId)),
          "POST",
          { result: req.body.result },
        ),
      ),
    ),
  );
  http.post(
    "/api/sessions/:id/approval-mode",
    route(async (req, res) =>
      res.json(
        await service.setApprovalMode(String(req.params.id), req.body?.mode),
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
      const s = await service.sessionFor(String(req.params.id), "read");
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
    "/api/sessions/:id/traces",
    route(async (req, res) => {
      const s = await service.sessionFor(String(req.params.id), "read");
      // Stored traces stay readable while the assistant service is down.
      await service.ingest(s).catch((error) =>
        log("warn", "trace ingestion failed", {
          sessionId: s._id,
          op: "ingest",
          ...errorFields(error),
        }),
      );
      res.json(
        sessionTraces(
          (await store.sessionTraces(s._id))
            .map(publicTrace)
            .filter((t): t is TurnTrace => t !== null),
        ),
      );
    }),
  );
  // Estimated cost of one conversation: its stored running total and each
  // turn's cost. The activity panel reads the same cost from the traces.
  http.get(
    "/api/sessions/:id/cost",
    route(async (req, res) => {
      const s = await service.sessionFor(String(req.params.id), "read");
      await service.ingest(s).catch((error) =>
        log("warn", "cost ingestion failed", {
          sessionId: s._id,
          op: "ingest",
          ...errorFields(error),
        }),
      );
      res.json(await service.costs.sessionCost(s._id));
    }),
  );
  // The signed-in user's own usage; never another user's.
  http.get(
    "/api/me/usage",
    route(async (req, res) =>
      res.json(
        await service.costs.userUsage(currentUser()!.id, usageRange(req.query)),
      ),
    ),
  );
  // Every user's usage in this tenant; admins only.
  http.get(
    "/api/usage/users",
    route(async (req, res) => {
      if (currentUser()?.role !== "admin")
        throw new ApiError(403, "Admins only", "ADMIN_ONLY");
      res.json(await service.costs.allUsersUsage(usageRange(req.query)));
    }),
  );
  // Live-only masked context; never persisted or logged here.
  http.get(
    "/api/sessions/:id/turns/:turnId/context",
    route(async (req, res) => {
      const s = await service.sessionFor(String(req.params.id), "read");
      res.set("Cache-Control", "no-store");
      res.json(
        await service.owned(
          s,
          `/turns/${encodeURIComponent(String(req.params.turnId))}/context`,
        ),
      );
    }),
  );
  http.get(
    "/api/sessions/:id/events",
    route(async (req, res) => {
      const s = await service.sessionFor(String(req.params.id), "read");
      if (!service.hosts.includes(s.agentCoreHost))
        throw new ApiError(
          503,
          "Session owner is not configured",
          "OWNER_UNCONFIGURED",
        );
      const requestId: string = res.locals.requestId;
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      let upstream: globalThis.Response;
      try {
        upstream = await service.events(
          s,
          req.get("Last-Event-ID") || String(req.query.cursor || ""),
          abort.signal,
          requestId,
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          503,
          "Live updates cannot connect to the assistant service. Reopen the conversation when the service is available.",
          "OWNER_UNAVAILABLE",
          { cause: error },
        );
      }
      if (!upstream.ok)
        throw upstreamError(
          upstream.status,
          await upstream.json().catch(() => null),
          "Live updates are unavailable. Reopen the conversation to reconnect.",
          "STREAM_UNAVAILABLE",
          "/events",
        );
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
        const remember = (
          goal: any,
          event?: { turnId?: string; at?: string },
        ) => {
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
            .catch((error) =>
              log("warn", "live update persistence failed", {
                sessionId: s._id,
                op: "rememberGoal",
                ...errorFields(error),
              }),
            );
        };
        // Latest plan seen on this stream, starting from the saved one.
        let planSteps = s.plan?.steps;
        // Prices a finished turn as it streams past, so its cost reaches the
        // browser in the same event as its tokens.
        const pricer = await service.costs.livePricer(s);
        const stream = new PublicEventStream((event) => {
          if (event.type === "goal.updated") remember(event.data.goal, event);
          if (event.type === "goal.cleared") remember(null, event);
          if (event.type === "snapshot" && "goal" in event.data)
            remember(event.data.goal);
          if (event.type === "plan.updated") {
            planSteps = event.data.plan;
            void store
              .savePlan(s._id, {
                plan: event.data.plan,
                explanation: event.data.explanation,
                turnId: event.turnId,
                cursor: event.cursor,
                at: event.at,
              })
              .catch((error) =>
                log("warn", "live update persistence failed", {
                  sessionId: s._id,
                  op: "savePlan",
                  ...errorFields(error),
                }),
              );
          }
          if (event.type === "snapshot") {
            if (event.data.plan?.length) {
              planSteps = event.data.plan;
              void service
                .rememberSnapshotPlan(s._id, event.data)
                .catch((error) =>
                  log("warn", "live update persistence failed", {
                    sessionId: s._id,
                    op: "rememberSnapshotPlan",
                    ...errorFields(error),
                  }),
                );
            } else
              return {
                ...event,
                data: withPlanFallback(event.data, { steps: planSteps }),
              };
          }
        }, pricer.prepare);
        await relay(upstream.body as any, res, stream);
        if (!res.destroyed) endedStream(res, { requestId, sessionId: s._id });
      } catch (error) {
        // A client disconnect aborts the upstream read; that is not a failure.
        if (!res.destroyed)
          failStream(res, error, { requestId, sessionId: s._id });
      } finally {
        abort.abort();
        if (!res.destroyed) res.end();
      }
    }),
  );
  http.use(errorHandler);
  const port = Number(process.env.PORT || 4000),
    host = process.env.HOST || "127.0.0.1";
  await app.listen(port, host);
  log("info", "platform listening", { port, host });
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log("info", "platform stopping", { signal });
      service.stop();
      setTimeout(() => {
        log("error", "platform shutdown timed out; forcing exit");
        process.exit(1);
      }, 10000).unref();
      // Stop taking requests before the store they depend on goes away.
      app
        .close()
        .then(() => store.client.close())
        .then(() => process.exit(0))
        .catch((error) => {
          log("error", "platform shutdown failed", errorFields(error));
          process.exit(1);
        });
    });
}
process.on("unhandledRejection", (reason) =>
  log("error", "unhandled rejection", errorFields(reason)),
);
process.on("uncaughtException", (error) => {
  log("error", "uncaught exception", errorFields(error));
  process.exit(1);
});
main().catch((error) => {
  log("error", "platform failed to start", errorFields(error));
  process.exit(1);
});
