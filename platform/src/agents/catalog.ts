import { Store } from "../persistence/store";
import { newAgent, hasGeneralAgent, isGeneralAgent } from "./agents";
import {
  GENERAL_AGENT_ID,
  GENERAL_AGENT_HANDLE,
} from "../../../shared/contracts";
import type {
  AgentSummary,
  AgentDetails,
  ModelOption,
} from "../../../shared/contracts";
import {
  AGENT_LOOK_COUNT,
  AGENT_TINTS,
  DEFAULT_AGENT_LOOK,
  DEFAULT_AGENT_TINT,
} from "../../../shared/contracts";
import { ApiError } from "../core/errors";
import {
  type ModelDocument,
  type AgentDocument,
} from "../persistence/configuration-documents";
import { currentTenant } from "../tenancy/tenant";
import { currentUser } from "../identity/user";
import {
  agentFilter,
  checkAgent,
  decideAgent,
  isPrivateWorkspace,
  readsOthersPrivate,
} from "../tenancy/access";
import { agentLimit } from "./limits";
export class AgentCatalog {
  constructor(
    private readonly store: Store,
    private readonly findAgent: (
      agentId: string,
    ) => Promise<AgentDocument | null>,
    private readonly auditRead: (
      type: string,
      id: string,
      ownerId?: string,
      action?: "read" | "list",
    ) => Promise<void>,
  ) {}

  private agentSummary(
    a: AgentDocument,
    p: ModelDocument | null | undefined,
    creatorName?: string,
  ): AgentSummary {
    const shared = isGeneralAgent(a);
    return {
      id: String(a._id),
      name: a.name,
      description: a.description || "",
      provider: p?.provider || "unknown",
      model: p?.modelName || "unknown",
      sandbox: a.sandbox || "read-only",
      ...(a.handle ? { handle: a.handle } : {}),
      look:
        Number.isInteger(a.look) && a.look! >= 0 && a.look! < AGENT_LOOK_COUNT
          ? a.look!
          : DEFAULT_AGENT_LOOK,
      tint: AGENT_TINTS.includes(a.tint!) ? a.tint! : DEFAULT_AGENT_TINT,
      builtin: a.builtin === true,
      ...(a.createdBy ? { createdBy: a.createdBy } : {}),
      ...(creatorName ? { creatorName } : {}),
      canUse:
        decideAgent(
          a.createdBy,
          "use",
          currentUser(),
          isPrivateWorkspace(),
          shared,
        ) === "allow",
      canWrite:
        !a.builtin &&
        decideAgent(
          a.createdBy,
          "write",
          currentUser(),
          isPrivateWorkspace(),
          shared,
        ) === "allow",
    };
  }

  async agents(): Promise<AgentSummary[]> {
    const [agents, profiles] = await Promise.all([
      this.store.agents
        .find({ enabled: { $ne: false }, ...agentFilter() })
        .limit(1000)
        .toArray(),
      this.store.profiles
        .find(
          { enabled: { $ne: false } },
          { projection: { apikey: 0, apiKey: 0 } },
        )
        .toArray(),
    ]);
    if (hasGeneralAgent()) {
      const general = (await this.findAgent(GENERAL_AGENT_ID))!;
      // The code-owned definition wins over any old record with the reserved id.
      for (let i = agents.length - 1; i >= 0; i--)
        if (String(agents[i]._id) === GENERAL_AGENT_ID) agents.splice(i, 1);
      agents.unshift(general);
    }
    // An admin listing agents that are not theirs is reading private content,
    // and sees who made each one: handles repeat across creators, so the
    // name (one batched lookup, never one per agent) tells them apart.
    const others = agents.filter(
      (a) => !isGeneralAgent(a) && readsOthersPrivate(a.createdBy),
    );
    const names = new Map<string, string>();
    if (others.length) {
      await this.auditRead("agent", "list", undefined, "list");
      const creators = [
        ...new Set(
          others.map((a) => a.createdBy).filter((id): id is string => !!id),
        ),
      ];
      for (const u of await this.store.users
        .find({ _id: { $in: creators } }, { projection: { name: 1, email: 1 } })
        .toArray())
        names.set(u._id, u.name || u.email);
    }
    return agents.map((a) => {
      const p = profiles.find(
        (p) => String(p._id) === String(a.modelProfileId),
      );
      return this.agentSummary(
        a,
        p,
        a.createdBy ? names.get(a.createdBy) : undefined,
      );
    });
  }
  /** Models the agent dialog may offer: enabled, allowed, and usable. */
  async models(): Promise<ModelOption[]> {
    const allowed = currentTenant()?.allowedModelIds;
    const rows = await this.store.profiles
      .find(
        {
          enabled: { $ne: false },
          baseUrl: { $type: "string", $ne: "" },
          modelName: { $type: "string", $ne: "" },
          $or: [
            { apiKey: { $type: "string", $ne: "" } },
            { apikey: { $type: "string", $ne: "" } },
          ],
        },
        { projection: { _id: 1, displayName: 1, modelName: 1, provider: 1 } },
      )
      .toArray();
    return rows
      .filter((m) => !allowed || allowed.includes(String(m._id)))
      .map((m) => ({
        id: String(m._id),
        name: m.displayName || m.modelName,
        provider: m.provider,
      }));
  }
  async createAgent(body: unknown): Promise<AgentSummary> {
    const user = currentUser();
    // The creator is the signed-in person, set here; the body cannot name one.
    const agent = newAgent(body, user?.id);
    if (hasGeneralAgent() && agent.handle === GENERAL_AGENT_HANDLE)
      throw new ApiError(
        409,
        "@generalagent is reserved for the built-in General Agent",
        "AGENT_HANDLE_TAKEN",
      );
    const profile = await this.store.findModel(agent.modelProfileId);
    if (!profile || !(profile.apiKey || profile.apikey))
      throw new ApiError(
        422,
        "That model is not available. Pick another model.",
        "MODEL_UNAVAILABLE",
      );
    agent.modelProfileId = profile._id;
    const taken = () =>
      new ApiError(
        409,
        `@${agent.handle} is taken. Choose a different name.`,
        "AGENT_HANDLE_TAKEN",
      );
    // The unique handle index must exist before the first write relies on it.
    await this.store.indexesReady();
    // In a private workspace a handle is unique per creator, so one person's
    // choice never blocks (or reveals) another's.
    const perCreator = !!user && isPrivateWorkspace();
    if (perCreator) {
      const limit = agentLimit();
      if (
        (await this.store.agents.countDocuments({ createdBy: user!.id })) >=
        limit
      )
        throw new ApiError(
          409,
          `You can have up to ${limit} agents. Remove one to create another.`,
          "AGENT_LIMIT",
        );
    }
    if (
      await this.store.agents.findOne(
        perCreator
          ? { handle: agent.handle, createdBy: user!.id }
          : { handle: agent.handle },
        { projection: { _id: 1 } },
      )
    )
      throw taken();
    try {
      await this.store.agents.insertOne(agent);
    } catch (error: any) {
      // The unique index catches a race between two creates.
      if (error?.code === 11000) throw taken();
      throw error;
    }
    return this.agentSummary(agent, profile);
  }

  async agentDetails(agentId: string): Promise<AgentDetails> {
    const agent = await this.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "AGENT_NOT_FOUND");
    checkAgent(agent, "read");
    if (!isGeneralAgent(agent) && readsOthersPrivate(agent.createdBy))
      await this.auditRead("agent", agentId, agent.createdBy);
    return {
      ...this.agentSummary(
        agent,
        await this.store.findModel(agent.modelProfileId),
      ),
      systemPrompt: agent.systemPrompt || "",
      modelProfileId: String(agent.modelProfileId),
    };
  }

  async updateAgent(agentId: string, body: unknown): Promise<AgentSummary> {
    const agent = await this.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "AGENT_NOT_FOUND");
    checkAgent(agent, "write");
    if (agent.builtin)
      throw new ApiError(
        403,
        "Built-in agents cannot be changed",
        "BUILTIN_AGENT_LOCKED",
      );
    const input = newAgent(body);
    const profile = await this.store.findModel(input.modelProfileId);
    if (!profile || !(profile.apiKey || profile.apikey))
      throw new ApiError(
        422,
        "That model is not available. Pick another model.",
        "MODEL_UNAVAILABLE",
      );
    // Keep the id, handle, creator, skills, connectors, and runtime policy intact.
    const fields = {
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      look: input.look,
      tint: input.tint,
      modelProfileId: profile._id,
    };
    const updated = await this.store.agents.findOneAndUpdate(
      {
        _id: agent._id,
        builtin: { $ne: true },
        enabled: { $ne: false },
        ...(isPrivateWorkspace() && currentUser()
          ? { createdBy: currentUser()!.id }
          : {}),
      },
      { $set: fields },
      { returnDocument: "after" },
    );
    if (!updated)
      throw new ApiError(
        409,
        "This agent changed or is no longer available. Refresh and try again.",
        "AGENT_CHANGED",
      );
    return this.agentSummary(updated, profile);
  }
}
