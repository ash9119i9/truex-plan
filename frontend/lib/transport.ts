import type { DomainEvent } from "../../shared/contracts";
import { api, base } from "./api.ts";

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

export const transport: Transport = {
  subscribe(sessionId, onEvent, onStatus, handlers = {}) {
    const key = `cursor:${sessionId}`,
      cursor = readCursor(key);
    const source = new EventSource(
      `${base}${sessionPath(sessionId)}/events${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
    );
    let failed = false;
    source.onopen = () => onStatus("Connected");
    // EventSource retries on its own unless the stream is CLOSED, which
    // happens on a non-retryable response; then only a new subscribe helps.
    source.onerror = () => {
      if (failed) return;
      onStatus(source.readyState === CLOSED ? "Disconnected" : "Reconnecting");
    };
    source.onmessage = (message) => {
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
      if (message.lastEventId) saveCursor(key, message.lastEventId);
      onEvent(event);
    };
    // Named `stream.error` because EventSource reserves the "error" event.
    source.addEventListener("stream.error", (message) => {
      failed = true;
      const failure = streamFailure((message as MessageEvent).data);
      console.error("[truex] stream failed", { sessionId, ...failure });
      source.close();
      onStatus("Disconnected");
      handlers.onFailure?.(failure);
    });
    return () => source.close();
  },
  send: (id, text, clientId) =>
    api(`${sessionPath(id)}/messages`, { text, clientId }),
  interrupt: (id) => api(`${sessionPath(id)}/interrupt`, {}),
  answer: (id, requestId, result) =>
    api(`${sessionPath(id)}/approvals/${encodeURIComponent(requestId)}`, {
      result,
    }),
};
