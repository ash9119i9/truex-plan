import type { Express } from "express";

import { PlatformService } from "../app/platform-service";
import { route } from "../http/handlers";

export function registerMcpRoutes(
  http: Express,
  { service }: { service: PlatformService },
) {
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
}
