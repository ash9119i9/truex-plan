import type { Express } from "express";
import type { Request, Response } from "express";

import { Store } from "../persistence/store";
import { PlatformService } from "./platform-service";
import { log } from "../../../shared/logging";
import { tenantMiddleware, userMiddleware } from "../http/handlers";
import { devTenantResolver, pocTenantResolver } from "../tenancy/tenant";
import { authMode, devUserResolver, pocUserResolver } from "../identity/user";
import {
  defaultSignupSettings,
  googleRoutes,
  googleSettings,
} from "../identity/google";
import { adminApiRoutes, adminAuthRoutes, adminGate } from "../admin/admin";
import { inviteLookupRoutes, inviteMailer } from "../identity/invites";
import {
  authMiddleware,
  authRoutes,
  csrfMiddleware,
  rateLimit,
} from "../identity/auth";
import { DemoGate } from "../demo/demo";
import { workspaceRoutes } from "../identity/workspaces";

export function registerSecurity(
  http: Express,
  {
    mode,
    origins,
    store,
    service,
    mailer,
    demo,
    defaultSignup,
  }: {
    mode: ReturnType<typeof authMode>;
    origins: string[];
    store: Store;
    service: PlatformService;
    mailer: ReturnType<typeof inviteMailer> | undefined;
    demo: DemoGate;
    defaultSignup: ReturnType<typeof defaultSignupSettings> | undefined;
  },
) {
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
      adminApiRoutes(store, service, mailer!, demo),
    );
  }

  if (mode === "google") {
    // Every API request resolves its tenant and user from the session
    // cookie. The dev resolvers are never built in this mode.
    http.use("/api", authMiddleware(store));
    http.use("/auth", authRoutes(store));
    http.use(
      "/auth",
      workspaceRoutes(store, mailer!, !demo.enabled, defaultSignup!.tenantId),
    );
    http.use(
      "/auth",
      googleRoutes(store, googleSettings(), demo, defaultSignup),
    );
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
}
