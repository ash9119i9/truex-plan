import type { Request, Response } from "express";
import { route } from "../http";
import { ApiError } from "../errors";
import type { AutomationService } from "./service";
export function automationRoutes(
  http: any,
  get: () => Promise<AutomationService>,
  enabled: boolean,
) {
  const id = (req: Request) => String(req.params.id),
    runId = (req: Request) => String(req.params.runId);
  http.get(
    "/api/automations",
    route(async (_req, res) =>
      res.json(
        enabled ? await (await get()).list() : { available: false, items: [] },
      ),
    ),
  );
  if (!enabled) return;
  http.post(
    "/api/automations/preview",
    route(async (req, res) => res.json(await (await get()).preview(req.body))),
  );
  http.post(
    "/api/automations",
    route(async (req, res) =>
      res.status(201).json(await (await get()).create(req.body)),
    ),
  );
  http.get(
    "/api/automations/:id",
    route(async (req, res) => res.json(await (await get()).get(id(req)))),
  );
  http.put(
    "/api/automations/:id",
    route(async (req, res) =>
      res.json(await (await get()).edit(id(req), req.body)),
    ),
  );
  http.post(
    "/api/automations/:id/control",
    route(async (req, res) =>
      res.json(await (await get()).control(id(req), req.body)),
    ),
  );
  http.post(
    "/api/automations/:id/runs",
    route(async (req, res) =>
      res.status(202).json(await (await get()).runNow(id(req), req.body)),
    ),
  );
  http.get(
    "/api/automations/:id/runs",
    route(async (req, res) =>
      res.json(await (await get()).history(id(req), req.query)),
    ),
  );
  http.get(
    "/api/automations/:id/runs/:runId",
    route(async (req, res) =>
      res.json(await (await get()).runDetails(id(req), runId(req))),
    ),
  );
  http.post(
    "/api/automations/:id/runs/:runId/cancel",
    route(async (req, res) =>
      res.json(await (await get()).cancel(id(req), runId(req))),
    ),
  );
  http.post(
    "/api/automations/:id/runs/:runId/read",
    route(async (req, res) =>
      res.json(await (await get()).read(id(req), runId(req))),
    ),
  );
  http.get(
    "/api/automations/:id/export.csv",
    route(async (req, res) => {
      res.type("text/csv");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="automation-history.csv"',
      );
      res.send(await (await get()).export(id(req), req.query));
    }),
  );
}
