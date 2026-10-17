// Follows one reply over the platform's server-sent events. EventSource
// cannot send the bearer token, so this reads a fetch body instead. Every
// connection starts with a snapshot that replaces what the screen has, so a
// dropped connection is simply opened again; the stream ends with `saved`
// once the reply is in the database.
import { addressed, base } from "./api.ts";
import { auth as defaultAuth, type Auth } from "./auth.ts";
import { identityGeneration, notifyUnauthenticated } from "./identity.ts";

// Delays before reconnecting after a dropped stream; the last one repeats
// until MAX_RECONNECTS, after which the screen offers a Reconnect button.
export const RECONNECT_DELAYS_MS = [250, 1_000, 2_000, 4_000, 8_000];
export const MAX_RECONNECTS = 8;
// The platform writes a heartbeat every 15 s. A connection silent for longer
// than this is treated as dropped.
export const SILENCE_MS = 40_000;

export type StreamEnd =
  // The reply is saved; `data` is the saved run and messages.
  | { kind: "saved"; data: unknown }
  // The platform can no longer stream it: reload the chat from history.
  | { kind: "unavailable" }
  // This reply or chat no longer exists for this person.
  | { kind: "notFound" }
  // Signed out, or no longer a member of this workspace.
  | { kind: "signedOut" }
  // Gave up reconnecting; follow() again to retry.
  | { kind: "lost" };

export interface FollowHandlers {
  // Every event other than `saved` and `end`, in order.
  onEvent(event: { type: string; data: unknown }): void;
  // true while connected, false while waiting to reconnect.
  onConnection?(connected: boolean): void;
  onEnd(end: StreamEnd): void;
}

export interface FollowDeps {
  auth?: Auth;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  silenceMs?: number;
}

// Server-sent events framing: "event:" and "data:" lines, a blank line ends
// a frame, ":" lines are comments (heartbeats).
export function createSseParser(
  onFrame: (frame: { type: string; data: string }) => void,
) {
  let buffer = "";
  let type = "";
  let data: string[] = [];
  const line = (text: string) => {
    if (text === "") {
      if (data.length)
        onFrame({ type: type || "message", data: data.join("\n") });
      type = "";
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const newline =
          buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        // A lone "\r" at the end may be the first half of "\r\n".
        if (buffer[index] === "\r" && index === buffer.length - 1) break;
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + newline);
      }
    },
  };
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

type Attempt =
  | { kind: "end"; end: StreamEnd }
  // Retry; `progressed` resets the backoff when frames arrived.
  | { kind: "retry"; progressed: boolean };

/**
 * Follows one reply until it is saved or cannot be followed. Returns a stop
 * function; after stopping (or a change of person or workspace) no handler
 * is called again.
 */
export function followRun(
  chatId: string,
  runId: string,
  handlers: FollowHandlers,
  deps: FollowDeps = {},
): () => void {
  const session = deps.auth ?? defaultAuth;
  const sleep = deps.sleep ?? defaultSleep;
  const silenceMs = deps.silenceMs ?? SILENCE_MS;
  const stopped = new AbortController();
  const generation = identityGeneration();
  const live = () =>
    !stopped.signal.aborted && generation === identityGeneration();
  const path = `/api/v1/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(runId)}/stream`;

  async function attempt(): Promise<Attempt> {
    const target = addressed(path);
    if (typeof target !== "string")
      return { kind: "end", end: { kind: "signedOut" } };
    const connection = new AbortController();
    const abort = () => connection.abort();
    stopped.signal.addEventListener("abort", abort, { once: true });
    let silence: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => {
      clearTimeout(silence);
      silence = setTimeout(abort, silenceMs);
    };
    let progressed = false;
    try {
      quiet();
      const outcome = await session.request(base + target, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        credentials: "same-origin",
        cache: "no-store",
        signal: connection.signal,
      });
      if (outcome.kind === "signedOut") {
        notifyUnauthenticated();
        return { kind: "end", end: { kind: "signedOut" } };
      }
      if (outcome.kind === "unavailable") return { kind: "retry", progressed };
      const res = outcome.response;
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return { kind: "end", end: { kind: "notFound" } };
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 401) notifyUnauthenticated();
        return { kind: "end", end: { kind: "signedOut" } };
      }
      if (!res.ok || !res.body || !live()) {
        await res.body?.cancel().catch(() => {});
        return { kind: "retry", progressed };
      }
      handlers.onConnection?.(true);
      // Set from the parser callback.
      const state: { result: Attempt | null } = { result: null };
      const parser = createSseParser(({ type, data }) => {
        if (state.result || !live()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        progressed = true;
        if (type === "saved")
          state.result = { kind: "end", end: { kind: "saved", data: parsed } };
        else if (type === "end") {
          // reauthenticate: the token aged out; the next request renews it,
          // and a revoked session or membership is refused there.
          const reason = (parsed as { reason?: unknown } | null)?.reason;
          state.result =
            reason === "reauthenticate"
              ? { kind: "retry", progressed: true }
              : { kind: "end", end: { kind: "unavailable" } };
        } else handlers.onEvent({ type, data: parsed });
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      // The silence watchdog and stop() abort the connection. Cancelling the
      // reader ends a pending read even when the body ignores the signal.
      const cancel = () => void reader.cancel().catch(() => {});
      if (connection.signal.aborted) cancel();
      else connection.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (!state.result) {
          const { value, done } = await reader.read();
          if (done) break;
          quiet();
          parser.push(value);
        }
      } finally {
        connection.signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
      }
      return state.result ?? { kind: "retry", progressed };
    } catch {
      return { kind: "retry", progressed };
    } finally {
      clearTimeout(silence);
      stopped.signal.removeEventListener("abort", abort);
    }
  }

  void (async () => {
    let failures = 0;
    while (live()) {
      const result = await attempt();
      if (!live()) return;
      if (result.kind === "end") {
        handlers.onEnd(result.end);
        return;
      }
      handlers.onConnection?.(false);
      failures = result.progressed ? 1 : failures + 1;
      if (failures > MAX_RECONNECTS) {
        handlers.onEnd({ kind: "lost" });
        return;
      }
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(failures - 1, RECONNECT_DELAYS_MS.length - 1)
        ];
      await sleep(delay, stopped.signal);
    }
  })();

  return () => stopped.abort();
}
