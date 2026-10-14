import { ApiError } from "../core/errors";
import { currentRequestId } from "../http/handlers";
import { log } from "../../../shared/logging";

// Owner failures the platform acts on (failover, orphaned/dead sessions) or
// that tell the user what to do; they keep their upstream status.
const OWNER_CODES = new Set([
  "CAPACITY",
  "DRAINING",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_OVERLOADED",
  "RPC_TIMEOUT",
  "THREAD_LOST",
]);

/** An agent-core rejection. 4xx passes through; an unexpected 5xx is a bad
 * gateway here, with the upstream status and code kept in the cause for logs. */
export function upstreamError(
  status: number,
  detail: any,
  fallback: string,
  fallbackCode: string,
  path?: string,
) {
  const message = typeof detail?.error === "string" ? detail.error : fallback;
  const code = typeof detail?.code === "string" ? detail.code : fallbackCode;
  if (status < 500 || OWNER_CODES.has(code))
    return new ApiError(status, message, code);
  const cause = Object.assign(new Error(message), {
    name: "UpstreamError",
    status,
    code,
    path,
  });
  log("warn", "assistant service failed", {
    requestId: currentRequestId(),
    path,
    upstreamStatus: status,
    upstreamCode: code,
  });
  return new ApiError(502, message, "UPSTREAM_FAILED", { cause });
}
