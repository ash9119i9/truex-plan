import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { httpError } from "../../shared/errors";
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
export const requestContext = new AsyncLocalStorage<{
  requestId: string;
  timings?: Map<string, number>;
}>();
export const currentRequestId = () => requestContext.getStore()?.requestId;

export async function measure<T>(
  name: "mongo" | "runtime" | "cache",
  work: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await work();
  } finally {
    const timings = requestContext.getStore()?.timings;
    if (timings)
      timings.set(name, (timings.get(name) ?? 0) + performance.now() - start);
  }
}

// Authenticated APIs opt in to validators individually after authorization.
// Sensitive paths, errors and mutation responses remain non-storable.
export function responsePolicy(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader("Cache-Control", "no-store");
  const start = performance.now();
  const json = res.json.bind(res);
  res.json = ((value: unknown) => {
    const timings = requestContext.getStore()?.timings;
    const parts = [...(timings ?? [])].map(
      ([name, ms]) => `${name};dur=${ms.toFixed(2)}`,
    );
    parts.push(`app;dur=${(performance.now() - start).toFixed(2)}`);
    res.setHeader("Server-Timing", parts.join(", "));
    return json(value);
  }) as Response["json"];
  next();
}

export function privateJson(req: Request, res: Response, value: unknown) {
  const scope = [res.locals.tenant, res.locals.user?.id, res.locals.user?.role];
  const etag = `"${createHash("sha256")
    .update(JSON.stringify([scope, value]))
    .digest("hex")}"`;
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", etag);
  res.vary("Cookie");
  res.vary("Authorization");
  res.vary("x-truex-tenant");
  res.vary("x-truex-user");
  res.vary("x-truex-role");
  const matches = req
    .get("If-None-Match")
    ?.split(",")
    .map((item) => item.trim());
  if (
    matches?.some((item) => item === "*" || item.replace(/^W\//, "") === etag)
  )
    return res.status(304).end();
  return res.json(value);
}

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
export const route =
  (fn: (req: Request, res: Response) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/sessions/"))
      res.locals.sessionId = req.params.id;
    const run = () =>
      requestContext.run(
        { requestId: res.locals.requestId, timings: new Map() },
        () =>
          Promise.resolve()
            .then(() => fn(req, res))
            .catch(next),
      );
    const user: UserRef | undefined = res.locals.user;
    const withUser = () => (user ? userContext.run(user, run) : run());
    const tenant: TenantRef | undefined = res.locals.tenant;
    return tenant ? tenantContext.run(tenant, withUser) : withUser();
  };

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
    path: req.path,
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
  res.status(status).json({ ...body, requestId: res.locals.requestId });
}

const streamEnds = {
  STREAM_FAILED:
    "Live updates stopped unexpectedly. Reopen the conversation to reconnect.",
  STREAM_ENDED:
    "The assistant service stopped live updates, usually for a restart. Reconnect in a moment.",
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
