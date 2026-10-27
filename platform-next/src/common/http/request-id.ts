import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

// Accept a caller's request ID (for example from the frontend forwarder) only
// when it is plain and short enough to log safely.
const INBOUND_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

// Gives every request an ID, returned in the response header and error body,
// so a user-reported failure can be matched to its log lines.
export function assignRequestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.get(REQUEST_ID_HEADER);
  const requestId =
    inbound && INBOUND_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

export function requestIdOf(res: Response): string {
  return String(res.locals.requestId ?? "");
}
