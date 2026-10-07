import type { DomainEvent } from "../../shared/contracts";
import { api, base } from "./api.ts";
import { createOrderedBatch } from "./ordered-batch.ts";
import { readSyncMarker } from "./source-sync.ts";
import { identityScope } from "./identity.ts";

// Connection states shown in the conversation header.
export type StreamStatus = "Connected" | "Reconnecting" | "Disconnected";

// A fatal stream failure the platform reported before closing the stream.
export interface StreamFailure {
  message: string;
  code?: string;
  requestId?: string;
}

export interface SubscribeHandlers {
  // Explicit null forces a source snapshot. Opt-in synchronization never trusts
  // an independently stored cursor without the corresponding source projection.
  sync?: "v1";
  cursor?: string | null;
  // Opt-in ordered publication. Returning false rejects stale ownership and
  // prevents checkpointing frames which did not reach conversation state.
  onBatch?: (events: DomainEvent[]) => boolean | void;
  // A frame could not be read: reload the transcript instead of guessing.
  onResync?: () => void;
  // The platform closed the stream with a reason. The stream is closed.
  onFailure?: (failure: StreamFailure) => void;
}

export type StreamSubscription = (() => void) & { flush?: () => void };

export interface Transport {
  subscribe(
    sessionId: string,
    onEvent: (e: DomainEvent) => unknown,
    // StreamStatus for the live stream; other transports (the mock) may
    // report their own labels.
    onStatus: (s: StreamStatus | (string & {})) => void,
    handlers?: SubscribeHandlers,
  ): StreamSubscription;
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

// Validate the shapes consumed synchronously by the chat reducers. Unknown
// event types retain forward compatibility through the common envelope.
function readEvent(raw: string): DomainEvent {
  const event = JSON.parse(raw) as DomainEvent;
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    typeof event.type !== "string" ||
    !event.data ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  )
    throw new TypeError("Invalid stream event envelope");
  const data = event.data;
  if (event.type === "sync.completed" && !readSyncMarker(event))
    throw new TypeError("Invalid synchronization marker");
  if (
    (event.type === "message.delta" || event.type === "reasoning.delta") &&
    typeof data.delta !== "string"
  )
    throw new TypeError("Invalid stream text delta");
  if (
    event.type === "snapshot" &&
    (!data.state ||
      typeof data.state.kind !== "string" ||
      !Array.isArray(data.messages) ||
      !Array.isArray(data.pending) ||
      ["thinking", "subAgents", "timings"].some(
        (key) => data[key] !== undefined && !Array.isArray(data[key]),
      ))
  )
    throw new TypeError("Invalid stream snapshot");
  return event;
}

export const transport: Transport = {
  subscribe(sessionId, onEvent, onStatus, handlers = {}) {
    const key = `cursor:${identityScope()}:${sessionId}`,
      cursor =
        handlers.sync === "v1"
          ? (handlers.cursor ?? "")
          : handlers.cursor !== undefined
            ? (handlers.cursor ?? "")
            : readCursor(key);
    const source = new EventSource(
      `${base}${sessionPath(sessionId)}/events?window=1${handlers.sync ? "&sync=v1" : ""}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
    );
    let failed = false;
    let closed = false;
    const deliver = (frames: { event: DomainEvent; cursor: string }[]) => {
      if (closed) return;
      try {
        const accepted = handlers.onBatch
          ? handlers.onBatch(frames.map((frame) => frame.event))
          : onEvent(frames[0].event);
        if (accepted === false) {
          closed = true;
          batch.discard();
          source.close();
          return;
        }
        // The cursor must never outlive the data it acknowledges. Checkpoint
        // once after synchronous publication, including navigation flushes.
        const cursor = frames.findLast((frame) => frame.cursor)?.cursor;
        if (cursor) saveCursor(key, cursor);
      } catch (error) {
        // Later frames must not leap past a rejected batch. Recovery reads the
        // durable transcript; reconnecting resumes from the last good cursor.
        console.error("[truex] stream delivery failed", { sessionId, error });
        closed = true;
        failed = true;
        batch.discard();
        source.close();
        onStatus("Disconnected");
        handlers.onResync?.();
      }
    };
    const batch = createOrderedBatch(deliver);
    source.onopen = () => {
      if (!closed) onStatus("Connected");
    };
    // EventSource retries on its own unless the stream is CLOSED, which
    // happens on a non-retryable response; then only a new subscribe helps.
    source.onerror = () => {
      if (failed || closed) return;
      batch.flush();
      if (closed) return;
      onStatus(source.readyState === CLOSED ? "Disconnected" : "Reconnecting");
    };
    source.onmessage = (message) => {
      if (closed) return;
      let event: DomainEvent;
      try {
        // Public frames intentionally omit the internal runtime thread id. The
        // authenticated subscription URL supplies their trusted public scope.
        event = { ...readEvent(message.data), threadId: sessionId };
        if (
          handlers.sync === "v1" &&
          event.type !== "resync.required" &&
          event.cursor !== message.lastEventId
        )
          throw new TypeError("Stream cursor disagrees with source event");
      } catch (error) {
        batch.flush();
        if (closed) return;
        // Keep the cursor where it was so the reload covers this frame.
        console.error("[truex] unreadable stream event", {
          sessionId,
          lastEventId: message.lastEventId,
          error,
        });
        // No later checkpoint may skip this missing frame. Recovery fetches
        // current durable state, and Retry starts at the last applied cursor.
        closed = true;
        failed = true;
        source.close();
        onStatus("Disconnected");
        handlers.onResync?.();
        return;
      }
      const frame = { event, cursor: message.lastEventId };
      const textDelta =
        event.type === "message.delta" ||
        event.type === "reasoning.delta" ||
        (event.type === "subagent.event" &&
          (event.data?.kind === "message.delta" ||
            event.data?.kind === "reasoning.delta"));
      if (handlers.onBatch && textDelta) batch.push(frame);
      else {
        // Snapshots, finals, approvals and status changes are ordering barriers.
        batch.flush();
        deliver([frame]);
      }
    };
    // Named `stream.error` because EventSource reserves the "error" event.
    source.addEventListener("stream.error", (message) => {
      if (closed) return;
      batch.flush();
      if (closed) return;
      failed = true;
      closed = true;
      const failure = streamFailure((message as MessageEvent).data);
      console.error("[truex] stream failed", { sessionId, ...failure });
      source.close();
      onStatus("Disconnected");
      handlers.onFailure?.(failure);
    });
    return Object.assign(
      () => {
        batch.flush();
        closed = true;
        batch.discard();
        source.close();
      },
      { flush: batch.flush },
    );
  },
  send: (id, text, clientId) =>
    api(`${sessionPath(id)}/messages`, { text, clientId }),
  interrupt: (id) => api(`${sessionPath(id)}/interrupt`, {}),
  answer: (id, requestId, result) =>
    api(`${sessionPath(id)}/approvals/${encodeURIComponent(requestId)}`, {
      result,
    }),
};
