import type { Express } from "express";

import { publicTiming, publicTrace } from "../public/telemetry";
import { Store } from "../persistence/store";
import { sessionTraces } from "./traces";
import type { TurnTrace } from "../../../shared/contracts";
import { PlatformService } from "../app/platform-service";
import { errorFields, log } from "../../../shared/logging";
import { route } from "../http/handlers";
import { authMode } from "../identity/user";

export function registerSessionCollectionRoutes(
  http: Express,
  { service }: { service: PlatformService },
) {
  http.post(
    "/api/sessions",
    route(async (req, res) =>
      res
        .status(201)
        .json(
          await service.create(
            req.body.agentId,
            req.body.subAgents,
            req.body.projectId,
            req.body.approvalMode,
          ),
        ),
    ),
  );

  http.get(
    "/api/sessions",
    route(async (req, res) =>
      res.json(await service.sessions(req.query.projectId)),
    ),
  );
}

export function registerConversationRoutes(
  http: Express,
  {
    service,
    store,
    mode,
  }: {
    service: PlatformService;
    store: Store;
    mode: ReturnType<typeof authMode>;
  },
) {
  http.get(
    "/api/sessions/:id",
    route(async (req, res) => {
      const timings: string[] = [];
      const history = await service.history(String(req.params.id), {
        persistedOnly: req.query.persisted === "1",
        window: req.query.window === "1",
        before: req.query.before,
        onTiming: (phase, duration) =>
          timings.push(`${phase};dur=${duration.toFixed(2)}`),
      });
      res.set({
        "Cache-Control": "private, no-store",
        "Server-Timing": timings.join(", "),
      });
      res.json(history);
    }),
  );

  http.post(
    "/api/sessions/:id/messages",
    route(async (req, res) => {
      const result = await service.message(
        String(req.params.id),
        req.body.text,
        req.body.clientId,
      );
      if (result.platformTiming)
        res.set(
          "Server-Timing",
          Object.entries<number>(result.platformTiming)
            .map(
              ([phase, duration]) =>
                `${phase.replace(/Ms$/, "")};dur=${duration.toFixed(2)}`,
            )
            .join(", "),
        );
      res.status(202).json(result);
    }),
  );

  http.get(
    "/api/sessions/:id/agents",
    route(async (req, res) =>
      res.json(await service.subAgents(String(req.params.id))),
    ),
  );

  http.get(
    "/api/sessions/:id/agents/:agentId",
    route(async (req, res) =>
      res.json(
        await service.subAgent(
          String(req.params.id),
          String(req.params.agentId),
        ),
      ),
    ),
  );

  http.post(
    "/api/sessions/:id/agents/:agentId/interrupt",
    route(async (req, res) =>
      res.json(
        await service.interruptAgent(
          String(req.params.id),
          String(req.params.agentId),
        ),
      ),
    ),
  );

  http.post(
    "/api/sessions/:id/interrupt",
    route(async (req, res) =>
      res.json(
        await service.owned(
          await service.sessionFor(String(req.params.id), "write"),
          "/interrupt",
          "POST",
          {},
        ),
      ),
    ),
  );

  http.post(
    "/api/sessions/:id/approvals/:requestId",
    route(async (req, res) =>
      res.json(
        await service.owned(
          await service.sessionFor(String(req.params.id), "write"),
          "/approvals/" + encodeURIComponent(String(req.params.requestId)),
          "POST",
          { result: req.body.result },
        ),
      ),
    ),
  );

  http.post(
    "/api/sessions/:id/approval-mode",
    route(async (req, res) =>
      res.json(
        await service.setApprovalMode(String(req.params.id), req.body?.mode),
      ),
    ),
  );

  http.post(
    "/api/sessions/:id/capabilities",
    route(async (req, res) =>
      res.json(
        await (req.body.command
          ? service.command(
              String(req.params.id),
              req.body.method,
              req.body.params || {},
              req.body.command,
            )
          : service.capability(
              String(req.params.id),
              req.body.method,
              req.body.params || {},
            )),
      ),
    ),
  );

  http.get(
    "/api/sessions/:id/goal/history",
    route(async (req, res) =>
      res.json(await service.goalHistory(String(req.params.id))),
    ),
  );

  http.post(
    "/api/sessions/:id/goal/review",
    route(async (req, res) =>
      res.json(await service.reviewGoal(String(req.params.id), req.body || {})),
    ),
  );

  http.get(
    "/api/sessions/:id/timings",
    route(async (req, res) => {
      const s = await service.sessionFor(String(req.params.id), "read");
      res.set("Cache-Control", "private, no-store");
      if (req.query.persisted !== "1" && !service.isPassiveView(s))
        await service.ingest(s);
      const rows = ((await service.session(s._id)).timings || []).map(
        publicTiming,
      );
      res.json({
        runtimeStartup: s.runtimeStartup
          ? {
              spawnMs: s.runtimeStartup.spawnMs,
              initializeMs: s.runtimeStartup.initializeMs,
            }
          : undefined,
        threadStartMs: s.threadStartMs,
        turns: rows,
        averages: {
          totalMs: rows.length
            ? rows.reduce((a, b) => a + b.totalMs, 0) / rows.length
            : 0,
          ttftMs:
            rows
              .filter((x) => x.ttftMs !== null)
              .reduce((a, b) => a + (b.ttftMs || 0), 0) /
            Math.max(1, rows.filter((x) => x.ttftMs !== null).length),
        },
      });
    }),
  );

  http.get(
    "/api/sessions/:id/traces",
    route(async (req, res) => {
      const s = await service.sessionFor(String(req.params.id), "read");
      res.set("Cache-Control", "private, no-store");
      // Stored traces stay readable while the assistant service is down.
      if (req.query.persisted !== "1" && !service.isPassiveView(s))
        await service.ingest(s).catch((error) =>
          log("warn", "trace ingestion failed", {
            sessionId: s._id,
            op: "ingest",
            ...errorFields(error),
          }),
        );
      res.json(
        sessionTraces(
          (await store.sessionTraces(s._id))
            .map(publicTrace)
            .filter((t): t is TurnTrace => t !== null),
        ),
      );
    }),
  );

  // Live-only masked context; never persisted or logged here.
  http.get(
    "/api/sessions/:id/turns/:turnId/context",
    route(async (req, res) => {
      const s = await service.sessionFor(String(req.params.id), "read");
      res.set("Cache-Control", "no-store");
      res.json(
        await service.owned(
          s,
          `/turns/${encodeURIComponent(String(req.params.turnId))}/context`,
        ),
      );
    }),
  );
}
