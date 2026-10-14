import type { DomainType, DomainEvent } from "../../../shared/contracts";
import { errorFields, log } from "../../../shared/logging";
import type { Redactor } from "../telemetry/redact";
import type { Thread } from "./state";
import { recordPath, writeRecord } from "./records";
import { frame as eventFrame, send, maxBufferedBytes } from "./stream";
interface EventView {
  generation(): string;
  redactor: Redactor;
  storageFailed(): void;
}
export class ThreadEvents {
  private replaySizes = new WeakMap<DomainEvent, number>();
  // Last goal written as a durable record, per thread.
  private goalRecords = new Map<string, string>();
  constructor(
    readonly home: string,
    readonly replayLimit: number,
    private readonly view: EventView,
  ) {}

  emit(
    t: Thread,
    type: DomainType,
    data: any,
    turnId?: string,
    itemId?: string,
  ) {
    data = this.view.redactor.clean(data);
    const event: DomainEvent = {
      type,
      threadId: t.id,
      seq: ++t.seq,
      cursor: `${this.view.generation()}:${t.seq}`,
      at: new Date().toISOString(),
      data,
      turnId,
      itemId,
    };
    let durable = [
      "message.final",
      "turn.completed",
      "approval.resolved",
      "goal.cleared",
      // Lets platform keep the plan when no browser is subscribed.
      "plan.updated",
    ].includes(type);
    if (type === "goal.cleared") this.goalRecords.set(t.id, "cleared");
    // Goal changes are durable; token-only updates are not.
    if (type === "goal.updated") {
      const g = data?.goal;
      const key = JSON.stringify(
        g
          ? [g.createdAt ?? null, g.objective, g.status, g.tokenBudget ?? null]
          : null,
      );
      durable = this.goalRecords.get(t.id) !== key;
      this.goalRecords.set(t.id, key);
    }
    let lost = false;
    if (durable) {
      const { dir, file } = recordPath(
        this.home,
        t.id,
        this.view.generation(),
        event.seq,
      );
      try {
        writeRecord(dir, file, event);
      } catch (e) {
        lost = true;
        this.view.storageFailed();
        log("error", "durable record write failed; stopping admission", {
          threadId: t.id,
          turnId,
          eventType: type,
          seq: event.seq,
          ...errorFields(e),
        });
      }
    }
    const frame = eventFrame(event);
    const retainedBytes = Buffer.byteLength(frame);
    this.replaySizes.set(event, retainedBytes);
    t.events.push(event);
    t.replayBytes += retainedBytes;
    while (
      t.events.length > this.replayLimit ||
      t.replayBytes > maxBufferedBytes
    ) {
      const dropped = t.events.shift();
      if (!dropped) break;
      t.replayBytes -= this.replaySizes.get(dropped) ?? 0;
    }
    for (const sub of t.subscribers) if (!send(sub, frame)) sub.destroy();
    if (lost) {
      // Subscribers learn why the stream ends before it is closed.
      this.emit(
        t,
        "error",
        {
          message:
            "Conversation storage is unavailable, so this update may not be saved. Refresh the conversation later to check its state.",
          code: "STORAGE_UNAVAILABLE",
          willRetry: false,
          ...(turnId ? { turnId } : {}),
        },
        turnId,
      );
      for (const sub of t.subscribers) sub.destroy();
    }
    return event;
  }
}
