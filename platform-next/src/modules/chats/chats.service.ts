import { Inject, Injectable } from "@nestjs/common";
import {
  ObjectId,
  type AnyClientBulkWriteModel,
  type ClientSession,
  type Collection,
  type Document,
} from "mongodb";
import type { TenantContext } from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { timed } from "../../common/http/server-timing";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import { toWireId } from "../../database/object-id";
import type { AgentTint } from "../agents/agent-fields";
import {
  AgentsService,
  type AgentSummary,
  type ChatAgent,
} from "../agents/agents.service";
import { modelView, type ModelDoc, type ModelView } from "../models/model";
import { ModelsService } from "../models/models.service";
import {
  CHAT_LIST_PAGE,
  HISTORY_PAGE,
  isSettled,
  PLATFORM_INSTRUCTIONS_VERSION,
  SENDS_PER_MINUTE,
  textHashOf,
  titleOf,
  type AgentSource,
  type ChatDoc,
  type MessageDoc,
  type MessageState,
  type RunDoc,
  type RunErrorInfo,
  type RunStatus,
  type RunUsage,
  type SendInput,
  type StartChatInput,
} from "./chat";
import { chatPrompt } from "./chat-prompt";
import {
  ChatStore,
  LEASE_MS,
  type ChatCollections,
  type SettleResult,
} from "./chat-store";
import { signGatewayToken } from "./gateway-token";
import { RunExecutor, type Dispatch } from "./run-executor";

export interface ChatView {
  id: string;
  title: string;
  agent: {
    id: string;
    source: AgentSource;
    name: string;
    look: number;
    tint: AgentTint;
  } | null;
  model: ModelView | null;
  // Why the chat can be read but not continued, or null when it can.
  readOnly: null | "THREAD_LOST" | "MODEL_UNAVAILABLE" | "AGENT_UNAVAILABLE";
  activeRunId: string | null;
  status: "active" | "archived";
  lastMessageAt: string;
  createdAt: string;
}

export interface MessageView {
  id: string;
  seq: number;
  runId: string;
  role: "user" | "assistant";
  text: string;
  state: MessageState;
  clientMessageId?: string;
  createdAt: string;
}

export interface RunView {
  id: string;
  status: RunStatus;
  error: RunErrorInfo | null;
  usage: RunUsage | null;
  timings: {
    acceptedAt: string;
    dispatchedAt?: string;
    firstTextAt?: string;
    completedAt?: string;
  };
}

// A chat without its agent's display fields.
export type ChatStateView = Omit<ChatView, "agent">;

export interface SendReceipt {
  // A follow-up that did not need its agent leaves `agent` out rather than
  // reading it: it has not changed, and the caller already shows it.
  chat: ChatView | ChatStateView;
  message: MessageView;
  run: RunView;
  created: boolean;
}

export interface HistoryPage {
  messages: MessageView[];
  runs: RunView[];
  // More, older messages exist: request them with before=<first seq>.
  hasMore: boolean;
}

const NOT_FOUND = "This chat does not exist or you cannot see it.";
const RATE_WINDOW_MS = 60_000;

// Private chats with one agent each. Every read and write filters by the
// caller's tenant database and ownerId; another member's chat and a missing
// one are the same 404.
@Injectable()
export class ChatsService {
  private readonly recentSends = new Map<string, number[]>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ChatStore) private readonly store: ChatStore,
    @Inject(RunExecutor) private readonly executor: RunExecutor,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(ModelsService) private readonly models: ModelsService,
  ) {}

  private db(context: TenantContext): ChatCollections {
    return this.store.collections(context.dbName);
  }

  // The first send creates the chat. A retry with the same clientMessageId
  // returns the same chat, message and run.
  //
  // Nearly every start is new, so the retry check is not a read up front: the
  // unique index owner_first_message_unique refuses a second chat, and the
  // original is read then. A refusal (agent archived since, rate limit) also
  // checks first, so a retry of a start that committed still gets its receipt.
  // Normally two round trips: the save and its commit, plus one read for a
  // user agent. Built-ins and models come from the catalog cache.
  async start(
    context: TenantContext,
    input: StartChatInput,
  ): Promise<SendReceipt> {
    this.requireRuntime();
    const agent = await timed("agent", () =>
      this.agents.resolveForChat(context, input.agentId, {
        allowArchived: false,
      }),
    );
    if (!agent)
      return this.startRefused(
        context,
        input,
        new DomainError(
          "NOT_FOUND",
          "This agent does not exist or you cannot use it.",
        ),
      );
    const model = await timed("model", () =>
      this.models.enabledById(agent.modelId),
    );
    if (!model) return this.startRefused(context, input, modelUnavailable());
    const refund = this.admitSend(context);
    if (!refund) return this.startRefused(context, input, rateLimited());

    const now = new Date();
    const chat: ChatDoc = {
      _id: new ObjectId(),
      ownerId: context.userId,
      title: titleOf(input.text),
      agent: { source: agent.source, id: agent.id, revision: agent.revision },
      model: { id: model._id, revision: model.revision },
      platformInstructionsVersion: PLATFORM_INSTRUCTIONS_VERSION,
      runtime: { threadId: null, state: "none" },
      activeRun: null,
      nextSeq: 2,
      status: "active",
      createdByMessageId: input.clientMessageId,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const { message, run } = this.newTurn(context, chat, 1, input, now);
    chat.activeRun = {
      runId: run._id,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    };
    const { chats, messages, runs } = this.db(context);
    try {
      // The chat, its first message and run in one call, then the commit.
      await timed("save", () =>
        this.database.withTransaction((session) =>
          this.database.bulkWrite(
            [
              insertOf(chats, chat),
              insertOf(messages, message),
              insertOf(runs, run),
            ],
            session,
          ),
        ),
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // A retry, or the same send racing itself: not a new message.
      refund();
      const raced = await timed("replay", () =>
        this.replayStart(context, input),
      );
      if (!raced) throw error;
      return raced;
    }
    this.executor.begin(
      this.dispatchOf(context, chat, run, message, agent, model, "start"),
    );
    return {
      chat: chatView(chat, summaryOf(agent), model),
      message: messageView(message),
      run: runView(run),
      created: true,
    };
  }

  // The same approach as start: the retry check runs only when the save hits
  // the unique index chat_client_message_unique, or before any refusal. The
  // claim, the message and the run are one call; the claim also requires the
  // chat to be as it was read, and matching nothing aborts the transaction.
  async send(
    context: TenantContext,
    chatId: ObjectId,
    input: SendInput,
  ): Promise<SendReceipt> {
    this.requireRuntime();
    const chat = await timed("chat", () => this.findOwned(context, chatId));
    const refuse = (error: DomainError) =>
      this.sendRefused(context, chat, input, error);

    if (chat.status !== "active")
      return refuse(
        new DomainError(
          "CHAT_READ_ONLY",
          "This chat is archived. Start a new chat.",
        ),
      );
    if (chat.runtime.state === "lost") return refuse(threadLost());
    if (chat.activeRun) {
      // Most likely this very message, retried while its reply streams.
      const replay = await timed("replay", () =>
        this.replaySend(context, chat, input),
      );
      if (replay) return replay;
      await timed("recover", () => this.recoverIfOrphaned(context, chat));
      throw chatBusy();
    }
    const model = await timed("model", () =>
      this.models.enabledById(chat.model.id),
    );
    if (!model)
      return refuse(
        new DomainError(
          "CHAT_READ_ONLY",
          "This chat's model is no longer available. Start a new chat.",
        ),
      );
    // A built-in the product team disabled stops its chats; an archived
    // user agent does not. The prompt is needed only before the thread
    // exists.
    const needsAgent =
      chat.agent.source === "builtin" || !chat.runtime.threadId;
    const agent = needsAgent
      ? await timed("agent", () =>
          this.agents.resolveForChat(context, chat.agent.id, {
            allowArchived: true,
          }),
        )
      : null;
    if (needsAgent && !agent)
      return refuse(
        new DomainError(
          "CHAT_READ_ONLY",
          "This chat's agent is no longer available. Start a new chat.",
        ),
      );
    const refund = this.admitSend(context);
    if (!refund) return refuse(rateLimited());

    const now = new Date();
    const runId = new ObjectId();
    const turn = this.newTurn(context, chat, chat.nextSeq, input, now, runId);
    const activeRun = {
      runId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    };
    const { chats, messages, runs } = this.db(context);
    try {
      await timed("save", () =>
        this.database.withTransaction(async (session) => {
          const result = await this.database.bulkWrite(
            [
              {
                namespace: chats.namespace,
                name: "updateOne",
                // Only if no run holds it and it is unchanged since the
                // read: the seq and thread used below are the ones read.
                filter: {
                  _id: chat._id,
                  ownerId: context.userId,
                  status: "active",
                  activeRun: null,
                  nextSeq: chat.nextSeq,
                  "runtime.threadId": chat.runtime.threadId,
                  "runtime.state": { $ne: "lost" },
                },
                update: {
                  $set: { activeRun, lastMessageAt: now, updatedAt: now },
                  $inc: { nextSeq: 1 },
                },
              },
              insertOf(messages, turn.message),
              insertOf(runs, turn.run),
            ],
            session,
          );
          // Aborts the inserts with it.
          if (result.matchedCount !== 1) throw chatBusy();
        }),
      );
    } catch (error) {
      const busy = error instanceof DomainError && error.code === "CHAT_BUSY";
      if (!busy && !isDuplicateKeyError(error)) throw error;
      refund();
      const raced = await timed("replay", () =>
        this.replaySend(context, chat, input),
      );
      if (raced) return raced;
      // Not this message: the chat moved on since it was read (its seq was
      // taken, or a run claimed it).
      throw chatBusy();
    }
    this.executor.begin(
      this.dispatchOf(
        context,
        chat,
        turn.run,
        turn.message,
        agent,
        model,
        "start",
      ),
    );
    const latest: ChatDoc = {
      ...chat,
      activeRun,
      nextSeq: chat.nextSeq + 1,
      lastMessageAt: now,
      updatedAt: now,
    };
    return {
      chat: agent
        ? chatView(latest, summaryOf(agent), model)
        : chatState(latest, model, false),
      message: messageView(turn.message),
      run: runView(turn.run),
      created: true,
    };
  }

  // A start that cannot go ahead. A retry of one that already committed
  // gets its receipt instead: the agent may have been archived since.
  private async startRefused(
    context: TenantContext,
    input: StartChatInput,
    refusal: DomainError,
  ): Promise<SendReceipt> {
    const replay = await timed("replay", () =>
      this.replayStart(context, input),
    );
    if (replay) return replay;
    throw refusal;
  }

  private async sendRefused(
    context: TenantContext,
    chat: ChatDoc,
    input: SendInput,
    refusal: DomainError,
  ): Promise<SendReceipt> {
    const replay = await timed("replay", () =>
      this.replaySend(context, chat, input),
    );
    if (replay) return replay;
    throw refusal;
  }

  async list(
    context: TenantContext,
    cursor: { before?: Date; beforeId?: ObjectId },
    status: "active" | "archived" = "active",
  ): Promise<{ chats: ChatView[]; nextCursor: string | null }> {
    const { chats } = this.db(context);
    const filter: Record<string, unknown> = { ownerId: context.userId, status };
    if (cursor.before && cursor.beforeId)
      filter.$or = [
        { lastMessageAt: { $lt: cursor.before } },
        { lastMessageAt: cursor.before, _id: { $lt: cursor.beforeId } },
      ];
    const page = await chats
      .find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(CHAT_LIST_PAGE + 1)
      .toArray();
    const more = page.length > CHAT_LIST_PAGE;
    const shown = page.slice(0, CHAT_LIST_PAGE);
    const views = await this.views(context, shown);
    const last = shown.at(-1);
    return {
      chats: views,
      nextCursor:
        more && last
          ? `${last.lastMessageAt.getTime()}_${toWireId(last._id)}`
          : null,
    };
  }

  // The chat with its latest messages. Never contacts the runtime, except to
  // recover a run that no process is streaming.
  async get(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ chat: ChatView } & HistoryPage> {
    const chat = await this.findOwned(context, chatId);
    if (chat.activeRun) await this.recoverIfOrphaned(context, chat);
    const [view, page] = await Promise.all([
      this.view(context, chat),
      this.history(context, chat),
    ]);
    return { chat: view, ...page };
  }

  async messagesBefore(
    context: TenantContext,
    chatId: ObjectId,
    beforeSeq: number,
  ): Promise<HistoryPage> {
    const chat = await this.findOwned(context, chatId);
    return this.history(context, chat, beforeSeq);
  }

  async rename(
    context: TenantContext,
    chatId: ObjectId,
    title: string,
  ): Promise<ChatView> {
    const { chats } = this.db(context);
    const chat = await chats.findOneAndUpdate(
      { _id: chatId, ownerId: context.userId },
      { $set: { title, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!chat) throw new DomainError("NOT_FOUND", NOT_FOUND);
    return this.view(context, chat);
  }

  // Hides the chat from the sidebar's active list; history stays readable.
  // An answering chat must finish or be stopped first.
  async archive(context: TenantContext, chatId: ObjectId): Promise<ChatView> {
    const { chats } = this.db(context);
    const chat = await chats.findOneAndUpdate(
      { _id: chatId, ownerId: context.userId, activeRun: null },
      { $set: { status: "archived", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!chat) {
      await this.findOwned(context, chatId);
      throw chatBusy();
    }
    return this.view(context, chat);
  }

  // The reply's saved outcome, or null while it is answering. Only for the
  // caller's own run in this chat; anything else is NOT_FOUND. A reply this
  // process is reading for the caller needs no read; an unsettled one no
  // process is reading gets a reader here, so a browser can always
  // subscribe.
  async runForStream(
    context: TenantContext,
    chatId: ObjectId,
    runId: ObjectId,
  ): Promise<{ saved: SettleResult | null }> {
    const here = this.executor.liveFor(
      context.dbName,
      chatId,
      runId,
      context.userId,
    );
    if (here) return { saved: here === "running" ? null : here };
    const { runs, messages } = this.db(context);
    const run = await timed("run", () =>
      runs.findOne({ _id: runId, chatId, ownerId: context.userId }),
    );
    if (!run) throw new DomainError("NOT_FOUND", "This reply does not exist.");
    if (isSettled(run.status))
      return {
        saved: {
          run,
          messages: await timed("saved", () =>
            messages
              .find({ runId, role: "assistant" })
              .sort({ seq: 1 })
              .toArray(),
          ),
        },
      };
    const chat = await timed("chat", () => this.findOwned(context, chatId));
    if (chat.activeRun?.runId.equals(runId))
      await timed("recover", () => this.recoverIfOrphaned(context, chat));
    return { saved: null };
  }

  async stop(
    context: TenantContext,
    chatId: ObjectId,
    runId: ObjectId,
  ): Promise<{ status: "stopping" | RunStatus }> {
    const { saved } = await this.runForStream(context, chatId, runId);
    if (saved) return { status: saved.run.status };
    await this.store.markStopRequested(context.dbName, runId);
    try {
      await this.executor.stop(runId);
    } catch {
      throw new DomainError(
        "UNAVAILABLE",
        "The assistant could not be reached to stop this reply. Try again.",
      );
    }
    return { status: "stopping" };
  }

  // A chat claimed by a run that no process here is reading. Once the lease
  // lapses (the reading process stopped renewing it), this process takes
  // over: it reattaches to the runtime's run, or settles from the runtime's
  // history. Never resends a message the runtime may have seen.
  private async recoverIfOrphaned(
    context: TenantContext,
    chat: ChatDoc,
  ): Promise<void> {
    const active = chat.activeRun;
    if (!active || !this.executor.configured) return;
    if (this.executor.isLive(active.runId)) return;
    const { runs, messages } = this.db(context);
    const run = await runs.findOne({ _id: active.runId, chatId: chat._id });
    if (!run) return;
    if (isSettled(run.status)) {
      // Settled but not released (crash between writes is impossible in one
      // transaction; this guards hand-edited data). Release it.
      await this.db(context).chats.updateOne(
        { _id: chat._id, "activeRun.runId": run._id },
        { $set: { activeRun: null } },
      );
      return;
    }
    const message = await messages.findOne({ _id: run.userMessageId });
    if (!message) return;
    const model = await this.models.findEnabled(chat.model.id);
    const agent = await this.agents.resolveForChat(context, chat.agent.id, {
      allowArchived: true,
    });
    const lapsed =
      active.leaseExpiresAt.getTime() <= Date.now() ||
      this.executor.abandonedHere(active.runId);
    this.executor.begin(
      this.dispatchOf(
        context,
        chat,
        run,
        message,
        agent,
        model,
        "recover",
        lapsed ? undefined : active.leaseExpiresAt,
      ),
    );
  }

  private dispatchOf(
    context: TenantContext,
    chat: ChatDoc,
    run: RunDoc,
    message: MessageDoc,
    agent: ChatAgent | null,
    model: ModelDoc | null,
    mode: Dispatch["mode"],
    notBefore?: Date,
  ): Dispatch {
    const chatConfig = this.config.chat!;
    const tenantId = toWireId(context.tenantId);
    const chatId = toWireId(chat._id);
    const modelId = toWireId(chat.model.id);
    // Recovery without a model or agent can still reattach or read history;
    // posting then fails validation in the adapter and settles as failed.
    const prompt = agent
      ? chatPrompt(agent)
      : "This chat's agent is no longer available.";
    return {
      dbName: context.dbName,
      chatId: chat._id,
      runId: run._id,
      ownerId: chat.ownerId,
      replySeq: message.seq + 1,
      ref: { tenantId, chatId },
      mode,
      ...(notBefore ? { notBefore } : {}),
      body: {
        runId: toWireId(run._id),
        tenantId,
        chatId,
        threadId: chat.runtime.threadId,
        input: { text: message.text, clientMessageId: run.clientMessageId },
        agentPrompt: prompt,
        model: {
          modelName: model?.modelName ?? "unavailable",
          gatewayUrl: `${chatConfig.gatewayUrl}/p/${modelId}/v1`,
          gatewayToken: signGatewayToken(
            modelId,
            chatConfig.gatewaySecret,
            tenantId,
          ),
          contextWindow: model?.contextWindow ?? 1024,
          autoCompactTokenLimit: model?.autoCompactTokenLimit ?? 512,
          ...(model?.reasoningEffort
            ? { reasoningEffort: model.reasoningEffort }
            : {}),
        },
      },
    };
  }

  private newTurn(
    context: TenantContext,
    chat: ChatDoc,
    seq: number,
    input: SendInput,
    now: Date,
    runId = new ObjectId(),
  ): { message: MessageDoc; run: RunDoc } {
    const message: MessageDoc = {
      _id: new ObjectId(),
      chatId: chat._id,
      ownerId: context.userId,
      seq,
      runId,
      role: "user",
      text: input.text,
      state: "complete",
      clientMessageId: input.clientMessageId,
      textHash: textHashOf(input.text),
      createdAt: now,
    };
    const run: RunDoc = {
      _id: runId,
      chatId: chat._id,
      ownerId: context.userId,
      userMessageId: message._id,
      clientMessageId: input.clientMessageId,
      status: "accepted",
      timings: { acceptedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    return { message, run };
  }

  private async replayStart(
    context: TenantContext,
    input: StartChatInput,
  ): Promise<SendReceipt | null> {
    const chat = await this.db(context).chats.findOne({
      ownerId: context.userId,
      createdByMessageId: input.clientMessageId,
    });
    if (!chat) return null;
    if (!chat.agent.id.equals(input.agentId)) throw reusedMessageId();
    return this.replaySend(context, chat, input);
  }

  private async replaySend(
    context: TenantContext,
    chat: ChatDoc,
    input: SendInput,
  ): Promise<SendReceipt | null> {
    const { messages, runs } = this.db(context);
    const message = await messages.findOne({
      chatId: chat._id,
      clientMessageId: input.clientMessageId,
    });
    if (!message) return null;
    if (message.textHash !== textHashOf(input.text)) throw reusedMessageId();
    const run = await runs.findOne({ _id: message.runId });
    if (!run) return null;
    return {
      chat: await this.view(context, chat),
      message: messageView(message),
      run: runView(run),
      created: false,
    };
  }

  private async findOwned(
    context: TenantContext,
    chatId: ObjectId,
    session?: ClientSession,
  ): Promise<ChatDoc> {
    const chat = await this.db(context).chats.findOne(
      { _id: chatId, ownerId: context.userId },
      { session },
    );
    if (!chat) throw new DomainError("NOT_FOUND", NOT_FOUND);
    return chat;
  }

  private async history(
    context: TenantContext,
    chat: ChatDoc,
    beforeSeq?: number,
  ): Promise<HistoryPage> {
    const { messages, runs } = this.db(context);
    const page = await messages
      .find({
        chatId: chat._id,
        ownerId: context.userId,
        ...(beforeSeq !== undefined ? { seq: { $lt: beforeSeq } } : {}),
      })
      .sort({ seq: -1 })
      .limit(HISTORY_PAGE + 1)
      .toArray();
    const hasMore = page.length > HISTORY_PAGE;
    const shown = page.slice(0, HISTORY_PAGE).reverse();
    const runIds = [
      ...new Map(shown.map((m) => [toWireId(m.runId), m.runId])).values(),
    ];
    const runDocs = runIds.length
      ? await runs
          .find({ _id: { $in: runIds }, ownerId: context.userId })
          .toArray()
      : [];
    return {
      messages: shown.map(messageView),
      runs: runDocs.map(runView),
      hasMore,
    };
  }

  private async view(context: TenantContext, chat: ChatDoc): Promise<ChatView> {
    const [view] = await this.views(context, [chat]);
    return view!;
  }

  // Current agent names and models for a page of chats: at most one agent
  // query (none when every agent is a built-in) and usually no model query.
  private async views(
    context: TenantContext,
    chats: readonly ChatDoc[],
  ): Promise<ChatView[]> {
    const agentIds = [
      ...new Map(chats.map((c) => [toWireId(c.agent.id), c.agent.id])).values(),
    ];
    const [summaries, enabled] = await Promise.all([
      this.agents.summariesFor(context, agentIds),
      this.models.enabledModels(),
    ]);
    const models = new Map(enabled.map((m) => [toWireId(m._id), m]));
    const unknown = chats
      .map((c) => c.model.id)
      .filter((id) => !models.has(toWireId(id)));
    if (unknown.length)
      for (const model of await this.models.findEnabledMany(unknown))
        models.set(toWireId(model._id), model);

    return chats.map((chat) =>
      chatView(
        chat,
        summaries.get(toWireId(chat.agent.id)),
        models.get(toWireId(chat.model.id)),
      ),
    );
  }

  private requireRuntime(): void {
    if (!this.executor.configured)
      throw new DomainError(
        "UNAVAILABLE",
        "Chat is not available on this server yet.",
      );
    if (this.executor.isDraining)
      throw new DomainError(
        "UNAVAILABLE",
        "The server is restarting. Send your message again in a moment.",
      );
  }

  // About 20 new messages a minute per member, across chats. One platform
  // process in v1, so memory is the right place. Returns null when over the
  // limit; otherwise a refund for a save that turns out to be a retry, so
  // replays are not counted.
  private admitSend(context: TenantContext): (() => void) | null {
    const key = `${toWireId(context.tenantId)}:${toWireId(context.userId)}`;
    const now = Date.now();
    const recent = (this.recentSends.get(key) ?? []).filter(
      (at) => now - at < RATE_WINDOW_MS,
    );
    if (recent.length >= SENDS_PER_MINUTE) {
      this.recentSends.set(key, recent);
      return null;
    }
    recent.push(now);
    this.recentSends.set(key, recent);
    if (this.recentSends.size > 1_000)
      for (const [k, times] of this.recentSends)
        if (times.every((at) => now - at >= RATE_WINDOW_MS))
          this.recentSends.delete(k);
    return () => {
      const times = this.recentSends.get(key);
      const at = times?.lastIndexOf(now) ?? -1;
      if (at >= 0) times!.splice(at, 1);
    };
  }
}

// A chat as its owner sees it, from its agent's current display fields and
// its model (either missing when gone or unavailable).
function chatView(
  chat: ChatDoc,
  summary: AgentSummary | undefined,
  model: ModelDoc | undefined,
): ChatView {
  const agentGone =
    !summary || (chat.agent.source === "builtin" && !summary.available);
  return {
    ...chatState(chat, model, agentGone),
    agent: summary
      ? {
          id: toWireId(chat.agent.id),
          source: chat.agent.source,
          name: summary.name,
          look: summary.look,
          tint: summary.tint,
        }
      : null,
  };
}

// Everything in a chat's view but its agent.
function chatState(
  chat: ChatDoc,
  model: ModelDoc | undefined,
  agentGone: boolean,
): ChatStateView {
  return {
    id: toWireId(chat._id),
    title: chat.title,
    model: model ? modelView(model) : null,
    readOnly:
      chat.runtime.state === "lost"
        ? "THREAD_LOST"
        : !model
          ? "MODEL_UNAVAILABLE"
          : agentGone
            ? "AGENT_UNAVAILABLE"
            : null,
    activeRunId: chat.activeRun ? toWireId(chat.activeRun.runId) : null,
    status: chat.status,
    lastMessageAt: chat.lastMessageAt.toISOString(),
    createdAt: chat.createdAt.toISOString(),
  };
}

// The agent a turn was just admitted with: usable by definition. An archived
// user agent still runs its existing chats, so this is not `available`.
function summaryOf(agent: ChatAgent): AgentSummary {
  return {
    name: agent.name,
    look: agent.look,
    tint: agent.tint,
    available: true,
  };
}

function insertOf<T extends Document>(
  collection: Collection<T>,
  document: T,
): AnyClientBulkWriteModel<Document> {
  return { namespace: collection.namespace, name: "insertOne", document };
}

export function messageView(message: MessageDoc): MessageView {
  return {
    id: toWireId(message._id),
    seq: message.seq,
    runId: toWireId(message.runId),
    role: message.role,
    text: message.text,
    state: message.state,
    ...(message.clientMessageId
      ? { clientMessageId: message.clientMessageId }
      : {}),
    createdAt: message.createdAt.toISOString(),
  };
}

export function runView(run: RunDoc): RunView {
  const t = run.timings;
  return {
    id: toWireId(run._id),
    status: run.status,
    error: run.error ?? null,
    usage: run.usage ?? null,
    timings: {
      acceptedAt: t.acceptedAt.toISOString(),
      ...(t.dispatchedAt ? { dispatchedAt: t.dispatchedAt.toISOString() } : {}),
      ...(t.firstTextAt ? { firstTextAt: t.firstTextAt.toISOString() } : {}),
      ...(t.completedAt ? { completedAt: t.completedAt.toISOString() } : {}),
    },
  };
}

function chatBusy(): DomainError {
  return new DomainError(
    "CHAT_BUSY",
    "This chat is still answering. Wait for the reply or stop it.",
  );
}

function threadLost(): DomainError {
  return new DomainError(
    "CHAT_READ_ONLY",
    "This conversation's history is no longer available, so it can't continue. Start a new chat.",
  );
}

function rateLimited(): DomainError {
  return new DomainError(
    "RATE_LIMITED",
    "You're sending messages quickly. Wait a moment and try again.",
  );
}

function modelUnavailable(): DomainError {
  return new DomainError(
    "MODEL_UNAVAILABLE",
    "This agent's model is not available right now.",
  );
}

function reusedMessageId(): DomainError {
  return new DomainError(
    "CONFLICT",
    "This message ID was already used for a different message.",
  );
}
