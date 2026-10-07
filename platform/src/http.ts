import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";
import { httpError } from "../../shared/errors";
import { ApiError } from "./errors";
import { tenantContext, type TenantRef, type TenantResolver } from "./tenant";
import { userContext, type UserRef, type UserResolver } from "./user";
import {
  errorFields,
  log,
  REQUEST_ID_HEADER,
  requestId,
} from "../../shared/logging";

// The inbound request id, so agent-core calls can forward it without every
// service method taking it as a parameter.
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const currentRequestId = () => requestContext.getStore()?.requestId;

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const id = requestId(req.get(REQUEST_ID_HEADER));
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

// Resolves the request's tenant once, before any handler touches storage.
export function tenantMiddleware(
  resolver: TenantResolver,
  lookup: (id: string) => Promise<TenantRef>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    let id: string;
    try {
      id = resolver.resolve(req);
    } catch (error) {
      return next(error);
    }
    lookup(id).then((tenant) => {
      res.locals.tenant = tenant;
      next();
    }, next);
  };
}

// Resolves the request's user once, next to its tenant.
export function userMiddleware(resolver: UserResolver) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.user = resolver.resolve(req);
    } catch (error) {
      return next(error);
    }
    next();
  };
}

// Runs a handler inside its request context. Set per handler because async
// context does not survive the body parser's stream events.
//
// No user in context means an internal caller (ingestion, scripts), which is
// allowed everything. A request on /api must therefore never reach a handler
// without its user and tenant: that would turn a missing middleware into an
// internal-caller bypass. It fails closed here, whatever mounted the route.
// /api/admin is the separate control plane, gated by its own session.
export const route =
  (fn: (req: Request, res: Response) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) => {
    const user: UserRef | undefined = res.locals.user;
    const tenant: TenantRef | undefined = res.locals.tenant;
    if (
      /^\/api(\/|\?|$)/.test(req.originalUrl) &&
      res.locals.admin !== true &&
      (!user || !tenant)
    ) {
      log("error", "api request without user or tenant context", {
        requestId: res.locals.requestId,
        method: req.method,
        path: loggablePath(req),
      });
      return next(
        new ApiError(500, "Request context is missing", "CONTEXT_MISSING"),
      );
    }
    if (req.path.startsWith("/api/sessions/"))
      res.locals.sessionId = req.params.id;
    const run = () =>
      requestContext.run({ requestId: res.locals.requestId }, () =>
        Promise.resolve()
          .then(() => fn(req, res))
          .catch(next),
      );
    const withUser = () => (user ? userContext.run(user, run) : run());
    return tenant ? tenantContext.run(tenant, withUser) : withUser();
  };

// Invite and session tokens travel in URL paths. A path is logged with any
// token-shaped segment replaced, never as received.
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{43}$/;
export function loggablePath(req: Pick<Request, "originalUrl">) {
  return req.originalUrl
    .split("?")[0]
    .split("/")
    .map((segment) => (TOKEN_SEGMENT.test(segment) ? ":token" : segment))
    .join("/");
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const { status, ...body } = httpError(error, "platform");
  const fields = {
    ...errorFields(error),
    requestId: res.locals.requestId,
    method: req.method,
    path: loggablePath(req),
    sessionId: res.locals.sessionId,
    tenantId: res.locals.tenant?.id,
    userId: res.locals.user?.id,
    status,
    code: body.code,
  };
  if (status >= 500) log("error", "request failed", fields);
  else log("debug", "request rejected", fields);
  // A partly written response cannot carry an error body.
  if (res.headersSent) return next(error);
  const retryAfter = (error as { retryAfterSeconds?: number })
    ?.retryAfterSeconds;
  if (status === 429 && Number.isFinite(retryAfter))
    res.setHeader("Retry-After", String(retryAfter));
  res.status(status).json({ ...body, requestId: res.locals.requestId });
}

const streamEnds = {
  STREAM_FAILED:
    "Live updates stopped unexpectedly. Reopen the conversation to reconnect.",
  STREAM_ENDED:
    "The assistant service stopped live updates, usually for a restart. Reconnect in a moment.",
  ACCESS_REVOKED:
    "Your access to this conversation has ended. Sign in again, or ask your administrator.",
  AUTH_UNAVAILABLE:
    "Live updates stopped because your access could not be confirmed. Reopen the conversation in a moment.",
};
type StreamEnd = keyof typeof streamEnds;

// Named stream.error because EventSource reserves "error" for connection loss.
export function streamErrorFrame(
  requestId?: string,
  code: StreamEnd = "STREAM_FAILED",
) {
  return `event: stream.error\ndata: ${JSON.stringify({
    code,
    error: streamEnds[code],
    requestId,
  })}\n\n`;
}

interface StreamResponse {
  destroyed: boolean;
  writableEnded: boolean;
  write(chunk: string): unknown;
}
export function failStream(
  res: StreamResponse,
  error: unknown,
  fields: { requestId?: string; sessionId?: string },
) {
  log("error", "live update stream failed", {
    ...errorFields(error),
    ...fields,
    code: "STREAM_FAILED",
  });
  if (!res.destroyed && !res.writableEnded)
    res.write(streamErrorFrame(fields.requestId));
}

// agent-core ends a stream cleanly only when it shuts down; any other end is
// a destroyed socket and goes through failStream.
export function endedStream(
  res: StreamResponse,
  fields: { requestId?: string; sessionId?: string },
) {
  log("warn", "live update stream ended by assistant service", {
    ...fields,
    code: "STREAM_ENDED",
  });
  if (!res.destroyed && !res.writableEnded)
    res.write(streamErrorFrame(fields.requestId, "STREAM_ENDED"));
}
