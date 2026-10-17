// A business-rule failure with a message that is safe to show a caller or an
// operator. HTTP mapping happens at the edge; services never build responses.
export type DomainErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  // A per-user or per-tenant cap would be exceeded.
  | "LIMIT_REACHED"
  // The referenced model is missing or disabled.
  | "MODEL_UNAVAILABLE"
  // The caller edited an out-of-date copy.
  | "STALE_REVISION"
  // The chat is answering a message; wait or stop it.
  | "CHAT_BUSY"
  // The chat can be read but not continued.
  | "CHAT_READ_ONLY"
  // Too many requests in a short time.
  | "RATE_LIMITED"
  // A dependency is missing or down; retrying later may work.
  | "UNAVAILABLE";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
