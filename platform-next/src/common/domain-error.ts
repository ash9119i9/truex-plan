// A business-rule failure with a message that is safe to show a caller or an
// operator. HTTP mapping happens at the edge; services never build responses.
export type DomainErrorCode =
  "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
