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
  MAX_ACTIVITY_COMMAND,
  MAX_ACTIVITY_FILES,
  MAX_ACTIVITY_OUTPUT,
  MAX_CHAT_COMMAND_APPROVALS,
  MAX_CHAT_TOOL_APPROVALS,
  RUNS_COLLECTION,
  TOOL_APPROVALS_COLLECTION,
  type ActivityFile,
  type ActivityStatus,
  type ApprovalDecision,
  type ChatDoc,
  type MessageDoc,
  type MessageState,
  type RunDoc,
  type RunErrorInfo,
  type RunStatus,
  type RunUsage,
  type SteerDoc,
  type ToolApprovalDoc,
} from "./chat";
import {
  MAX_CHAT_NETWORK_GRANTS,
  type ChatNetworkGrant,
  type MessageNetwork,
  type NetworkDecision,
} from "../network/network-grants";

// How long a run stays claimed by the process streaming it without a lease
// renewal. The executor renews every LEASE_RENEW_MS.
export const LEASE_MS = 30_000;
export const LEASE_RENEW_MS = 10_000;

export interface ChatCollections {
  readonly chats: Collection<ChatDoc>;
  readonly messages: Collection<MessageDoc>;
  readonly runs: Collection<RunDoc>;
}

// The runtime's items for a run, in the order it produced them: a reply's
// text, or a steer entering the turn. The run's own message is not in it.
export type SettleItem =
  | {
      readonly type: "reply";
      readonly itemId: string;
      readonly text: string;
      // The runtime finished it; a reply cut off by a steer never is.
      readonly completed: boolean;
    }
  | { readonly type: "input"; readonly clientMessageId: string }
  | ToolSettleItem
  | CommandSettleItem
  | FileChangeSettleItem
  | SkillSettleItem
  | NetworkSettleItem;

// A sandbox request the network proxy refused, once per site and method in a
// run (network-grants.ts). Saved as a tool message whose card the chat owner
// answers.
export type NetworkSettleItem = { readonly type: "network" } & Omit<
  MessageNetwork,
  "decision" | "decidedAt"
>;

// A skill the model opened (`skills.read`), once per run, named as it was
// when the chat started.
export interface SkillSettleItem {
  readonly type: "skill";
  readonly slug: string;
  readonly name: string;
}

// A command in the chat's workspace (coding). `inProgress` only while the
// run streams; one still running at settle is saved failed.
export interface CommandSettleItem {
  readonly type: "command";
  readonly itemId: string;
  readonly command: string;
  readonly status: "inProgress" | ActivityStatus;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly approval?: ApprovalDecision;
}

export interface FileChangeSettleItem {
  readonly type: "file_change";
  readonly itemId: string;
  readonly files: readonly ActivityFile[];
  readonly status: "inProgress" | ActivityStatus;
  readonly approval?: ApprovalDecision;
}

// A connector tool call (slice 4/5 contract). `inProgress` only while the
// run streams; a call still running at settle is saved failed / UNKNOWN.
// Arguments and results are never carried.
export interface ToolSettleItem {
  readonly type: "tool";
  readonly itemId: string;
  readonly connector: string;
  readonly tool: string;
  readonly status: "inProgress" | "completed" | "failed";
  readonly durationMs?: number;
  readonly errorCode?: string;
  // How the call's approval ended, when it needed one (write tools).
  readonly approval?: ApprovalDecision;
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
  // Files the run wrote that couldn't be stored (see ChatFilesService).
  readonly unsavedFiles?: readonly string[];
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

type PlannedMessage = Pick<
  MessageDoc,
  | "role"
  | "text"
  | "state"
  | "clientMessageId"
  | "textHash"
  | "runtimeItemId"
  | "tool"
  | "activity"
  | "skill"
  | "network"
>;

// The messages a settled run writes after its own, in order: each non-empty
// reply, each tool call and each steer where the runtime used it, then the
// steers it never
// read as `not_sent`. A reply followed by a steer was finished or cut off by
// it; the replies after the last steer take the run's outcome.
// A tool call's saved summary. A call the runtime never finished (the run
// was stopped or failed around it) is saved failed / UNKNOWN.
function toolMessage(item: ToolSettleItem): PlannedMessage {
  const finished = item.status !== "inProgress";
  const status = item.status === "completed" ? "completed" : "failed";
  return {
    role: "tool",
    text: "",
    state: status === "completed" ? "complete" : "failed",
    runtimeItemId: item.itemId,
    tool: {
      connector: item.connector,
      name: item.tool,
      status,
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(finished
        ? item.errorCode
          ? { errorCode: item.errorCode }
          : {}
        : { errorCode: "UNKNOWN" }),
      ...(item.approval ? { approval: item.approval } : {}),
    },
  };
}

// A command's or file change's saved record. One the runtime never finished
// is saved failed.
function activityMessage(
  item: CommandSettleItem | FileChangeSettleItem,
): PlannedMessage {
  const status: ActivityStatus =
    item.status === "inProgress" ? "failed" : item.status;
  const approval = item.approval ? { approval: item.approval } : {};
  return {
    role: "tool",
    text: "",
    state: status === "completed" ? "complete" : "failed",
    runtimeItemId: item.itemId,
    activity:
      item.type === "command"
        ? {
            kind: "command",
            command: item.command.slice(0, MAX_ACTIVITY_COMMAND),
            status,
            ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
            ...(item.durationMs !== undefined
              ? { durationMs: item.durationMs }
              : {}),
            output: item.output.slice(0, MAX_ACTIVITY_OUTPUT),
            outputTruncated:
              item.outputTruncated || item.output.length > MAX_ACTIVITY_OUTPUT,
            ...approval,
          }
        : {
            kind: "file_change",
            files: item.files
              .slice(0, MAX_ACTIVITY_FILES)
              .map((file) => ({ ...file })),
            status,
            ...approval,
          },
  };
}

export function plannedMessages(
  run: Pick<RunDoc, "steers">,
  outcome: Pick<Settlement, "status" | "items">,
  onUnknownInput: (clientMessageId: string) => void = () => undefined,
): PlannedMessage[] {
  const steers = new Map(
    (run.steers ?? []).map((steer) => [steer.clientMessageId, steer]),
  );
  const used = new Set<string>();
  const lastInput = outcome.items.findLastIndex(
    (item) => item.type === "input",
  );
  const planned: PlannedMessage[] = [];
  outcome.items.forEach((item, index) => {
    if (item.type === "tool") {
      planned.push(toolMessage(item));
      return;
    }
    if (item.type === "command" || item.type === "file_change") {
      planned.push(activityMessage(item));
      return;
    }
    if (item.type === "skill") {
      planned.push({
        role: "tool",
        text: "",
        state: "complete",
        // Unique per run (the runtime reports each skill once).
        runtimeItemId: `skill:${item.slug}`,
        skill: { slug: item.slug, name: item.name },
      });
      return;
    }
    if (item.type === "network") {
      const { type: _type, ...network } = item;
      planned.push({
        role: "tool",
        text: "",
        state: "complete",
        // Unique per run (the runtime reports each block once).
        runtimeItemId: `network:${networkKey(item)}`,
        network,
      });
      return;
    }
    if (item.type === "reply") {
      if (item.text.trim().length === 0) return;
      planned.push({
        role: "assistant",
        text: item.text,
        state:
          index < lastInput
            ? item.completed
              ? "complete"
              : "interrupted"
            : MESSAGE_STATE[outcome.status],
        runtimeItemId: item.itemId,
      });
      return;
    }
    const steer = steers.get(item.clientMessageId);
    if (!steer || used.has(steer.clientMessageId))
      return onUnknownInput(item.clientMessageId);
    used.add(steer.clientMessageId);
    planned.push(userMessage(steer, "complete"));
  });
  for (const steer of run.steers ?? [])
    if (!used.has(steer.clientMessageId))
      planned.push(userMessage(steer, "not_sent"));
  return planned;
}

// One card per site and method in a run, whatever the command retried (the
// adapter's blockKey).
export function networkKey(
  item: Pick<NetworkSettleItem, "kind" | "host" | "method">,
): string {
  return `${item.kind}:${item.host}:${item.kind === "unlisted" ? "" : item.method}`;
}

function userMessage(steer: SteerDoc, state: MessageState): PlannedMessage {
  return {
    role: "user",
    text: steer.text,
    state,
    clientMessageId: steer.clientMessageId,
    textHash: steer.textHash,
  };
}

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

  // The audit record of one resolved approval. Keyed by approvalId, so a
  // resolution seen again after a reconnect is not a second record.
  async recordApproval(dbName: string, doc: ToolApprovalDoc): Promise<void> {
    try {
      await this.database
        .tenantDb(dbName)
        .collection<ToolApprovalDoc>(TOOL_APPROVALS_COLLECTION)
        .insertOne(doc);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  // Allow for this chat: later calls of the tool in this chat run without a
  // card. Once per connector and tool, and at most MAX_CHAT_TOOL_APPROVALS.
  async allowToolForChat(
    dbName: string,
    chatId: ObjectId,
    ownerId: ObjectId,
    connector: string,
    tool: string,
  ): Promise<void> {
    const now = new Date();
    await this.collections(dbName).chats.updateOne(
      {
        _id: chatId,
        ownerId,
        toolApprovals: { $not: { $elemMatch: { connector, tool } } },
        [`toolApprovals.${MAX_CHAT_TOOL_APPROVALS - 1}`]: { $exists: false },
      },
      {
        $push: { toolApprovals: { connector, tool, at: now } },
        $set: { updatedAt: now },
      },
    );
  }

  // Allow for this chat on a coding card: a command's scope (that exact
  // command). Bounded like tool approvals.
  async allowCodingForChat(
    dbName: string,
    chatId: ObjectId,
    ownerId: ObjectId,
    allow: { command: string },
  ): Promise<void> {
    const now = new Date();
    await this.collections(dbName).chats.updateOne(
      {
        _id: chatId,
        ownerId,
        [`codingApprovals.commands.${MAX_CHAT_COMMAND_APPROVALS - 1}`]: {
          $exists: false,
        },
      },
      {
        $addToSet: { "codingApprovals.commands": allow.command },
        $set: { updatedAt: now },
      },
    );
  }

  // The owner's allow on a network card. Once per card (messageId), and at
  // most MAX_CHAT_NETWORK_GRANTS. False when the chat already holds that many
  // or is not the owner's.
  async addNetworkGrant(
    dbName: string,
    chatId: ObjectId,
    ownerId: ObjectId,
    grant: ChatNetworkGrant,
  ): Promise<boolean> {
    const result = await this.collections(dbName).chats.updateOne(
      {
        _id: chatId,
        ownerId,
        networkGrants: {
          $not: { $elemMatch: { messageId: grant.messageId } },
        },
        [`networkGrants.${MAX_CHAT_NETWORK_GRANTS - 1}`]: { $exists: false },
      },
      { $push: { networkGrants: grant }, $set: { updatedAt: grant.at } },
    );
    if (result.modifiedCount === 1) return true;
    // Already there (a retried answer) counts as added.
    const existing = await this.collections(dbName).chats.countDocuments(
      { _id: chatId, ownerId, "networkGrants.messageId": grant.messageId },
      { limit: 1 },
    );
    return existing === 1;
  }

  // Removes the `once` grants a run used, when it ends.
  async consumeNetworkGrants(
    dbName: string,
    chatId: ObjectId,
    messageIds: readonly ObjectId[],
  ): Promise<void> {
    if (messageIds.length === 0) return;
    await this.collections(dbName).chats.updateOne(
      { _id: chatId },
      {
        $pull: {
          networkGrants: {
            scope: "once",
            messageId: { $in: [...messageIds] },
          },
        },
      },
    );
  }

  // Records the owner's answer on a network card's message, once. Returns
  // the saved network (with the decision that won) or null when the message
  // is not one of the owner's network cards in this chat.
  async decideNetwork(
    dbName: string,
    chatId: ObjectId,
    ownerId: ObjectId,
    messageId: ObjectId,
    decision: NetworkDecision,
    at: Date,
  ): Promise<MessageNetwork | null> {
    const { messages } = this.collections(dbName);
    const filter = {
      _id: messageId,
      chatId,
      ownerId,
      role: "tool" as const,
      network: { $exists: true },
    };
    await messages.updateOne(
      { ...filter, "network.decision": { $exists: false } },
      { $set: { "network.decision": decision, "network.decidedAt": at } },
    );
    const saved = await messages.findOne(filter, {
      projection: { network: 1 },
    });
    return saved?.network ?? null;
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

  // Saves the outcome, the reply text and the run's steers, and releases the
  // chat in one transaction: the run, then the chat and the messages in one
  // call, then the commit. An unsettled run holds its chat's claim, and
  // nothing else moves the chat's nextSeq meanwhile (steers wait on the run,
  // not in messages), so the run's messages start at `replySeq`, the seq
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
            ...(outcome.unsavedFiles?.length
              ? { unsavedFiles: [...outcome.unsavedFiles] }
              : {}),
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
            .find({ runId, _id: { $ne: saved.userMessageId } }, { session })
            .sort({ seq: 1 })
            .toArray(),
        };
      }
      const planned = plannedMessages(run, outcome, (clientMessageId) =>
        this.logger.warn({
          message: "runtime reported a steer this run does not have",
          runId: runId.toHexString(),
          clientMessageId,
        }),
      );
      const chatSet = {
        updatedAt: now,
        ...(planned.length ? { lastMessageAt: now } : {}),
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
        planned.map((message, index) => ({
          _id: new ObjectId(),
          chatId,
          ownerId: run.ownerId,
          seq: seq + index,
          runId,
          ...message,
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
        { $inc: { nextSeq: planned.length }, $set: chatSet },
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
