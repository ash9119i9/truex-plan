import type { Express } from "express";

import { recentSnapshot, withPlanFallback } from "../public/conversation";
import { PublicEventStream } from "./event-stream";
import { relay } from "./relay";
import { Store } from "../persistence/store";
import {
  PlatformService,
  ApiError,
  upstreamError,
} from "../app/platform-service";
import { errorFields, log } from "../../../shared/logging";
import {
  endedStream,
  failStream,
  route,
  streamErrorFrame,
} from "../http/handlers";
import { currentTenant, tenantContext } from "../tenancy/tenant";
import { authMode, currentUser, userContext } from "../identity/user";
import { authorizeRequest } from "../identity/auth";
import { checkSession } from "../tenancy/access";
import { auditAfter } from "../tenancy/audit";
import {
  StreamLimiter,
  logStreamEnd,
  revalidateMs,
  watchAccess,
  type GuardVerdict,
} from "./guards";

export function registerEventRoutes(
  http: Express,
  {
    service,
    store,
    mode,
    streams,
  }: {
    service: PlatformService;
    store: Store;
    mode: ReturnType<typeof authMode>;
    streams: StreamLimiter;
  },
) {
  http.get(
    "/api/sessions/:id/events",
    route(async (req, res) => {
      if (
        (req.query.window !== undefined && req.query.window !== "1") ||
        (req.query.sync !== undefined && req.query.sync !== "v1")
      )
        throw new ApiError(
          400,
          "Invalid conversation synchronization options",
          "INVALID_INPUT",
        );
      const s = await service.sessionFor(String(req.params.id), "read");
      // Someone else's private conversation (an admin's view) is relayed as it
      // happens and nothing is stored from it: the owner's own stream and the
      // background sync do the saving.
      const passive = service.isPassiveView(s);
      const me = currentUser();
      const release = me ? streams.acquire(me.id) : () => {};
      if (!release)
        throw new ApiError(
          429,
          "You have too many conversations open at once. Close one and try again.",
          "STREAM_LIMIT",
        );
      if (!service.hosts.includes(s.agentCoreHost)) {
        release();
        throw new ApiError(
          503,
          "Session owner is not configured",
          "OWNER_UNCONFIGURED",
        );
      }
      const requestId: string = res.locals.requestId;
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      let upstream: globalThis.Response;
      try {
        upstream = await service.events(
          s,
          req.get("Last-Event-ID") || String(req.query.cursor || ""),
          abort.signal,
          requestId,
          {
            window: req.query.window === "1" ? true : undefined,
            sync: req.query.sync === "v1" ? "v1" : undefined,
          },
        );
      } catch (error) {
        release();
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          503,
          "Live updates cannot connect to the assistant service. Reopen the conversation when the service is available.",
          "OWNER_UNAVAILABLE",
          { cause: error },
        );
      }
      if (!upstream.ok) {
        release();
        throw upstreamError(
          upstream.status,
          await upstream.json().catch(() => null),
          "Live updates are unavailable. Reopen the conversation to reconnect.",
          "STREAM_UNAVAILABLE",
          "/events",
        );
      }
      if (!upstream.body) {
        release();
        throw new ApiError(
          502,
          "The assistant service returned an empty live-update stream. Reopen the conversation to reconnect.",
          "STREAM_UNAVAILABLE",
        );
      }
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const openedAt = Date.now();
      // Google mode: keep checking that this person may still read this
      // conversation, and end the stream the moment they may not. Runs with
      // the request's own identity, never extending the session.
      let ended: Exclude<GuardVerdict, { ok: true }> | undefined;
      const stopGuard =
        mode === "google"
          ? watchAccess({
              intervalMs: revalidateMs(),
              check: async () => {
                try {
                  const auth = await authorizeRequest(store, req, {
                    passive: true,
                  });
                  // The same tenant the stream was opened in.
                  if (auth.tenant.id !== currentTenant()?.id)
                    return { ok: false, reason: "revoked" };
                  await tenantContext.run(auth.tenant, () =>
                    userContext.run(auth.ref, async () => {
                      const fresh = await store.sessions.findOne({
                        _id: s._id,
                      });
                      if (!fresh)
                        throw new ApiError(
                          404,
                          "Session not found",
                          "SESSION_NOT_FOUND",
                        );
                      checkSession(fresh, "read");
                    }),
                  );
                  return { ok: true };
                } catch (error) {
                  // A refusal from the authority is a revocation; anything
                  // else (storage down) means access cannot be confirmed.
                  return error instanceof ApiError &&
                    [401, 403, 404].includes(error.status)
                    ? { ok: false, reason: "revoked" }
                    : { ok: false, reason: "unavailable" };
                }
              },
              onEnd: (verdict) => {
                ended = verdict;
                logStreamEnd({
                  requestId,
                  sessionId: s._id,
                  userId: me?.id,
                  reason: verdict.reason,
                });
                if (!res.destroyed && !res.writableEnded)
                  res.write(
                    streamErrorFrame(
                      requestId,
                      verdict.reason === "revoked"
                        ? "ACCESS_REVOKED"
                        : "AUTH_UNAVAILABLE",
                    ),
                  );
                abort.abort();
              },
            })
          : () => {};
      try {
        // Highest token count seen for the current goal on this stream, so a
        // restarted assistant service never shows a smaller count.
        let counted = s.goal ?? null;
        const remember = (
          goal: any,
          event?: { turnId?: string; at?: string },
        ) => {
          if (goal) {
            const same =
              !!counted &&
              (counted.createdAt ?? null) === (goal.createdAt ?? null);
            goal.tokensObserved = Math.max(
              goal.tokensObserved ?? 0,
              same ? (counted?.tokensObserved ?? 0) : 0,
            );
          }
          counted = goal;
          if (passive) return;
          void service
            .rememberGoal(s._id, goal, {
              turnId: event?.turnId,
              eventAt: event?.at,
            })
            .catch((error) =>
              log("warn", "live update persistence failed", {
                sessionId: s._id,
                op: "rememberGoal",
                ...errorFields(error),
              }),
            );
        };
        // Latest plan seen on this stream, starting from the saved one.
        let planSteps = s.plan?.steps;
        const stream = new PublicEventStream((event) => {
          if (event.type === "goal.updated") remember(event.data.goal, event);
          if (event.type === "goal.cleared") remember(null, event);
          if (event.type === "snapshot" && "goal" in event.data)
            remember(event.data.goal);
          if (event.type === "plan.updated") {
            planSteps = event.data.plan;
            if (!passive)
              void store
                .savePlan(s._id, {
                  plan: event.data.plan,
                  explanation: event.data.explanation,
                  turnId: event.turnId,
                  cursor: event.cursor,
                  at: event.at,
                })
                .catch((error) =>
                  log("warn", "live update persistence failed", {
                    sessionId: s._id,
                    op: "savePlan",
                    ...errorFields(error),
                  }),
                );
          }
          if (event.type === "sync.completed") {
            const operational = withPlanFallback(event.data.snapshot, {
              steps: planSteps,
            });
            if (operational.goal) remember(operational.goal, event);
            return { ...event, data: { ...event.data, snapshot: operational } };
          }
          if (event.type === "snapshot") {
            if (event.data.plan?.length) {
              planSteps = event.data.plan;
              if (!passive)
                void service
                  .rememberSnapshotPlan(s._id, event.data)
                  .catch((error) =>
                    log("warn", "live update persistence failed", {
                      sessionId: s._id,
                      op: "rememberSnapshotPlan",
                      ...errorFields(error),
                    }),
                  );
            } else
              event = {
                ...event,
                data: withPlanFallback(event.data, { steps: planSteps }),
              };
            return req.query.window === "1"
              ? { ...event, data: recentSnapshot(event.data) }
              : event;
          }
        }, req.query.sync === "v1");
        await relay(upstream.body as any, res, stream);
        if (!res.destroyed && !ended)
          endedStream(res, { requestId, sessionId: s._id });
      } catch (error) {
        // A client disconnect (or the guard ending the stream) aborts the
        // upstream read; that is not a failure.
        if (!res.destroyed && !ended)
          failStream(res, error, { requestId, sessionId: s._id });
      } finally {
        stopGuard();
        abort.abort();
        release();
        if (!res.destroyed) res.end();
        if (passive && me)
          await auditAfter(store, {
            actor: me.id,
            actorRole: me.role,
            action: "session.stream.close",
            tenantId: currentTenant()!.id,
            target: {
              type: "session",
              id: s._id,
              ...(s.userId ? { ownerId: s.userId } : {}),
            },
            outcome: ended ? `ended:${ended.reason}` : "closed",
            requestId,
            detail: { durationMs: Date.now() - openedAt },
          });
      }
    }),
  );
}
