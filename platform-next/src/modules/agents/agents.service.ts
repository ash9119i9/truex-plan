import { Inject, Injectable } from "@nestjs/common";
import {
  ObjectId,
  type ClientSession,
  type Collection,
  type Db,
} from "mongodb";
import type { TenantContext } from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import { toWireId } from "../../database/object-id";
import { AuditService } from "../audit/audit.service";
import { MembershipsService } from "../memberships/memberships.service";
import { modelView, type ModelDoc, type ModelView } from "../models/model";
import { ModelsService } from "../models/models.service";
import {
  AGENT_QUOTA_COLLECTION,
  AGENTS_COLLECTION,
  MAX_AGENTS_PER_USER,
  MAX_TENANT_AGENTS,
  requestHashOf,
  type AgentDoc,
  type AgentScope,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "./agent";
import type { AgentTint } from "./agent-fields";
import type { BuiltinAgentDoc } from "./builtin-agent";
import {
  BuiltinAgentsService,
  type BuiltinListing,
} from "./builtin-agents.service";

export type AgentSource = "builtin" | AgentScope;

// What a chat needs from its agent. Instructions only for built-ins; this
// never leaves the server.
export interface ChatAgent {
  source: AgentSource;
  id: ObjectId;
  revision: number;
  name: string;
  description: string;
  instructions?: string;
  modelId: ObjectId;
  look: number;
  tint: AgentTint;
}

// One agent as the caller sees it, with what the caller may do to it.
export interface AgentView {
  id: string;
  source: AgentSource;
  name: string;
  description: string;
  look: number;
  tint: AgentTint;
  // Null when the agent's model is disabled or gone.
  model: ModelView | null;
  // False when a chat could not start with it right now.
  available: boolean;
  revision: number;
  createdByMe: boolean;
  status: "active" | "archived";
  canEdit: boolean;
  canArchive: boolean;
  canPromote: boolean;
}

export interface AgentSummary {
  name: string;
  look: number;
  tint: AgentTint;
  // False for an archived agent or a disabled built-in.
  available: boolean;
}

interface QuotaLock {
  _id: string;
  version: number;
}

const NOT_FOUND = "This agent does not exist or you cannot see it.";
const TENANT_LOCK = "tenant";
const ownerLock = (userId: ObjectId) => `owner:${userId.toHexString()}`;

// Personal agents of the caller, plus every tenant agent.
function visibleTo(userId: ObjectId) {
  return {
    $or: [
      { scope: "tenant" as const },
      { scope: "personal" as const, ownerId: userId },
    ],
  };
}

// Personal and tenant agents. Every read and write is bounded to the
// caller's tenant database and to the agents the caller can see.
@Injectable()
export class AgentsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ModelsService) private readonly models: ModelsService,
    @Inject(BuiltinAgentsService)
    private readonly builtins: BuiltinAgentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
  ) {}

  private db(context: TenantContext): Db {
    return this.database.tenantDb(context.dbName);
  }

  private agents(context: TenantContext): Collection<AgentDoc> {
    return this.db(context).collection<AgentDoc>(AGENTS_COLLECTION);
  }

  private locks(context: TenantContext): Collection<QuotaLock> {
    return this.db(context).collection<QuotaLock>(AGENT_QUOTA_COLLECTION);
  }

  // The agents collection's indexes are built when the tenant is
  // provisioned (AGENT_INDEXES). The audit trail's are built once per
  // process, outside the write transactions that record to it.
  private ensureIndexes(): Promise<void> {
    return this.audit.ensureIndexes();
  }

  // Everything the picker shows: enabled built-ins, then the caller's
  // personal agents, then the tenant's agents. Built-ins and models usually
  // come from memory, so this is normally one indexed tenant query.
  async list(context: TenantContext): Promise<AgentView[]> {
    const [builtins, enabledModels, agents] = await Promise.all([
      this.builtins.enabledAgents(),
      this.models.enabledModels(),
      this.agents(context)
        .find({ status: "active", ...visibleTo(context.userId) })
        // The largest valid set: the caller's personal agents plus the
        // tenant's shared ones, both capped at creation.
        .limit(MAX_AGENTS_PER_USER + MAX_TENANT_AGENTS)
        .toArray(),
    ]);
    const models = new Map(enabledModels.map((m) => [toWireId(m._id), m]));
    // A model added after the cache loaded is looked up directly, so a new
    // agent never shows as unavailable just because the cache is behind.
    const unknown = new Map<string, ObjectId>();
    for (const ref of [...builtins, ...agents])
      if (!models.has(toWireId(ref.modelId)))
        unknown.set(toWireId(ref.modelId), ref.modelId);
    for (const model of await this.models.findEnabledMany([
      ...unknown.values(),
    ]))
      models.set(toWireId(model._id), model);

    const byName = (a: AgentDoc, b: AgentDoc) =>
      a.name.localeCompare(b.name) ||
      toWireId(a._id).localeCompare(toWireId(b._id));
    const personal = agents.filter((a) => a.scope === "personal").sort(byName);
    const tenant = agents.filter((a) => a.scope === "tenant").sort(byName);
    return [
      ...builtins.map((b) => builtinView(b, models.get(toWireId(b.modelId)))),
      ...[...personal, ...tenant].map((a) =>
        agentView(a, context, models.get(toWireId(a.modelId))),
      ),
    ];
  }

  async create(
    context: TenantContext,
    input: CreateAgentInput,
    requestId?: string,
  ): Promise<{ agent: AgentView; created: boolean }> {
    await this.ensureIndexes();
    const requestHash = requestHashOf(input);
    const replay = await this.replay(context, input, requestHash);
    if (replay) return { agent: replay, created: false };

    const model = await this.models.findEnabled(input.modelId);
    if (!model) throw modelUnavailable();
    await this.prepareLocks(context, input.scope === "tenant");

    const now = new Date();
    const doc: AgentDoc = {
      _id: new ObjectId(),
      scope: input.scope,
      ownerId: context.userId,
      name: input.name,
      description: input.description,
      modelId: input.modelId,
      look: input.look,
      tint: input.tint,
      status: "active",
      revision: 1,
      clientRequestId: input.clientRequestId,
      requestHash,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.database.withTransaction(async (session) => {
        await this.checkLimits(
          context,
          input.scope === "tenant",
          true,
          session,
        );
        await this.agents(context).insertOne(doc, { session });
        await this.record(context, "agent.create", doc, requestId, session);
      });
    } catch (error) {
      // The same request committed first in another attempt.
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.replay(context, input, requestHash);
      if (!raced) throw error;
      return { agent: raced, created: false };
    }
    return { agent: agentView(doc, context, model), created: true };
  }

  async update(
    context: TenantContext,
    agentId: ObjectId,
    input: UpdateAgentInput,
    requestId?: string,
  ): Promise<AgentView> {
    await this.ensureIndexes();
    const agent = await this.findVisible(context, agentId);
    if (!agent.ownerId.equals(context.userId))
      throw new DomainError(
        "FORBIDDEN",
        "Only the agent's creator can edit it.",
      );
    if (agent.status !== "active")
      throw new DomainError("CONFLICT", "This agent is archived.");
    if (agent.revision !== input.revision) throw staleRevision();

    const changes = Object.fromEntries(
      Object.entries(input.changes).filter(([field, value]) =>
        field === "modelId"
          ? !agent.modelId.equals(value as ObjectId)
          : agent[field as keyof AgentDoc] !== value,
      ),
    ) as UpdateAgentInput["changes"];
    if (Object.keys(changes).length === 0)
      return this.singleView(context, agent);
    if (changes.modelId && !(await this.models.findEnabled(changes.modelId)))
      throw modelUnavailable();

    const updated = await this.database.withTransaction(async (session) => {
      if (
        changes.modelId &&
        !(await this.models.findEnabled(changes.modelId, session))
      )
        throw modelUnavailable();
      const next = await this.agents(context).findOneAndUpdate(
        { _id: agent._id, revision: input.revision, status: "active" },
        {
          $set: { ...changes, updatedAt: new Date() },
          $inc: { revision: 1 },
        },
        { returnDocument: "after", session },
      );
      if (!next) throw staleRevision();
      await this.record(context, "agent.update", next, requestId, session, {
        fields: Object.keys(changes).sort().join(","),
      });
      return next;
    });
    return this.singleView(context, updated);
  }

  // Shares a personal agent with the whole tenant. There is no way back:
  // other members may already have chats with it.
  async promote(
    context: TenantContext,
    agentId: ObjectId,
    requestId?: string,
  ): Promise<AgentView> {
    await this.ensureIndexes();
    const agent = await this.findVisible(context, agentId);
    if (!agent.ownerId.equals(context.userId))
      throw new DomainError(
        "FORBIDDEN",
        "Only the agent's creator can share it.",
      );
    if (agent.scope === "tenant") return this.singleView(context, agent);
    if (agent.status !== "active")
      throw new DomainError("CONFLICT", "This agent is archived.");
    await this.prepareLocks(context, true);

    const promoted = await this.database.withTransaction(async (session) => {
      await this.checkLimits(context, true, false, session);
      const next = await this.agents(context).findOneAndUpdate(
        { _id: agent._id, scope: "personal", status: "active" },
        {
          $set: { scope: "tenant", updatedAt: new Date() },
          $inc: { revision: 1 },
        },
        { returnDocument: "after", session },
      );
      if (!next)
        throw new DomainError(
          "CONFLICT",
          "The agent changed while sharing it. Reload and try again.",
        );
      await this.record(context, "agent.promote", next, requestId, session);
      return next;
    });
    return this.singleView(context, promoted);
  }

  // Removes the agent from every picker. Existing chats keep their pinned
  // copy. Repeating it is safe.
  async archive(
    context: TenantContext,
    agentId: ObjectId,
    requestId?: string,
  ): Promise<AgentView> {
    await this.ensureIndexes();
    const agent = await this.findVisible(context, agentId);
    if (!(await this.mayArchiveNow(agent, context)))
      throw new DomainError(
        "FORBIDDEN",
        "Only the agent's creator or a workspace admin can archive it.",
      );
    if (agent.status === "archived") return this.singleView(context, agent);

    const archived = await this.database.withTransaction(async (session) => {
      const now = new Date();
      const next = await this.agents(context).findOneAndUpdate(
        { _id: agent._id, status: "active" },
        {
          $set: {
            status: "archived",
            archivedAt: now,
            archivedBy: context.userId,
            updatedAt: now,
          },
          $inc: { revision: 1 },
        },
        { returnDocument: "after", session },
      );
      // Archived by someone else in the meantime: the outcome is the same.
      if (!next) return null;
      await this.record(context, "agent.archive", next, requestId, session);
      return next;
    });
    return this.singleView(
      context,
      archived ?? (await this.findVisible(context, agentId)),
    );
  }

  // The agent a chat runs with. A new chat needs an active agent; an
  // existing chat keeps working after its user agent is archived (it runs
  // from its own thread). A disabled built-in stops every chat with it: that
  // is the product team's switch for a prompt that must not run again.
  // Returns null for anything the caller cannot use.
  //
  // Built-ins come from the catalog cache (no query; a disable takes effect
  // within BUILTIN_CACHE_TTL_MS). A user agent is one indexed tenant query.
  // An ID neither knows is checked once more as a built-in added since the
  // cache loaded.
  async resolveForChat(
    context: TenantContext,
    agentId: ObjectId,
    options: { allowArchived: boolean },
  ): Promise<ChatAgent | null> {
    const cached = await this.builtins.cachedById(agentId);
    if (cached === "disabled") return null;
    if (cached !== "unknown") return builtinChatAgent(cached);
    const agent = await this.agents(context).findOne({
      _id: agentId,
      ...visibleTo(context.userId),
      ...(options.allowArchived ? {} : { status: "active" as const }),
    });
    if (agent)
      return {
        source: agent.scope,
        id: agent._id,
        revision: agent.revision,
        name: agent.name,
        description: agent.description,
        modelId: agent.modelId,
        look: agent.look,
        tint: agent.tint,
      };
    const added = await this.builtins.findEnabledWithInstructions(agentId);
    return added ? builtinChatAgent(added) : null;
  }

  // Display fields for the agents of a page of chats. A chat shows its
  // agent's current name and look. Built-ins come from the catalog cache;
  // user agents take one tenant query, skipped when there are none.
  async summariesFor(
    context: TenantContext,
    agentIds: readonly ObjectId[],
  ): Promise<Map<string, AgentSummary>> {
    const summaries = new Map<string, AgentSummary>();
    if (agentIds.length === 0) return summaries;
    const addBuiltin = (b: BuiltinListing) =>
      summaries.set(toWireId(b._id), {
        name: b.name,
        look: b.look,
        tint: b.tint,
        available: b.enabled,
      });
    for (const b of await this.builtins.cachedListings())
      if (agentIds.some((id) => id.equals(b._id))) addBuiltin(b);
    const rest = agentIds.filter((id) => !summaries.has(toWireId(id)));
    if (rest.length === 0) return summaries;
    const agents = await this.agents(context)
      .find(
        { _id: { $in: rest }, ...visibleTo(context.userId) },
        { projection: { name: 1, look: 1, tint: 1, status: 1 } },
      )
      .toArray();
    for (const a of agents)
      summaries.set(toWireId(a._id), {
        name: a.name,
        look: a.look,
        tint: a.tint,
        available: a.status === "active",
      });
    // Built-ins added since the cache loaded. Rare; one catalog query.
    const missing = rest.filter((id) => !summaries.has(toWireId(id)));
    for (const b of await this.builtins.findListings(missing)) addBuiltin(b);
    return summaries;
  }

  // The agent if the caller can see it. Another member's personal agent and
  // an ID that does not exist give the same answer.
  private async findVisible(
    context: TenantContext,
    agentId: ObjectId,
  ): Promise<AgentDoc> {
    const agent = await this.agents(context).findOne({
      _id: agentId,
      ...visibleTo(context.userId),
    });
    if (!agent) throw new DomainError("NOT_FOUND", NOT_FOUND);
    return agent;
  }

  private async replay(
    context: TenantContext,
    input: CreateAgentInput,
    requestHash: string,
  ): Promise<AgentView | null> {
    const existing = await this.agents(context).findOne({
      ownerId: context.userId,
      clientRequestId: input.clientRequestId,
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash)
      throw new DomainError(
        "CONFLICT",
        "This request ID was already used for a different agent. Start a new request.",
      );
    return this.singleView(context, existing);
  }

  // Lock documents exist before any transaction writes them: concurrent
  // first-time upserts inside transactions could otherwise fail on the
  // unique _id instead of retrying.
  private async prepareLocks(
    context: TenantContext,
    tenantScope: boolean,
  ): Promise<void> {
    const ids = [
      ownerLock(context.userId),
      ...(tenantScope ? [TENANT_LOCK] : []),
    ];
    await Promise.all(
      ids.map(async (_id) => {
        try {
          await this.locks(context).updateOne(
            { _id },
            { $setOnInsert: { version: 0 } },
            { upsert: true },
          );
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
        }
      }),
    );
  }

  // Writing the lock documents makes concurrent creates conflict, so the
  // driver retries the losers and their counts include the winner's insert.
  private async checkLimits(
    context: TenantContext,
    tenantScope: boolean,
    countOwner: boolean,
    session: ClientSession,
  ): Promise<void> {
    const agents = this.agents(context);
    if (countOwner) {
      await this.locks(context).updateOne(
        { _id: ownerLock(context.userId) },
        { $inc: { version: 1 } },
        { session },
      );
      const owned = await agents.countDocuments(
        { ownerId: context.userId, status: "active" },
        { session },
      );
      if (owned >= MAX_AGENTS_PER_USER)
        throw new DomainError(
          "LIMIT_REACHED",
          `You can have up to ${MAX_AGENTS_PER_USER} agents. Archive one to create another.`,
        );
    }
    if (tenantScope) {
      await this.locks(context).updateOne(
        { _id: TENANT_LOCK },
        { $inc: { version: 1 } },
        { session },
      );
      const shared = await agents.countDocuments(
        { scope: "tenant", status: "active" },
        { session },
      );
      if (shared >= MAX_TENANT_AGENTS)
        throw new DomainError(
          "LIMIT_REACHED",
          `This workspace already has ${MAX_TENANT_AGENTS} shared agents. Ask an admin to archive one.`,
        );
    }
  }

  private record(
    context: TenantContext,
    action: string,
    agent: AgentDoc,
    requestId: string | undefined,
    session: ClientSession,
    details: Record<string, string> = {},
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor: { kind: "user", userId: context.userId },
        result: "success",
        tenantId: context.tenantId,
        ...(agent.ownerId.equals(context.userId)
          ? {}
          : { targetUserId: agent.ownerId }),
        details: {
          agentId: toWireId(agent._id),
          scope: agent.scope,
          revision: agent.revision,
          ...details,
        },
        requestId,
      },
      session,
    );
  }

  // mayArchive with the admin role read now: the context's role can come from
  // an access token up to ACCESS_TOKEN_TTL_SECONDS old, and a demoted admin
  // must not archive other people's agents in that time.
  private async mayArchiveNow(
    agent: AgentDoc,
    context: TenantContext,
  ): Promise<boolean> {
    if (agent.ownerId.equals(context.userId)) return true;
    if (agent.scope !== "tenant") return false;
    const membership = await this.memberships.findActive(
      context.userId,
      context.tenantId,
    );
    return membership?.role === "admin";
  }

  // One agent after a write, with its model read now rather than from cache.
  private async singleView(
    context: TenantContext,
    agent: AgentDoc,
  ): Promise<AgentView> {
    const model = await this.models.findEnabled(agent.modelId);
    return agentView(agent, context, model ?? undefined);
  }
}

function mayArchive(agent: AgentDoc, context: TenantContext): boolean {
  return (
    agent.ownerId.equals(context.userId) ||
    (agent.scope === "tenant" && context.role === "admin")
  );
}

function agentView(
  agent: AgentDoc,
  context: TenantContext,
  model: ModelDoc | undefined,
): AgentView {
  const mine = agent.ownerId.equals(context.userId);
  const active = agent.status === "active";
  return {
    id: toWireId(agent._id),
    source: agent.scope,
    name: agent.name,
    description: agent.description,
    look: agent.look,
    tint: agent.tint,
    model: model ? modelView(model) : null,
    available: active && !!model,
    revision: agent.revision,
    createdByMe: mine,
    status: agent.status,
    canEdit: active && mine,
    canArchive: active && mayArchive(agent, context),
    canPromote: active && mine && agent.scope === "personal",
  };
}

function builtinChatAgent(builtin: BuiltinAgentDoc): ChatAgent {
  return {
    source: "builtin",
    id: builtin._id,
    revision: builtin.revision,
    name: builtin.name,
    description: builtin.description,
    instructions: builtin.instructions,
    modelId: builtin.modelId,
    look: builtin.look,
    tint: builtin.tint,
  };
}

function builtinView(
  agent: BuiltinListing,
  model: ModelDoc | undefined,
): AgentView {
  return {
    id: toWireId(agent._id),
    source: "builtin",
    name: agent.name,
    description: agent.description,
    look: agent.look,
    tint: agent.tint,
    model: model ? modelView(model) : null,
    available: !!model,
    revision: agent.revision,
    createdByMe: false,
    status: "active",
    canEdit: false,
    canArchive: false,
    canPromote: false,
  };
}

function modelUnavailable(): DomainError {
  return new DomainError(
    "MODEL_UNAVAILABLE",
    "This model is not available. Choose another model.",
  );
}

function staleRevision(): DomainError {
  return new DomainError(
    "STALE_REVISION",
    "This agent changed since you opened it. Reload it and try again.",
  );
}
