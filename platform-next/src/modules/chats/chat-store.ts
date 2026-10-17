import { Inject, Injectable, Logger } from "@nestjs/common";
import { ObjectId, type Collection, type Db } from "mongodb";
import { DatabaseService } from "../../database/database.service";
import {
  CHATS_COLLECTION,
  MESSAGES_COLLECTION,
  RUNS_COLLECTION,
  type ChatDoc,
  type MessageDoc,
  type MessageState,
  type RunDoc,
  type RunErrorInfo,
  type RunStatus,
  type RunUsage,
} from "./chat";

// How long a run stays claimed by the process streaming it without a lease
// renewal. The executor renews every LEASE_RENEW_MS.
export const LEASE_MS = 30_000;
export const LEASE_RENEW_MS = 10_000;
const INDEX_RECHECK_MS = 10 * 60_000;

export interface ChatCollections {
  readonly chats: Collection<ChatDoc>;
  readonly messages: Collection<MessageDoc>;
  readonly runs: Collection<RunDoc>;
}

export interface SettleItem {
  readonly itemId: string;
  readonly text: string;
}

export interface Settlement {
  readonly status: "completed" | "stopped" | "failed";
  readonly error: RunErrorInfo | null;
  readonly items: readonly SettleItem[];
  readonly usage: RunUsage | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly firstTextAt?: Date;
  readonly threadLost: boolean;
}

export interface SettleResult {
  readonly run: RunDoc;
  readonly messages: MessageDoc[];
}

const MESSAGE_STATE: Record<Settlement["status"], MessageState> = {
  completed: "complete",
  stopped: "stopped",
  failed: "failed",
};
const SETTLED: RunStatus[] = ["completed", "stopped", "failed"];

// Collections, indexes and the writes of a run's lifecycle. Every write is
// conditional on the state it expects, so a late or repeated writer (a
// recovered run, a duplicate stream) changes nothing.
@Injectable()
export class ChatStore {
  private readonly logger = new Logger("Chats");
  private readonly indexes = new Map<
    string,
    { ready: Promise<void>; checkedAt: number }
  >();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  collections(dbName: string): ChatCollections {
    const db: Db = this.database.tenantDb(dbName);
    return {
      chats: db.collection<ChatDoc>(CHATS_COLLECTION),
      messages: db.collection<MessageDoc>(MESSAGES_COLLECTION),
      runs: db.collection<RunDoc>(RUNS_COLLECTION),
    };
  }

  // The unique indexes are what make retried sends idempotent, so they are
  // re-checked every INDEX_RECHECK_MS (a dropped or restored collection is
  // repaired) rather than on every send. A failed build is retried at once.
  ensureIndexes(dbName: string): Promise<void> {
    const known = this.indexes.get(dbName);
    if (known && Date.now() - known.checkedAt < INDEX_RECHECK_MS)
      return known.ready;
    const ready = this.createIndexes(dbName).catch((error: unknown) => {
      this.indexes.delete(dbName);
      throw error;
    });
    this.indexes.set(dbName, { ready, checkedAt: Date.now() });
    return ready;
  }

  // Tests drop databases between cases.
  forgetIndexes(): void {
    this.indexes.clear();
  }

  private async createIndexes(dbName: string): Promise<void> {
    const { chats, messages, runs } = this.collections(dbName);
    await Promise.all([
      chats.createIndexes([
        // A retried first send finds the chat it created.
        {
          key: { ownerId: 1, createdByMessageId: 1 },
          name: "owner_first_message_unique",
          unique: true,
        },
        // The sidebar: newest first, cursor-paginated.
        {
          key: { ownerId: 1, status: 1, lastMessageAt: -1, _id: -1 },
          name: "owner_recent",
        },
      ]),
      messages.createIndexes([
        { key: { chatId: 1, seq: 1 }, name: "chat_seq_unique", unique: true },
        {
          key: { chatId: 1, clientMessageId: 1 },
          name: "chat_client_message_unique",
          unique: true,
          partialFilterExpression: { clientMessageId: { $type: "string" } },
        },
        {
          key: { runId: 1, runtimeItemId: 1 },
          name: "run_item_unique",
          unique: true,
          partialFilterExpression: { runtimeItemId: { $type: "string" } },
        },
      ]),
      runs.createIndexes([{ key: { chatId: 1, _id: -1 }, name: "by_chat" }]),
    ]);
  }

  async markAccepted(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    const { chats, runs } = this.collections(dbName);
    const now = new Date();
    await runs.updateOne(
      { _id: runId, status: { $in: ["accepted", "uncertain"] } },
      {
        $set: {
          status: "running",
          threadId,
          turnId,
          "timings.dispatchedAt": now,
          updatedAt: now,
        },
      },
    );
    // The thread is recorded once; a different one is never overwritten.
    await chats.updateOne(
      { _id: chatId, "runtime.threadId": null },
      { $set: { runtime: { threadId, state: "ready" }, updatedAt: now } },
    );
  }

  async renewLease(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
  ): Promise<boolean> {
    const result = await this.collections(dbName).chats.updateOne(
      { _id: chatId, "activeRun.runId": runId },
      { $set: { "activeRun.leaseExpiresAt": new Date(Date.now() + LEASE_MS) } },
    );
    return result.matchedCount === 1;
  }

  async markUncertain(dbName: string, runId: ObjectId): Promise<void> {
    await this.collections(dbName).runs.updateOne(
      { _id: runId, status: { $in: ["accepted", "running"] } },
      { $set: { status: "uncertain", updatedAt: new Date() } },
    );
  }

  async markStopRequested(dbName: string, runId: ObjectId): Promise<void> {
    await this.collections(dbName).runs.updateOne(
      { _id: runId },
      { $set: { stopRequested: true, updatedAt: new Date() } },
    );
  }

  // Saves the outcome, the reply text and releases the chat in one
  // transaction. A run that is already settled is returned as saved: the
  // first writer wins and a repeat changes nothing.
  async settle(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    outcome: Settlement,
  ): Promise<SettleResult> {
    const { chats, messages, runs } = this.collections(dbName);
    const texts = outcome.items.filter((item) => item.text.trim().length > 0);
    return this.database.withTransaction(async (session) => {
      const now = new Date();
      const run = await runs.findOneAndUpdate(
        { _id: runId, status: { $nin: SETTLED } },
        {
          $set: {
            status: outcome.status,
            updatedAt: now,
            "timings.completedAt": now,
            ...(outcome.firstTextAt
              ? { "timings.firstTextAt": outcome.firstTextAt }
              : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
            ...(outcome.usage ? { usage: outcome.usage } : {}),
            ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
            ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
          },
        },
        { returnDocument: "after", session },
      );
      if (!run) {
        const saved = await runs.findOne({ _id: runId }, { session });
        if (!saved) throw new Error("settling a run that does not exist");
        return {
          run: saved,
          messages: await messages
            .find({ runId, role: "assistant" }, { session })
            .sort({ seq: 1 })
            .toArray(),
        };
      }
      const chat = await chats.findOneAndUpdate(
        { _id: chatId },
        {
          $inc: { nextSeq: texts.length },
          $set: {
            updatedAt: now,
            ...(texts.length ? { lastMessageAt: now } : {}),
            ...(outcome.threadLost ? { "runtime.state": "lost" } : {}),
          },
        },
        { returnDocument: "before", session },
      );
      if (!chat) throw new Error("settling a run whose chat does not exist");
      const docs: MessageDoc[] = texts.map((item, index) => ({
        _id: new ObjectId(),
        chatId,
        ownerId: run.ownerId,
        seq: chat.nextSeq + index,
        runId,
        role: "assistant",
        text: item.text,
        state: MESSAGE_STATE[outcome.status],
        runtimeItemId: item.itemId,
        createdAt: now,
      }));
      if (docs.length) await messages.insertMany(docs, { session });
      // Only this run's claim is released; a newer run is never unlocked.
      await chats.updateOne(
        { _id: chatId, "activeRun.runId": runId },
        { $set: { activeRun: null } },
        { session },
      );
      return { run, messages: docs };
    });
  }

  // Delays between settle attempts: backoff to 30 s, about 10 minutes in
  // all. The reader keeps the chat's lease meanwhile; tests shorten this.
  settleRetryDelaysMs: readonly number[] = [
    500,
    1_000,
    2_000,
    4_000,
    8_000,
    15_000,
    ...Array.from({ length: 19 }, () => 30_000),
  ];

  // Retries a settle with backoff. Returns null when every attempt failed;
  // the run then stays claimed until recovery settles it from the runtime's
  // history on the chat's next access.
  async settleWithRetry(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    outcome: Settlement,
  ): Promise<SettleResult | null> {
    const delaysMs = this.settleRetryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.settle(dbName, chatId, runId, outcome);
      } catch (error) {
        const delay = delaysMs[attempt];
        this.logger.warn({
          message: "saving run outcome failed",
          runId: runId.toHexString(),
          attempt: attempt + 1,
          error: error instanceof Error ? error.name : "unknown",
          willRetry: delay !== undefined,
        });
        if (delay === undefined) return null;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
