import type { Express } from "express";
import { HttpError } from "../../errors";
import { readItems } from "../../runtime/history";
import {
  runtimeWindowQuery,
  runtimeSyncOption,
} from "../../../../shared/runtime-read-options";
import type { CoreDependencies } from "../dependencies";

function snapshotOptions(path: string, window: unknown, sync: unknown) {
  try {
    return {
      window: runtimeWindowQuery(window),
      sync: runtimeSyncOption("GET", path, sync),
    };
  } catch {
    throw new HttpError(400, "Invalid runtime read options");
  }
}
export function registerThreadRoutes(
  app: Express,
  { client, manager }: CoreDependencies,
) {
  app.post("/threads", async (req, res) =>
    res.status(201).json({
      ...(await manager.create(req.body)),
      runtimeStartup: {
        spawnMs: client.spawnMs,
        initializeMs: client.initializeMs,
      },
    }),
  );
  app.post("/threads/:id/resume", async (req, res) =>
    res.json(await manager.resume(req.params.id, req.body)),
  );
  // Alpha: changes a conversation's approval mode and applies it to waiting
  // requests. Body { mode: "ask" | "readOnly" | "auto" }.
  app.post("/threads/:id/approval-mode", (req, res) =>
    res.json(manager.setApprovalMode(req.params.id, req.body?.mode)),
  );
  app.post("/threads/:id/turns", async (req, res) =>
    res
      .status(202)
      .json(
        await manager.message(req.params.id, req.body.text, req.body.clientId),
      ),
  );
  app.post("/threads/:id/steer", async (req, res) =>
    res
      .status(202)
      .json(
        await manager.message(
          req.params.id,
          req.body.text,
          req.body.clientId,
          true,
        ),
      ),
  );
  app.post("/threads/:id/interrupt", async (req, res) =>
    res.json(await manager.interrupt(req.params.id)),
  );
  app.get("/threads/:id/events", (req, res) =>
    manager.subscribe(
      req.params.id,
      res,
      req.get("Last-Event-ID") || String(req.query.cursor || "") || undefined,
      snapshotOptions(req.path, req.query.window, req.query.sync),
    ),
  );
  app.get("/threads/:id/snapshot", (req, res) =>
    res.json(
      manager.snapshot(
        req.params.id,
        snapshotOptions(req.path, req.query.window, req.query.sync),
      ),
    ),
  );
  app.get("/threads/:id/records", (req, res) =>
    res.json(manager.records(req.params.id)),
  );
  app.post("/threads/:id/records/ack", (req, res) => {
    if (!Array.isArray(req.body.keys))
      throw new HttpError(400, "keys must be an array");
    manager.ack(req.params.id, req.body.keys);
    res.json({ ok: true });
  });
  app.post("/threads/:id/approvals/:requestId", (req, res) =>
    res.json(
      manager.answer(req.params.id, req.params.requestId, req.body.result),
    ),
  );
  app.get("/threads/:id/items", async (req, res) =>
    res.json(
      manager.redactor.clean(
        await readItems(
          client,
          req.params.id,
          String(req.query.cursor || "") || undefined,
        ),
      ),
    ),
  );
  app.get("/threads/:id/turns/:turnId/context", (req, res) =>
    res.json(manager.turnContext(req.params.id, req.params.turnId)),
  );
  app.get("/threads/:id/agents", (req, res) =>
    res.json(manager.agents(req.params.id)),
  );
  app.get("/threads/:id/agents/:agentId", (req, res) =>
    res.json(manager.agent(req.params.id, req.params.agentId)),
  );
  app.post("/threads/:id/agents/:agentId/interrupt", async (req, res) =>
    res.json(await manager.interruptAgent(req.params.id, req.params.agentId)),
  );
  app.post("/threads/:id/capabilities", async (req, res) =>
    res.json(
      await manager.capability(
        req.params.id,
        req.body.method,
        req.body.params || {},
      ),
    ),
  );
  app.delete("/threads/:id", async (req, res) =>
    res.json(await manager.capability(req.params.id, "thread/delete", {})),
  );
}
