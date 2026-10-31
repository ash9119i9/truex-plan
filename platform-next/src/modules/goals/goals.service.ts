import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Collection, ObjectId } from "mongodb";
import type { TenantContext } from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import { toWireId } from "../../database/object-id";
import { CHATS_COLLECTION, type ChatDoc } from "../chats/chat";
import { ChatsService } from "../chats/chats.service";
import { RUNTIME_CLIENT } from "../chats/run-executor";
import {
  AdapterRefusal,
  AdapterUnreachable,
  type ChatRef,
  type GoalOrigin,
  type RuntimeClient,
  type RuntimeGoal,
} from "../chats/runtime-client";
import type { TenantGoals } from "../tenants/tenant";
import { TenantsService } from "../tenants/tenants.service";
import { AuditService } from "../audit/audit.service";
import {
  GOAL_SLOTS_PER_USER,
  GOALS_COLLECTION,
  type GoalDoc,
  type GoalReview,
} from "./goal";
import {
  goalLength,
  MAX_GOAL_OBJECTIVE,
  mergeFeedback,
  type GoalStartInput,
  type RequestChangesInput,
} from "./goal-input";
import { GoalStore } from "./goal-store";
import { GoalWatcher } from "./goal-watcher";

// A goal start still `starting` this long after it began died with its
// process (the adapter's cold start allows 190 s); another start may take
// the chat over.
export const GOAL_START_LAPSE_MS = 5 * 60_000;

const NOT_FOUND = "This chat does not exist or you cannot see it.";
const NO_GOAL = "This chat has no goal.";
const HAS_GOAL = "This chat already has a goal.";
const ENDED = "Goal mode has ended in this chat.";

// What a member sees of their chat's goal.
export interface GoalView {
  objective: string;
  status: RuntimeGoal["status"];
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  origin: GoalOrigin;
  review: GoalReview;
  // The goal document's revision: of two views, the higher one is newer.
  rev: number;
}

export function viewOf(doc: GoalDoc): GoalView {
  const { goal } = doc;
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    origin: doc.origin,
    review: doc.review,
    rev: doc.rev,
  };
}

// A goal chat as the routes read it: owned, active and with goals on.
type GoalChat = ChatDoc & { goals: { maxTokenBudget: number } };

// The owner's goal routes: start (objective and preset), edit the
// objective, pause, resume and clear; and the review (approve, request
// changes, accept as is) and raising the budget. Codex owns the goal; this decides who
// may change it, holds the slots, and records what Codex answered. Making a
// goal active takes a slot first and gives it back if the adapter refuses,
// so no goal runs past a cap and no failed start keeps a slot.
@Injectable()
export class GoalsService implements OnModuleInit {
  private readonly logger = new Logger("Goals");

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RUNTIME_CLIENT) private readonly client: RuntimeClient | null,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(GoalStore) private readonly store: GoalStore,
    @Inject(GoalWatcher) private readonly watcher: GoalWatcher,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.chats.onBeforeArchive((context, chat) =>
      this.endForArchive(context, chat._id),
    );
  }

  // What the chat event stream starts with: the goal, and the run the chat
  // is answering (a goal turn's run can be attached by its ID).
  async snapshot(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ goal: GoalView | null; activeRunId: string | null }> {
    const chat = await this.ownedChat(context, chatId);
    const saved = await this.goalDoc(context, chatId);
    return {
      goal: saved && !saved.ended ? viewOf(saved) : null,
      activeRunId: chat.activeRun ? toWireId(chat.activeRun.runId) : null,
    };
  }

  // Before a chat is archived: its goal is cleared in Codex and goal mode
  // ended, which frees its slot, so an archived chat never runs a goal. A
  // clear that fails refuses the archive and changes nothing.
  private async endForArchive(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<void> {
    const saved = await this.goalDoc(context, chatId);
    if (!saved || saved.ended) return;
    const client = this.requireClient();
    await this.adapter(() => client.clearGoal(refOf(context, chatId)));
    await this.store.endGoal(context.dbName, context.tenantId, chatId);
  }

  async get(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ goal: GoalView | null }> {
    await this.ownedChat(context, chatId);
    const saved = await this.goalDoc(context, chatId);
    return { goal: saved && !saved.ended ? viewOf(saved) : null };
  }

  // One goal per chat. A retry with the same clientRequestId returns the
  // goal it started; the goal the model proposed is started by choosing a
  // preset (its objective may be given too).
  async start(
    context: TenantContext,
    chatId: ObjectId,
    input: GoalStartInput,
  ): Promise<{ goal: GoalView; created: boolean }> {
    const client = this.requireClient();
    const chat = await this.goalChat(context, chatId);
    const settings = await this.settings(context);
    if (
      !settings.presets.includes(input.tokenBudget) ||
      input.tokenBudget > chat.goals.maxTokenBudget
    )
      throw new DomainError(
        "INVALID_INPUT",
        "tokenBudget must be one of the workspace's goal budgets.",
      );
    const saved = await this.goalDoc(context, chatId);
    if (saved?.ended) throw new DomainError("CONFLICT", ENDED);
    const mine = chat.goalStart?.clientRequestId === input.clientRequestId;
    if (mine && chat.goalStart?.state === "started" && saved)
      return { goal: viewOf(saved), created: false };
    const proposal =
      saved?.origin === "model" &&
      saved.goal.status === "paused" &&
      !saved.slotHeld;
    if (saved && !proposal) throw new DomainError("CONFLICT", HAS_GOAL);
    if (!saved && input.objective === undefined)
      throw new DomainError("INVALID_INPUT", "objective is required.");

    const chats = this.chatsOf(context);
    const now = new Date();
    const claimed = await chats.findOneAndUpdate(
      {
        _id: chatId,
        ownerId: context.userId,
        status: "active",
        $or: [
          { goalStart: { $exists: false } },
          {
            "goalStart.state": "starting",
            "goalStart.at": {
              $lt: new Date(now.getTime() - GOAL_START_LAPSE_MS),
            },
          },
        ],
      },
      {
        $set: {
          goalStart: {
            clientRequestId: input.clientRequestId,
            state: "starting",
            at: now,
          },
        },
      },
    );
    if (!claimed) {
      const current = await chats.findOne(
        { _id: chatId },
        { projection: { goalStart: 1 } },
      );
      if (current?.goalStart?.clientRequestId !== input.clientRequestId)
        throw new DomainError("CONFLICT", HAS_GOAL);
      const goal = await this.goalDoc(context, chatId);
      if (current.goalStart.state === "started" && goal && !goal.ended)
        return { goal: viewOf(goal), created: false };
      throw new DomainError(
        "CHAT_BUSY",
        "This goal is still being started. Try again in a moment.",
      );
    }
    const ours = {
      _id: chatId,
      "goalStart.clientRequestId": input.clientRequestId,
    };
    try {
      const goal = await this.activate(context, client, chat, settings, {
        ...(input.objective !== undefined
          ? { objective: input.objective }
          : {}),
        tokenBudget: input.tokenBudget,
      });
      await chats.updateOne(ours, { $set: { "goalStart.state": "started" } });
      return { goal, created: true };
    } catch (error) {
      await chats.updateOne(
        { ...ours, "goalStart.state": "starting" },
        { $unset: { goalStart: "" } },
      );
      throw error;
    }
  }

  // A running goal or a paused one keeps its status; Codex edits the
  // objective in place (tokensUsed and createdAt stay).
  async editObjective(
    context: TenantContext,
    chatId: ObjectId,
    objective: string,
  ): Promise<{ goal: GoalView }> {
    const client = this.requireClient();
    const chat = await this.goalChat(context, chatId);
    const saved = await this.liveGoal(context, chatId);
    const status = saved.goal.status;
    if (status !== "active" && status !== "paused")
      throw new DomainError(
        "CONFLICT",
        "Only a running or paused goal can be edited.",
      );
    const goals = { maxTokenBudget: chat.goals.maxTokenBudget };
    const goal = await this.adapter(async () => {
      if (status === "paused")
        return client.setGoal(refOf(context, chatId), {
          goals,
          status,
          objective,
        });
      return client.setGoal(refOf(context, chatId), {
        goals,
        status,
        objective,
        run: await this.runContext(context, chatId),
      });
    });
    return { goal: await this.record(context, chat, goal, saved.origin) };
  }

  // Pausing a paused goal changes nothing. The slot is given back when the
  // paused goal is recorded.
  async pause(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ goal: GoalView }> {
    const client = this.requireClient();
    const chat = await this.goalChat(context, chatId);
    const saved = await this.liveGoal(context, chatId);
    if (saved.goal.status === "paused") return { goal: viewOf(saved) };
    if (saved.goal.status !== "active")
      throw new DomainError("CONFLICT", "Only a running goal can be paused.");
    const goal = await this.adapter(() =>
      client.setGoal(refOf(context, chatId), {
        goals: { maxTokenBudget: chat.goals.maxTokenBudget },
        status: "paused",
      }),
    );
    return { goal: await this.record(context, chat, goal, saved.origin) };
  }

  async resume(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ goal: GoalView }> {
    const client = this.requireClient();
    const chat = await this.goalChat(context, chatId);
    const saved = await this.liveGoal(context, chatId);
    if (saved.goal.status === "active") return { goal: viewOf(saved) };
    // The statuses Codex's footer offers /goal resume for.
    const status = saved.goal.status;
    if (
      status !== "paused" &&
      status !== "blocked" &&
      status !== "usageLimited"
    )
      throw new DomainError(
        "CONFLICT",
        "Only a paused, stalled or usage-limited goal can be resumed.",
      );
    if (saved.origin === "model")
      throw new DomainError(
        "CONFLICT",
        "Choose a budget to start the proposed goal.",
      );
    const settings = await this.settings(context);
    return {
      goal: await this.activate(context, client, chat, settings, {}),
    };
  }

  // Ends goal mode in the chat: the goal is cleared in Codex, no later
  // update is recorded, and a goal the model creates later is cleared too
  // (GoalWatcher). No goal can be started in the chat again.
  async clear(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ cleared: true }> {
    const client = this.requireClient();
    await this.goalChat(context, chatId);
    await this.liveGoal(context, chatId);
    await this.adapter(() => client.clearGoal(refOf(context, chatId)));
    await this.store.endGoal(context.dbName, context.tenantId, chatId);
    return { cleared: true };
  }

  // Records that the owner approved the goal Codex marked complete. A
  // repeat returns the approved goal and records nothing.
  async approve(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ goal: GoalView }> {
    await this.goalChat(context, chatId);
    const saved = await this.liveGoal(context, chatId);
    if (saved.review === "approved") return { goal: viewOf(saved) };
    const decided = await this.store.decide(context.dbName, chatId, {
      where: { "goal.status": "complete", review: "pending" },
      review: "approved",
      kind: "approved",
    });
    if (!decided)
      throw new DomainError(
        "CONFLICT",
        "Only a goal waiting for your review can be approved.",
      );
    await this.audited(context, "goal.approve", decided);
    return { goal: viewOf(decided) };
  }

  // Reopens the goal Codex marked complete with the owner's feedback merged
  // into its objective, optionally with a higher budget: one set, active.
  // Codex edits the goal in place, so its createdAt and tokensUsed stay. The
  // review is taken first, so of two requests one reopens the goal; a
  // refused set gives it back.
  async requestChanges(
    context: TenantContext,
    chatId: ObjectId,
    input: RequestChangesInput,
  ): Promise<{ goal: GoalView }> {
    const client = this.requireClient();
    const chat = await this.goalChat(context, chatId);
    const saved = await this.liveGoal(context, chatId);
    const notPending = new DomainError(
      "CONFLICT",
      "Only a goal waiting for your review can be sent back with changes.",
    );
    if (saved.goal.status !== "complete" || saved.review !== "pending")
      throw notPending;
    const objective = mergeFeedback(saved.goal.objective, input.feedback);
    const characters = goalLength(objective);
    if (characters > MAX_GOAL_OBJECTIVE)
      throw new DomainError(
        "OBJECTIVE_TOO_LONG",
        `The objective with your feedback would be ${characters} characters; the limit is ${MAX_GOAL_OBJECTIVE}. Shorten the feedback.`,
        { characters, maxCharacters: MAX_GOAL_OBJECTIVE },
      );
    if (input.tokenBudget !== undefined)
      this.checkBudget(chat, saved, input.tokenBudget);
    const settings = await this.settings(context);
    const taken = await this.store.decide(context.dbName, chatId, {
      where: { rev: saved.rev, "goal.status": "complete", review: "pending" },
      review: "none",
    });
    if (!taken) throw notPending;
    let goal: GoalView;
    try {
      goal = await this.activate(context, client, chat, settings, {
        objective,
        ...(input.tokenBudget !== undefined
          ? { tokenBudget: input.tokenBudget }
          : {}),
      });
    } catch (error) {
      await this.store.decide(context.dbName, chatId, {
        where: { "goal.status": "complete", review: "none" },
        review: "pending",
      });
      throw error;
    }
    const decided = await this.store.decide(context.dbName, chatId, {
      where: {},
      kind: "changes_requested",
    });
    await this.audited(context, "goal.request_changes", decided ?? saved);
    return { goal: decided ? viewOf(decided) : goal };
  }

  // A new budget above what the goal has used and at most the chat's
  // maximum. A budget-limited goal becomes active again and takes a slot; a
  // running or paused goal keeps its status.
  async raiseBudget(
    context: TenantContext,
    chatId: ObjectId,
    tokenBudget: number,
  ): Promise<{ goal: GoalView }> {
    const client = this.requireClient();
    const chat = await this.goalChat(context, chatId);
    const saved = await this.liveGoal(context, chatId);
    const status = saved.goal.status;
    if (
      status !== "active" &&
      status !== "paused" &&
      status !== "budgetLimited"
    )
      throw new DomainError(
        "CONFLICT",
        "Only a running, paused or budget-limited goal's budget can be raised.",
      );
    if (saved.origin === "model")
      throw new DomainError(
        "CONFLICT",
        "Choose a budget to start the proposed goal.",
      );
    this.checkBudget(chat, saved, tokenBudget);
    const goals = { maxTokenBudget: chat.goals.maxTokenBudget };
    let goal: GoalView;
    if (status === "budgetLimited")
      goal = await this.activate(
        context,
        client,
        chat,
        await this.settings(context),
        { tokenBudget },
      );
    else {
      const set = await this.adapter(async () =>
        status === "paused"
          ? client.setGoal(refOf(context, chatId), {
              goals,
              status,
              tokenBudget,
            })
          : client.setGoal(refOf(context, chatId), {
              goals,
              status,
              tokenBudget,
              run: await this.runContext(context, chatId),
            }),
      );
      goal = await this.record(context, chat, set, saved.origin);
    }
    await this.audited(context, "goal.raise_budget", {
      ...saved,
      goal: { ...saved.goal, tokenBudget },
    });
    return { goal };
  }

  // Ends the review of a goal that ran out of budget at the chat's maximum,
  // recorded as achieved. A repeat returns it and records nothing.
  async acceptAsIs(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<{ goal: GoalView }> {
    const chat = await this.goalChat(context, chatId);
    const saved = await this.liveGoal(context, chatId);
    if (saved.review === "accepted_as_is") return { goal: viewOf(saved) };
    const decided = await this.store.decide(context.dbName, chatId, {
      where: {
        "goal.status": "budgetLimited",
        "goal.tokenBudget": chat.goals.maxTokenBudget,
        review: { $ne: "accepted_as_is" },
      },
      review: "accepted_as_is",
      kind: "accepted_as_is",
    });
    if (!decided)
      throw new DomainError(
        "CONFLICT",
        "Only a goal that used its whole budget at the maximum can be accepted as is. Raise its budget instead.",
      );
    await this.audited(context, "goal.accept_as_is", decided);
    return { goal: viewOf(decided) };
  }

  // Codex keeps a goal budget-limited unless the budget is above what it
  // has used; the chat's maximum is the most Codex accepts.
  private checkBudget(chat: GoalChat, saved: GoalDoc, tokenBudget: number) {
    const max = chat.goals.maxTokenBudget;
    if (tokenBudget <= saved.goal.tokensUsed || tokenBudget > max)
      throw new DomainError(
        "INVALID_INPUT",
        `tokenBudget must be above the ${saved.goal.tokensUsed} tokens the goal has used and at most ${max}.`,
      );
  }

  // The owner's decision, as a security audit event: no objective or
  // feedback text.
  private async audited(
    context: TenantContext,
    action: string,
    goal: GoalDoc,
  ): Promise<void> {
    await this.audit.record({
      action,
      actor: { kind: "user", userId: context.userId },
      result: "success",
      tenantId: context.tenantId,
      details: {
        chatId: toWireId(goal.chatId),
        status: goal.goal.status,
        tokenBudget: goal.goal.tokenBudget,
        tokensUsed: goal.goal.tokensUsed,
      },
    });
  }

  // Takes a slot, makes the goal active in Codex (which resumes the thread
  // and starts the goal's turns), records it as the member's, marks the slot
  // held and watches the chat. A refusal gives the slot back; an unanswered
  // request is paused first, in case it landed.
  private async activate(
    context: TenantContext,
    client: RuntimeClient,
    chat: GoalChat,
    settings: TenantGoals,
    change: { objective?: string; tokenBudget?: number },
  ): Promise<GoalView> {
    const { dbName, tenantId } = context;
    const ownerId = chat.ownerId;
    if (
      !(await this.store.takeSlot(
        dbName,
        tenantId,
        ownerId,
        settings.maxActive,
      ))
    )
      throw new DomainError(
        "GOAL_LIMIT",
        (await this.store.userSlots(dbName, tenantId, ownerId)) >=
          GOAL_SLOTS_PER_USER
          ? `${GOAL_SLOTS_PER_USER} goals running. Pause or finish one.`
          : "Your workspace has as many goals running as it allows. Pause or finish one.",
      );
    const ref = refOf(context, chat._id);
    const goals = { maxTokenBudget: chat.goals.maxTokenBudget };
    let goal: RuntimeGoal;
    try {
      const run = await this.runContext(context, chat._id);
      goal = await client.setGoal(ref, {
        goals,
        status: "active",
        ...change,
        run,
      });
    } catch (error) {
      if (error instanceof AdapterUnreachable)
        await client
          .setGoal(ref, { goals, status: "paused" })
          .catch(() => undefined);
      await this.store.giveSlot(dbName, tenantId, ownerId);
      throw this.goalError(error);
    }
    const view = await this.record(context, chat, goal, "user");
    await this.store.adoptSlot(dbName, tenantId, chat._id, ownerId);
    // Not watched here (another process holds it, or this failed): the
    // goal sweep takes it over.
    await this.watcher
      .watch({ tenantId, dbName }, chat._id)
      .catch((error: unknown) =>
        this.logger.warn({
          message: "goal watch could not start",
          chatId: toWireId(chat._id),
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    return view;
  }

  // What resuming the chat's thread needs, or a refusal saying why not.
  private async runContext(context: TenantContext, chatId: ObjectId) {
    const run = await this.chats.goalRunContext(
      { tenantId: context.tenantId, dbName: context.dbName },
      chatId,
    );
    if (!run)
      throw new DomainError(
        "CHAT_READ_ONLY",
        "This chat can't run a goal now. Send a message first, or check its agent and model.",
      );
    return run;
  }

  // Records what Codex answered and returns the goal as saved.
  private async record(
    context: TenantContext,
    chat: ChatDoc,
    goal: RuntimeGoal,
    origin: GoalOrigin,
  ): Promise<GoalView> {
    const { goal: saved } = await this.store.recordUpdate(
      context.dbName,
      context.tenantId,
      { chatId: chat._id, ownerId: chat.ownerId },
      { goal, origin, position: null },
    );
    const now = saved ?? (await this.goalDoc(context, chat._id));
    if (!now) throw new Error("goal update left no goal document");
    return viewOf(now);
  }

  private async adapter<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.goalError(error);
    }
  }

  // Adapter refusals and silences as the member's errors; anything else
  // as it was.
  private goalError(error: unknown): unknown {
    if (error instanceof AdapterRefusal && error.code === "CHAT_BUSY")
      return new DomainError(
        "CHAT_BUSY",
        "Wait for the reply to finish, or stop it, then try again.",
      );
    if (
      error instanceof AdapterRefusal ||
      error instanceof AdapterUnreachable
    ) {
      this.logger.warn({
        message: "goal change failed in the runtime",
        error: error instanceof AdapterRefusal ? error.code : error.reason,
      });
      return new DomainError(
        "UNAVAILABLE",
        "The goal couldn't be changed right now. Try again.",
      );
    }
    return error;
  }

  private async ownedChat(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<ChatDoc> {
    const chat = await this.chatsOf(context).findOne({
      _id: chatId,
      ownerId: context.userId,
      status: "active",
    });
    if (!chat) throw new DomainError("NOT_FOUND", NOT_FOUND);
    return chat;
  }

  private async goalChat(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<GoalChat> {
    const chat = await this.ownedChat(context, chatId);
    if (!chat.goals)
      throw new DomainError("CONFLICT", "Goals are off in this chat.");
    return chat as GoalChat;
  }

  private async settings(context: TenantContext): Promise<TenantGoals> {
    const settings = await this.tenants.goalsOf(context.tenantId);
    if (!settings)
      throw new DomainError("CONFLICT", "Goals are off in this workspace.");
    return settings;
  }

  private async liveGoal(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<GoalDoc> {
    const saved = await this.goalDoc(context, chatId);
    if (!saved || saved.ended) throw new DomainError("NOT_FOUND", NO_GOAL);
    return saved;
  }

  private goalDoc(
    context: TenantContext,
    chatId: ObjectId,
  ): Promise<GoalDoc | null> {
    return this.database
      .tenantDb(context.dbName)
      .collection<GoalDoc>(GOALS_COLLECTION)
      .findOne({ chatId });
  }

  private chatsOf(context: TenantContext): Collection<ChatDoc> {
    return this.database
      .tenantDb(context.dbName)
      .collection<ChatDoc>(CHATS_COLLECTION);
  }

  private requireClient(): RuntimeClient {
    if (!this.client)
      throw new DomainError(
        "UNAVAILABLE",
        "Chat is not available on this server yet.",
      );
    return this.client;
  }
}

function refOf(context: TenantContext, chatId: ObjectId): ChatRef {
  return { tenantId: toWireId(context.tenantId), chatId: toWireId(chatId) };
}
