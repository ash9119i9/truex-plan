import { auth, type Auth } from "./auth.ts";
import {
  identityGeneration,
  identityTenant,
  notifyUnauthenticated,
} from "./identity.ts";

// The browser talks only to its own origin. app/api carries each request on to
// the platform. There is no platform address in the browser bundle to point at
// the wrong place.
export const base = "";

// Account-level reads that belong to no tenant. Every other request names the
// tenant this tab is showing with exactly one ?tenantId=.
const GLOBAL_PATHS = new Set(["/api/v1/me", "/api/v1/me/tenants"]);
const TENANT_ID = /^[0-9a-f]{24}$/;

export class ApiRequestError extends Error {
  status: number;
  code: string;
  // Correlates this failure with platform logs; absent for network failures.
  requestId?: string;
  constructor(
    message: string,
    status: number,
    code: string,
    options?: { requestId?: string; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    if (options?.requestId) this.requestId = options.requestId;
  }
}

// A message that is safe to show a user. API errors already carry a friendly
// message; anything else (a TypeError from a bug, say) is logged and replaced.
export function userMessage(
  error: unknown,
  fallback = "Something went wrong. Try again, or refresh the page.",
): string {
  if (error instanceof ApiRequestError) return error.message;
  console.error("[truex] unexpected error", error);
  return fallback;
}

// The reference shown under an error so users can quote it to support.
export interface ErrorRef {
  code?: string;
  requestId?: string;
  // Stream errors have no request; the turn id matches agent-core's logs.
  turnId?: string;
}
export function errorRef(error: unknown): ErrorRef | null {
  if (!(error instanceof ApiRequestError)) return null;
  return {
    code: error.code,
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}

// For background loads that fail quietly: records which load failed and the
// details needed to trace it, without interrupting the user.
export function warnFailure(tag: string, error: unknown) {
  if (error instanceof ApiRequestError)
    console.warn(`[truex] ${tag} failed`, {
      code: error.code,
      status: error.status,
      requestId: error.requestId,
    });
  else console.warn(`[truex] ${tag} failed`, error);
}

// One log line per failed call, keyed by what support needs to find it.
function logFailure(method: string, path: string, error: ApiRequestError) {
  const detail = {
    method,
    path,
    status: error.status,
    code: error.code,
    requestId: error.requestId,
  };
  if (error.status === 0 || error.status >= 500)
    console.error("[truex] api request failed", detail);
  else console.warn("[truex] api request failed", detail);
}

function statusMessage(status: number): string {
  const messages: Record<number, string> = {
    400: "The request is invalid. Check your input.",
    401: "Your session is not authenticated. Sign in again.",
    403: "You do not have permission to perform this operation.",
    404: "The requested conversation, agent, or file was not found.",
    409: "The request conflicts with the conversation's current state. Refresh it before retrying.",
    413: "The request is too large. Reduce the attachment or message size.",
    422: "The request could not be processed. Check your input and agent configuration.",
    429: "Too many requests. Wait before trying again.",
    502: "The assistant service returned an invalid response. Check the conversation before retrying.",
    503: "The service is temporarily unavailable. Try again later.",
    504: "The service timed out. Check the conversation before retrying; the request may have been accepted.",
  };
  return (
    messages[status] ||
    `The service could not complete the request (HTTP ${status}). Check the conversation before retrying.`
  );
}

/**
 * The path with this tab's tenant added, or the reason it cannot be sent. The
 * tenant is never taken from the path itself: a caller that names one is a
 * bug, and two values would be refused by the platform anyway.
 */
export function addressed(
  path: string,
  tenantId: string | null = identityTenant(),
): string | ApiRequestError {
  const mark = path.indexOf("?");
  const pathname = mark < 0 ? path : path.slice(0, mark);
  const query = mark < 0 ? "" : path.slice(mark + 1);
  if (new URLSearchParams(query).has("tenantId"))
    return new ApiRequestError(
      "This request names its own workspace.",
      0,
      "TENANT_IN_PATH",
    );
  if (GLOBAL_PATHS.has(pathname)) return path;
  if (!tenantId || !TENANT_ID.test(tenantId))
    return new ApiRequestError(
      "Open a workspace before using it.",
      0,
      "NO_TENANT",
    );
  return `${path}${mark < 0 ? "?" : "&"}tenantId=${tenantId}`;
}

export async function api(
  path: string,
  body?: unknown,
  session: Auth = auth,
  // GET without a body and POST with one, unless named (for example PATCH).
  method: "GET" | "POST" | "PATCH" = body === undefined ? "GET" : "POST",
) {
  // AgentCore can cold-start on session creation or restoration. Its backend
  // invocation deadline is 150 seconds; let that response reach the browser.
  const runtimeRequest =
    path === "/healthz" ||
    (path === "/api/sessions" && method === "POST") ||
    path.startsWith("/api/sessions/");
  const fail = (error: ApiRequestError): never => {
    logFailure(method, path, error);
    throw error;
  };
  // A reply that arrives after the person or workspace changed belongs to
  // someone else's view; it is dropped rather than applied.
  const generation = identityGeneration();
  const target = addressed(path);
  if (target instanceof ApiRequestError) return fail(target);
  let outcome: Awaited<ReturnType<Auth["request"]>>;
  try {
    outcome = await session.request(base + target, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(runtimeRequest ? 180_000 : 45_000),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return fail(
      new ApiRequestError(
        timeout
          ? "The request timed out. Check the conversation before retrying; the request may have been accepted."
          : "Unable to connect to Truex. Check your network connection and service availability. If you submitted a message, check the conversation before retrying.",
        0,
        timeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        { cause: error },
      ),
    );
  }
  if (outcome.kind === "signedOut") {
    notifyUnauthenticated();
    return fail(
      new ApiRequestError(statusMessage(401), 401, "UNAUTHENTICATED"),
    );
  }
  if (outcome.kind === "unavailable")
    return fail(
      new ApiRequestError(
        "Truex is temporarily unavailable. Your session is not affected. Try again in a moment.",
        503,
        "SESSION_UNAVAILABLE",
      ),
    );
  const res = outcome.response;
  if (generation !== identityGeneration())
    return fail(
      new ApiRequestError("This view is out of date.", 0, "STALE_IDENTITY"),
    );
  // Only a 401 that survived a token refresh means the session ended. The
  // session gate asks the platform before it acts; 403 and 5xx are never read
  // as a sign-out.
  if (res.status === 401) notifyUnauthenticated();
  const headerId = res.headers.get("x-request-id") || undefined;
  if (res.status === 204) return undefined;
  let data: any;
  try {
    data = await res.json();
  } catch (error) {
    return fail(
      new ApiRequestError(
        res.ok
          ? "The service returned an unreadable response. Refresh the conversation to check its current state."
          : statusMessage(res.status),
        res.status,
        res.ok ? "INVALID_RESPONSE" : `HTTP_${res.status}`,
        { requestId: headerId, cause: error },
      ),
    );
  }
  if (generation !== identityGeneration())
    return fail(
      new ApiRequestError("This view is out of date.", 0, "STALE_IDENTITY"),
    );
  if (!res.ok) {
    // platform-next nests the detail: { error: { code, message }, requestId }.
    const detail =
      data?.error && typeof data.error === "object"
        ? { error: data.error.message, code: data.error.code }
        : data;
    return fail(
      new ApiRequestError(
        typeof detail?.error === "string" && detail.error.trim()
          ? detail.error
          : statusMessage(res.status),
        res.status,
        typeof detail?.code === "string" ? detail.code : `HTTP_${res.status}`,
        {
          requestId:
            typeof data?.requestId === "string" && data.requestId
              ? data.requestId
              : headerId,
        },
      ),
    );
  }
  return data;
}

// Helper agents spawned inside a conversation.
const agentsPath = (sessionId: string, agentId?: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/agents` +
  (agentId ? `/${encodeURIComponent(agentId)}` : "");
export const listAgents = (sessionId: string) => api(agentsPath(sessionId));
export const getAgentTranscript = (sessionId: string, agentId: string) =>
  api(agentsPath(sessionId, agentId));
export const interruptAgent = (sessionId: string, agentId: string) =>
  api(agentsPath(sessionId, agentId) + "/interrupt", {});

// Observability: traces of completed turns and, while the session is live,
// a masked reconstruction of what the model saw for one turn.
const sessionPath = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}`;
export const getTraces = (sessionId: string, persisted = false) =>
  api(sessionPath(sessionId) + `/traces${persisted ? "?persisted=1" : ""}`);
export const getTurnContext = (sessionId: string, turnId: string) =>
  api(sessionPath(sessionId) + `/turns/${encodeURIComponent(turnId)}/context`);
