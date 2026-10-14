import type { Express } from "express";

import { PlatformService } from "../app/platform-service";
import { route } from "../http/handlers";

export function registerProjectRoutes(
  http: Express,
  { service }: { service: PlatformService },
) {
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
}
