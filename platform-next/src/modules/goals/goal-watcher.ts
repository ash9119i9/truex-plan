import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ObjectId } from "mongodb";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DatabaseService } from "../../database/database.service";
import { toWireId } from "../../database/object-id";
import {
  CHATS_COLLECTION,
  RUNS_COLLECTION,
  type ChatDoc,
  type RunDoc,
} from "../chats/chat";
import { ChatsService } from "../chats/chats.service";
import { RECOVERY_SWEEP_MS } from "../chats/recovery-sweep";
import {
  RUNTIME_CLIENT,
  RunExecutor,
  type GoalUpdateSource,
} from "../chats/run-executor";
import {
  AdapterRefusal,
  type ChatCursor,
  type ChatEvent,
  type ChatRef,
  type GoalOrigin,
  type GoalUpdate,
  type RuntimeClient,
  type RuntimeGoal,
} from "../chats/runtime-client";
import { TenantsService } from "../tenants/tenants.service";
import { GOAL_WATCH_RENEW_MS, type GoalDoc, type GoalPosition } from "./goal";
import { GoalStore } from "./goal-store";

// The run ID the adapter gives a goal turn (runtime-adapter contract,
// goalRunId): the first 24 hex characters of sha256("threadId:turnId").
export function goalRunId(threadId: string, turnId: string): ObjectId {
  return ObjectId.createFromHexString(
    createHash("sha256")
      .update(`${threadId}:${turnId}`)
      .digest("hex")
      .slice(0, 24),
  );
}

// A goal run waits this long between tries while another run holds the chat.
const BUSY_RETRY_MS = 200;
// Stream failures in a row before the watch is handed back to the sweep.
const MAX_STREAM_FAILURES = 5;
// Lapsed watches one sweep takes per tenant.
const SWEEP_LIMIT = 100;

type Tenant = { readonly tenantId: ObjectId; readonly dbName: string };
type Step = "next" | "stop" | "aborted";

interface Reader {
  readonly controller: AbortController;
  done: Promise<void>;
}

// Reads the adapter chat stream of every chat whose goal is active, so goal
// turns are saved with no browser attached (tasks/goal-mode-plan.md). One
// process reads a chat at a time, under the goal's watch lease (GoalStore):
//   run.started   begins the goal run (ChatsService.beginGoalRun), in order;
//                 the cursor moves past it only once it is saved
//   goal.updated  is recorded (GoalStore.recordUpdate); a goal no longer
//                 active ends the watch
//   chat.snapshot means events were missed: the goal is recorded, goal
//                 turns nobody saved are begun from the chat's history, then
//                 the turn in progress
// The sweep takes over lapsed watches. A goal Codex still reports active is
// resumed with the chat's run context, after the stream is read, since a
// resume continues the goal by itself (Task 1, finding 9).
@Injectable()
export class GoalWatcher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger("GoalWatcher");
  // This process, as the owner of the watches it holds.
  readonly owner = randomBytes(12).toString("hex");
  // How often a held watch is renewed; tests shorten it.
  renewMs = GOAL_WATCH_RENEW_MS;
  private readonly readers = new Map<string, Reader>();
  // Aborted on shutdown; waits outside a reader stop with it.
  private readonly shutdown = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RUNTIME_CLIENT) private readonly client: RuntimeClient | null,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(RunExecutor) private readonly executor: RunExecutor,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(GoalStore) private readonly store: GoalStore,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.client || !this.executor.configured) return;
    this.executor.onGoalUpdate((at, update) => void this.fromRun(at, update));
    const every = this.config.chat?.recoverySweepMs ?? RECOVERY_SWEEP_MS;
    if (every <= 0) return;
    this.timer = setInterval(() => void this.runOnce(), every);
    this.timer.unref();
  }

  // Stops every reader; each gives its watch back, keeping the cursor.
  async onApplicationShutdown(): Promise<void> {
    this.shutdown.abort();
    clearInterval(this.timer);
    this.timer = undefined;
    const readers = [...this.readers.values()];
    for (const reader of readers) reader.controller.abort();
    await Promise.allSettled(readers.map((reader) => reader.done));
  }

  isReading(dbName: string, chatId: ObjectId): boolean {
    return this.readers.has(keyOf(dbName, chatId));
  }

  // Starts reading the chat's stream unless another process holds its
  // watch. Resolves whether this process now reads it.
  async watch(tenant: Tenant, chatId: ObjectId): Promise<boolean> {
    if (!this.client || this.shutdown.signal.aborted) return false;
    if (this.isReading(tenant.dbName, chatId)) return true;
    const claimed = await this.store.claimWatch(
      tenant.dbName,
      chatId,
      this.owner,
    );
    if (!claimed) return false;
    // Only a goal saved as active is read. A replayed, older update (a
    // recovered run's stream) is not applied, so its goal is not read for
    // events that will never come.
    if (claimed.goal.status !== "active") {
      await this.release(tenant, chatId);
      return false;
    }
    // A concurrent watch() in this process may have started it meanwhile.
    if (!this.isReading(tenant.dbName, chatId)) this.read(tenant, claimed);
    return true;
  }

  // One sweep; a call while one runs joins it. Returns how many lapsed
  // watches it looked at. Never throws.
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async sweep(): Promise<number> {
    if (
      !this.client ||
      !this.executor.configured ||
      this.executor.isDraining ||
      this.shutdown.signal.aborted
    )
      return 0;
    let tenants;
    try {
      tenants = await this.tenants.listReady();
    } catch (error) {
      this.logger.warn({
        message: "goal sweep could not list tenants",
        error: errorName(error),
      });
      return 0;
    }
    let found = 0;
    for (const { _id: tenantId, dbName } of tenants) {
      if (this.shutdown.signal.aborted) break;
      // Slot counts left wrong by a crash (repairSlots); a failure here
      // still lets the tenant's lapsed watches be taken over.
      await this.store.repairSlots(dbName, tenantId).catch((error: unknown) =>
        this.logger.warn({
          message: "goal slot repair failed for a tenant",
          tenantId: toWireId(tenantId),
          error: errorName(error),
        }),
      );
      try {
        const lapsed = await this.store.lapsedWatches(
          dbName,
          new Date(),
          SWEEP_LIMIT,
        );
        for (const goal of lapsed) {
          if (this.shutdown.signal.aborted) break;
          found++;
          await this.reconcile({ tenantId, dbName }, goal.chatId).catch(
            (error: unknown) =>
              this.logger.warn({
                message: "goal sweep failed for a chat",
                chatId: toWireId(goal.chatId),
                error: errorName(error),
              }),
          );
        }
      } catch (error) {
        this.logger.warn({
          message: "goal sweep failed for a tenant",
          tenantId: toWireId(tenantId),
          error: errorName(error),
        });
      }
    }
    if (found > 0)
      this.logger.log({ message: "goal sweep took over watches", found });
    return found;
  }

  // A lapsed watch: what Codex reports decides. An active goal is read and
  // resumed; any other goal has its unsaved turns saved, then is recorded.
  private async reconcile(tenant: Tenant, chatId: ObjectId): Promise<void> {
    if (this.isReading(tenant.dbName, chatId)) return;
    const claimed = await this.store.claimWatch(
      tenant.dbName,
      chatId,
      this.owner,
    );
    if (!claimed) return;
    const ref = refOf(tenant, chatId);
    const chat = { chatId, ownerId: claimed.ownerId };
    let goal: RuntimeGoal | null;
    try {
      goal = await this.client!.getGoal(ref);
    } catch (error) {
      await this.release(tenant, chatId);
      throw error;
    }
    if (goal?.status !== "active") {
      try {
        // Turns that ran while no process read the chat.
        await this.backfill(tenant, ref, chatId, this.shutdown.signal);
        if (goal) await this.record(tenant, chat, goal, claimed.origin, null);
      } finally {
        await this.release(tenant, chatId);
      }
      return;
    }
    // Read first: the resume can start a goal turn at once.
    const reader = this.read(tenant, claimed);
    if (!(await this.resume(tenant, ref, chatId))) {
      // Given back with its cursor; the next sweep tries again.
      reader.controller.abort();
      await reader.done;
    }
  }

  // Resumes the chat's thread so Codex continues the goal. A run already
  // going (CHAT_BUSY) means the thread is loaded and the goal runs.
  private async resume(
    tenant: Tenant,
    ref: ChatRef,
    chatId: ObjectId,
  ): Promise<boolean> {
    try {
      const chat = await this.chatsOf(tenant).findOne(
        { _id: chatId },
        { projection: { goals: 1 } },
      );
      const run = chat?.goals
        ? await this.chats.goalRunContext(tenant, chatId)
        : null;
      if (!chat?.goals || !run) {
        this.logger.warn({
          message: "goal could not be resumed: the chat cannot run",
          chatId: toWireId(chatId),
        });
        return false;
      }
      await this.client!.setGoal(ref, {
        goals: { maxTokenBudget: chat.goals.maxTokenBudget },
        status: "active",
        run,
      });
      return true;
    } catch (error) {
      if (error instanceof AdapterRefusal && error.code === "CHAT_BUSY")
        return true;
      this.logger.warn({
        message: "goal could not be resumed",
        chatId: toWireId(chatId),
        error: errorName(error),
      });
      return false;
    }
  }

  // A goal update seen on a run's stream: recorded, and an active goal is
  // watched. Never throws into the run.
  private async fromRun(
    at: GoalUpdateSource,
    update: GoalUpdate,
  ): Promise<void> {
    try {
      const tenant = { tenantId: at.tenantId, dbName: at.dbName };
      const { applied, goal } = await this.store.recordUpdate(
        tenant.dbName,
        tenant.tenantId,
        { chatId: at.chatId, ownerId: at.ownerId },
        { goal: update.goal, origin: update.origin, position: null },
      );
      // The member ended goal mode in this chat: a goal the model creates
      // later is cleared, not shown.
      if (!applied && goal?.ended) {
        if (update.origin === "model")
          await this.client!.clearGoal(refOf(tenant, at.chatId));
        return;
      }
      if (update.goal.status === "active") await this.watch(tenant, at.chatId);
    } catch (error) {
      this.logger.warn({
        message: "goal update from a run could not be recorded",
        chatId: toWireId(at.chatId),
        error: errorName(error),
      });
    }
  }

  private read(tenant: Tenant, claimed: GoalDoc): Reader {
    const key = keyOf(tenant.dbName, claimed.chatId);
    const reader: Reader = {
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.readers.set(key, reader);
    reader.done = this.loop(tenant, claimed, reader.controller)
      .catch((error: unknown) =>
        this.logger.warn({
          message: "goal watch failed",
          chatId: toWireId(claimed.chatId),
          error: errorName(error),
        }),
      )
      .finally(() => {
        if (this.readers.get(key) === reader) this.readers.delete(key);
      });
    return reader;
  }

  // Reads the chat stream from the saved cursor until the goal is no longer
  // active, the watch is lost, or it is stopped; then gives the watch back
  // unless another process took it.
  private async loop(
    tenant: Tenant,
    claimed: GoalDoc,
    controller: AbortController,
  ): Promise<void> {
    const { signal } = controller;
    const { chatId } = claimed;
    const ref = refOf(tenant, chatId);
    const chat = { chatId, ownerId: claimed.ownerId };
    let cursor: ChatCursor | null = claimed.watch?.cursor ?? null;
    let lost = false;
    const renew = setInterval(() => {
      this.store.renewWatch(tenant.dbName, chatId, this.owner).then(
        (held) => {
          if (held) return;
          lost = true;
          controller.abort();
        },
        () => undefined,
      );
    }, this.renewMs);
    let failures = 0;
    try {
      while (!signal.aborted) {
        try {
          for await (const event of this.client!.chatEvents(
            ref,
            cursor,
            signal,
          )) {
            failures = 0;
            const at = positionOf(event, cursor);
            if (!at) continue;
            const step = await this.handle(
              tenant,
              ref,
              chat,
              event,
              at,
              signal,
            );
            if (step === "aborted") break;
            cursor = at;
            if (
              !(await this.store.saveCursor(
                tenant.dbName,
                chatId,
                this.owner,
                at,
              ))
            ) {
              lost = true;
              return;
            }
            if (step === "stop") return;
          }
        } catch (error) {
          if (signal.aborted) break;
          if (++failures >= MAX_STREAM_FAILURES) {
            this.logger.warn({
              message: "goal watch gave up on the chat stream",
              chatId: toWireId(chatId),
              error: errorName(error),
            });
            return;
          }
        }
        // The stream ended or failed: reconnect from the cursor.
        await sleep(200 * (failures + 1), undefined, { signal }).catch(
          () => undefined,
        );
      }
    } finally {
      clearInterval(renew);
      if (!lost) await this.release(tenant, chatId);
    }
  }

  private async handle(
    tenant: Tenant,
    ref: ChatRef,
    chat: { chatId: ObjectId; ownerId: ObjectId },
    event: ChatEvent,
    at: GoalPosition,
    signal: AbortSignal,
  ): Promise<Step> {
    switch (event.type) {
      case "chat.snapshot": {
        if (event.goal)
          await this.record(
            tenant,
            chat,
            event.goal,
            event.origin ?? "user",
            at,
          );
        const filled = await this.backfill(tenant, ref, chat.chatId, signal);
        if (filled !== "next") return filled;
        const run = event.activeRun;
        if (run?.trigger === "goal" && run.turnId) {
          const begun = await this.begin(
            tenant,
            chat.chatId,
            run.runId,
            run.turnId,
            signal,
          );
          if (begun !== "next") return begun;
        }
        return event.goal?.status === "active" ? "next" : "stop";
      }
      case "run.started":
        return this.begin(
          tenant,
          chat.chatId,
          event.runId,
          event.turnId,
          signal,
        );
      case "goal.updated": {
        const saved = await this.record(
          tenant,
          chat,
          event.goal,
          event.origin,
          at,
        );
        if (event.goal.status === "active") return "next";
        // A replayed update can be older than the goal saved since (a
        // member's resume, recorded from the adapter's answer), and Codex
        // times are whole seconds, so only Codex's current goal ends the
        // watch.
        const now = await this.client!.getGoal(ref);
        if (now)
          await this.record(
            tenant,
            chat,
            now,
            saved?.origin ?? event.origin,
            null,
          );
        if (now?.status === "active") return "next";
        // Codex can be ahead of the stream: turns it ran after this update
        // are announced in events this watch will not read, so they are
        // saved from the chat's history before it ends.
        const filled = await this.backfill(tenant, ref, chat.chatId, signal);
        return filled === "next" ? "stop" : filled;
      }
      case "goal.cleared":
        return "stop";
    }
  }

  // Begins the goal run, waiting while another run holds the chat, so goal
  // turns are saved in the order Codex ran them.
  private async begin(
    tenant: Tenant,
    chatId: ObjectId,
    runId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<Step> {
    const id = ObjectId.createFromHexString(runId);
    for (;;) {
      if (signal.aborted) return "aborted";
      const answer = await this.chats.beginGoalRun(tenant, chatId, id, turnId);
      // Announced once, by the process that saved it; a browser that missed
      // it finds the run in its next snapshot (activeRunId).
      if (answer === "started")
        this.store.publish(tenant.dbName, chatId, {
          type: "run.started",
          runId,
          turnId,
        });
      if (answer === "started" || answer === "exists") return "next";
      if (answer === "unavailable") return "stop";
      await sleep(BUSY_RETRY_MS, undefined, { signal }).catch(() => undefined);
    }
  }

  // Goal turns in the chat's history that no run saved, begun oldest first.
  // A goal turn has no member message (clientMessageId null); every member
  // turn carries one, and a saved run of any kind names its turn.
  private async backfill(
    tenant: Tenant,
    ref: ChatRef,
    chatId: ObjectId,
    signal: AbortSignal,
  ): Promise<Step> {
    const chat = await this.chatsOf(tenant).findOne(
      { _id: chatId },
      { projection: { runtime: 1 } },
    );
    const threadId = chat?.runtime.threadId;
    if (!threadId) return "next";
    const turns = await this.client!.history(ref);
    const runs = await this.database
      .tenantDb(tenant.dbName)
      .collection<RunDoc>(RUNS_COLLECTION)
      .find(
        { chatId, turnId: { $exists: true } },
        { projection: { turnId: 1 } },
      )
      .toArray();
    const saved = new Set(runs.map((run) => run.turnId));
    // Codex lists a thread's turns newest first (thread/turns/list's
    // default), so they are walked from the end.
    for (const turn of [...turns].reverse()) {
      if (turn.clientMessageId !== null || saved.has(turn.turnId)) continue;
      const begun = await this.begin(
        tenant,
        chatId,
        toWireId(goalRunId(threadId, turn.turnId)),
        turn.turnId,
        signal,
      );
      if (begun !== "next") return begun;
    }
    return "next";
  }

  private async record(
    tenant: Tenant,
    chat: { chatId: ObjectId; ownerId: ObjectId },
    goal: RuntimeGoal,
    origin: GoalOrigin,
    position: GoalPosition | null,
  ): Promise<GoalDoc | null> {
    const { goal: saved } = await this.store.recordUpdate(
      tenant.dbName,
      tenant.tenantId,
      chat,
      { goal, origin, position },
    );
    return saved;
  }

  private async release(tenant: Tenant, chatId: ObjectId): Promise<void> {
    await this.store
      .releaseWatch(tenant.dbName, chatId, this.owner)
      .catch(() => undefined);
  }

  private chatsOf(tenant: Tenant) {
    return this.database
      .tenantDb(tenant.dbName)
      .collection<ChatDoc>(CHATS_COLLECTION);
  }
}

function keyOf(dbName: string, chatId: ObjectId): string {
  return `${dbName}:${chatId.toHexString()}`;
}

function refOf(tenant: Tenant, chatId: ObjectId): ChatRef {
  return { tenantId: toWireId(tenant.tenantId), chatId: toWireId(chatId) };
}

// The stream position an event is at: a snapshot starts a stream's
// numbering, later events follow it. Null before the first snapshot.
function positionOf(
  event: ChatEvent,
  cursor: ChatCursor | null,
): ChatCursor | null {
  if (event.type === "chat.snapshot")
    return { streamId: event.streamId, seq: event.seq };
  return cursor && { streamId: cursor.streamId, seq: event.seq };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
