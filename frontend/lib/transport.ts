import type { DomainEvent } from "../../shared/contracts";
import {
  api,
  apiIdentityEpoch,
  apiIdentityScope,
  base,
  clientCacheEnabled,
  onApiIdentityChange,
} from "./api.ts";

// Connection states shown in the conversation header.
export type StreamStatus = "Connected" | "Reconnecting" | "Disconnected";

// A fatal stream failure the platform reported before closing the stream.
export interface StreamFailure {
  message: string;
  code?: string;
  requestId?: string;
}

export interface SubscribeHandlers {
  // A frame could not be read: reload the transcript instead of guessing.
  onResync?: () => void;
  // The platform closed the stream with a reason. The stream is closed.
  onFailure?: (failure: StreamFailure) => void;
}

export interface Transport {
  subscribe(
    sessionId: string,
    onEvent: (e: DomainEvent) => void,
    // StreamStatus for the live stream; other transports (the mock) may
    // report their own labels.
    onStatus: (s: StreamStatus | (string & {})) => void,
    handlers?: SubscribeHandlers,
  ): () => void;
  send(sessionId: string, text: string, clientId: string): Promise<any>;
  interrupt(sessionId: string): Promise<any>;
  answer(sessionId: string, requestId: string, result: unknown): Promise<any>;
}

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
const CLOSED = 2; // EventSource.CLOSED

function readCursor(key: string) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
function saveCursor(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* Storage can be unavailable; the stream then restarts from its snapshot. */
  }
}

// Reads the platform's `stream.error` payload, tolerating missing fields.
function streamFailure(raw: string): StreamFailure {
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* Fall through to the generic message. */
  }
  return {
    message:
      typeof data?.error === "string" && data.error.trim()
        ? data.error
        : "The live connection to this conversation stopped.",
    ...(typeof data?.code === "string" ? { code: data.code } : {}),
    ...(typeof data?.requestId === "string" && data.requestId
      ? { requestId: data.requestId }
      : {}),
  };
}

const connectStream: Transport["subscribe"] = (
  sessionId,
  onEvent,
  onStatus,
  handlers = {},
) => {
  const identity = apiIdentityScope();
  const epoch = apiIdentityEpoch();
  const scoped = clientCacheEnabled();
  const key = !scoped
      ? `cursor:${sessionId}`
      : identity
        ? `cursor:${identity}:${sessionId}`
        : undefined,
    cursor = key ? readCursor(key) : "";
  const source = new EventSource(
    `${base}${sessionPath(sessionId)}/events${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
    { withCredentials: true },
  );
  let failed = false;
  let stopped = false;
  let offIdentity = () => {};
  const current = () => {
    if (!scoped) return true;
    if (stopped) return false;
    if (
      epoch === apiIdentityEpoch() &&
      identity !== undefined &&
      identity === apiIdentityScope()
    )
      return true;
    stopped = true;
    source.close();
    offIdentity();
    onStatus("Disconnected");
    return false;
  };
  source.onopen = () => {
    if (current()) onStatus("Connected");
  };
  // EventSource retries on its own unless the stream is CLOSED, which
  // happens on a non-retryable response; then only a new subscribe helps.
  source.onerror = () => {
    if (!current()) return;
    if (failed) return;
    onStatus(source.readyState === CLOSED ? "Disconnected" : "Reconnecting");
  };
  source.onmessage = (message) => {
    if (!current()) return;
    let event: DomainEvent;
    try {
      event = JSON.parse(message.data);
    } catch (error) {
      // Keep the cursor where it was so the reload covers this frame.
      console.error("[truex] unreadable stream event", {
        sessionId,
        lastEventId: message.lastEventId,
        error,
      });
      handlers.onResync?.();
      return;
    }
    if (key && message.lastEventId) saveCursor(key, message.lastEventId);
    onEvent(event);
  };
  // Named `stream.error` because EventSource reserves the "error" event.
  source.addEventListener("stream.error", (message) => {
    if (!current()) return;
    failed = true;
    const failure = streamFailure((message as MessageEvent).data);
    console.error("[truex] stream failed", { sessionId, ...failure });
    source.close();
    onStatus("Disconnected");
    handlers.onFailure?.(failure);
  });
  if (scoped) offIdentity = onApiIdentityChange(current);
  return () => {
    stopped = true;
    offIdentity();
    source.close();
  };
};

export const transport: Transport = {
  subscribe(sessionId, onEvent, onStatus, handlers = {}) {
    if (!clientCacheEnabled())
      return connectStream(sessionId, onEvent, onStatus, handlers);
    let cancelled = false;
    let stop: (() => void) | undefined;
    let boundIdentity: string | undefined;
    const stopWatching = onApiIdentityChange((reason) => {
      if (
        reason === "focus-restored" &&
        !cancelled &&
        boundIdentity !== undefined &&
        boundIdentity === apiIdentityScope()
      ) {
        stop?.();
        stop = connectStream(sessionId, onEvent, onStatus, handlers);
      }
    });
    void api("/api/me")
      .then(() => {
        if (!cancelled) {
          boundIdentity = apiIdentityScope();
          stop = connectStream(sessionId, onEvent, onStatus, handlers);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        onStatus("Disconnected");
        handlers.onFailure?.({
          message:
            error instanceof Error
              ? error.message
              : "Unable to verify this account. Sign in again.",
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
        });
      });
    return () => {
      cancelled = true;
      stopWatching();
      stop?.();
    };
  },
  send: (id, text, clientId) =>
    api(`${sessionPath(id)}/messages`, { text, clientId }),
  interrupt: (id) => api(`${sessionPath(id)}/interrupt`, {}),
  answer: (id, requestId, result) =>
    api(`${sessionPath(id)}/approvals/${encodeURIComponent(requestId)}`, {
      result,
    }),
};
