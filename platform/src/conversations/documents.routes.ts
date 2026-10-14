import type { Express } from "express";

import { PlatformService, ApiError } from "../app/platform-service";
import { route } from "../http/handlers";

export function registerDocumentRoutes(
  http: Express,
  { service }: { service: PlatformService },
) {
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
}
