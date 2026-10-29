import { randomBytes } from "node:crypto";
import type { RunEvent, Subscriber } from "./run";

// A chat's own stream (GET /v1/chats/:chatId/events): its goal's changes and
// the runs Codex starts for the goal. Numbered and bounded like a run's
// stream, but it never ends. Numbering starts at 1 in every stream (a new
// adapter process, or the chat again after the idle sweep dropped it), so a
// cursor names its stream. A cursor without this stream's ID, older than the
// buffer, or newer than the last event gets one `chat.snapshot`, carrying the
// ID, instead of a replay.

export interface ChatCursor {
  readonly streamId?: string;
  readonly after: number;
}

export class ChatStream {
  readonly id = randomBytes(12).toString("hex");
  private seq = 0;
  private readonly events: RunEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    private readonly bufferLimit: number,
    private readonly snapshot: () => Record<string, unknown>,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  emit(type: string, data: Record<string, unknown>): void {
    const event = { seq: ++this.seq, type, data };
    this.events.push(event);
    if (this.events.length > this.bufferLimit) this.events.shift();
    for (const subscriber of this.subscribers) subscriber.send(event);
  }

  // Replays everything after `after` and registers for live events in the
  // same synchronous step, so no event can fall between them.
  subscribe(
    { streamId, after }: ChatCursor,
    subscriber: Subscriber,
  ): () => void {
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    if (streamId !== this.id || after < oldest - 1 || after > this.seq)
      subscriber.send({
        seq: this.seq,
        type: "chat.snapshot",
        data: { streamId: this.id, ...this.snapshot() },
      });
    else
      for (const event of this.events)
        if (event.seq > after) subscriber.send(event);
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}
