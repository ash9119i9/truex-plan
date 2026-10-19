import type { RunError } from "../errors";

// One run = one user message and the turn that answers it. The run keeps a
// bounded buffer of numbered events plus the full text of each item, so a
// reconnecting caller either replays from its cursor or receives a snapshot.
// Memory per run is bounded by the answer's size, not its token count.

export type RunStatus =
  "starting" | "running" | "stopping" | "completed" | "stopped" | "failed";

// Whether Codex received the turn: "none" means nothing ran and resending is
// safe; "unknown" means a request went out and its answer was lost.
export type Delivery = "none" | "accepted" | "unknown";

export interface RunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface Subscriber {
  readonly send: (event: RunEvent) => void;
  readonly end: () => void;
}

// An ordered entry of what Codex produced during the turn. A reply holds one
// assistant message; an input marks where a steer entered the turn. The run's
// own first input is not recorded, so the list is the steered conversation.
export type RunItem =
  | { type: "reply"; itemId: string; text: string; completed: boolean }
  | { type: "input"; clientMessageId: string };

interface ReplyState {
  text: string;
  completed: boolean;
  // Index in `order`, or undefined until the reply has its first text and is
  // placed. Empty replies are never placed, so they never appear.
  placedAt: number | undefined;
}

export interface Timings {
  receivedAt: number;
  dispatchedAt?: number;
  firstTextAt?: number;
  completedAt?: number;
}

export function isFinished(status: RunStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

export class Run {
  status: RunStatus = "starting";
  delivery: Delivery = "none";
  threadId: string | null = null;
  turnId: string | null = null;
  resumed = false;
  stopRequested = false;
  finishedAt: number | undefined;
  readonly timings: Timings = { receivedAt: Date.now() };

  private seq = 0;
  private readonly events: RunEvent[] = [];
  private readonly replies = new Map<string, ReplyState>();
  // Replies and inputs in the order Codex produced them. Replies appear only
  // once they have text (empty ones never do); every steer input appears.
  private readonly order: RunItem[] = [];
  // Steer inputs already recorded, so a repeated userMessage/completed for one
  // is placed once.
  private readonly recordedInputs = new Set<string>();
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    readonly runId: string,
    readonly tenantId: string,
    readonly chatId: string,
    readonly requestHash: string,
    private readonly bufferLimit: number,
    // The run's own first input; its userMessage item is never listed.
    readonly inputClientMessageId: string | null = null,
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  emit(type: string, data: Record<string, unknown>): void {
    if (this.finishedAt !== undefined) return;
    const event = { seq: ++this.seq, type, data };
    this.events.push(event);
    if (this.events.length > this.bufferLimit) this.events.shift();
    for (const subscriber of this.subscribers) subscriber.send(event);
  }

  appendText(itemId: string, delta: string): void {
    const reply = this.reply(itemId);
    if (reply.completed) return;
    reply.text += delta;
    this.place(itemId, reply);
    this.timings.firstTextAt ??= Date.now();
    this.emit("text.delta", { itemId, delta });
  }

  completeItem(itemId: string, text: string): void {
    const reply = this.reply(itemId);
    if (reply.completed) return;
    reply.text = text;
    reply.completed = true;
    this.place(itemId, reply);
    this.timings.firstTextAt ??= Date.now();
    this.emit("item.completed", { itemId, text });
  }

  // A steer entered the turn: Codex's userMessage item for it completed. The
  // run's own input is never listed; every steer is recorded once, in stream
  // order, and emits `input.accepted`. A reply still streaming at this point
  // was cut off by the steer and never gets `item.completed`.
  recordInput(clientMessageId: string): void {
    if (
      clientMessageId === this.inputClientMessageId ||
      this.recordedInputs.has(clientMessageId)
    )
      return;
    this.recordedInputs.add(clientMessageId);
    this.order.push({ type: "input", clientMessageId });
    this.emit("input.accepted", { clientMessageId });
  }

  itemList(): RunItem[] {
    return this.order.map((item) =>
      item.type === "reply"
        ? {
            type: "reply" as const,
            itemId: item.itemId,
            text: this.replies.get(item.itemId)!.text,
            completed: this.replies.get(item.itemId)!.completed,
          }
        : item,
    );
  }

  // The terminal event. Everything a caller needs to save the outcome is in
  // it, including partial text, which Codex does not keep after a stop.
  finish(
    status: "completed" | "stopped" | "failed",
    error: RunError | null,
    usage: Record<string, unknown> | null,
  ): void {
    if (this.finishedAt !== undefined) return;
    this.status = status;
    this.timings.completedAt = Date.now();
    this.emit("run.completed", {
      status,
      error,
      delivery: this.delivery,
      threadId: this.threadId,
      turnId: this.turnId,
      items: this.itemList(),
      usage,
      timings: this.timings,
    });
    this.finishedAt = Date.now();
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
  }

  // Replays everything after `after` and registers for live events in the
  // same synchronous step, so no event can fall between them.
  subscribe(after: number, subscriber: Subscriber): () => void {
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    if (after < oldest - 1) {
      subscriber.send({
        seq: this.seq,
        type: "run.snapshot",
        data: {
          status: this.status,
          threadId: this.threadId,
          turnId: this.turnId,
          items: this.itemList(),
        },
      });
      after = this.seq;
      // A finished run's last event is run.completed; resend it after the
      // snapshot so the caller always ends on the outcome.
      const last = this.events.at(-1);
      if (this.finishedAt !== undefined && last) subscriber.send(last);
    } else {
      for (const event of this.events)
        if (event.seq > after) subscriber.send(event);
    }
    if (this.finishedAt !== undefined) {
      subscriber.end();
      return () => undefined;
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private reply(itemId: string): ReplyState {
    let reply = this.replies.get(itemId);
    if (!reply) {
      reply = { text: "", completed: false, placedAt: undefined };
      this.replies.set(itemId, reply);
    }
    return reply;
  }

  // Puts a reply into the ordered list the first time it has any text, so an
  // empty reply (started then cut off) never appears.
  private place(itemId: string, reply: ReplyState): void {
    if (reply.placedAt !== undefined || reply.text.length === 0) return;
    reply.placedAt = this.order.length;
    this.order.push({ type: "reply", itemId, text: "", completed: false });
  }
}
