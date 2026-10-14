import type { Express } from "express";

import { PlatformService } from "../app/platform-service";
import { route } from "../http/handlers";

export function registerAgentRoutes(
  http: Express,
  { service }: { service: PlatformService },
) {
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
    "/api/agents/:id",
    route(async (req, res) =>
      res.json(await service.agentDetails(String(req.params.id))),
    ),
  );

  http.post(
    "/api/agents/:id",
    route(async (req, res) =>
      res.json(await service.updateAgent(String(req.params.id), req.body)),
    ),
  );
}
