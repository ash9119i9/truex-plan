/** Public errors contain actionable messages, never raw provider diagnostics. */
export class ApplicationError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
    // The original error stays server-side for logs; it is never serialized.
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApplicationError";
  }
}

export function safeErrorMessage(message: string): string {
  return message
    .replace(
      /\b(?:https?|mongodb(?:\+srv)?):\/\/[^\s"<>]+/gi,
      "[service address]",
    )
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|authorization|password|secret|access_token|refresh_token|experimental_bearer_token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[\w-]+/g, "[REDACTED]")
    .slice(0, 1200);
}

const transientStorage =
  /^Mongo(Network|NetworkTimeout|ServerSelection|NotConnected|TopologyClosed|PoolClosed|WaitQueueTimeout)Error$/;

export function httpError(error: unknown, layer: "platform" | "agent-core") {
  const e = error as { name?: string; type?: string; status?: number } | null;
  if (e?.type === "entity.parse.failed")
    return {
      status: 400,
      error: "The request contains invalid JSON. Check the request format.",
      code: "INVALID_JSON",
    };
  if (e?.type === "entity.too.large")
    return {
      status: 413,
      error:
        "The request is too large. Reduce the attachment or message size (request limit: 2 MB).",
      code: "REQUEST_TOO_LARGE",
    };
  if (error instanceof ApplicationError)
    return {
      status: error.status,
      error: safeErrorMessage(error.message),
      code: error.code,
    };
  if (e?.name?.startsWith("Mongo") && (e as { code?: number }).code === 11000)
    return {
      status: 409,
      error:
        "This record already exists. Refresh the conversation to see its current state.",
      code: "CONFLICT",
    };
  // Only connection-level failures are worth retrying; other storage errors
  // (validation, bad queries) would fail again, so they are internal errors.
  if (e?.name && transientStorage.test(e.name))
    return {
      status: 503,
      error:
        "Conversation storage is unavailable. Please try again later; if this continues, ask your administrator to check the database connection.",
      code: "STORAGE_UNAVAILABLE",
    };
  return {
    status: 500,
    error:
      layer === "platform"
        ? "The conversation service encountered an unexpected error. Contact support if this continues."
        : "The assistant runtime encountered an unexpected error. Contact support if this continues.",
    code: layer === "platform" ? "PLATFORM_INTERNAL" : "RUNTIME_INTERNAL",
  };
}

/** Why a model call failed. Derived from Codex's error info and HTTP status,
 * with narrowly matched gateway stream failures for Codex's untyped errors. */
export type ErrorReason =
  | "rateLimited"
  | "quota"
  | "credentials"
  | "providerDown"
  | "contextWindow"
  | "other";
const errorReasons: Record<string, ErrorReason> = {
  PROVIDER_RATE_LIMITED: "rateLimited",
  PROVIDER_QUOTA_EXCEEDED: "quota",
  PROVIDER_AUTH_FAILED: "credentials",
  PROVIDER_UNAVAILABLE: "providerDown",
  PROVIDER_TIMEOUT: "providerDown",
  PROVIDER_CONNECTION_FAILED: "providerDown",
  CONTEXT_LIMIT: "contextWindow",
};
export function runtimeError(data: any): {
  message: string;
  code: string;
  reason: ErrorReason;
  httpStatus?: number;
} {
  const info = data?.error?.codexErrorInfo ?? data?.codexErrorInfo;
  const kind =
    typeof info === "string"
      ? info
      : info && typeof info === "object"
        ? Object.keys(info)[0]
        : undefined;
  const status =
    kind && typeof info === "object" ? info[kind]?.httpStatusCode : undefined;
  const result = (code: string, message: string) => ({
    code,
    message,
    reason: errorReasons[code] ?? ("other" as const),
    ...(typeof status === "number" ? { httpStatus: status } : {}),
  });
  if (kind === "usageLimitExceeded" || status === 402)
    return result(
      "PROVIDER_QUOTA_EXCEEDED",
      "The model provider account has run out of usage or credits. Ask your administrator to check the provider account, then try again.",
    );
  if (status === 429)
    return result(
      "PROVIDER_RATE_LIMITED",
      "The model provider's rate limit has been reached. Try again later, or ask your administrator to check the provider quota or change the configured model.",
    );
  if (kind === "unauthorized" || status === 401 || status === 403)
    return result(
      "PROVIDER_AUTH_FAILED",
      "The model provider denied access. Ask your administrator to check the configured API key and model permissions.",
    );
  if (kind === "contextWindowExceeded")
    return result(
      "CONTEXT_LIMIT",
      "This conversation exceeds the model's context limit. Compact the conversation or start a new one with a shorter message.",
    );
  if (kind === "sessionBudgetExceeded")
    return result(
      "SESSION_BUDGET_EXCEEDED",
      "This conversation has reached its usage budget. Ask your administrator to review the budget before continuing.",
    );
  if (
    kind === "serverOverloaded" ||
    kind === "internalServerError" ||
    status >= 500
  )
    return result(
      "PROVIDER_UNAVAILABLE",
      "The model provider is temporarily unavailable. Try again later.",
    );
  if (kind === "badRequest" || status === 400 || status === 422)
    return result(
      "PROVIDER_INVALID_REQUEST",
      "The model provider rejected the request. Shorten your message or ask your administrator to check the model configuration.",
    );
  if (kind === "cyberPolicy" || kind === "misalignmentPolicyViolation")
    return result(
      "PROVIDER_POLICY",
      "The model provider could not process this request under its usage policy. Rephrase your request.",
    );
  if (kind === "sandboxError")
    return result(
      "TOOL_ACCESS_DENIED",
      "The assistant could not access a required resource. Ask your administrator to check tool permissions.",
    );
  if (kind === "activeTurnNotSteerable")
    return result(
      "TURN_BUSY",
      "The assistant cannot accept another message during this operation. Wait for it to finish.",
    );
  if (kind === "threadRollbackFailed")
    return result(
      "ROLLBACK_FAILED",
      "The conversation could not be restored to the previous turn. Refresh it to check its current state.",
    );
  if (
    kind &&
    [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ].includes(kind)
  )
    return result(
      "PROVIDER_CONNECTION_FAILED",
      "The connection to the model provider was interrupted. Check the conversation for a partial response before trying again.",
    );
  // The pinned Codex maps generic response.failed events to `other`, retaining
  // only a prefixed message. Recognize our exact gateway sentences; never relay
  // the raw message or infer provider failures from arbitrary diagnostics.
  if (kind === "other") {
    const message = data?.error?.message ?? data?.message;
    if (
      typeof message === "string" &&
      /^stream disconnected before completion: The model provider timed out: no (?:response|data) from the model provider within \d+(?:\.\d+)?ms\. Please retry\.(?![\s\S])/.test(
        message,
      )
    )
      return result(
        "PROVIDER_TIMEOUT",
        "The model provider stopped responding before this response finished. Check the conversation for a partial response before trying again.",
      );
    if (
      message ===
      "stream disconnected before completion: The connection to the model provider was interrupted."
    )
      return result(
        "PROVIDER_CONNECTION_FAILED",
        "The connection to the model provider was interrupted. Check the conversation for a partial response before trying again.",
      );
  }
  // agent-core's own codes: `code` on error events, `code`/`error.code` on
  // failed turns.
  const own = data?.code ?? data?.error?.code;
  if (own === "RUNTIME_UNAVAILABLE")
    return result(
      "RUNTIME_UNAVAILABLE",
      "The assistant runtime stopped. Reopen this conversation to resume it.",
    );
  if (own === "RUNTIME_OVERLOADED")
    return result(
      "RUNTIME_OVERLOADED",
      "The assistant runtime is busy. Wait a moment, then try again.",
    );
  if (own === "TURN_STALLED")
    return result(
      "TURN_STALLED",
      "The assistant stopped responding and this response was cancelled. Check the conversation for a partial response, then send your message again.",
    );
  if (own === "ADAPTER_INTERNAL")
    return result(
      "ADAPTER_INTERNAL",
      "The assistant hit an internal error while handling this response. Check the conversation before trying again; contact support if this continues.",
    );
  if (own === "STORAGE_UNAVAILABLE")
    return result(
      "STORAGE_UNAVAILABLE",
      "Conversation updates could not be saved, so live updates stopped. Reopen the conversation; if this continues, ask your administrator to check the assistant's storage.",
    );
  return result(
    "RUNTIME_FAILED",
    "The assistant could not finish this response. Check the conversation before trying again; contact support if this continues.",
  );
}
