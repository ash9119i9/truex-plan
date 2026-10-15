import type { Response } from "express";
import type { DomainEvent, Snapshot } from "../../../shared/contracts";
import type { RuntimeReadOptions } from "../../../shared/runtime-read-options";
import type { Thread } from "./state";
interface StreamView {
  generation(): string;
  snapshot(id: string, options?: RuntimeReadOptions): Snapshot;
  operationalSnapshot(t: Thread): Snapshot;
}
// write() returns false once the socket buffer passes its high-water mark,
// which a single large frame (an MCP tool result, a long replay) does on a
// healthy client. Only a subscriber whose unsent data keeps growing is dropped.
export const maxBufferedBytes = 8 * 1024 * 1024;
const maxReplayEvents = 500;
const maxReplayBytes = 2 * 1024 * 1024;
export function send(res: Response, chunk: string) {
  res.write(chunk);
  return res.writableLength <= maxBufferedBytes;
}

export function frame(event: DomainEvent) {
  return `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`;
}
export class ThreadStream {
  constructor(private readonly view: StreamView) {}

  /**
   * Opens an SSE connection for an existing thread. Sends its current snapshot
   * or retained events first, then registers the response for future events
   * published by ThreadEvents.emit(). Earlier generated text comes from the
   * thread's stored projection; subscribing does not start a new Codex turn.
   *
   * @param t Thread state containing messages, replay events and subscribers.
   * @param res Express response kept open to write SSE frames to the caller.
   * @param cursor Optional last applied "generation:sequence" cursor for replay.
   * @param options Read settings: window selects recent turns in snapshots;
   * sync: "v1" uses snapshot/replay plus sync.completed when sourceCovered is true.
   * @returns Nothing (void). Output is written to res, not returned as JSON.
   * Returns after initial delivery and listener setup, without waiting for the
   * turn to finish. Heartbeats run every 15 seconds; closing the connection
   * removes its subscriber and timer. Excess buffered output closes the stream.
   * Keep initial delivery and subscriber registration synchronous to avoid gaps.
   */
  subscribe(
    t: Thread,
    res: Response,
    cursor?: string,
    options: RuntimeReadOptions = {},
  ) {
    const id = t.id;
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    if (options.sync === "v1" && t.sourceCovered) {
      if (!this.synchronize(t, res, cursor)) {
        res.destroy();
        return;
      }
    } else {
      if (cursor) {
        const [generation, seqText] = cursor.split(":");
        const seq = Number(seqText);
        const oldest = t.events[0]?.seq ?? t.seq + 1;
        if (
          generation !== this.view.generation() ||
          !Number.isSafeInteger(seq) ||
          seq < oldest - 1 ||
          seq > t.seq
        ) {
          res.write(
            `data: ${JSON.stringify({ type: "resync.required", data: { reason: "Cursor no longer retained" }, threadId: id })}\n\n`,
          );
        } else
          for (const e of t.events.filter((e) => e.seq > seq)) {
            if (!send(res, frame(e))) {
              res.destroy();
              return;
            }
          }
      }
      const data = this.view.snapshot(id, options);
      const snapshot = {
        type: "snapshot",
        threadId: id,
        cursor: data.cursor,
        data,
      };
      if (
        !send(
          res,
          `id: ${snapshot.cursor}\ndata: ${JSON.stringify(snapshot)}\n\n`,
        )
      ) {
        res.destroy();
        return;
      }
    }
    t.subscribers.add(res);
    const timer = setInterval(() => {
      if (!send(res, ": heartbeat\n\n")) res.destroy();
    }, 15_000);
    res.on("close", () => {
      clearInterval(timer);
      t.subscribers.delete(res);
    });
  }
  private synchronize(t: Thread, res: Response, cursor?: string): boolean {
    // Capture, encode, publish and subscriber attachment share one event-loop
    // turn without an await, before the next runtime notification task.
    const highWaterCursor = `${this.view.generation()}:${t.seq}`;
    const highWaterSeq = t.seq;
    const oldest = t.events[0]?.seq ?? highWaterSeq + 1;
    let reason: string | undefined;
    let seq = 0;
    if (!cursor) reason = "missing_cursor";
    else {
      const match = /^([A-Za-z0-9_-]{1,64}):(0|[1-9][0-9]{0,15})$/.exec(cursor);
      if (!match || !Number.isSafeInteger(Number(match[2])))
        reason = "invalid_cursor";
      else {
        seq = Number(match[2]);
        if (match[1] !== this.view.generation()) reason = "generation_changed";
        else if (seq < oldest - 1) reason = "cursor_expired";
        else if (seq > highWaterSeq) reason = "cursor_ahead";
      }
    }
    const frames: string[] = [];
    if (!reason) {
      const replay = t.events.filter(
        (event) => event.seq > seq && event.seq <= highWaterSeq,
      );
      if (replay.length > maxReplayEvents) reason = "replay_event_limit";
      else {
        let rawBytes = 0,
          encodedBytes = 0;
        for (const event of replay) {
          const payload = JSON.stringify(event);
          rawBytes += Buffer.byteLength(payload);
          const frame = `id: ${event.cursor}\ndata: ${payload}\n\n`;
          encodedBytes += Buffer.byteLength(frame);
          if (rawBytes > maxReplayBytes || encodedBytes > maxReplayBytes) {
            reason = "replay_byte_limit";
            break;
          }
          frames.push(frame);
        }
      }
    }
    const mode = reason ? "snapshot" : "replay";
    if (reason) {
      // A missing paired cursor is an ordinary cold start. Other failures make
      // replay unsafe; clients must recover rather than trusting their cache.
      if (
        cursor &&
        !send(
          res,
          `data: ${JSON.stringify({ type: "resync.required", threadId: t.id, data: { reason } })}\n\n`,
        )
      )
        return false;
      const snapshot: DomainEvent = {
        type: "snapshot",
        threadId: t.id,
        seq: highWaterSeq,
        cursor: highWaterCursor,
        at: new Date().toISOString(),
        data: this.view.snapshot(t.id, { window: true }),
      };
      if (!send(res, frame(snapshot))) return false;
    } else for (const frame of frames) if (!send(res, frame)) return false;
    const operational = this.view.operationalSnapshot(t);
    const marker: DomainEvent = {
      type: "sync.completed",
      threadId: t.id,
      seq: highWaterSeq,
      cursor: highWaterCursor,
      at: new Date().toISOString(),
      data: {
        protocol: 1,
        mode,
        fromCursor: cursor ?? null,
        highWaterCursor,
        ...(reason ? { reason } : {}),
        snapshot: operational,
      },
    };
    return send(res, frame(marker));
  }
}
