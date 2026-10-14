import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { json } from "express";

import { Store } from "../persistence/store";

import { PlatformService, ApiError } from "./platform-service";
import { errorFields, log, REQUEST_ID_HEADER } from "../../../shared/logging";
import { errorHandler, requestIdMiddleware, route } from "../http/handlers";
import { currentTenant } from "../tenancy/tenant";
import { authMode, currentUser } from "../identity/user";
import {
  assertGoogleConfig,
  defaultSignupSettings,
  googleSettings,
} from "../identity/google";

import { inviteMailer } from "../identity/invites";

import { DemoGate, demoConfig } from "../demo/demo";
import { DemoQuota } from "../demo/quota";

import { StreamLimiter, streamLimit } from "../streaming/guards";
import { registerMeRoutes } from "../http/metadata.routes";
import { registerAgentRoutes } from "../agents/routes";
import { registerFeatureRoutes } from "../http/metadata.routes";
import { registerDocumentRoutes } from "../conversations/documents.routes";
import { registerMcpRoutes } from "../mcp/routes";
import { registerRuntimeMetadataRoutes } from "../http/metadata.routes";
import { registerSessionCollectionRoutes } from "../conversations/routes";
import { registerProjectRoutes } from "../projects/routes";
import { registerConversationRoutes } from "../conversations/routes";
import { registerEventRoutes } from "../streaming/events.route";
import { registerSecurity } from "./security";
import { registerShutdown } from "./lifecycle";

@Module({})
class AppModule {}
export async function main() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  const http = app.getHttpAdapter().getInstance();
  http.use(requestIdMiddleware);
  // Refuses an unknown mode, or google without its keys, before anything
  // else is built.
  const mode = authMode();
  // The public demo exists only with Google sign-in. Refused here rather than
  // quietly running a demo that cannot identify anyone.
  const demoSettings = demoConfig();
  if (demoSettings && mode !== "google")
    throw new Error("DEMO_TENANT_ID requires AUTH_MODE=google.");
  if (mode === "google") {
    assertGoogleConfig(googleSettings());
    if (
      process.env.NODE_ENV === "production" &&
      !process.env.TRUST_PROXY?.trim()
    )
      log(
        "warn",
        "TRUST_PROXY is not set: every sign-in request shares the rate limit of the forwarder's address",
      );
  }
  // POC mode does not register invitation routes or initialize email delivery.
  // Without a mail key outside development, invitations are issued with the
  // operator command and the demo needs no mail at all.
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
  // Google sign-in writes account, membership and invitation changes in catalog
  // transactions, which need a replica set. Reported loudly and never worked
  // around: without it sign-in fails (and says so), while sessions that exist
  // keep working.
  let transactions = true;
  if (mode === "google" && connected) {
    transactions = await store.supportsTransactions().catch(() => false);
    if (!transactions)
      log(
        "error",
        "the database does not support transactions; Google sign-in and invitations will fail until MongoDB runs as a replica set",
      );
  }
  const service = new PlatformService(store);
  const demo = new DemoGate(store, demoSettings, mode);
  const defaultSignup = mode === "google" ? defaultSignupSettings() : undefined;
  if (demoSettings) service.quota = new DemoQuota(store, demoSettings);
  const streams = new StreamLimiter(streamLimit());
  if (mode === "google")
    service.dispatchGuard = async () => {
      const user = currentUser();
      const tenant = currentTenant();
      if (!user || !tenant) return;
      const [account, membership] = await Promise.all([
        store.users.findOne(
          { _id: user.id, status: "active" },
          { projection: { _id: 1 } },
        ),
        store.memberships.findOne(
          { userId: user.id, tenantId: tenant.id, status: "active" },
          { projection: { _id: 1 } },
        ),
      ]);
      if (!account || !membership)
        throw new ApiError(
          403,
          "Your access to this workspace has ended",
          "ACCESS_REVOKED",
        );
      // Throws TENANT_DISABLED for a workspace disabled since the request began.
      await store.resolveTenant(tenant.id, { fresh: true });
    };
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
      // Reported (as a flag only; the reasons are for operators, at
      // GET /api/admin/demo), but never part of ok: a demo that is not ready
      // keeps people out of the demo only, and must not take the service out of
      // rotation for customers.
      let demoStatus: { enabled: true; ready: boolean } | undefined;
      if (mongo && demo.enabled)
        try {
          demoStatus = {
            enabled: true,
            ready: !!(await demo.readiness())?.ready,
          };
        } catch {
          demoStatus = { enabled: true, ready: false };
        }
      res.status(ok ? 200 : 503).json({
        ok,
        mongo,
        agentCore,
        ...(mode === "google" ? { transactions } : {}),
        ...(demoStatus ? { demo: demoStatus } : {}),
      });
    }),
  );
  // Nothing under /api or /auth is cached, by the browser or a shared cache:
  // responses are per person and per cookie.
  http.use(
    ["/api", "/auth"],
    (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Cookie");
      next();
    },
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
  registerSecurity(http, {
    mode,
    origins,
    store,
    service,
    mailer,
    demo,
    defaultSignup,
  });
  registerMeRoutes(http, { store, mode, defaultSignup });
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
  registerAgentRoutes(http, { service });
  registerFeatureRoutes(http, { service });
  registerDocumentRoutes(http, { service });
  registerMcpRoutes(http, { service });
  registerRuntimeMetadataRoutes(http, { service });
  registerSessionCollectionRoutes(http, { service });
  registerProjectRoutes(http, { service });
  registerConversationRoutes(http, { service, store, mode });
  registerEventRoutes(http, { service, store, mode, streams });
  http.use(errorHandler);
  const port = Number(process.env.PORT || 4000),
    host = process.env.HOST || "127.0.0.1";
  await app.listen(port, host);
  log("info", "platform listening", { port, host });
  registerShutdown(app, service, store);
}
