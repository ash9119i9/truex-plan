import type { Express } from "express";

import { assistantCapabilities } from "../../../shared/assistant-capabilities";
import { Store } from "../persistence/store";
import { PlatformService } from "../app/platform-service";
import { route } from "./handlers";
import { currentTenant } from "../tenancy/tenant";
import { authMode, currentUser } from "../identity/user";
import { defaultSignupSettings } from "../identity/google";
import { userTenants } from "../identity/auth";

export function registerMeRoutes(
  http: Express,
  {
    store,
    mode,
    defaultSignup,
  }: {
    store: Store;
    mode: ReturnType<typeof authMode>;
    defaultSignup: ReturnType<typeof defaultSignupSettings> | undefined;
  },
) {
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
        tenant: {
          id: tenant.id,
          name: current?.name ?? tenant.id,
          ...(tenant.isUserSpecific === undefined
            ? {}
            : { isUserSpecific: tenant.isUserSpecific }),
        },
        role: user.role,
        tenants,
        // Lets the app know whether there is a session to end.
        auth: mode,
        ...(mode === "google"
          ? {
              selfService: false,
              showWorkspaces: tenant.id !== defaultSignup!.tenantId,
            }
          : {}),
      });
    }),
  );
}

export function registerFeatureRoutes(
  http: Express,
  { service }: { service: PlatformService },
) {
  http.get(
    "/api/features",
    route((_req, res) => res.json({ approvalModes: service.approvalModes })),
  );

  http.get(
    "/api/assistant-capabilities",
    route((_req, res) => res.json(assistantCapabilities)),
  );
}

export function registerRuntimeMetadataRoutes(
  http: Express,
  { service }: { service: PlatformService },
) {
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
}
