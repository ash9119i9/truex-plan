import { HttpException } from "@nestjs/common";

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_REACHED"
  | "MODEL_UNAVAILABLE"
  | "STALE_REVISION"
  | "CHAT_BUSY"
  | "STEER_LIMIT"
  | "CHAT_READ_ONLY"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "CONNECTORS_NOT_CONFIGURED"
  | "CONNECTION_REQUIRED"
  | "APPROVAL_RESOLVED"
  | "APPROVAL_NOT_FOUND"
  | "INTERNAL";

// An error whose code and message are safe to show the caller.
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message, status);
  }
}

// The single error shape every endpoint returns.
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Readonly<Record<string, unknown>>;
  };
  requestId: string;
}
