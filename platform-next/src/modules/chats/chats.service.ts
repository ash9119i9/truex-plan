import { Inject, Injectable, Logger } from "@nestjs/common";
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
  type AgentConnectorView,
  type AgentSummary,
  type ChatAgent,
} from "../agents/agents.service";
import type { ConnectorDoc } from "../connectors/connector";
import { connectorView } from "../connectors/connector";
import type { McpConnectionDoc } from "../connectors/connection";
import { ConnectorsCatalogService } from "../connectors/connectors-catalog.service";
import {
  ConnectorsService,
  enabledToolsOf,
  type RunConnectorRef,
  type RunToolApproval,
} from "../connectors/connectors.service";
import type { McpServerSpec } from "../connectors/mcp-server-spec";
import { invalid } from "../../common/validation";
import { AuditService } from "../audit/audit.service";
import {
  applyNetworkGrants,
  decisionAllowed,
  MAX_CHAT_NETWORK_GRANTS,
  type ChatNetworkGrant,
  type MessageNetwork,
  type NetworkDecision,
} from "../network/network-grants";
import {
  buildNetworkPolicy,
  type RequestMethod,
  type RunNetworkConnector,
  type RunNetworkPolicy,
} from "../network/network-policy";
import { TenantNetworkService } from "../network/tenant-network.service";
import { modelView, type ModelDoc, type ModelView } from "../models/model";
import { ModelsService } from "../models/models.service";
import {
  CHAT_FILES_COLLECTION,
  CHAT_LIST_PAGE,
  CHAT_UPLOADS_COLLECTION,
  HISTORY_PAGE,
  isSettled,
  PLATFORM_INSTRUCTIONS_VERSION,
  SENDS_PER_MINUTE,
  STEERS_PER_RUN,
  textHashOf,
  titleOf,
  titleOfFiles,
  type AgentSource,
  type ApprovalAnswer,
  type ChatConnector,
  type ChatDoc,
  type ChatToolApproval,
  type FollowUpsAssignment,
  type MessageDoc,
  type MessageState,
  type MessageActivity,
  type MessageAgent,
  type MessageSkill,
  type MessageTool,
  type RunDoc,
  type RunErrorInfo,
  type RunPlan,
  type RunStatus,
  type RunUsage,
  type SendInput,
  type StartChatInput,
  type SteerDoc,
} from "./chat";
import { ChatFilesService, MAX_UNSAVED, type ChatFileView } from "./chat-files";
import {
  AttachmentsGoneError,
  ChatUploadsService,
  checkClaims,
  MAX_CHAT_UPLOAD_BYTES,
  planAttachments,
  runtimeImages,
  runtimeText,
  type AttachmentPlan,
  type ChatUploadDoc,
} from "./chat-uploads";
import { chatPrompt } from "./chat-prompt";
import type { FollowUpItem } from "./followups";
import {
  ChatStore,
  LEASE_MS,
  type ChatCollections,
  type SettleResult,
} from "./chat-store";
import { signGatewayToken } from "./gateway-token";
import { SkillsService } from "../skills/skills.service";
import { RunExecutor, type Dispatch } from "./run-executor";
import { AdapterUnreachable, type StartRunBody } from "./runtime-client";

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
  // The chat's snapshotted connectors as views, always present ([] when none).
  connectors: AgentConnectorView[];
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
  role: "user" | "assistant" | "tool";
  text: string;
  state: MessageState;
  clientMessageId?: string;
  // Role `tool` only: the connector-tool-call summary.
  tool?: MessageTool;
  // Role `tool` only: a command or file change in the chat's workspace.
  activity?: MessageActivity;
  // Role `tool` only: a skill the reply used.
  skill?: MessageSkill;
  // Role `tool` only: a sandbox request the network proxy refused, with the
  // owner's answer once given.
  network?: NetworkView;
  // Role `tool` only: a helper agent the reply used, with its result.
  agent?: MessageAgent;
  // Role `user` only: the files attached to it.
  attachments?: AttachmentView[];
  createdAt: string;
}

export type NetworkView = Omit<MessageNetwork, "decidedAt">;

export interface AttachmentView {
  fileId: string;
  name: string;
  path: string;
  size: number;
  contentType: string;
}

export interface SteerView {
  clientMessageId: string;
  text: string;
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
  // The messages added to the reply, while it is unsettled; once it is,
  // they are saved messages.
  steers?: SteerView[];
  // Files the reply wrote that couldn't be saved; absent when none.
  unsavedFiles?: string[];
  // Files the reply wrote that are too large to save; absent when none.
  tooLargeFiles?: string[];
  // Some files weren't checked; absent otherwise.
  filesTruncated?: true;
  // The rows a completed reply offered, while Follow Ups are on. Only the
  // items: status, shape and stage stay in the database for the report.
  followUps?: { items: FollowUpItem[] };
  // The reply's last checklist, as the model left it; absent when it never
  // planned.
  plan?: RunPlan;
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

// A message sent while the chat was replying joined that reply (a steer).
// It has `steer` and no `message`; `run` is the reply it joined.
export interface SteerReceipt {
  chat: ChatStateView;
  run: RunView;
  steer: SteerView;
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
// How long a message that arrived as a reply ended waits for that reply to be
// saved before it is sent as the next one.
const STEER_FALLBACK_WAIT_MS = 15_000;
const SETTLED_STATUSES: RunStatus[] = ["completed", "stopped", "failed"];
// Orphaned chats one sweep takes per tenant; the rest wait a sweep.
const RECOVERY_BATCH = 100;
const RECOVERY_FAILED: RunErrorInfo = {
  code: "RUNTIME_ERROR",
  message: "The assistant couldn't run this message. Try again.",
  retryable: true,
};

// Private chats with one agent each. Every read and write filters by the
// caller's tenant database and ownerId; another member's chat and a missing
// one are the same 404.
@Injectable()
export class ChatsService {
  private readonly logger = new Logger("Chats");
  private readonly recentSends = new Map<string, number[]>();
  // Replies whose files are being retried here.
  private readonly retrying = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ChatStore) private readonly store: ChatStore,
    @Inject(RunExecutor) private readonly executor: RunExecutor,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(ModelsService) private readonly models: ModelsService,
    @Inject(ConnectorsService)
    private readonly connectors: ConnectorsService,
    @Inject(ConnectorsCatalogService)
    private readonly connectorCatalog: ConnectorsCatalogService,
    @Inject(ChatFilesService) private readonly chatFiles: ChatFilesService,
    @Inject(ChatUploadsService) private readonly uploads: ChatUploadsService,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(TenantNetworkService)
    private readonly tenantNetwork: TenantNetworkService,
    @Inject(AuditService) private readonly audit: AuditService,
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
    // Read alongside the agent; needed only once its connectors are known.
    const tenantHosts = this.tenantHosts(context);
    const connections = this.connectors.ownerConnections(
      context.dbName,
      context.userId,
    );
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

    // The connectors the chat snapshots from the resolved agent. runSpecs is
    // called before anything is saved and only when the agent has connectors,
    // so a text-only chat makes zero extra Mongo round trips and a connector
    // chat makes exactly one tenant read (the connections find). A missing or
    // reconnect-needed connection refuses the whole start — no chat, message,
    // run or runtime call — routed through startRefused so a retry of a
    // committed start still gets its receipt.
    const connectors = agent.connectors;
    let mcp: McpServerSpec[];
    let network: RunNetworkPolicy | undefined;
    let staged: ChatUploadDoc[];
    try {
      // A new chat has no per-chat approvals yet, so none are forwarded.
      let resolved: RunConnectors;
      [resolved, staged] = await Promise.all([
        this.runMcpSpecs(context, connectors, undefined, connections),
        this.stagedUploads(context, input.attachments),
      ]);
      mcp = resolved.mcp;
      ({ network } = await this.runNetwork(
        context,
        resolved.network,
        undefined,
        tenantHosts,
      ));
    } catch (error) {
      refund();
      if (error instanceof DomainError)
        return this.startRefused(context, input, error);
      throw error;
    }

    // The agent's enabled skills at their current versions, from the catalog
    // cache (no query). Fixed for the chat's life.
    const skills = await this.skills.snapshot(agent.skillIds);

    const now = new Date();
    const chat: ChatDoc = {
      _id: new ObjectId(),
      ownerId: context.userId,
      title: input.text
        ? titleOf(input.text)
        : titleOfFiles(staged.map((u) => u.name)),
      agent: { source: agent.source, id: agent.id, revision: agent.revision },
      model: { id: model._id, revision: model.revision },
      ...(connectors.length ? { connectors } : {}),
      ...(skills.length ? { skills } : {}),
      ...(agent.helpers ? { helpers: true as const } : {}),
      platformInstructionsVersion: PLATFORM_INSTRUCTIONS_VERSION,
      followUps: this.followUpsForNewChat(),
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
    const plan = this.attachmentPlan(
      context,
      chat,
      message,
      staged,
      new Map(),
      3,
    );
    if (plan) {
      message.attachments = plan.attachments;
      chat.uploadBytes = plan.bytes;
    }
    try {
      // The chat, its first message and run in one call, then the commit.
      await timed("save", () =>
        this.database.withTransaction(async (session) => {
          const result = await this.database.bulkWrite(
            [
              insertOf(chats, chat),
              insertOf(messages, message),
              insertOf(runs, run),
              ...(plan?.writes ?? []),
            ],
            session,
            plan !== null,
          );
          if (plan) checkClaims(result, plan.claims);
        }),
      );
    } catch (error) {
      if (!isDuplicateKeyError(error) && !isAttachmentsGone(error)) throw error;
      // A retry, or the same send racing itself: not a new message.
      refund();
      const raced = await timed("replay", () =>
        this.replayStart(context, input),
      );
      if (!raced) throw error;
      return raced;
    }
    this.executor.begin(
      this.dispatchOf(context, chat, run, message, agent, model, "start", {
        mcp,
        ...(network ? { network } : {}),
        toolNames: await this.connectorNames(chat.connectors),
        writeToolNames: await this.writeToolNames(chat.connectors),
      }),
    );
    return {
      chat: chatView(
        chat,
        summaryOf(agent),
        model,
        await this.connectorViews(chat.connectors),
      ),
      message: messageView(message),
      run: runView(run, this.followUpsEnabled),
      created: true,
    };
  }

  // The same approach as start: the retry check runs only when the save hits
  // the unique index chat_client_message_unique, or before any refusal. The
  // claim, the message and the run are one call; the claim also requires the
  // chat to be as it was read, and matching nothing aborts the transaction.
  // A chat that is replying takes the message into that reply (steer).
  async send(
    context: TenantContext,
    chatId: ObjectId,
    input: SendInput,
    // A message that arrived as the reply ended is sent as the next one,
    // once; that second attempt does not fall back again.
    allowFallback = true,
  ): Promise<SendReceipt | SteerReceipt> {
    this.requireRuntime();
    // Read alongside the chat; a steer or a refusal leaves them unused.
    const tenantHosts = this.tenantHosts(context);
    const connections = this.connectors.ownerConnections(
      context.dbName,
      context.userId,
    );
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
      // A retry of a message saved already, or of one that started this run.
      const replay = await timed("replay", () =>
        this.replaySend(context, chat, input),
      );
      if (replay) return replay;
      // Files go into the workspace before a run starts, never mid-reply.
      if (input.attachments.length > 0)
        throw new DomainError(
          "CHAT_BUSY",
          "Files can't be added to a reply while it's being written. Wait for it to finish, then send them.",
        );
      return this.steer(
        context,
        chat,
        chat.activeRun.runId,
        input,
        allowFallback,
      );
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

    // Connectors are checked before anything is saved, only when the chat
    // snapshotted some (zero extra Mongo work for a text-only chat; exactly
    // one tenant read otherwise). A missing connection refuses the send with
    // nothing written, through refuse so a committed retry still replays.
    let mcp: McpServerSpec[];
    let network: RunNetworkPolicy | undefined;
    let networkOnce: ObjectId[] = [];
    let staged: ChatUploadDoc[];
    let versions: Map<string, number>;
    try {
      let resolved: RunConnectors;
      [resolved, staged] = await Promise.all([
        this.runMcpSpecs(
          context,
          chat.connectors ?? [],
          chat.toolApprovals,
          connections,
        ),
        this.stagedUploads(context, input.attachments),
      ]);
      mcp = resolved.mcp;
      ({ network, networkOnce } = await this.runNetwork(
        context,
        resolved.network,
        chat.networkGrants,
        tenantHosts,
      ));
      const bytes = staged.reduce((sum, u) => sum + u.size, 0);
      if ((chat.uploadBytes ?? 0) + bytes > MAX_CHAT_UPLOAD_BYTES)
        throw new DomainError(
          "LIMIT_REACHED",
          `This chat already holds ${MAX_CHAT_UPLOAD_BYTES / (1024 * 1024)} MB of attached files. Start a new chat to attach more.`,
        );
      versions = await this.chatFiles.latestVersionNumbers(
        context.dbName,
        chat._id,
        staged.map((u) => `uploads/${u.name}`),
      );
    } catch (error) {
      refund();
      if (error instanceof DomainError) return refuse(error);
      throw error;
    }

    const now = new Date();
    const runId = new ObjectId();
    const turn = this.newTurn(context, chat, chat.nextSeq, input, now, runId);
    const activeRun = {
      runId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    };
    const { chats, messages, runs } = this.db(context);
    const plan = this.attachmentPlan(
      context,
      chat,
      turn.message,
      staged,
      versions,
      3,
    );
    if (plan) turn.message.attachments = plan.attachments;
    const bytes = plan?.bytes ?? 0;
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
                  // And only while the attached files still fit.
                  ...(bytes
                    ? {
                        $or: [
                          { uploadBytes: { $exists: false } },
                          {
                            uploadBytes: {
                              $lte: MAX_CHAT_UPLOAD_BYTES - bytes,
                            },
                          },
                        ],
                      }
                    : {}),
                },
                update: {
                  $set: { activeRun, lastMessageAt: now, updatedAt: now },
                  $inc: {
                    nextSeq: 1,
                    ...(bytes ? { uploadBytes: bytes } : {}),
                  },
                },
              },
              insertOf(messages, turn.message),
              insertOf(runs, turn.run),
              ...(plan?.writes ?? []),
            ],
            session,
            plan !== null,
          );
          // Aborts the inserts with it.
          const claimed = plan
            ? result.updateResults?.get(0)?.matchedCount
            : result.matchedCount;
          if (claimed !== 1) throw chatBusy();
          if (plan) checkClaims(result, plan.claims);
        }),
      );
    } catch (error) {
      const busy = error instanceof DomainError && error.code === "CHAT_BUSY";
      const gone = isAttachmentsGone(error);
      if (!busy && !gone && !isDuplicateKeyError(error)) throw error;
      refund();
      const raced = await timed("replay", () =>
        this.replaySend(context, chat, input),
      );
      if (raced) return raced;
      if (gone) throw error;
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
        {
          mcp,
          ...(network ? { network } : {}),
          ...(networkOnce.length ? { networkOnce } : {}),
          toolNames: await this.connectorNames(chat.connectors),
          writeToolNames: await this.writeToolNames(chat.connectors),
        },
      ),
    );
    const latest: ChatDoc = {
      ...chat,
      activeRun,
      nextSeq: chat.nextSeq + 1,
      lastMessageAt: now,
      updatedAt: now,
    };
    const connectors = await this.connectorViews(latest.connectors);
    return {
      chat: agent
        ? chatView(latest, summaryOf(agent), model, connectors)
        : chatState(latest, model, false, connectors),
      message: messageView(turn.message),
      run: runView(turn.run, this.followUpsEnabled),
      created: true,
    };
  }

  // Adds the message to the reply being written. It is saved on the run
  // first, so settle writes it where the runtime used it, or as `not_sent`
  // when the runtime never read it. A reply that ended meanwhile gets the
  // message as its next one instead (fallback).
  private async steer(
    context: TenantContext,
    chat: ChatDoc,
    runId: ObjectId,
    input: SendInput,
    allowFallback: boolean,
  ): Promise<SendReceipt | SteerReceipt> {
    const { runs } = this.db(context);
    const owned = { _id: runId, chatId: chat._id, ownerId: context.userId };
    if (!this.executor.isLive(runId))
      await timed("recover", () => this.recoverIfOrphaned(context, chat));
    const textHash = textHashOf(input.text);
    const steer: SteerDoc = {
      clientMessageId: input.clientMessageId,
      text: input.text,
      textHash,
      createdAt: new Date(),
    };

    // A retry of a steer already on the run, or why it can't take one.
    const refused = async (): Promise<SteerReceipt | "fallback"> => {
      const run = await timed("run", () => runs.findOne(owned));
      if (!run) throw chatBusy();
      const mine = run.steers?.find(
        (s) => s.clientMessageId === input.clientMessageId,
      );
      if (mine) {
        if (mine.textHash !== textHash) throw reusedMessageId();
        return this.steerReceipt(chat, run, mine, false);
      }
      if (isSettled(run.status) || run.stopRequested) return "fallback";
      if ((run.steers?.length ?? 0) >= STEERS_PER_RUN) throw steerLimit();
      throw chatBusy();
    };

    const refund = this.admitSend(context);
    if (!refund) {
      const replay = await refused().catch(() => null);
      if (replay && replay !== "fallback") return replay;
      throw rateLimited();
    }
    const run = await timed("steer", () =>
      runs.findOneAndUpdate(
        {
          ...owned,
          status: { $nin: SETTLED_STATUSES },
          stopRequested: { $ne: true },
          "steers.clientMessageId": { $ne: input.clientMessageId },
          [`steers.${STEERS_PER_RUN - 1}`]: { $exists: false },
        },
        { $push: { steers: steer }, $set: { updatedAt: steer.createdAt } },
        { returnDocument: "after" },
      ),
    );
    if (!run) {
      refund();
      const answer = await refused();
      if (answer !== "fallback") return answer;
      return this.steerFallback(context, chat, runId, input, allowFallback);
    }

    const outcome = await timed("runtime", () =>
      this.executor.steer(
        runId,
        { tenantId: toWireId(context.tenantId), chatId: toWireId(chat._id) },
        { text: input.text, clientMessageId: input.clientMessageId },
      ),
    );
    // Taken, or sent with its answer lost: either way settle decides where
    // it goes, and it is never sent again.
    if (outcome === "queued" || outcome === "unknown")
      return this.steerReceipt(chat, run, steer, true);

    // Nothing was delivered: take it back off the run, unless the run
    // settled with it meanwhile, or (for a reply that ended) is being
    // stopped, when the member sees it as not sent.
    const withdrawn = await timed("withdraw", () =>
      runs.updateOne(
        {
          ...owned,
          status: { $nin: SETTLED_STATUSES },
          ...(outcome === "ended" ? { stopRequested: { $ne: true } } : {}),
        },
        {
          $pull: { steers: { clientMessageId: input.clientMessageId } },
          $set: { updatedAt: new Date() },
        },
      ),
    );
    if (withdrawn.modifiedCount !== 1) {
      const current = await timed("run", () => runs.findOne(owned));
      if (current && !isSettled(current.status))
        return this.steerReceipt(chat, current, steer, true);
      const saved = await timed("replay", () =>
        this.replaySend(context, chat, input),
      );
      if (saved) return saved;
      throw chatBusy();
    }
    refund();
    switch (outcome) {
      case "ended":
        return this.steerFallback(context, chat, runId, input, allowFallback);
      case "limit":
        throw steerLimit();
      case "not_found":
        throw chatBusy();
      default:
        throw new DomainError(
          "UNAVAILABLE",
          "The assistant couldn't take this message. Try again.",
        );
    }
  }

  // The reply ended as the message arrived: once it is saved, the message
  // is sent as the next one.
  private async steerFallback(
    context: TenantContext,
    chat: ChatDoc,
    runId: ObjectId,
    input: SendInput,
    allowFallback: boolean,
  ): Promise<SendReceipt | SteerReceipt> {
    if (!allowFallback) throw chatBusy();
    await timed("wait", () =>
      this.executor.waitClosed(runId, STEER_FALLBACK_WAIT_MS),
    );
    return this.send(context, chat._id, input, false);
  }

  private async steerReceipt(
    chat: ChatDoc,
    run: RunDoc,
    steer: SteerDoc,
    created: boolean,
  ): Promise<SteerReceipt> {
    const model = await this.models.enabledById(chat.model.id);
    return {
      chat: chatState(
        chat,
        model ?? undefined,
        false,
        await this.connectorViews(chat.connectors),
      ),
      run: runView(run, this.followUpsEnabled),
      steer: steerView(steer),
      created,
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

  // Every stored version of the chat's files, newest first.
  async files(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<ChatFileView[]> {
    await this.findOwned(context, chatId);
    return this.chatFiles.list(context.dbName, chatId);
  }

  // Tries again to store the files a settled reply couldn't. Returns the
  // versions stored and the paths that still failed; a path no longer in
  // the chat (or stored meanwhile by a later reply) is dropped. Refused
  // while the chat answers, so a retry never reads a file mid-edit, and one
  // at a time per reply in this process.
  async retryFiles(
    context: TenantContext,
    chatId: ObjectId,
    runId: ObjectId,
  ): Promise<{ files: ChatFileView[]; unsaved: string[]; tooLarge: string[] }> {
    this.requireRuntime();
    const chat = await this.findOwned(context, chatId);
    const { runs } = this.db(context);
    const owned = { _id: runId, chatId, ownerId: context.userId };
    const run = await runs.findOne(owned);
    if (!run) throw new DomainError("NOT_FOUND", "This reply does not exist.");
    const paths = run.unsavedFiles ?? [];
    if (paths.length === 0) return { files: [], unsaved: [], tooLarge: [] };
    if (!isSettled(run.status) || chat.activeRun) throw chatBusy();
    const key = toWireId(runId);
    if (this.retrying.has(key))
      throw new DomainError(
        "CONFLICT",
        "These files are already being saved. Wait a moment.",
      );
    this.retrying.add(key);
    try {
      const result = await this.executor.retryFiles(
        {
          dbName: context.dbName,
          tenantId: toWireId(context.tenantId),
          chatId,
          ownerId: context.userId,
          runId,
          ref: {
            tenantId: toWireId(context.tenantId),
            chatId: toWireId(chatId),
          },
        },
        new Set(paths),
      );
      if (!result)
        throw new DomainError(
          "UNAVAILABLE",
          "Files can't be saved on this server.",
        );
      const { stored, unsaved, tooLarge } = result;
      // A file that grew past the per-file limit moves to the run's too
      // large files: it is never retried again.
      const kept = [
        ...new Set([...(run.tooLargeFiles ?? []), ...tooLarge]),
      ].slice(0, MAX_UNSAVED);
      await runs.updateOne(owned, {
        $set: {
          updatedAt: new Date(),
          ...(unsaved.length ? { unsavedFiles: unsaved } : {}),
          ...(kept.length ? { tooLargeFiles: kept } : {}),
        },
        ...(unsaved.length ? {} : { $unset: { unsavedFiles: "" } }),
      });
      return { files: stored, unsaved, tooLarge };
    } finally {
      this.retrying.delete(key);
    }
  }

  // One stored file version's bytes; the owner filter is on the file read.
  openFile(context: TenantContext, chatId: ObjectId, fileId: ObjectId) {
    return this.chatFiles.open(context.dbName, chatId, context.userId, fileId);
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
          // Everything the run wrote after its own message.
          messages: await timed("saved", () =>
            messages
              .find({ runId, _id: { $ne: run.userMessageId } })
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

  // The member's answer to a write-tool approval on their own chat's reply
  // that is still being written. A run this process reads is checked from
  // memory; otherwise one owner-filtered chat read. First answer wins. The
  // chat allow and audit record are written by the run's reader when the
  // runtime reports the approval resolved, so a retried answer changes
  // nothing.
  async answerApproval(
    context: TenantContext,
    chatId: ObjectId,
    runId: ObjectId,
    approvalId: string,
    decision: ApprovalAnswer,
  ): Promise<{ decision: ApprovalAnswer }> {
    this.requireRuntime();
    const here = this.executor.liveFor(
      context.dbName,
      chatId,
      runId,
      context.userId,
    );
    if (here !== "running") {
      if (here) throw approvalNotFound();
      const chat = await timed("chat", () => this.findOwned(context, chatId));
      if (!chat.activeRun?.runId.equals(runId)) throw approvalNotFound();
    }
    let outcome;
    try {
      outcome = await timed("runtime", () =>
        this.executor.answerApproval(
          runId,
          { tenantId: toWireId(context.tenantId), chatId: toWireId(chatId) },
          approvalId,
          decision,
        ),
      );
    } catch (error) {
      if (error instanceof AdapterUnreachable)
        throw new DomainError(
          "UNAVAILABLE",
          "Your answer couldn't reach the assistant. Try again.",
        );
      throw new DomainError(
        "UNAVAILABLE",
        "Your answer couldn't be sent. Try again.",
      );
    }
    if (outcome === "resolved")
      throw new DomainError(
        "APPROVAL_RESOLVED",
        "This request was already answered.",
      );
    if (outcome === "not_found") throw approvalNotFound();
    return { decision };
  }

  // The recovery sweep's work for one tenant: every chat whose run's lease
  // lapsed gets a reader, as opening it would. Recovery reattaches or reads
  // the runtime's history and never posts a message again, so it runs
  // whatever the owner's access is now. Returns how many it looked at.
  async recoverOrphans(
    tenant: { tenantId: ObjectId; dbName: string },
    limit = RECOVERY_BATCH,
  ): Promise<number> {
    if (!this.executor.configured || this.executor.isDraining) return 0;
    const lapsed = await this.store.lapsedChats(
      tenant.dbName,
      new Date(),
      limit,
    );
    for (const chat of lapsed) {
      if (this.executor.isDraining) break;
      const context: TenantContext = {
        userId: chat.ownerId,
        tenantId: tenant.tenantId,
        role: "user",
        dbName: tenant.dbName,
      };
      await this.recoverIfOrphaned(context, chat);
    }
    return lapsed.length;
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
    if (!run || isSettled(run.status)) {
      // Settled but not released, or claimed by a run that does not exist.
      // Neither happens in one transaction; this guards hand-edited data,
      // which would otherwise lock the chat and be swept every minute.
      await this.db(context).chats.updateOne(
        { _id: chat._id, "activeRun.runId": active.runId },
        { $set: { activeRun: null } },
      );
      if (!run)
        this.logger.warn({
          message: "released a chat claimed by a missing run",
          chatId: toWireId(chat._id),
        });
      return;
    }
    const message = await messages.findOne({ _id: run.userMessageId });
    if (!message) {
      // Nothing to recover from: saved as failed, so the chat goes on.
      await this.store.settle(context.dbName, chat._id, run._id, chat.nextSeq, {
        status: "failed",
        error: RECOVERY_FAILED,
        items: [],
        usage: null,
        threadId: null,
        turnId: null,
        threadLost: false,
      });
      this.logger.warn({
        message: "settled a run whose message is missing",
        runId: toWireId(run._id),
      });
      return;
    }
    const model = await this.models.findEnabled(chat.model.id);
    const agent = await this.agents.resolveForChat(context, chat.agent.id, {
      allowArchived: true,
    });
    // Reattach specs: the live token when available, else placeholders that
    // keep the adapter's request-hash surface identical so the thread
    // reattaches rather than restarting. Only for a chat that snapshotted
    // connectors.
    const recovered = await this.recoverMcpSpecs(
      context,
      chat.connectors,
      chat.toolApprovals,
    );
    const mcp = recovered.mcp;
    // Best effort: a recovery never reposts the turn, so a run reattaches
    // without a policy when the tenant's list cannot be read.
    const { network, networkOnce } = await this.runNetwork(
      context,
      recovered.network,
      chat.networkGrants,
    ).catch(() => ({ network: undefined, networkOnce: [] }));
    const toolNames = await this.connectorNames(chat.connectors);
    const writeToolNames = await this.writeToolNames(chat.connectors);
    const lapsed =
      active.leaseExpiresAt.getTime() <= Date.now() ||
      this.executor.abandonedHere(active.runId);
    // A lapsed claim is taken over first; losing that race means another
    // reader has it now.
    if (
      lapsed &&
      !(await this.store.takeOverLease(
        context.dbName,
        chat._id,
        active.runId,
        active.leaseExpiresAt,
      ))
    )
      return;
    this.executor.begin(
      this.dispatchOf(context, chat, run, message, agent, model, "recover", {
        mcp,
        ...(network ? { network } : {}),
        ...(networkOnce.length ? { networkOnce } : {}),
        toolNames,
        writeToolNames,
        ...(lapsed ? {} : { notBefore: active.leaseExpiresAt }),
      }),
    );
  }

  // The MCP server specs for a chat/agent's connectors, resolved before
  // anything is saved. [] (and NO Mongo round trip) when there are none, so a
  // text-only chat costs exactly what it did before connectors existed. With
  // connectors it is exactly one tenant read (the connections find inside
  // ConnectorsService.runSpecs); the catalog comes from its cache. A missing
  // or reconnect-needed connection throws CONNECTION_REQUIRED (409) naming the
  // connectors to connect; an unreachable provider mid-refresh throws
  // UNAVAILABLE. Steers never call this.
  private async runMcpSpecs(
    context: TenantContext,
    connectors: readonly ChatConnector[] | undefined,
    toolApprovals: readonly ChatToolApproval[] | undefined,
    prefetched?: Promise<McpConnectionDoc[]>,
  ): Promise<RunConnectors> {
    if (!connectors || connectors.length === 0) return { mcp: [], network: [] };
    const result = await timed("connectors", () =>
      this.connectors.runSpecs(
        context.dbName,
        context.userId,
        runConnectorRefs(connectors),
        { toolApprovals: approvalRefs(toolApprovals), prefetched },
      ),
    );
    if (result.ok) return { mcp: result.specs, network: result.network };
    const names = result.missing.map((m) => m.displayName);
    throw new DomainError(
      "CONNECTION_REQUIRED",
      `Connect ${joinNames(names)} to use this agent.`,
      { connectors: result.missing },
    );
  }

  // The MCP specs for a recovery reattach. It tries runSpecs; when the
  // connection is gone or the provider cannot be reached, it still builds
  // specs with the same names, URLs, enabled tools and timeouts and a
  // placeholder Authorization value, so the adapter's request hash (which
  // excludes header values — see runtime-adapter manager.ts requestHash) still
  // matches and the thread reattaches instead of restarting. The turn is never
  // reposted on recovery, so a placeholder token is never used to call a
  // provider.
  private async recoverMcpSpecs(
    context: TenantContext,
    connectors: readonly ChatConnector[] | undefined,
    toolApprovals: readonly ChatToolApproval[] | undefined,
  ): Promise<RunConnectors> {
    if (!connectors || connectors.length === 0) return { mcp: [], network: [] };
    try {
      const result = await this.connectors.runSpecs(
        context.dbName,
        context.userId,
        runConnectorRefs(connectors),
        { toolApprovals: approvalRefs(toolApprovals) },
      );
      if (result.ok) return { mcp: result.specs, network: result.network };
    } catch (error) {
      this.logger.warn({
        message: "recovery could not resolve connector tokens",
        chatId: toWireId(context.userId),
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    // No token, so no connection reaches the sandbox network.
    return {
      mcp: await this.placeholderSpecs(connectors, toolApprovals),
      network: [],
    };
  }

  // The run's sandbox network policy, or undefined when the operator has not
  // turned the sandbox network on (CHAT_SANDBOX_NETWORK). The tenant's list
  // comes from a short cache, so this is normally no round trip.
  // The chat's network grants widen it (applyNetworkGrants checks each
  // again); `networkOnce` are the Allow-once grants used, removed when the
  // run ends.
  // `hosts` is the read tenantHosts started earlier, when the caller had one.
  private async runNetwork(
    context: TenantContext,
    connectors: readonly RunNetworkConnector[],
    grants?: readonly ChatNetworkGrant[],
    hosts?: Promise<readonly string[]> | null,
  ): Promise<{ network?: RunNetworkPolicy; networkOnce: ObjectId[] }> {
    if (!this.config.chat?.sandboxNetwork) return { networkOnce: [] };
    const tenantHosts = await (hosts ?? this.tenantHosts(context));
    // Null only with the sandbox network off, returned above; narrows the type.
    if (!tenantHosts) return { networkOnce: [] };
    const { policy, onceIds } = applyNetworkGrants(
      buildNetworkPolicy({ tenantHosts, connectors }),
      grants,
    );
    return { network: policy, networkOnce: onceIds };
  }

  // Starts reading the tenant's hosts for a run, so the read overlaps the
  // other reads before a save. Null when the sandbox network is off. A caller
  // that refuses first never awaits it, so its failure is not left unhandled.
  private tenantHosts(
    context: TenantContext,
  ): Promise<readonly string[]> | null {
    if (!this.config.chat?.sandboxNetwork) return null;
    const hosts = timed("network", () =>
      this.tenantNetwork.runHosts(context.dbName),
    );
    hosts.catch(() => undefined);
    return hosts;
  }

  // The owner's answer to a network card on a saved reply: Allow once, Allow
  // for this chat or Keep blocked. The first answer wins; the same answer
  // again returns it (a retry also completes a grant a crash left unsaved).
  // An allow takes effect from the chat's next reply. Owner only: another
  // member's chat is NOT_FOUND.
  async answerNetwork(
    context: TenantContext,
    chatId: ObjectId,
    messageId: ObjectId,
    decision: NetworkDecision,
  ): Promise<{ decision: NetworkDecision }> {
    const chat = await timed("chat", () => this.findOwned(context, chatId));
    const at = new Date();
    const card = await this.db(context).messages.findOne(
      { _id: messageId, chatId, ownerId: context.userId, role: "tool" },
      { projection: { network: 1, runId: 1 } },
    );
    const block = card?.network;
    if (!card || !block)
      throw new DomainError(
        "APPROVAL_NOT_FOUND",
        "This blocked request was not found.",
      );
    if (!decisionAllowed(block.grant, decision))
      invalid(
        block.grant === "none"
          ? "This request can't be allowed."
          : "This request can only be allowed once.",
      );
    const saved = await this.store.decideNetwork(
      context.dbName,
      chatId,
      context.userId,
      messageId,
      decision,
      at,
    );
    if (!saved?.decision) throw new Error("network decision not saved");
    if (saved.decision !== decision)
      throw new DomainError(
        "APPROVAL_RESOLVED",
        "This request was already answered.",
      );
    if (decision !== "keep_blocked") {
      const grant: ChatNetworkGrant = {
        messageId,
        host: block.host,
        ...(block.kind === "write" && block.connector
          ? {
              connector: block.connector.name,
              method: block.method as RequestMethod,
            }
          : {}),
        scope: decision === "allow_for_chat" ? "chat" : "once",
        at,
      };
      const added = await this.store.addNetworkGrant(
        context.dbName,
        chat._id,
        context.userId,
        grant,
      );
      if (!added)
        throw new DomainError(
          "LIMIT_REACHED",
          `This chat already allows ${MAX_CHAT_NETWORK_GRANTS} requests. Start a new chat to allow more.`,
        );
    }
    await this.store.recordApproval(context.dbName, {
      _id: `net_${toWireId(messageId)}`,
      chatId,
      runId: card.runId,
      userId: context.userId,
      kind: "network",
      connector: block.connector?.name ?? "web",
      tool: `${block.method} ${block.host}`,
      decision:
        decision === "allow_once"
          ? "allow"
          : decision === "allow_for_chat"
            ? "allow_for_chat"
            : "deny",
      auto: false,
      params: [
        { name: "host", value: block.host },
        { name: "method", value: block.method },
        { name: "kind", value: block.kind },
      ],
      at,
    });
    // An allow widens what the chat's sandbox may reach: a security event,
    // recorded by the answer that decided (a retry is not a second one).
    const decidedHere = saved.decidedAt?.getTime() === at.getTime();
    if (decision !== "keep_blocked" && decidedHere)
      await this.audit.record({
        action: "chat.network.allow",
        actor: { kind: "user", userId: context.userId },
        result: "success",
        tenantId: context.tenantId,
        details: {
          chatId: toWireId(chatId),
          host: block.host,
          method: block.method,
          kind: block.kind,
          connector: block.connector?.name ?? null,
          scope: decision === "allow_for_chat" ? "chat" : "once",
        },
      });
    if (decidedHere)
      this.logger.log({
        message: "network request answered",
        chatId: toWireId(chatId),
        host: block.host,
        method: block.method,
        kind: block.kind,
        connector: block.connector?.name,
        decision,
      });
    return { decision };
  }

  // Specs built from the catalog alone, with a placeholder Authorization, for
  // a reattach when the live token is unavailable. A connector that has since
  // been disabled is dropped (no catalog entry); its tools simply do not come
  // back on reattach. Access and approvals are honored so the adapter's MCP
  // fingerprint matches (approvedTools is outside the fingerprint, but
  // enabledTools is part of it — a read_only chat must reattach with the same
  // narrowed list).
  private async placeholderSpecs(
    connectors: readonly ChatConnector[],
    toolApprovals: readonly ChatToolApproval[] | undefined,
  ): Promise<McpServerSpec[]> {
    const catalog = await this.enabledConnectorMap(connectors);
    const approvedByConnector = new Map<string, string[]>();
    for (const approval of toolApprovals ?? []) {
      const tools = approvedByConnector.get(approval.connector) ?? [];
      tools.push(approval.tool);
      approvedByConnector.set(approval.connector, tools);
    }
    const specs: McpServerSpec[] = [];
    for (const { slug, access } of connectors) {
      const connector = catalog.get(slug);
      if (!connector) continue;
      const spec: McpServerSpec = {
        name: connector.slug,
        url: connector.url,
        headers: {
          ...connector.fixedHeaders,
          Authorization: "Bearer unavailable",
        },
        toolTimeoutSec: connector.toolTimeoutSec,
        startupTimeoutSec: connector.startupTimeoutSec,
      };
      const enabledTools = enabledToolsOf(connector, access === "read_only");
      if (enabledTools !== undefined) spec.enabledTools = enabledTools;
      const critical = connector.criticalTools ?? [];
      // A critical tool is never allowed for the chat.
      const approved = approvedByConnector
        .get(connector.slug)
        ?.filter((tool) => !critical.includes(tool));
      if (approved && approved.length > 0) spec.approvedTools = approved;
      if (critical.length > 0) spec.criticalTools = [...critical];
      specs.push(spec);
    }
    return specs;
  }

  // The connectors' display names for the prompt, from the catalog cache
  // (snapshot slug → displayName, falling back to the slug). Empty and no
  // catalog read when the chat has no connectors.
  private async connectorNames(
    connectors: readonly ChatConnector[] | undefined,
  ): Promise<string[]> {
    if (!connectors || connectors.length === 0) return [];
    const catalog = await this.enabledConnectorMap(connectors);
    return connectors.map((c) => catalog.get(c.slug)?.displayName ?? c.slug);
  }

  // The writable tool names the v4 prompt lists: a read_write connector's
  // writeTools, by catalog name. Empty for a read_only chat or one with no
  // write tools, and no catalog read when the chat has no connectors.
  private async writeToolNames(
    connectors: readonly ChatConnector[] | undefined,
  ): Promise<string[]> {
    if (!connectors || connectors.length === 0) return [];
    const catalog = await this.enabledConnectorMap(connectors);
    const names: string[] = [];
    for (const { slug, access } of connectors) {
      if (access === "read_only") continue;
      const connector = catalog.get(slug);
      for (const tool of connector?.writeTools ?? []) names.push(tool);
    }
    return names;
  }

  // The staged uploads a message names. Timed as its own step only when it
  // names some, so a text-only message's timing is unchanged.
  private stagedUploads(
    context: TenantContext,
    ids: readonly ObjectId[],
  ): Promise<ChatUploadDoc[]> {
    return ids.length
      ? timed("uploads", () => this.uploads.staged(context, ids))
      : Promise.resolve([]);
  }

  // The writes that attach the staged uploads to this message, or null when
  // it has none. `offset`: the number of writes before them in the save.
  private attachmentPlan(
    context: TenantContext,
    chat: ChatDoc,
    message: MessageDoc,
    staged: readonly ChatUploadDoc[],
    latest: ReadonlyMap<string, number>,
    offset: number,
  ): AttachmentPlan | null {
    if (staged.length === 0) return null;
    const db = this.database.tenantDb(context.dbName);
    return planAttachments({
      uploads: staged,
      chatId: chat._id,
      ownerId: context.userId,
      runId: message.runId,
      messageId: message._id,
      latest,
      now: message.createdAt,
      uploadsNamespace: `${db.databaseName}.${CHAT_UPLOADS_COLLECTION}`,
      filesNamespace: `${db.databaseName}.${CHAT_FILES_COLLECTION}`,
      offset,
    });
  }

  private dispatchOf(
    context: TenantContext,
    chat: ChatDoc,
    run: RunDoc,
    message: MessageDoc,
    agent: ChatAgent | null,
    model: ModelDoc | null,
    mode: Dispatch["mode"],
    options: {
      mcp?: readonly McpServerSpec[];
      network?: RunNetworkPolicy;
      networkOnce?: readonly ObjectId[];
      toolNames?: readonly string[];
      writeToolNames?: readonly string[];
      notBefore?: Date;
    } = {},
  ): Dispatch {
    const chatConfig = this.config.chat!;
    const tenantId = toWireId(context.tenantId);
    const chatId = toWireId(chat._id);
    const modelId = toWireId(chat.model.id);
    const { mcp, network, networkOnce, toolNames, writeToolNames, notBefore } =
      options;
    // Recovery without a model or agent can still reattach or read history;
    // posting then fails validation in the adapter and settles as failed. The
    // tool names make the v3+ prompt list the chat's connectors; v4 also
    // names the tools that change data.
    const prompt = agent
      ? chatPrompt(agent, chat, toolNames ?? [], writeToolNames ?? [])
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
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      ...(chat.skills?.length ? { skills: chat.skills } : {}),
      ...(networkOnce?.length ? { networkOnce } : {}),
      ...(chat.followUps ? { followUps: chat.followUps } : {}),
      body: {
        runId: toWireId(run._id),
        tenantId,
        chatId,
        threadId: chat.runtime.threadId,
        input: {
          text: runtimeText(message.text, message.attachments),
          clientMessageId: run.clientMessageId,
          ...imagesOf(message.attachments),
        },
        agentPrompt: prompt,
        // Included only when non-empty, so a text-only turn is byte-identical
        // to before. Never logged (it carries per-user Authorization headers).
        ...(mcp && mcp.length ? { mcp } : {}),
        // Only with CHAT_SANDBOX_NETWORK=1. Never logged (connector tokens).
        ...(network ? { network } : {}),
        // The member's coding Allow-for-this-chat answers. Included only when
        // the chat has some; the runtime uses them only with coding on.
        ...codingApprovalsOf(chat),
        ...(chat.skills?.length
          ? {
              skills: chat.skills.map(({ sha256, slug }) => ({ sha256, slug })),
            }
          : {}),
        // Only when the server has CHAT_SUBAGENTS and the chat's agent
        // allowed helpers, so any other run is byte-identical.
        ...(chatConfig.subAgents && chat.helpers
          ? { subAgents: { maxConcurrent: chatConfig.subAgents } }
          : {}),
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
      // A send that becomes a steer never reaches here, so it drops the
      // claim as the plan requires.
      ...(input.followUp
        ? {
            origin: {
              source: "suggestion" as const,
              fromRunId: input.followUp.fromRunId,
              slot: input.followUp.slot,
            },
          }
        : {}),
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
      run: runView(run, this.followUpsEnabled),
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
      runs: runDocs.map((run) => runView(run, this.followUpsEnabled)),
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

    // One catalog read, only when a chat on the page has connectors and
    // connectors are configured; a text-only listing adds no work.
    const connectorCatalog = await this.enabledConnectorMap(
      ...chats.map((c) => c.connectors),
    );
    return chats.map((chat) =>
      chatView(
        chat,
        summaries.get(toWireId(chat.agent.id)),
        models.get(toWireId(chat.model.id)),
        connectorViewsOf(chat.connectors, connectorCatalog),
      ),
    );
  }

  // The enabled catalog connectors keyed by slug. Empty (no read) when
  // connectors are off or no chat in view has any.
  private async enabledConnectorMap(
    ...connectorLists: ReadonlyArray<readonly ChatConnector[] | undefined>
  ): Promise<ReadonlyMap<string, ConnectorDoc>> {
    const empty = new Map<string, ConnectorDoc>();
    if (
      !this.config.connectors ||
      !connectorLists.some((list) => list && list.length > 0)
    )
      return empty;
    return new Map(
      (await this.connectorCatalog.enabledConnectors()).map((c) => [c.slug, c]),
    );
  }

  // One chat's snapshotted connectors as views (the same shape as an agent's).
  private async connectorViews(
    connectors: readonly ChatConnector[] | undefined,
  ): Promise<AgentConnectorView[]> {
    return connectorViewsOf(
      connectors,
      await this.enabledConnectorMap(connectors),
    );
  }

  // Decided once, in the chat-creation transaction: a retried first send
  // returns the chat already created with its original assignment.
  private followUpsForNewChat(): FollowUpsAssignment {
    const chat = this.config.chat;
    if (!chat || chat.followUps === false) return "off";
    const percent = chat.followUpsHoldoutPercent ?? 0;
    return percent > 0 && Math.random() * 100 < percent ? "holdout" : "on";
  }

  // The kill switch: FOLLOW_UPS=off hides stored rows from every API view.
  private get followUpsEnabled(): boolean {
    return (
      this.config.chat !== undefined && this.config.chat.followUps !== false
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
  connectors: AgentConnectorView[],
): ChatView {
  const agentGone =
    !summary || (chat.agent.source === "builtin" && !summary.available);
  return {
    ...chatState(chat, model, agentGone, connectors),
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
  connectors: AgentConnectorView[],
): ChatStateView {
  return {
    id: toWireId(chat._id),
    title: chat.title,
    model: model ? modelView(model) : null,
    connectors,
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

// A chat's snapshotted connectors as views: product-written display fields
// from the catalog. A connector since disabled (not in the enabled map) is
// still shown, named from the stored slug, with `available: false`.
function connectorViewsOf(
  connectors: readonly ChatConnector[] | undefined,
  enabled: ReadonlyMap<string, ConnectorDoc>,
): AgentConnectorView[] {
  return (connectors ?? []).map((ref) => {
    const access = ref.access === "read_only" ? "read_only" : "read_write";
    const connector = enabled.get(ref.slug);
    return connector
      ? {
          slug: connector.slug,
          displayName: connector.displayName,
          icon: connector.icon,
          available: true,
          access,
          writeTools: connector.writeTools ?? [],
        }
      : {
          slug: ref.slug,
          displayName: ref.slug,
          icon: "",
          available: false,
          access,
          writeTools: [],
        };
  });
}

// "GitHub", "GitHub and Jira", "GitHub, Jira and Slack" — for the
// CONNECTION_REQUIRED message. Never a URL or ID.
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "the connector";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// A run's connector resolution: the MCP servers, and the connections whose
// connector has egress data for the sandbox network policy.
interface RunConnectors {
  mcp: McpServerSpec[];
  network: RunNetworkConnector[];
}

// A chat's snapshotted connectors as the refs runSpecs takes: the catalog ID
// with the chat's access choice (absent = read_write).
function runConnectorRefs(
  connectors: readonly ChatConnector[],
): RunConnectorRef[] {
  return connectors.map((c) =>
    c.access === "read_only"
      ? { connectorId: c.connectorId, access: "read_only" as const }
      : c.connectorId,
  );
}

// The chat's per-chat tool approvals as runSpecs takes them, or undefined
// when it has none.
function approvalRefs(
  approvals: readonly ChatToolApproval[] | undefined,
): RunToolApproval[] | undefined {
  if (!approvals || approvals.length === 0) return undefined;
  return approvals.map(({ connector, tool }) => ({ connector, tool }));
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

function isAttachmentsGone(error: unknown): boolean {
  return error instanceof AttachmentsGoneError;
}

function insertOf<T extends Document>(
  collection: Collection<T>,
  document: T,
): AnyClientBulkWriteModel<Document> {
  return { namespace: collection.namespace, name: "insertOne", document };
}

function codingApprovalsOf(
  chat: Pick<ChatDoc, "codingApprovals">,
): Pick<StartRunBody, "codingApprovals"> {
  const commands = chat.codingApprovals?.commands ?? [];
  if (commands.length === 0) return {};
  return { codingApprovals: { commands: [...commands] } };
}

// Included only when the message has images, so other turns are unchanged.
function imagesOf(attachments: MessageDoc["attachments"]): {
  images?: string[];
} {
  const images = runtimeImages(attachments);
  return images.length ? { images } : {};
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
    ...(message.tool ? { tool: message.tool } : {}),
    ...(message.activity ? { activity: message.activity } : {}),
    ...(message.skill ? { skill: message.skill } : {}),
    ...(message.agent ? { agent: message.agent } : {}),
    ...(message.network ? { network: networkView(message.network) } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((a) => ({
            fileId: toWireId(a.fileId),
            name: a.name,
            path: a.path,
            size: a.size,
            contentType: a.contentType,
          })),
        }
      : {}),
    createdAt: message.createdAt.toISOString(),
  };
}

function networkView(network: MessageNetwork): NetworkView {
  const { decidedAt: _at, ...view } = network;
  return view;
}

export function runView(run: RunDoc, showFollowUps = false): RunView {
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
    ...(!isSettled(run.status) && run.steers?.length
      ? { steers: run.steers.map(steerView) }
      : {}),
    ...(run.unsavedFiles?.length ? { unsavedFiles: run.unsavedFiles } : {}),
    ...(run.tooLargeFiles?.length ? { tooLargeFiles: run.tooLargeFiles } : {}),
    ...(run.filesTruncated ? { filesTruncated: true as const } : {}),
    ...(run.plan
      ? {
          plan: {
            explanation: run.plan.explanation,
            steps: run.plan.steps.map(({ step, status }) => ({ step, status })),
          },
        }
      : {}),
    ...(showFollowUps && run.followUps?.items.length
      ? {
          followUps: {
            items: run.followUps.items.map(({ slot, intent, text }) => ({
              slot,
              intent,
              text,
            })),
          },
        }
      : {}),
  };
}

function steerView(steer: SteerDoc): SteerView {
  return {
    clientMessageId: steer.clientMessageId,
    text: steer.text,
    createdAt: steer.createdAt.toISOString(),
  };
}

function chatBusy(): DomainError {
  return new DomainError(
    "CHAT_BUSY",
    "This chat is still answering. Wait for the reply or stop it.",
  );
}

function steerLimit(): DomainError {
  return new DomainError(
    "STEER_LIMIT",
    "This reply already has too many follow-ups. Send it once the reply ends.",
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

function approvalNotFound(): DomainError {
  return new DomainError(
    "APPROVAL_NOT_FOUND",
    "This request has expired or the reply has finished.",
  );
}

function reusedMessageId(): DomainError {
  return new DomainError(
    "CONFLICT",
    "This message ID was already used for a different message.",
  );
}
