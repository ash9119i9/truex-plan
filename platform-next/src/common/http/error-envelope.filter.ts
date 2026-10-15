import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { isDatabaseUnavailableError } from "../../database/mongo-errors";
import { ApiError, type ErrorCode, type ErrorEnvelope } from "./api-error";
import { requestIdOf } from "./request-id";

interface SafeError {
  status: number;
  code: ErrorCode;
  message: string;
}

const STATUS_ERRORS: Record<number, Omit<SafeError, "status">> = {
  400: { code: "BAD_REQUEST", message: "The request is not valid." },
  401: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
  403: {
    code: "FORBIDDEN",
    message: "You do not have permission to do this.",
  },
  404: { code: "NOT_FOUND", message: "Not found." },
  409: {
    code: "CONFLICT",
    message: "This conflicts with the current state. Refresh and try again.",
  },
  413: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
  429: {
    code: "RATE_LIMITED",
    message: "Too many requests. Wait a moment and try again.",
  },
  503: {
    code: "UNAVAILABLE",
    message: "The service is temporarily unavailable. Try again shortly.",
  },
};

const INTERNAL: SafeError = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  code: "INTERNAL",
  message: "Something went wrong. Try again, or contact support.",
};

// Errors thrown before routing (for example by the JSON body parser) carry a
// client-error status but are not HttpExceptions.
function clientStatusOf(exception: unknown): number | undefined {
  if (typeof exception !== "object" || exception === null) return undefined;
  const status = (exception as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : undefined;
}

function toSafeError(exception: unknown): SafeError {
  if (isDatabaseUnavailableError(exception))
    return { status: 503, ...STATUS_ERRORS[503]! };
  if (exception instanceof ApiError)
    return {
      status: exception.getStatus(),
      code: exception.code,
      message: exception.message,
    };
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : clientStatusOf(exception);
  if (status === undefined) return INTERNAL;
  const known = STATUS_ERRORS[status];
  if (known) return { status, ...known };
  return status < 500 ? { status, ...STATUS_ERRORS[400]! } : INTERNAL;
}

// Turns every failure into the one error envelope. Unexpected errors are
// logged with their request ID and reach the caller only as INTERNAL.
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = requestIdOf(res);
    const safe = toSafeError(exception);

    if (safe.code === "INTERNAL")
      this.logger.error(
        { message: "unhandled error", requestId },
        exception instanceof Error ? exception.stack : String(exception),
      );

    if (res.headersSent) return;
    const body: ErrorEnvelope = {
      error: { code: safe.code, message: safe.message },
      requestId,
    };
    res.status(safe.status).json(body);
  }
}
