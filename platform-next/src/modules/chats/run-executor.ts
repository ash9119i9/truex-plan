import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import type { ObjectId } from "mongodb";
import { detached } from "../../common/http/server-timing";
import { toWireId } from "../../database/object-id";
import {
  APPROVAL_DECISIONS,
  type ApprovalAnswer,
  type ApprovalDecision,
  type RunErrorInfo,
  type RunUsage,
} from "./chat";
import {
  ChatStore,
  LEASE_RENEW_MS,
  type SettleItem,
  type SettleResult,
  type Settlement,
  type ToolSettleItem,
} from "./chat-store";
import { ConnectorsService } from "../connectors/connectors.service";
import {
  AdapterRefusal,
  AdapterUnreachable,
  RuntimeClient,
  type AdapterEvent,
  type ChatRef,
  type HistoryTurn,
  type StartRunBody,
} from "./runtime-client";

export const RUNTIME_CLIENT = Symbol("RUNTIME_CLIENT");

// What a run tells the connectors module: a connector's server refused the
// chat owner's token, so the next run refreshes it or asks to reconnect.
export interface ConnectorFeedback {
  tokenRejected(dbName: string, userId: ObjectId, slug: string): Promise<void>;
}

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
  | { type: "input"; data: { clientMessageId: string } }
  | { type: "tool"; data: ToolEventData }
  | { type: "connector"; data: ConnectorEventData }
  | { type: "approval"; data: ApprovalEventData }
  | { type: "usage"; data: RunUsage }
  | { type: "completed"; data: Completed }
  | { type: "saved"; data: SettleResult }
  | { type: "save_failed"; data: Record<string, never> };

// A connector tool call starting or finishing. Never arguments or results.
export interface ToolEventData {
  itemId: string;
  connector: string;
  tool: string;
  status: ToolSettleItem["status"];
  durationMs?: number;
  errorCode?: string;
  approval?: ApprovalDecision;
}

// A write-tool call waiting for the member (`status: "pending"`, with
// `expiresAt`), or how its approval ended (`auto` when an earlier Allow for
// this chat answered it). `params` are what the card shows: model-written,
// bounded by the adapter and re-bounded here, rendered as plain text.
export interface ApprovalEventData {
  approvalId: string;
  itemId: string;
  connector: string;
  tool: string;
  params: Array<{ name: string; value: string }>;
  status: "pending" | ApprovalDecision;
  expiresAt?: string;
  auto?: boolean;
}

// What a member's answer to an approval came to.
export type ApprovalOutcome = "answered" | "resolved" | "not_found";

// A connector's server starting, ready or failed for this run.
export interface ConnectorEventData {
  connector: string;
  status: "starting" | "ready" | "failed";
  reason?: "auth" | "unreachable" | "unknown";
}

// Replies, tool calls and steers in the runtime's order (see SettleItem).
export interface Snapshot {
  runId: string;
  phase: Phase;
  items: SettleItem[];
  usage: RunUsage | null;
  // Approvals still waiting for the member, so a reconnecting browser shows
  // their cards.
  approvals: ApprovalEventData[];
}

export interface Completed {
  status: Settlement["status"];
  error: RunErrorInfo | null;
  items: SettleItem[];
  usage: RunUsage | null;
}

// What became of a steer sent to the runtime.
//   queued: the runtime took it into the running turn
//   unknown: it went out and the answer was lost; settle shows if it was used
//   ended: the turn had ended or was stopping; nothing was delivered
//   not_found: the runtime does not know the run
//   limit / refused: refused; nothing was delivered
export type SteerOutcome =
  "queued" | "unknown" | "ended" | "not_found" | "limit" | "refused";

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
// How long a steer waits for the runtime to accept a run this process just
// started, so it does not arrive before the run exists there.
const STEER_ACCEPT_WAIT_MS = 20_000;
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

type OrderEntry =
  | { type: "reply"; itemId: string }
  | { type: "tool"; itemId: string }
  | { type: "input"; clientMessageId: string };

// The tool error codes the adapter sends (slice 3 contract); anything else
// is saved as UNKNOWN so no free text reaches a message.
const TOOL_ERROR_CODES = new Set([
  "REFUSED",
  "DENIED",
  "TOOL_ERROR",
  "TIMEOUT",
  "UNKNOWN",
]);

class LiveRun {
  phase: Phase = "waiting";
  // Text already sent to subscribers, per reply.
  readonly items = new Map<string, string>();
  // Replies and steers in the runtime's order. A reply is placed when its
  // first text arrives, so an empty one never appears.
  private readonly order: OrderEntry[] = [];
  private readonly completedItems = new Set<string>();
  private readonly inputs = new Set<string>();
  private readonly pending = new Map<string, string>();
  // Tool calls by item, placed in `order` when first seen.
  private readonly tools = new Map<string, ToolSettleItem>();
  // Approvals waiting for the member, by approvalId, and the ones that ended
  // (so a replayed request never reopens a card).
  private readonly approvals = new Map<string, ApprovalEventData>();
  private readonly resolvedApprovals = new Set<string>();
  // Connectors already reported as refusing the token, once per run.
  readonly authReported = new Set<string>();
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
  // Resolve when the runtime accepts the run, and when this process stops
  // holding it (settled or released).
  private markAccepted!: () => void;
  readonly acceptedOrClosed = new Promise<void>(
    (resolve) => (this.markAccepted = resolve),
  );
  private markClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => (this.markClosed = resolve));

  constructor(readonly dispatch: Dispatch) {}

  get id(): string {
    return toWireId(this.dispatch.runId);
  }

  snapshot(): Snapshot {
    return {
      runId: this.id,
      phase: this.phase,
      items: this.settleItems(),
      usage: this.usage,
      approvals: [...this.approvals.values()],
    };
  }

  // What was sent to subscribers, in order. Call flush() first to include
  // pending text.
  settleItems(): SettleItem[] {
    return this.order.map((entry): SettleItem => {
      if (entry.type === "input") return entry;
      if (entry.type === "tool") return this.tools.get(entry.itemId)!;
      return {
        type: "reply",
        itemId: entry.itemId,
        text: this.items.get(entry.itemId) ?? "",
        completed: this.completedItems.has(entry.itemId),
      };
    });
  }

  hasInput(clientMessageId: string): boolean {
    return this.inputs.has(clientMessageId);
  }

  // The last reply, when the runtime never finished it.
  trailingPartial(): SettleItem | null {
    const last = this.settleItems().at(-1);
    return last?.type === "reply" && !last.completed && last.text ? last : null;
  }

  accept(): void {
    this.accepted = true;
    this.markAccepted();
  }

  // A steer entered the turn at this point. Once per steer.
  addInput(clientMessageId: string): void {
    if (this.inputs.has(clientMessageId)) return;
    this.flush();
    this.inputs.add(clientMessageId);
    this.order.push({ type: "input", clientMessageId });
    this.broadcast({ type: "input", data: { clientMessageId } });
  }

  // A tool call started or finished. Placed in stream order when first seen;
  // a finished call never goes back to in progress (a reconnect snapshot
  // can carry an older state).
  setTool(item: ToolSettleItem): void {
    const before = this.tools.get(item.itemId);
    if (before && before.status !== "inProgress") return;
    if (before && item.status === "inProgress") return;
    if (!before) {
      this.flush();
      this.order.push({ type: "tool", itemId: item.itemId });
    }
    // A finished call's event does not repeat its approval; keep it.
    const merged =
      before?.approval && !item.approval
        ? { ...item, approval: before.approval }
        : item;
    this.tools.set(item.itemId, merged);
    const { type: _type, ...data } = merged;
    this.broadcast({ type: "tool", data });
  }

  // A write-tool call is waiting for the member. Ignored once it ended.
  requestApproval(approval: ApprovalEventData): void {
    if (this.resolvedApprovals.has(approval.approvalId)) return;
    const before = this.approvals.get(approval.approvalId);
    this.approvals.set(approval.approvalId, approval);
    if (!before) this.broadcast({ type: "approval", data: approval });
  }

  // An approval ended. Returns false when this run already saw it end, so
  // its audit record and chat allow are written once per reader.
  resolveApproval(approval: ApprovalEventData): boolean {
    if (this.resolvedApprovals.has(approval.approvalId)) return false;
    this.resolvedApprovals.add(approval.approvalId);
    this.approvals.delete(approval.approvalId);
    const tool = this.tools.get(approval.itemId);
    if (tool && approval.status !== "pending")
      this.tools.set(approval.itemId, { ...tool, approval: approval.status });
    this.broadcast({ type: "approval", data: approval });
    return true;
  }

  // Pending approvals the runtime no longer has (a reconnect snapshot
  // replaced the event stream, so their approval.resolved was missed). Their
  // cards close; the tool's own outcome carries how they ended. No audit
  // record is written for these: who answered is not known here.
  closeApprovalsNotIn(pending: ReadonlySet<string>): void {
    for (const [approvalId, approval] of [...this.approvals]) {
      if (pending.has(approvalId)) continue;
      const { expiresAt: _expiresAt, ...rest } = approval;
      const decision = this.tools.get(approval.itemId)?.approval ?? "cancelled";
      this.resolveApproval({ ...rest, status: decision });
    }
  }

  private place(itemId: string): void {
    if (!this.items.has(itemId) && !this.pending.has(itemId))
      this.order.push({ type: "reply", itemId });
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
    this.place(itemId);
    this.pending.set(itemId, (this.pending.get(itemId) ?? "") + delta);
    if (this.phase === "waiting" || this.phase === "retrying")
      this.setPhase("streaming");
    if (first) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), DELTA_FLUSH_MS);
  }

  // Replaces a reply's text when the runtime reports it: whole when
  // completed, or so far (a reconnect snapshot).
  setItem(itemId: string, text: string, completed = true): void {
    if (!text && !this.items.has(itemId) && !this.pending.has(itemId)) return;
    this.place(itemId);
    this.pending.delete(itemId);
    const before = this.items.get(itemId);
    const wasCompleted = this.completedItems.has(itemId);
    if (completed) this.completedItems.add(itemId);
    if (before === text && wasCompleted === completed) return;
    this.items.set(itemId, text);
    // `item` tells a browser the reply is finished; text so far that only
    // extends what it has goes out as a delta.
    if (!completed && before !== undefined && text.startsWith(before)) {
      if (text.length > before.length)
        for (const subscriber of this.subscribers)
          subscriber.send({
            type: "delta",
            data: { itemId, text: text.slice(before.length) },
          });
      return;
    }
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
    this.markAccepted();
    this.markClosed();
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
    @Optional()
    @Inject(ConnectorsService)
    private readonly connectors: ConnectorFeedback | null = null,
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

  // Sends a steer to the runtime. A run this process started and the
  // runtime has not accepted yet is waited for (bounded) first, so the steer
  // does not arrive before the run exists there. A recovered run already
  // exists there, or never will.
  async steer(
    runId: ObjectId,
    ref: ChatRef,
    input: { text: string; clientMessageId: string },
  ): Promise<SteerOutcome> {
    if (!this.client) throw new Error("chat runtime is not configured");
    const id = toWireId(runId);
    const run = this.live.get(id);
    if (
      run?.dispatch.mode === "start" &&
      !run.accepted &&
      run.phase !== "settled"
    )
      await Promise.race([
        run.acceptedOrClosed,
        sleep(STEER_ACCEPT_WAIT_MS, run.abort.signal),
      ]);
    if (run?.phase === "settled") return "ended";
    try {
      await this.client.steer(id, ref, input);
      return "queued";
    } catch (error) {
      if (error instanceof AdapterUnreachable) return "unknown";
      if (!(error instanceof AdapterRefusal)) throw error;
      switch (error.code) {
        case "STEER_UNKNOWN":
          return "unknown";
        case "RUN_ENDED":
          return "ended";
        case "RUN_NOT_FOUND":
          return "not_found";
        case "STEER_LIMIT":
          return "limit";
        default:
          this.logger.warn({
            message: "runtime refused steer",
            runId: id,
            code: error.code,
          });
          return "refused";
      }
    }
  }

  // Sends the member's answer to a pending approval. The runtime holds the
  // approval, so this works whichever process reads the run. First answer
  // wins: a later one is `resolved`; an unknown, expired or finished one is
  // `not_found`. AdapterUnreachable propagates (the caller may retry).
  async answerApproval(
    runId: ObjectId,
    ref: ChatRef,
    approvalId: string,
    decision: ApprovalAnswer,
  ): Promise<ApprovalOutcome> {
    if (!this.client) throw new Error("chat runtime is not configured");
    try {
      await this.client.answerApproval(
        toWireId(runId),
        approvalId,
        ref,
        decision,
      );
      return "answered";
    } catch (error) {
      if (!(error instanceof AdapterRefusal)) throw error;
      if (error.code === "APPROVAL_RESOLVED") return "resolved";
      if (
        error.code === "APPROVAL_NOT_FOUND" ||
        error.code === "RUN_NOT_FOUND" ||
        error.code === "RUN_ENDED"
      )
        return "not_found";
      this.logger.warn({
        message: "runtime refused approval answer",
        runId: toWireId(runId),
        code: error.code,
      });
      throw error;
    }
  }

  // Resolves once this process stops holding the run (saved, save failed or
  // let go), or after `ms`. At once when the run is not live here.
  async waitClosed(runId: ObjectId, ms: number): Promise<void> {
    const run = this.live.get(toWireId(runId));
    if (!run) return;
    await Promise.race([run.closed, sleep(ms)]);
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
        run.accept();
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
      case "input.accepted": {
        const clientMessageId = str(d.clientMessageId);
        if (clientMessageId) run.addInput(clientMessageId);
        return null;
      }
      case "tool.started":
      case "tool.completed": {
        const item = toolOf({
          ...d,
          status:
            event.type === "tool.started"
              ? "inProgress"
              : d.status === "completed"
                ? "completed"
                : "failed",
        });
        if (item) run.setTool(item);
        return null;
      }
      case "connector.status":
        this.connectorStatus(run, d);
        return null;
      case "approval.requested": {
        const approval = approvalOf(d, "pending");
        if (approval) run.requestApproval(approval);
        return null;
      }
      case "approval.resolved": {
        const approval = approvalOf(d, "resolved");
        if (approval && run.resolveApproval(approval))
          this.recordApproval(run, approval);
        return null;
      }
      case "run.snapshot": {
        run.flush();
        for (const item of itemsOf(d.items))
          if (item.type === "input") run.addInput(item.clientMessageId);
          else if (item.type === "tool") run.setTool(item);
          else run.setItem(item.itemId, item.text, item.completed);
        const pending = new Set<string>();
        if (Array.isArray(d.approvals))
          for (const raw of d.approvals as unknown[]) {
            const approval =
              raw && typeof raw === "object"
                ? approvalOf(raw as Record<string, unknown>, "pending")
                : null;
            if (!approval) continue;
            pending.add(approval.approvalId);
            run.requestApproval(approval);
          }
        run.closeApprovalsNotIn(pending);
        if (str(d.threadId)) run.threadId = str(d.threadId);
        if (str(d.turnId)) {
          // A snapshot with a turn replaces a run.accepted no longer buffered.
          run.turnId = str(d.turnId);
          run.accept();
        }
        return null;
      }
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

  // The audit record of a resolved approval and, for the member's own Allow
  // for this chat, the chat allow that later runs send as approvedTools. Not
  // awaited: the reply goes on; a failure is logged (params never are).
  private recordApproval(run: LiveRun, approval: ApprovalEventData): void {
    if (approval.status === "pending") return;
    const { dbName, chatId, runId, ownerId } = run.dispatch;
    const decision = approval.status;
    const writes: Promise<void>[] = [
      this.store.recordApproval(dbName, {
        _id: approval.approvalId,
        chatId,
        runId,
        userId: ownerId,
        connector: approval.connector,
        tool: approval.tool,
        decision,
        auto: approval.auto === true,
        params: approval.params,
        at: new Date(),
      }),
    ];
    if (decision === "allow_for_chat" && approval.auto !== true)
      writes.push(
        this.store.allowToolForChat(
          dbName,
          chatId,
          ownerId,
          approval.connector,
          approval.tool,
        ),
      );
    this.logger.log({
      message: "tool approval resolved",
      runId: run.id,
      connector: approval.connector,
      tool: approval.tool,
      decision,
      auto: approval.auto === true,
    });
    void Promise.all(writes).catch((error: unknown) =>
      this.logger.warn({
        message: "saving a tool approval failed",
        runId: run.id,
        connector: approval.connector,
        tool: approval.tool,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }

  // Relays a connector's state to subscribers. A server that refused the
  // owner's token marks the connection so the next run refreshes it or asks
  // the member to reconnect. Not awaited: the reply goes on without it.
  private connectorStatus(run: LiveRun, d: Record<string, unknown>): void {
    const connector = str(d.connector);
    const status =
      d.status === "starting" || d.status === "ready" || d.status === "failed"
        ? d.status
        : null;
    if (!connector || !status) return;
    const reason =
      status !== "failed"
        ? undefined
        : d.reason === "auth" || d.reason === "unreachable"
          ? d.reason
          : "unknown";
    run.broadcast({
      type: "connector",
      data: { connector, status, ...(reason ? { reason } : {}) },
    });
    if (reason !== "auth" || !this.connectors) return;
    if (run.authReported.has(connector)) return;
    run.authReported.add(connector);
    const { dbName, ownerId } = run.dispatch;
    this.connectors
      .tokenRejected(dbName, ownerId, connector)
      .catch((error: unknown) =>
        this.logger.warn({
          message: "marking a rejected connector token failed",
          runId: run.id,
          connector,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
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
    run.flush();
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
        items: historySettleItems(
          turn,
          run.dispatch.body.input.clientMessageId,
        ),
      };
    const items = unfinishedItems(
      run,
      turn,
      run.dispatch.body.input.clientMessageId,
    );
    if (turn.status === "interrupted")
      return { ...base, status: "stopped", error: null, items };
    return { ...base, status: "failed", error: RUNTIME_FAILED, items };
  }

  private async finish(run: LiveRun, outcome: Settlement): Promise<void> {
    run.flush();
    run.completed = {
      status: outcome.status,
      error: outcome.error,
      items: [...outcome.items],
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
  run.flush();
  return {
    status: "failed",
    error,
    items: run.settleItems(),
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

// A tool call from an adapter event or item, or null when unreadable.
function toolOf(value: Record<string, unknown>): ToolSettleItem | null {
  const itemId = str(value.itemId);
  const connector = str(value.connector);
  const tool = str(value.tool);
  const status =
    value.status === "inProgress" ||
    value.status === "completed" ||
    value.status === "failed"
      ? value.status
      : null;
  if (!itemId || !connector || !tool || !status) return null;
  const durationMs =
    typeof value.durationMs === "number" &&
    Number.isSafeInteger(value.durationMs) &&
    value.durationMs >= 0
      ? value.durationMs
      : undefined;
  const errorCode =
    status === "failed"
      ? typeof value.errorCode === "string" &&
        TOOL_ERROR_CODES.has(value.errorCode)
        ? value.errorCode
        : "UNKNOWN"
      : undefined;
  const approval = APPROVAL_DECISIONS.includes(
    value.approval as ApprovalDecision,
  )
    ? (value.approval as ApprovalDecision)
    : undefined;
  return {
    type: "tool",
    itemId,
    connector,
    tool,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(approval ? { approval } : {}),
  };
}

// At most this many card params, each value cut to this length. The adapter
// bounds them already; this keeps the platform safe on its own.
const MAX_APPROVAL_PARAMS = 12;
const MAX_APPROVAL_PARAM_CHARS = 500;

// An approval from an adapter event (or snapshot entry), or null when
// unreadable. `pending` reads a request; `resolved` needs a known decision.
function approvalOf(
  value: Record<string, unknown>,
  kind: "pending" | "resolved",
): ApprovalEventData | null {
  const approvalId = str(value.approvalId);
  const itemId = str(value.itemId);
  const connector = str(value.connector);
  const tool = str(value.tool);
  if (!approvalId || !itemId || !connector || !tool) return null;
  const params: ApprovalEventData["params"] = [];
  if (Array.isArray(value.params))
    for (const raw of value.params as unknown[]) {
      if (params.length >= MAX_APPROVAL_PARAMS) break;
      const p = raw as { name?: unknown; value?: unknown } | null;
      const name = typeof p?.name === "string" ? p.name.slice(0, 64) : "";
      if (!name || typeof p?.value !== "string") continue;
      params.push({
        name,
        value: p.value.slice(0, MAX_APPROVAL_PARAM_CHARS),
      });
    }
  const base = { approvalId, itemId, connector, tool, params };
  if (kind === "pending") {
    const expiresAt =
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
        ? new Date(value.expiresAt).toISOString()
        : undefined;
    return { ...base, status: "pending", ...(expiresAt ? { expiresAt } : {}) };
  }
  if (!APPROVAL_DECISIONS.includes(value.decision as ApprovalDecision))
    return null;
  return {
    ...base,
    status: value.decision as ApprovalDecision,
    auto: value.auto === true,
  };
}

// The adapter's ordered items: replies `{type: "reply", itemId, text,
// completed}`, tool calls `{type: "tool", …}` and steers `{type: "input",
// clientMessageId}`. An entry with no type is a reply, as an adapter that
// predates steering sends it.
function itemsOf(value: unknown): SettleItem[] {
  if (!Array.isArray(value)) return [];
  const items: SettleItem[] = [];
  for (const item of value as Array<Record<string, unknown> | null>) {
    if (!item) continue;
    if (item.type === "tool") {
      const tool = toolOf(item);
      if (tool) items.push(tool);
      continue;
    }
    if (item.type === "input") {
      const clientMessageId = str(item.clientMessageId);
      if (clientMessageId) items.push({ type: "input", clientMessageId });
      continue;
    }
    const itemId = str(item.itemId);
    if (itemId && typeof item.text === "string")
      items.push({
        type: "reply",
        itemId,
        text: item.text,
        completed: item.completed === true,
      });
  }
  return items;
}

// A finished turn's items from the runtime's saved history, without the
// run's own message. Reply IDs are history:<turnId>:<n>.
function historySettleItems(turn: HistoryTurn, own: string): SettleItem[] {
  if (!turn.items)
    return [
      {
        type: "reply",
        itemId: `history:${turn.turnId}`,
        text: turn.text,
        completed: true,
      },
    ];
  let replies = 0;
  return turn.items.flatMap((item): SettleItem[] => {
    if (item.type === "reply")
      return [
        {
          type: "reply",
          itemId: `history:${turn.turnId}:${replies++}`,
          text: item.text,
          completed: true,
        },
      ];
    return item.clientMessageId && item.clientMessageId !== own
      ? [{ type: "input", clientMessageId: item.clientMessageId }]
      : [];
  });
}

// A stopped or failed turn. The runtime's history drops partial text, so
// what this process streamed is used when it saw every steer the runtime
// used; otherwise the history, plus the reply being written when it ended.
function unfinishedItems(
  run: LiveRun,
  turn: HistoryTurn,
  own: string,
): SettleItem[] {
  const live = run.settleItems();
  if (!turn.items) return live;
  const history = historySettleItems(turn, own);
  const sawAll = history.every(
    (item) => item.type !== "input" || run.hasInput(item.clientMessageId),
  );
  if (sawAll && live.length) return live;
  const partial = run.trailingPartial();
  return partial ? [...history, partial] : history;
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
