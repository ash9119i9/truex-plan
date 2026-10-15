import { HttpException } from "@nestjs/common";

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "INTERNAL";

// An error whose code and message are safe to show the caller.
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message, status);
  }
}

// The single error shape every endpoint returns.
export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
  requestId: string;
}
