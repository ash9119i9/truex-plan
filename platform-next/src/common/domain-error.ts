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
  // The reply already carries as many added messages as it can take.
  | "STEER_LIMIT"
  // The chat can be read but not continued.
  | "CHAT_READ_ONLY"
  // Too many requests in a short time.
  | "RATE_LIMITED"
  // A dependency is missing or down; retrying later may work.
  | "UNAVAILABLE"
  // The connector token keys are not configured, so connectors are off.
  | "CONNECTORS_NOT_CONFIGURED"
  // The chat's agent uses a connector the member has not connected, or whose
  // connection needs a new sign-in. Nothing was saved or started.
  | "CONNECTION_REQUIRED"
  // A tool approval was already answered (first answer wins).
  | "APPROVAL_RESOLVED"
  // A tool approval is unknown, expired, or its reply has finished.
  | "APPROVAL_NOT_FOUND";

// Safe, structured facts a client can act on (which connectors to connect).
// Never secrets or provider text.
export type ErrorDetails = Readonly<Record<string, unknown>>;

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
