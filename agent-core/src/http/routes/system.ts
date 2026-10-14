import type { Express } from "express";
import { accessSync, constants } from "node:fs";
import { HttpError } from "../../errors";
import { inventory, schema } from "../../protocol/schema";
import type { CoreDependencies } from "../dependencies";

export function registerHealthRoutes(
  app: Express,
  dependencies: CoreDependencies,
) {
  const { home, client, manager, pin } = dependencies;
  app.get("/livez", (_req, res) => res.json({ ok: true }));
  app.get("/healthz", async (_req, res) => {
    let writable = true;
    try {
      accessSync(home, constants.W_OK);
    } catch {
      writable = false;
    }
    const identity = await client.start();
    res.status(manager.draining ? 503 : 200).json({
      ok: !manager.draining,
      codex: identity.userAgent,
      revision: pin.revision,
      spawnMs: client.spawnMs,
      initializeMs: client.initializeMs,
      codexHome: home,
      codexHomeWritable: writable,
      unknownMethods: manager.unknownMethods,
      threads: manager.threads.size,
      activeThreads: [...manager.threads.values()].filter(
        (thread) => thread.state.kind !== "idle",
      ).length,
    });
  });
  app.get("/capabilities", (_req, res) => res.json(inventory));
}

export function registerSchemaRoutes(app: Express) {
  app.get("/schemas/:name", (req, res) => {
    if (!/^\w+$/.test(req.params.name))
      throw new HttpError(400, "Invalid schema");
    res.json(schema(req.params.name));
  });
}
