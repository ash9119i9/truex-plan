import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from "@nestjs/common";
import type { ObjectId } from "mongodb";
import { detached } from "../../common/http/server-timing";
import { toWireId } from "../../database/object-id";
import type { RunErrorInfo, RunUsage } from "./chat";
import {
  ChatStore,
  LEASE_RENEW_MS,
  type SettleResult,
  type Settlement,
} from "./chat-store";
import {
  AdapterRefusal,
  AdapterUnreachable,
  RuntimeClient,
  type AdapterEvent,
  type ChatRef,
  type StartRunBody,
} from "./runtime-client";

export const RUNTIME_CLIENT = Symbol("RUNTIME_CLIENT");

// Everything needed to run (or recover) one turn. Built by ChatsService from
// the saved chat; holds a gateway token, so it never leaves the server.
export interface Dispatch {
  readonly dbName: string;
  readonly chatId: ObjectId;
  readonly runId: ObjectId;
  // The chat's owner: a stream proves its caller against this, not MongoDB.
  readonly ownerId: ObjectId;
  // The seq of the reply's first message: the one after the member's.
  readonly replySeq: number;
  readonly ref: ChatRef;
  readonly body: StartRunBody;
  // start: post the run. recover: reattach first; post only when the
  // runtime has no trace of the message.
  readonly mode: "start" | "recover";
  // A recovered run whose lease is still held waits until it expires.
  readonly notBefore?: Date;
}

export type Phase =
  | "waiting"
  | "streaming"
  | "retrying"
  | "stopping"
  | "reconnecting"
  | "settled";

// What a browser subscriber receives. Deltas are batched per run.
export type LiveEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "status"; data: { phase: Phase } }
  | { type: "delta"; data: { itemId: string; text: string } }
  | { type: "item"; data: { itemId: string; text: string } }
  | { type: "usage"; data: RunUsage }
  | { type: "completed"; data: Completed }
  | { type: "saved"; data: SettleResult }
  | { type: "save_failed"; data: Record<string, never> };

export interface Snapshot {
  runId: string;
  phase: Phase;
  items: Array<{ itemId: string; text: string }>;
  usage: RunUsage | null;
}

export interface Completed {
  status: Settlement["status"];
  error: RunErrorInfo | null;
  items: Array<{ itemId: string; text: string }>;
  usage: RunUsage | null;
}

export interface LiveSubscriber {
  send(event: LiveEvent): void;
  end(): void;
}

// The first delta of an item goes out at once; later ones every 50 ms.
export const DELTA_FLUSH_MS = 50;
// A settled run stays here this long for late subscribers; after that the
// saved messages are the answer.
const SETTLED_TTL_MS = 60_000;
// Reconnect attempts after the adapter stream drops, and the delays between.
const RECONNECT_DELAYS_MS = [250, 1_000, 2_000, 4_000, 8_000, 15_000];
// Request-level refusals that mean "not started; try again shortly".
const RETRYABLE_START = new Set([
  "RUNTIME_BUSY",
  "DRAINING",
  "RUNTIME_UNAVAILABLE",
  "INTERNAL",
]);

const RUNTIME_FAILED: RunErrorInfo = {
  code: "RUNTIME_ERROR",
  message: "The assistant couldn't run this message. Try again.",
  retryable: true,
};
const NOT_SENT: RunErrorInfo = {
  code: "NOT_SENT",
  message: "This message wasn't sent to the assistant. Try again.",
  retryable: true,
};
const BUSY_ELSEWHERE: RunErrorInfo = {
  code: "RUNTIME_BUSY",
  message:
    "The assistant is still finishing an earlier reply. Try again shortly.",
  retryable: true,
};
const THREAD_LOST: RunErrorInfo = {
  code: "THREAD_LOST",
  message:
    "This conversation's history is no longer available, so it can't continue.",
  retryable: false,
};

class LiveRun {
  phase: Phase = "waiting";
  // Text already sent to subscribers, per item, in arrival order.
  readonly items = new Map<string, string>();
  private readonly pending = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | undefined;
  usage: RunUsage | null = null;
  firstTextAt: Date | undefined;
  threadId: string | null = null;
  turnId: string | null = null;
  stopRequested = false;
  accepted = false;
  // The runtime's acceptance being saved. Text keeps streaming meanwhile;
  // the run's later writes wait for it so they land in order.
  acceptedWrite: Promise<void> = Promise.resolve();
  completed: Completed | undefined;
  saved: SettleResult | undefined;
  saveFailed = false;
  readonly subscribers = new Set<LiveSubscriber>();
  readonly abort = new AbortController();
  done: Promise<void> = Promise.resolve();

  constructor(readonly dispatch: Dispatch) {}

  get id(): string {
    return toWireId(this.dispatch.runId);
  }

  snapshot(): Snapshot {
    return {
      runId: this.id,
      phase: this.phase,
      items: [...this.items].map(([itemId, text]) => ({ itemId, text })),
      usage: this.usage,
    };
  }

  broadcast(event: LiveEvent): void {
    if (event.type !== "delta") this.flush();
    for (const subscriber of this.subscribers) subscriber.send(event);
  }

  setPhase(phase: Phase): void {
    if (this.phase === phase || this.phase === "settled") return;
    if (this.phase === "stopping" && phase !== "settled") return;
    this.phase = phase;
    this.broadcast({ type: "status", data: { phase } });
  }

  appendDelta(itemId: string, delta: string): void {
    this.firstTextAt ??= new Date();
    const first = !this.items.has(itemId) && !this.pending.has(itemId);
    this.pending.set(itemId, (this.pending.get(itemId) ?? "") + delta);
    if (this.phase === "waiting" || this.phase === "retrying")
      this.setPhase("streaming");
    if (first) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), DELTA_FLUSH_MS);
  }

  // Replaces an item's text when the runtime reports it whole.
  setItem(itemId: string, text: string): void {
    this.pending.delete(itemId);
    if (this.items.get(itemId) === text) return;
    this.items.set(itemId, text);
    this.broadcast({ type: "item", data: { itemId, text } });
  }

  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pending.size === 0) return;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [itemId, text] of batch) {
      this.items.set(itemId, (this.items.get(itemId) ?? "") + text);
      for (const subscriber of this.subscribers)
        subscriber.send({ type: "delta", data: { itemId, text } });
    }
  }

  close(): void {
    this.flush();
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
  }
}

// Owns every run this process is streaming. One reader per run consumes the
// adapter's stream whether or not a browser is watching, saves the outcome,
// and fans live text out to any number of browser subscribers.
//
// v1 runs one platform process (tasks/chat-v1-plan.md). A run whose process
// died is recovered once its lease lapses: by the next access to its chat, or
// by the RecoverySweep within a minute.
@Injectable()
export class RunExecutor implements OnApplicationShutdown {
  private readonly logger = new Logger("RunExecutor");
  private readonly live = new Map<string, LiveRun>();
  // Bounded: a run leaves it when it is read again.
  private readonly abandoned = new Set<string>();
  private draining = false;

  constructor(
    @Inject(ChatStore) private readonly store: ChatStore,
    @Inject(RUNTIME_CLIENT) private readonly client: RuntimeClient | null,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  // This process read the run and gave up on it (save failed, or the
  // runtime stayed unreachable), so no lease needs to lapse before
  // recovering it.
  abandonedHere(runId: ObjectId): boolean {
    return this.abandoned.has(toWireId(runId));
  }

  isLive(runId: ObjectId): boolean {
    const run = this.live.get(toWireId(runId));
    return !!run && run.phase !== "settled";
  }

  // What this process holds for a run it is reading for exactly this tenant
  // database, chat and owner: "running", or the saved outcome. The entry was
  // written by this server from a verified caller and a run's owner never
  // changes, so it answers as the owner-filtered read of the run would.
  // Null otherwise, including a run whose save failed: the caller then reads
  // MongoDB and recovery runs as before.
  liveFor(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    ownerId: ObjectId,
  ): "running" | SettleResult | null {
    const run = this.live.get(toWireId(runId));
    if (!run) return null;
    const { dispatch } = run;
    if (
      dispatch.dbName !== dbName ||
      !dispatch.chatId.equals(chatId) ||
      !dispatch.ownerId.equals(ownerId)
    )
      return null;
    if (run.saved) return run.saved;
    return run.phase === "settled" ? null : "running";
  }

  // Starts reading a run. Repeating it for a run already live here is a
  // no-op, so recovery and a fresh start can never double-read in one
  // process.
  begin(dispatch: Dispatch): void {
    if (!this.client) throw new Error("chat runtime is not configured");
    const id = toWireId(dispatch.runId);
    const existing = this.live.get(id);
    if (existing && existing.phase !== "settled") return;
    const run = new LiveRun(dispatch);
    this.abandoned.delete(id);
    if (dispatch.mode === "recover") run.phase = "reconnecting";
    this.live.set(id, run);
    const client = this.client;
    // The reader outlives the request that started it.
    run.done = detached(() =>
      this.execute(run, client).catch((error: unknown) => {
        this.logger.error({
          message: "run reader failed",
          runId: id,
          error: error instanceof Error ? error.name : "unknown",
        });
        run.close();
        this.live.delete(id);
      }),
    );
  }

  // Snapshot then live events, registered in one synchronous step so no
  // event falls between them. Returns null when the run is not live here.
  subscribe(runId: ObjectId, subscriber: LiveSubscriber): (() => void) | null {
    const run = this.live.get(toWireId(runId));
    if (!run) return null;
    run.flush();
    subscriber.send({ type: "snapshot", data: run.snapshot() });
    if (run.completed)
      subscriber.send({ type: "completed", data: run.completed });
    if (run.saved) subscriber.send({ type: "saved", data: run.saved });
    else if (run.saveFailed) subscriber.send({ type: "save_failed", data: {} });
    if (run.saved || run.saveFailed) {
      subscriber.end();
      return () => undefined;
    }
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  // Asks the runtime to stop. Safe to repeat. A stop that arrives before
  // the runtime knows the run is sent again once it does.
  async stop(runId: ObjectId): Promise<void> {
    const run = this.live.get(toWireId(runId));
    if (!run || run.phase === "settled") return;
    run.stopRequested = true;
    run.setPhase("stopping");
    await this.sendStop(run);
  }

  private async sendStop(run: LiveRun): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.stop(run.id, run.dispatch.ref);
    } catch (error) {
      // Not yet known to the runtime: resent on its first event.
      if (error instanceof AdapterRefusal && error.code === "RUN_NOT_FOUND")
        return;
      throw error;
    }
  }

  private async execute(run: LiveRun, client: RuntimeClient): Promise<void> {
    const { dispatch } = run;
    let lease: NodeJS.Timeout | undefined;
    try {
      if (dispatch.notBefore) {
        const wait = dispatch.notBefore.getTime() - Date.now();
        if (wait > 0) await sleep(wait, run.abort.signal);
        if (run.abort.signal.aborted) return this.release(run);
        // Its holder may have renewed the lease meanwhile: then it is still
        // reading, and this process lets go.
        if (
          !(await this.store.takeOverLease(
            dispatch.dbName,
            dispatch.chatId,
            dispatch.runId,
            dispatch.notBefore,
          ))
        )
          return this.release(run);
      }
      // Renewed only once the run is this process's to read.
      lease = setInterval(() => {
        this.store
          .renewLease(dispatch.dbName, dispatch.chatId, dispatch.runId)
          .catch(() => undefined);
      }, LEASE_RENEW_MS);
      lease.unref();
      const outcome = await this.read(run, client);
      if (outcome) await this.finish(run, outcome);
      else {
        // Unreachable runtime or shutdown: let go of the run so the next
        // access recovers it once the lease lapses. Browsers reconnect.
        this.release(run);
        if (!this.draining) this.abandoned.add(run.id);
      }
    } finally {
      clearInterval(lease);
      // Shutdown waits for it with the reader.
      await run.acceptedWrite;
    }
  }

  // Stops holding a run without settling it; browsers reconnect.
  private release(run: LiveRun): void {
    run.close();
    if (this.live.get(run.id) === run) this.live.delete(run.id);
  }

  // Reads the run to its outcome, reconnecting through drops. Returns null
  // when the runtime stayed unreachable: the run is left claimed and
  // `uncertain`, and recovery settles it once its lease lapses.
  private async read(
    run: LiveRun,
    client: RuntimeClient,
  ): Promise<Settlement | null> {
    const { dispatch } = run;
    const signal = run.abort.signal;
    let after = 0;
    let posts = 0;
    let failures = 0;
    let stream =
      dispatch.mode === "start"
        ? (posts++, client.startRun(dispatch.body, signal))
        : client.events(run.id, dispatch.ref, 0, signal);
    for (;;) {
      try {
        for await (const event of stream) {
          failures = 0;
          after = event.seq;
          const outcome = await this.handle(run, event, client);
          if (outcome) return outcome;
        }
        throw new AdapterUnreachable("stream ended early");
      } catch (error) {
        if (signal.aborted) return null;
        if (error instanceof AdapterRefusal) {
          if (error.code === "RUN_NOT_FOUND") {
            // undefined: history unreadable right now; retried below.
            const known = await this.fromHistory(run, client).catch(
              () => undefined,
            );
            if (known) return known;
            if (known === null) {
              // Recovery may run long after the message was written; never
              // post it then. The member sees "not sent" and can resend.
              if (dispatch.mode === "recover" || posts >= 2)
                return failed(run, NOT_SENT);
              posts++;
              after = 0;
              stream = client.startRun(dispatch.body, signal);
              continue;
            }
          }
          if (error.code === "THREAD_LOST")
            return failed(run, THREAD_LOST, true);
          if (error.code === "CHAT_BUSY") return failed(run, BUSY_ELSEWHERE);
          if (
            !RETRYABLE_START.has(error.code) &&
            error.code !== "RUN_NOT_FOUND"
          ) {
            this.logger.warn({
              message: "runtime refused run",
              runId: run.id,
              code: error.code,
            });
            return failed(run, RUNTIME_FAILED);
          }
        }
        const delay = RECONNECT_DELAYS_MS[failures++];
        if (delay === undefined) {
          this.logger.warn({ message: "runtime unreachable", runId: run.id });
          await run.acceptedWrite;
          await this.store
            .markUncertain(dispatch.dbName, dispatch.runId)
            .catch(() => undefined);
          return null;
        }
        run.setPhase("reconnecting");
        await sleep(delay, signal);
        if (signal.aborted) return null;
        // A refusal before streaming means nothing started: post again.
        // Anything else may have started: reattach, never repost blindly.
        stream =
          error instanceof AdapterRefusal &&
          RETRYABLE_START.has(error.code) &&
          after === 0 &&
          posts > 0
            ? client.startRun(dispatch.body, signal)
            : client.events(run.id, dispatch.ref, after, signal);
      }
    }
  }

  private async handle(
    run: LiveRun,
    event: AdapterEvent,
    client: RuntimeClient,
  ): Promise<Settlement | null> {
    const d = event.data;
    if (run.phase === "reconnecting")
      run.setPhase(run.items.size ? "streaming" : "waiting");
    switch (event.type) {
      case "run.accepted": {
        const threadId = str(d.threadId);
        const turnId = str(d.turnId);
        run.accepted = true;
        run.threadId = threadId;
        run.turnId = turnId;
        if (threadId && turnId) {
          const { dbName, chatId, runId } = run.dispatch;
          // Not awaited: the reply's first text must not wait for a database
          // round trip. A failure is logged; the run's thread and turn are
          // saved again when it settles.
          run.acceptedWrite = run.acceptedWrite.then(() =>
            this.store
              .markAccepted(dbName, chatId, runId, threadId, turnId)
              .catch((error: unknown) =>
                this.logger.warn({
                  message: "saving run acceptance failed",
                  runId: run.id,
                  error: error instanceof Error ? error.name : "unknown",
                }),
              ),
          );
        }
        if (run.stopRequested) await this.sendStop(run).catch(() => undefined);
        return null;
      }
      case "text.delta": {
        const itemId = str(d.itemId);
        const delta = typeof d.delta === "string" ? d.delta : "";
        if (itemId && delta) run.appendDelta(itemId, delta);
        return null;
      }
      case "item.completed": {
        const itemId = str(d.itemId);
        if (itemId && typeof d.text === "string") run.setItem(itemId, d.text);
        return null;
      }
      case "run.snapshot":
        run.flush();
        for (const item of itemsOf(d.items))
          run.setItem(item.itemId, item.text);
        if (str(d.threadId)) run.threadId = str(d.threadId);
        if (str(d.turnId)) run.turnId = str(d.turnId);
        return null;
      case "retrying":
        run.setPhase("retrying");
        return null;
      case "usage": {
        const usage = usageOf(d.last);
        if (usage) {
          run.usage = usage;
          run.broadcast({ type: "usage", data: usage });
        }
        return null;
      }
      case "run.completed":
        return this.outcomeOf(run, d, client);
      default:
        return null;
    }
  }

  private async outcomeOf(
    run: LiveRun,
    d: Record<string, unknown>,
    client: RuntimeClient,
  ): Promise<Settlement> {
    const status =
      d.status === "completed" || d.status === "stopped" ? d.status : "failed";
    const error = errorOf(d.error);
    const items = itemsOf(d.items);
    const base = {
      items,
      usage:
        usageOf((d.usage as Record<string, unknown> | null)?.last) ?? run.usage,
      threadId: str(d.threadId) ?? run.threadId,
      turnId: str(d.turnId) ?? run.turnId,
      firstTextAt: run.firstTextAt,
    };
    if (status === "failed" && d.delivery === "unknown") {
      // The turn may have run anyway; its saved history decides.
      const known = await this.fromHistory(run, client).catch(() => null);
      if (known && known.status === "completed") return known;
    }
    if (status === "failed" && d.delivery === "none" && !error)
      return { ...base, status, error: NOT_SENT, threadLost: false };
    return {
      ...base,
      status,
      error: status === "failed" ? (error ?? RUNTIME_FAILED) : null,
      threadLost: error?.code === "THREAD_LOST",
    };
  }

  // The run's message in the runtime's saved history, or null when the
  // runtime has no trace of it (nothing ran; posting is safe).
  private async fromHistory(
    run: LiveRun,
    client: RuntimeClient,
  ): Promise<Settlement | null> {
    let turns;
    try {
      turns = await client.history(run.dispatch.ref);
    } catch (error) {
      // No thread was ever created: a first message that never started.
      if (error instanceof AdapterRefusal && error.code === "THREAD_LOST")
        return run.dispatch.body.threadId
          ? failed(run, THREAD_LOST, true)
          : null;
      throw error;
    }
    const turn = turns.find(
      (t) => t.clientMessageId === run.dispatch.body.input.clientMessageId,
    );
    if (!turn) return null;
    const items = [...run.items].map(([itemId, text]) => ({ itemId, text }));
    const base = {
      usage: run.usage,
      threadId: run.threadId,
      turnId: turn.turnId,
      firstTextAt: run.firstTextAt,
      threadLost: false,
    };
    if (turn.status === "completed")
      return {
        ...base,
        status: "completed",
        error: null,
        items: [{ itemId: `history:${turn.turnId}`, text: turn.text }],
      };
    if (turn.status === "interrupted")
      return { ...base, status: "stopped", error: null, items };
    return { ...base, status: "failed", error: RUNTIME_FAILED, items };
  }

  private async finish(run: LiveRun, outcome: Settlement): Promise<void> {
    run.flush();
    run.completed = {
      status: outcome.status,
      error: outcome.error,
      items: outcome.items.map(({ itemId, text }) => ({ itemId, text })),
      usage: outcome.usage,
    };
    run.broadcast({ type: "completed", data: run.completed });
    const { dbName, chatId, runId, replySeq } = run.dispatch;
    // The chat's thread is recorded before the chat is released, so the
    // next message continues it.
    await run.acceptedWrite;
    const saved = await this.store.settleWithRetry(
      dbName,
      chatId,
      runId,
      replySeq,
      outcome,
    );
    if (saved) {
      run.saved = saved;
      run.broadcast({ type: "saved", data: saved });
    } else {
      run.saveFailed = true;
      this.abandoned.add(run.id);
      run.broadcast({ type: "save_failed", data: {} });
    }
    run.phase = "settled";
    run.close();
    const timer = setTimeout(() => {
      if (this.live.get(run.id) === run) this.live.delete(run.id);
    }, SETTLED_TTL_MS);
    timer.unref();
  }

  // Lets live runs finish for up to `drainMs`, then detaches from the rest.
  // Their turns keep running in the runtime; the next process recovers
  // them once their leases lapse.
  async drain(drainMs = 30_000): Promise<void> {
    this.draining = true;
    const pending = [...this.live.values()].map((run) => run.done);
    await Promise.race([Promise.allSettled(pending), sleep(drainMs)]);
    for (const run of this.live.values()) {
      run.abort.abort();
      run.close();
    }
    await Promise.allSettled([...this.live.values()].map((run) => run.done));
    this.live.clear();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }
}

function failed(
  run: LiveRun,
  error: RunErrorInfo,
  threadLost = false,
): Settlement {
  return {
    status: "failed",
    error,
    items: [...run.items].map(([itemId, text]) => ({ itemId, text })),
    usage: run.usage,
    threadId: run.threadId,
    turnId: run.turnId,
    firstTextAt: run.firstTextAt,
    threadLost,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

function itemsOf(value: unknown): Array<{ itemId: string; text: string }> {
  if (!Array.isArray(value)) return [];
  const items: Array<{ itemId: string; text: string }> = [];
  for (const item of value as Array<Record<string, unknown>>) {
    const itemId = str(item?.itemId);
    if (itemId && typeof item.text === "string")
      items.push({ itemId, text: item.text });
  }
  return items;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function usageOf(value: unknown): RunUsage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  return {
    input: count(u.inputTokens),
    cached: count(u.cachedInputTokens),
    cacheWrite: count(u.cacheWriteInputTokens),
    output: count(u.outputTokens),
    reasoning: count(u.reasoningOutputTokens),
  };
}

// What members see for each runtime failure. Messages are the platform's
// own, never text from the adapter or a provider.
const RUN_ERRORS: Record<string, Omit<RunErrorInfo, "code">> = {
  MODEL_TIMEOUT: {
    message: "The model didn't respond in time. Try again.",
    retryable: true,
  },
  CONTEXT_FULL: {
    message: "This conversation is too long for the model. Start a new chat.",
    retryable: false,
  },
  RATE_LIMITED: {
    message: "The model is rate limited right now. Try again shortly.",
    retryable: true,
  },
  PROVIDER_ERROR: {
    message: "The model provider returned an error. Try again.",
    retryable: true,
  },
  RUNTIME_ERROR: {
    message: "The assistant stopped unexpectedly. Try again.",
    retryable: true,
  },
  RUNTIME_SHUTDOWN: {
    message: "The assistant restarted before finishing. Try again.",
    retryable: true,
  },
  THREAD_LOST: { message: THREAD_LOST.message, retryable: false },
  THREAD_MISMATCH: {
    message: "This conversation can't continue here. Start a new chat.",
    retryable: false,
  },
};

function errorOf(value: unknown): RunErrorInfo | null {
  if (!value || typeof value !== "object") return null;
  const code = str((value as Record<string, unknown>).code);
  const known = code ? RUN_ERRORS[code] : undefined;
  return code && known ? { code, ...known } : RUNTIME_FAILED;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
