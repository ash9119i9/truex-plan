// Every failure the adapter reports has a fixed code, HTTP status, retry hint
// and user-safe message. Raw Codex or provider text never reaches a caller.

export const REQUEST_ERRORS = {
  INVALID_REQUEST: [400, false, "The request is invalid."],
  UNAUTHORIZED: [401, false, "Authentication is required."],
  RUN_NOT_FOUND: [404, false, "This run is unknown or has expired."],
  THREAD_LOST: [
    404,
    false,
    "This conversation's history is no longer available, so it can't continue.",
  ],
  CHAT_BUSY: [409, false, "This chat is still answering. Wait or stop it."],
  RUN_CONFLICT: [
    409,
    false,
    "This run ID was already used for another request.",
  ],
  RUN_ENDED: [409, false, "This run has finished, so it can't take a message."],
  STEER_LIMIT: [409, false, "This run has too many steers."],
  STEER_UNKNOWN: [
    503,
    false,
    "The message was sent but its outcome is unknown.",
  ],
  APPROVAL_NOT_FOUND: [404, false, "This approval is unknown or has expired."],
  FILE_NOT_FOUND: [404, false, "This file is not in the chat."],
  APPROVAL_RESOLVED: [409, false, "This approval was already answered."],
  PAYLOAD_TOO_LARGE: [413, false, "The request is too large."],
  UPLOAD_CONFLICT: [
    409,
    false,
    "A folder in the chat is in the way of this file.",
  ],
  // The run names skills this runtime does not hold; `missing` lists them.
  // The platform pushes them and starts the run again.
  SKILLS_MISSING: [409, false, "This chat's skills are not loaded yet."],
  UPLOADS_DISABLED: [
    409,
    false,
    "This assistant can't open attached files here.",
  ],
  // No longer thrown by this adapter (coding + helpers run together). Kept so
  // the platform still maps it for an older adapter that predates that change.
  SUBAGENTS_DISABLED: [
    409,
    false,
    "Helper agents aren't available for this assistant.",
  ],
  // A pause or change for a chat that has no goal (or no thread yet).
  GOAL_NOT_FOUND: [404, false, "This chat has no goal to change."],
  RUNTIME_BUSY: [503, true, "The assistant is at capacity. Try again shortly."],
  DRAINING: [503, true, "The assistant is restarting. Try again shortly."],
  RUNTIME_UNAVAILABLE: [503, true, "The assistant did not respond. Try again."],
  INTERNAL: [500, true, "Something went wrong in the assistant. Try again."],
} as const satisfies Record<string, readonly [number, boolean, string]>;

export type RequestErrorCode = keyof typeof REQUEST_ERRORS;

export class AdapterError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    readonly code: RequestErrorCode,
    message?: string,
    // Machine-readable fields for the platform, never user text.
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    const [status, retryable, fallback] = REQUEST_ERRORS[code];
    super(message ?? fallback);
    this.name = "AdapterError";
    this.status = status;
    this.retryable = retryable;
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// Failures of a run that was admitted; reported in `run.completed.error`.
export const RUN_ERRORS = {
  MODEL_TIMEOUT: [true, "The model didn't respond in time. Try again."],
  CONTEXT_FULL: [
    false,
    "This conversation is too long for the model. Start a new chat.",
  ],
  RATE_LIMITED: [
    true,
    "The model is rate limited right now. Try again shortly.",
  ],
  PROVIDER_ERROR: [true, "The model provider returned an error. Try again."],
  RUNTIME_ERROR: [true, "The assistant stopped unexpectedly. Try again."],
  RUNTIME_SHUTDOWN: [
    true,
    "The assistant restarted before finishing. Try again.",
  ],
  THREAD_LOST: [false, REQUEST_ERRORS.THREAD_LOST[2]],
  THREAD_MISMATCH: [
    false,
    "This conversation can't continue here. Start a new chat.",
  ],
  SUBAGENT_LIMIT: [
    false,
    "This needed more helper agents than one reply allows. Try a narrower request.",
  ],
} as const satisfies Record<string, readonly [boolean, string]>;

export type RunErrorCode = keyof typeof RUN_ERRORS;

export interface RunError {
  readonly code: RunErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export function runError(code: RunErrorCode): RunError {
  const [retryable, message] = RUN_ERRORS[code];
  return { code, message, retryable };
}

// Maps Codex's typed error info (never its message text) to a run error.
export function fromCodexErrorInfo(info: unknown): RunError {
  const key =
    typeof info === "string"
      ? info
      : info && typeof info === "object"
        ? Object.keys(info)[0]
        : undefined;
  // A provider 429 arrives as e.g. responseTooManyFailedAttempts with the
  // status inside, not as rateLimitExceeded.
  const detail =
    key && info && typeof info === "object"
      ? (info as Record<string, unknown>)[key]
      : undefined;
  if (
    detail &&
    typeof detail === "object" &&
    (detail as { httpStatusCode?: unknown }).httpStatusCode === 429
  )
    return runError("RATE_LIMITED");
  switch (key) {
    case "contextWindowExceeded":
      return runError("CONTEXT_FULL");
    case "rateLimitExceeded":
    case "usageLimitExceeded":
      return runError("RATE_LIMITED");
    default:
      return runError("PROVIDER_ERROR");
  }
}
