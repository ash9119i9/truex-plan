import {
  QueryCache,
  QueryCacheError,
  metadataTtl,
  safeMetadata,
} from "./query-cache.ts";

export const base =
  process.env.NEXT_PUBLIC_PLATFORM_URL || "http://localhost:4000";

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

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const method = body === undefined ? "GET" : "POST";
  // AgentCore can cold-start on session creation or restoration. Its backend
  // invocation deadline is 150 seconds; let that response reach the browser.
  const runtimeRequest =
    path === "/healthz" ||
    (path === "/api/sessions" && method === "POST") ||
    path.startsWith("/api/sessions/");
  const fail = (error: ApiRequestError): never => {
    if (error.status === 401 || error.status === 403) clearApiCache();
    logFailure(method, path, error);
    throw error;
  };
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "include",
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(runtimeRequest ? 180_000 : 45_000),
          ])
        : AbortSignal.timeout(runtimeRequest ? 180_000 : 45_000),
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
  if (!res.ok)
    return fail(
      new ApiRequestError(
        typeof data?.error === "string" && data.error.trim()
          ? data.error
          : statusMessage(res.status),
        res.status,
        typeof data?.code === "string" ? data.code : `HTTP_${res.status}`,
        {
          requestId:
            typeof data?.requestId === "string" && data.requestId
              ? data.requestId
              : headerId,
        },
      ),
    );
  return data;
}

const metadata = new QueryCache();
let scope: string | undefined;
let identityEpoch = 0;
let identityPending:
  Promise<{ scope: string; data: any; epoch: number }> | undefined;
let identityController: AbortController | undefined;
let channel: BroadcastChannel | undefined;
let listening = false;
let activeMetadataReads = 0;
type IdentityChange = "clear" | "scope" | "focus-restored";
const identityListeners = new Set<(reason?: IdentityChange) => void>();
let focusRecovery = false;
export const clientCacheEnabled = () =>
  typeof window !== "undefined" &&
  process.env.NEXT_PUBLIC_CLIENT_CACHE?.trim().toLowerCase() === "on";

function openChannel() {
  if (
    !channel &&
    clientCacheEnabled() &&
    typeof window.BroadcastChannel === "function"
  ) {
    channel = new window.BroadcastChannel(`truex-metadata:${base}`);
    channel.onmessage = (event) => {
      if (event.data === "identity") clearApiCache(false);
      else if (event.data === "metadata") metadata.clear();
    };
  }
}

function listenForCacheChanges() {
  if (listening || !clientCacheEnabled()) return;
  listening = true;
  openChannel();
  // BFCache restores this module and its listeners after pagehide, but the
  // closed channel must be recreated before accepting cross-tab changes.
  window.addEventListener("pageshow", openChannel);
  // Re-check identity after backgrounding, including account changes on an
  // authentication redirect or another tab where BroadcastChannel is absent.
  window.addEventListener("focus", refreshIdentityAfterFocus);
  window.addEventListener("pagehide", () => {
    clearApiCache(false);
    channel?.close();
    channel = undefined;
  });
}

export function clearApiCache(broadcast = true) {
  if (broadcast) listenForCacheChanges();
  identityEpoch++;
  scope = undefined;
  identityController?.abort();
  metadata.clear();
  notifyIdentityChange("clear");
  if (broadcast) channel?.postMessage("identity");
}

// For identity-bound stream cursors. Never stores identity or response data
// in localStorage; absent before an authoritative /api/me response.
export function apiIdentityScope() {
  return scope;
}
export function apiIdentityEpoch() {
  return identityEpoch;
}

export function onApiIdentityChange(
  listener: (reason?: IdentityChange) => void,
) {
  if (identityListeners.size >= 256)
    throw new ApiRequestError(
      "Too many open account views. Close a view and try again.",
      0,
      "CACHE_BUSY",
    );
  identityListeners.add(listener);
  return () => {
    identityListeners.delete(listener);
  };
}
function notifyIdentityChange(reason: IdentityChange) {
  for (const listener of identityListeners) {
    try {
      listener(reason);
    } catch {
      console.warn("[truex] account view could not be cleared");
    }
  }
}

function refreshIdentityAfterFocus() {
  if (focusRecovery) return;
  focusRecovery = true;
  const previousScope = scope;
  const previousPending = identityPending;
  // Hide private views/close streams before waiting for network verification.
  clearApiCache(false);
  const epoch = identityEpoch;
  void Promise.resolve(previousPending)
    .catch(() => {})
    .then(async () => {
      if (epoch !== identityEpoch) return;
      const verified = await verifyIdentity();
      if (
        verified.epoch === identityEpoch &&
        previousScope !== undefined &&
        scope === previousScope
      )
        notifyIdentityChange("focus-restored");
    })
    .catch(() => {
      // Request diagnostics are recorded by request(); do not restore a view
      // when identity authority is unavailable or the account was revoked.
      if (epoch === identityEpoch) clearApiCache(false);
    })
    .finally(() => {
      focusRecovery = false;
    });
}

function identify(data: any): string {
  if (
    typeof data?.user?.id !== "string" ||
    typeof data?.tenant?.id !== "string" ||
    !["user", "admin"].includes(data?.role)
  )
    throw new ApiRequestError(
      "The service returned an invalid account. Sign in again.",
      502,
      "INVALID_IDENTITY",
    );
  const next = JSON.stringify([base, data.tenant.id, data.user.id, data.role]);
  if (scope !== next) {
    // A scope can cycle Alice -> Bob -> Alice while old work is pending.
    // Its string alone cannot distinguish that earlier account lifecycle.
    identityEpoch++;
    metadata.clear();
    scope = next;
    notifyIdentityChange("scope");
  }
  return next;
}

function verifyIdentity(): Promise<{
  scope: string;
  data: any;
  epoch: number;
}> {
  if (identityPending) return identityPending;
  const epoch = identityEpoch;
  const controller = new AbortController();
  identityController = controller;
  const pending = request("/api/me", undefined, controller.signal)
    .then((data) => {
      if (epoch !== identityEpoch)
        throw new QueryCacheError("CACHE_INVALIDATED");
      const verifiedScope = identify(data);
      return { scope: verifiedScope, data, epoch: identityEpoch };
    })
    .catch((error) => {
      if (
        epoch !== identityEpoch &&
        !(error instanceof ApiRequestError && [401, 403].includes(error.status))
      )
        throw new QueryCacheError("CACHE_INVALIDATED");
      throw error;
    })
    .finally(() => {
      if (identityPending === pending) {
        identityPending = undefined;
        identityController = undefined;
      }
    });
  identityPending = pending;
  return pending;
}

export async function api(path: string, body?: unknown): Promise<any> {
  if (!clientCacheEnabled()) return request(path, body);
  listenForCacheChanges();
  if (body !== undefined) {
    // Both before and after: reads started during an uncertain mutation must
    // not refill a pre-write value, even when delivery timed out locally.
    metadata.clear();
    channel?.postMessage("metadata");
    try {
      return await request(path, body);
    } finally {
      metadata.clear();
      channel?.postMessage("metadata");
    }
  }
  const ttl = metadataTtl(path);
  // Session GETs remain uncached, but their late results must not reappear in
  // a view that now belongs to another identity (including visualizations).
  if (
    !ttl &&
    path !== "/api/me" &&
    !/^\/api\/(sessions|projects)(?:[/?]|$)/.test(path)
  )
    return request(path);
  if (activeMetadataReads >= 256)
    throw new ApiRequestError(
      "Too many metadata requests. Try again.",
      0,
      "CACHE_BUSY",
    );
  activeMetadataReads++;
  try {
    // Authorization is never cached: concurrent checks share only the active
    // /me request. Even a warm hit checks the current user/membership first.
    const verified = await verifyIdentity();
    const verifiedScope = verified.scope;
    if (verified.epoch !== identityEpoch || scope !== verifiedScope)
      throw new QueryCacheError("CACHE_INVALIDATED");
    if (path === "/api/me") return structuredClone(verified.data);
    const data = ttl
      ? await metadata.get(
          JSON.stringify([verifiedScope, path]),
          ttl,
          (signal) => request(path, undefined, signal),
          safeMetadata,
        )
      : await request(path);
    if (verified.epoch !== identityEpoch || scope !== verifiedScope)
      throw new QueryCacheError("CACHE_INVALIDATED");
    return data;
  } catch (error) {
    if (error instanceof QueryCacheError)
      throw new ApiRequestError(error.message, 0, error.code, { cause: error });
    throw error;
  } finally {
    activeMetadataReads--;
  }
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
export const getTraces = (sessionId: string) =>
  api(sessionPath(sessionId) + "/traces");
export const getTurnContext = (sessionId: string, turnId: string) =>
  api(sessionPath(sessionId) + `/turns/${encodeURIComponent(turnId)}/context`);
