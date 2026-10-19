import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { catchError, type Observable } from "rxjs";
import { DomainError, type DomainErrorCode } from "../domain-error";
import { ApiError, type ErrorCode } from "./api-error";

const HTTP: Record<DomainErrorCode, { status: number; code: ErrorCode }> = {
  INVALID_INPUT: { status: 400, code: "BAD_REQUEST" },
  NOT_FOUND: { status: 404, code: "NOT_FOUND" },
  CONFLICT: { status: 409, code: "CONFLICT" },
  FORBIDDEN: { status: 403, code: "FORBIDDEN" },
  LIMIT_REACHED: { status: 409, code: "LIMIT_REACHED" },
  MODEL_UNAVAILABLE: { status: 422, code: "MODEL_UNAVAILABLE" },
  STALE_REVISION: { status: 409, code: "STALE_REVISION" },
  CHAT_BUSY: { status: 409, code: "CHAT_BUSY" },
  STEER_LIMIT: { status: 409, code: "STEER_LIMIT" },
  CHAT_READ_ONLY: { status: 409, code: "CHAT_READ_ONLY" },
  RATE_LIMITED: { status: 429, code: "RATE_LIMITED" },
  UNAVAILABLE: { status: 503, code: "UNAVAILABLE" },
};

export function toApiError(error: DomainError): ApiError {
  const { status, code } = HTTP[error.code];
  return new ApiError(status, code, error.message);
}

// Opt-in per controller: business-rule refusals become their HTTP error with
// the domain message. Anything else passes through to the envelope filter,
// which hides it as INTERNAL.
@Injectable()
export class DomainErrorsInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        throw error instanceof DomainError ? toApiError(error) : error;
      }),
    );
  }
}
