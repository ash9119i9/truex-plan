import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ObjectId,
  type AnyClientBulkWriteModel,
  type Collection,
  type Db,
  type Document,
} from "mongodb";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
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

// The chat is not in the state an unsettled run implies; aborts the fast
// settle so the general one runs.
class ClaimMoved extends Error {}

// Collections and the writes of a run's lifecycle. Their indexes are built
// when the tenant is provisioned (CHAT_INDEXES). Every write is
// conditional on the state it expects, so a late or repeated writer (a
// recovered run, a duplicate stream) changes nothing.
@Injectable()
export class ChatStore {
  private readonly logger = new Logger("Chats");

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

  // The runtime took the run: both writes in one call. Each is conditional
  // and safe to repeat, so they need no transaction.
  async markAccepted(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    const { chats, runs } = this.collections(dbName);
    const now = new Date();
    await this.database.bulkWrite([
      {
        namespace: runs.namespace,
        name: "updateOne",
        filter: { _id: runId, status: { $in: ["accepted", "uncertain"] } },
        update: {
          $set: {
            status: "running",
            threadId,
            turnId,
            "timings.dispatchedAt": now,
            updatedAt: now,
          },
        },
      },
      {
        namespace: chats.namespace,
        name: "updateOne",
        // The thread is recorded once; a different one is never overwritten.
        filter: { _id: chatId, "runtime.threadId": null },
        update: {
          $set: { runtime: { threadId, state: "ready" }, updatedAt: now },
        },
      },
    ]);
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

  // Takes over a run's claim from a reader that stopped renewing it: only if
  // the lease is still the one read, so of two processes recovering the same
  // run, one wins and the other leaves it.
  async takeOverLease(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    seen: Date,
  ): Promise<boolean> {
    const result = await this.collections(dbName).chats.updateOne(
      {
        _id: chatId,
        "activeRun.runId": runId,
        "activeRun.leaseExpiresAt": seen,
      },
      { $set: { "activeRun.leaseExpiresAt": new Date(Date.now() + LEASE_MS) } },
    );
    return result.matchedCount === 1;
  }

  // Chats in this tenant database whose run's lease lapsed before `now`:
  // the reading process stopped (a crash or restart) or gave the run up.
  // Uses active_lease; at most `limit`, oldest lapse first.
  lapsedChats(dbName: string, now: Date, limit: number): Promise<ChatDoc[]> {
    return this.collections(dbName)
      .chats.find({
        "activeRun.leaseExpiresAt": { $type: "date", $lte: now },
      })
      .sort({ "activeRun.leaseExpiresAt": 1 })
      .limit(limit)
      .toArray();
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
  // transaction: the run, then the chat and the reply in one call, then the
  // commit. An unsettled run holds its chat's claim, and nothing else moves
  // the chat's nextSeq meanwhile, so the reply starts at `replySeq`, the seq
  // after the member's message. The chat write requires exactly that state;
  // a chat that does not match (hand-edited data) is saved the general way.
  // A run that is already settled is returned as saved: the first writer
  // wins and a repeat changes nothing.
  async settle(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    replySeq: number,
    outcome: Settlement,
  ): Promise<SettleResult> {
    try {
      return await this.settleOnce(dbName, chatId, runId, outcome, replySeq);
    } catch (error) {
      if (!(error instanceof ClaimMoved)) throw error;
      this.logger.warn({
        message:
          "chat changed under an unsettled run; saved after its last message",
        runId: runId.toHexString(),
      });
      return this.settleOnce(dbName, chatId, runId, outcome, null);
    }
  }

  // replySeq null: read the chat's next seq and release the claim only if
  // this run still holds it, whatever the chat's state.
  private async settleOnce(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    outcome: Settlement,
    replySeq: number | null,
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
      const chatSet = {
        updatedAt: now,
        ...(texts.length ? { lastMessageAt: now } : {}),
        ...(outcome.threadLost ? { "runtime.state": "lost" as const } : {}),
      };
      // The thread the runtime ran this turn on, recorded on a chat that has
      // none yet: normally markAccepted did it, but that write may have
      // failed. Without it the next message would ask the runtime for a new
      // thread, and a runtime that lost its disk would silently start one.
      const recordThread: AnyClientBulkWriteModel<Document>[] =
        outcome.threadId && !outcome.threadLost
          ? [
              {
                namespace: chats.namespace,
                name: "updateOne",
                filter: {
                  _id: chatId,
                  "runtime.threadId": null,
                  "runtime.state": { $ne: "lost" },
                },
                update: {
                  $set: {
                    runtime: { threadId: outcome.threadId, state: "ready" },
                  },
                },
              },
            ]
          : [];
      const replyFrom = (seq: number): MessageDoc[] =>
        texts.map((item, index) => ({
          _id: new ObjectId(),
          chatId,
          ownerId: run.ownerId,
          seq: seq + index,
          runId,
          role: "assistant",
          text: item.text,
          state: MESSAGE_STATE[outcome.status],
          runtimeItemId: item.itemId,
          createdAt: now,
        }));

      if (replySeq !== null) {
        const docs = replyFrom(replySeq);
        let matched: number;
        try {
          const result = await this.database.bulkWrite(
            [
              {
                namespace: chats.namespace,
                name: "updateOne",
                filter: {
                  _id: chatId,
                  "activeRun.runId": runId,
                  nextSeq: replySeq,
                },
                update: {
                  $set: { ...chatSet, activeRun: null },
                  $inc: { nextSeq: docs.length },
                },
              },
              ...recordThread,
              ...docs.map((document): AnyClientBulkWriteModel<Document> => ({
                namespace: messages.namespace,
                name: "insertOne",
                document,
              })),
            ],
            session,
            true,
          );
          // The claim's own result: recordThread may match too.
          matched = result.updateResults?.get(0)?.matchedCount ?? 0;
        } catch (error) {
          // A seq already taken: the chat is not in the state assumed.
          if (isDuplicateKeyError(error)) throw new ClaimMoved();
          throw error;
        }
        // Aborts the reply's inserts with it.
        if (matched !== 1) throw new ClaimMoved();
        return { run, messages: docs };
      }

      const chat = await chats.findOneAndUpdate(
        { _id: chatId },
        { $inc: { nextSeq: texts.length }, $set: chatSet },
        { returnDocument: "before", session },
      );
      if (!chat) throw new Error("settling a run whose chat does not exist");
      const docs = replyFrom(chat.nextSeq);
      if (docs.length) await messages.insertMany(docs, { session });
      if (recordThread.length)
        await this.database.bulkWrite(recordThread, session);
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
  // history: on the chat's next access, or by the recovery sweep.
  async settleWithRetry(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    replySeq: number,
    outcome: Settlement,
  ): Promise<SettleResult | null> {
    const delaysMs = this.settleRetryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.settle(dbName, chatId, runId, replySeq, outcome);
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
