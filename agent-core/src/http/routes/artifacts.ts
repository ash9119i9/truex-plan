import type { Express } from "express";
import { HttpError } from "../../errors";
import type { CoreDependencies } from "../dependencies";

export function registerArtifactRoutes(
  app: Express,
  { client }: CoreDependencies,
) {
  app.get("/threads/:id/documents", async (req, res) =>
    res.json({
      available: client.documentToolsAvailable(req.params.id),
      visualizationAvailable: client.visualizationToolsAvailable(req.params.id),
      files: await client.files.list(req.params.id),
    }),
  );
  app.post("/threads/:id/documents", async (req, res) => {
    if (!client.documentToolsAvailable(req.params.id))
      throw new HttpError(409, "Start a new conversation to use documents");
    res
      .status(201)
      .json(
        await client.files.upload(
          req.params.id,
          req.body.name,
          req.body.base64,
        ),
      );
  });
  app.get("/threads/:id/visualizations/:fileId", async (req, res) =>
    res.json(
      await client.files.visualization(req.params.id, req.params.fileId),
    ),
  );
  app.get("/threads/:id/documents/:fileId", async (req, res) => {
    const { data, ...file } = await client.files.get(
      req.params.id,
      req.params.fileId,
    );
    res.json({ ...file, base64: data.toString("base64") });
  });
}
