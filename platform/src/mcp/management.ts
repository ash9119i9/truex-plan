import { Store } from "../persistence/store";
import { isGeneralAgent } from "../agents/agents";
import { ApiError } from "../core/errors";
import {
  checkMcpProfile,
  checkMcpUrl,
  mcpProfileUpdate,
  mcpSummary,
  newMcpProfile,
} from "./profiles";
import {
  idCandidates,
  type DatabaseId,
  type McpDocument,
  type AgentDocument,
} from "../persistence/configuration-documents";
import { currentUser, userId } from "../identity/user";
import {
  checkAgent,
  readsOthersPrivate,
  type AgentAccess,
} from "../tenancy/access";
import { mcpLimit } from "./limits";
export class ConnectorService {
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
    private readonly tenantNames: () => Promise<Set<string>>,
    private readonly agentMcpFor: (
      agentId: string,
    ) => ReturnType<ConnectorService["agentMcp"]>,
    private readonly agentTenantMcpFor: (
      agentId: string,
    ) => ReturnType<ConnectorService["agentTenantMcp"]>,
  ) {}

  // --- MCP profiles: tenant scope (admins) and user scope (the owner). ---
  // Credentials stay in storage; responses carry hasKey, never a key. Someone
  // else's user MCP answers 404, like an unknown id.
  private mcpCaller() {
    const user = currentUser();
    if (!user)
      throw new ApiError(
        401,
        "Sign in to manage MCP servers",
        "UNAUTHENTICATED",
      );
    return user;
  }
  private tenantAdmin() {
    const user = this.mcpCaller();
    if (user.role !== "admin")
      throw new ApiError(
        403,
        "Only a tenant admin can manage tenant MCP servers",
        "TENANT_ADMIN_REQUIRED",
      );
    return user;
  }
  // The agent an MCP request is about, checked against the caller: reading a
  // private agent's attachments needs read access, changing them needs the
  // creator. Content access for an admin is not permission to change another
  // person's agent.
  private async mcpAgentKey(agentId: string, mode: AgentAccess) {
    const agent = await this.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "AGENT_NOT_FOUND");
    checkAgent(agent, mode);
    if (
      mode === "read" &&
      !isGeneralAgent(agent) &&
      readsOthersPrivate(agent.createdBy)
    )
      await this.auditRead("agent", String(agent._id), agent.createdBy);
    // agentIds holds String(agent._id), whatever the _id's BSON type.
    return String(agent._id);
  }
  private async scopedMcp(id: string, filter: Record<string, unknown>) {
    const profile =
      typeof id === "string" && id && id.length <= 200
        ? await this.store.mcp.findOne({
            _id: { $in: idCandidates(id) },
            ...filter,
          })
        : null;
    if (!profile)
      throw new ApiError(404, "MCP profile not found", "MCP_NOT_FOUND");
    return profile;
  }
  private ownMcp(id: string) {
    return this.scopedMcp(id, { scope: "user", ownerId: this.mcpCaller().id });
  }
  private tenantMcp(id: string) {
    this.tenantAdmin();
    return this.scopedMcp(id, { scope: "tenant" });
  }
  // Tenant names are reserved tenant-wide, for user MCPs of every member.
  private async reservedName(name: string) {
    if (
      await this.store.mcp.findOne(
        { scope: "tenant", name },
        { projection: { _id: 1 } },
      )
    )
      throw new ApiError(
        409,
        `A tenant MCP server is already named ${name}. Choose another name.`,
        "MCP_NAME_RESERVED",
      );
  }
  private async shadowedCount(name: string) {
    return this.store.mcp.countDocuments({ scope: "user", name });
  }
  // A user MCP that a tenant MCP shadows is skipped in every chat.
  private userMcpSummary(profile: McpDocument, tenantNames: Set<string>) {
    const shadowed = tenantNames.has(profile.name);
    return {
      ...mcpSummary(
        profile,
        shadowed
          ? [
              `A tenant MCP server is also named ${profile.name}. Chats use the tenant server and skip this one; rename it to use it.`,
            ]
          : [],
      ),
      editable: true,
      ...(shadowed ? { shadowed: true } : {}),
    };
  }
  private tenantMcpSummary(profile: McpDocument, warnings: string[] = []) {
    return {
      ...mcpSummary(profile, warnings),
      editable: currentUser()?.role === "admin",
    };
  }
  private mcpIds(ids: unknown): string[] {
    if (
      !Array.isArray(ids) ||
      ids.length > 50 ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 200)
    )
      throw new ApiError(
        400,
        "profileIds must be an array of up to 50 MCP IDs",
        "INVALID_INPUT",
      );
    return [...new Set(ids as string[])];
  }
  private taken(error: unknown, name: string): never {
    if ((error as { code?: number })?.code === 11000)
      throw new ApiError(
        409,
        `An MCP server named ${name} already exists`,
        "MCP_NAME_TAKEN",
      );
    throw error;
  }
  // Resolves ids within `filter` (404 for anything outside it) and validates
  // newly attached profiles; already attached ones stay as they are.
  private async attachable(
    agentKey: string,
    ids: string[],
    filter: Record<string, unknown>,
  ) {
    const chosen = [];
    for (const id of ids) {
      const profile = await this.scopedMcp(id, filter);
      if (!(profile.agentIds || []).includes(agentKey))
        if (checkMcpProfile(profile).command)
          throw new ApiError(
            422,
            "Local command connectors are unavailable. Use an HTTP connector.",
            "CONNECTOR_POLICY",
          );
      chosen.push(profile._id);
    }
    return chosen;
  }
  // Makes `chosen` the exact set of `filter`'s profiles attached to the
  // agent: $addToSet on the chosen ones, $pull on the rest.
  private async attach(
    agentKey: string,
    chosen: DatabaseId[],
    filter: Record<string, unknown>,
  ) {
    const updatedAt = new Date().toISOString();
    if (chosen.length)
      await this.store.mcp.updateMany(
        { ...filter, _id: { $in: chosen } },
        { $addToSet: { agentIds: agentKey }, $set: { updatedAt } },
      );
    await this.store.mcp.updateMany(
      { ...filter, agentIds: agentKey, _id: { $nin: chosen } },
      { $pull: { agentIds: agentKey }, $set: { updatedAt } },
    );
  }
  private async saveUpdate(
    existing: McpDocument,
    set: Partial<McpDocument>,
    unset: Record<string, "">,
  ) {
    if (!Object.keys(set).length && !Object.keys(unset).length) return;
    await this.store.mcpReady();
    await this.store.mcp
      .updateOne(
        { _id: existing._id },
        {
          $set: { ...set, updatedAt: new Date().toISOString() },
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
      )
      .catch((e) => this.taken(e, set.name ?? existing.name));
  }
  private async insertMcp(
    body: unknown,
    scope: Pick<McpDocument, "scope" | "ownerId">,
    createdBy: string,
  ) {
    const profile = newMcpProfile(body);
    // Open sign-up means anyone can add connectors, so a person's own are capped.
    if (scope.scope === "user") {
      const limit = mcpLimit();
      if (
        (await this.store.mcp.countDocuments({
          scope: "user",
          ownerId: scope.ownerId,
        })) >= limit
      )
        throw new ApiError(
          409,
          `You can have up to ${limit} connected tools. Remove one to add another.`,
          "MCP_LIMIT",
        );
    }
    if (scope.scope === "user") await this.reservedName(profile.name);
    const warnings = await checkMcpUrl(profile.url!);
    const now = new Date().toISOString();
    const stored: McpDocument = {
      ...profile,
      ...scope,
      agentIds: [],
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.mcpReady();
    await this.store.mcp
      .insertOne(stored)
      .catch((e) => this.taken(e, profile.name));
    // The cross-scope rule has no index, so check again after writing: an
    // admin may have created the tenant name between the first check and
    // our insert. Then ours is removed and the caller gets the 409. The
    // opposite order (tenant MCP created after a user one) is not a race:
    // configuration() skips the shadowed user copy at build.
    if (scope.scope === "user")
      try {
        await this.reservedName(profile.name);
      } catch (e) {
        await this.store.mcp.deleteOne({ _id: stored._id });
        throw e;
      }
    return { profile: stored, warnings };
  }

  // Main app: the caller's user MCPs (editable) plus the tenant's MCPs
  // (name, url host, attached agents; editable for admins only).
  async listMcp() {
    const user = this.mcpCaller();
    const [own, tenant] = await Promise.all([
      this.store.mcp
        .find({ scope: "user", ownerId: user.id })
        .sort({ name: 1 })
        .toArray(),
      this.store.mcp.find({ scope: "tenant" }).sort({ name: 1 }).toArray(),
    ]);
    const tenantNames = new Set(tenant.map((p) => p.name));
    return {
      userProfiles: own.map((p) => this.userMcpSummary(p, tenantNames)),
      tenantProfiles: tenant.map((p) => this.tenantMcpSummary(p)),
    };
  }
  // POST /api/mcp: a user MCP owned by the caller. 409 on a name clash.
  async createMcp(body: unknown) {
    const user = this.mcpCaller();
    const { profile, warnings } = await this.insertMcp(
      body,
      { scope: "user", ownerId: user.id },
      user.id,
    );
    return { ...mcpSummary(profile, warnings), editable: true };
  }
  async updateMcp(id: string, body: unknown) {
    const existing = await this.ownMcp(id);
    const { set, unset, profile } = mcpProfileUpdate(existing, body);
    const renamed = set.name !== undefined && set.name !== existing.name;
    if (renamed) await this.reservedName(set.name!);
    const warnings = await checkMcpUrl(profile.url!);
    await this.saveUpdate(existing, set, unset);
    // Re-checked after the write, like insertMcp: a tenant MCP created in
    // between wins, and the rename is reverted.
    if (renamed)
      try {
        await this.reservedName(set.name!);
      } catch (e) {
        await this.store.mcp.updateOne(
          { _id: existing._id, name: set.name },
          { $set: { name: existing.name } },
        );
        throw e;
      }
    const summary = this.userMcpSummary(profile, await this.tenantNames());
    const all = [...warnings, ...(summary.warnings || [])];
    return { ...summary, ...(all.length ? { warnings: all } : {}) };
  }
  async deleteMcp(id: string) {
    const existing = await this.ownMcp(id);
    await this.store.mcp.deleteOne({ _id: existing._id });
    return { ok: true };
  }
  // GET /api/agents/:id/mcp. `profiles`/`profileIds` keep their original
  // meaning for the MCP settings form: the servers the caller may attach
  // (their own) and which of them are attached. Tenant MCPs attached to the
  // agent are listed read-only in tenantProfiles.
  async agentMcp(agentId: string) {
    const user = this.mcpCaller();
    const agentKey = await this.mcpAgentKey(agentId, "read");
    const [own, tenant] = await Promise.all([
      this.store.mcp
        .find({ scope: "user", ownerId: user.id })
        .sort({ name: 1 })
        .toArray(),
      this.store.mcp.find({ scope: "tenant" }).sort({ name: 1 }).toArray(),
    ]);
    const tenantNames = new Set(tenant.map((p) => p.name));
    const isAttached = (p: McpDocument) =>
      (p.agentIds || []).includes(agentKey);
    const profiles = [
      ...own.map((p) => ({
        ...this.userMcpSummary(p, tenantNames),
        attached: isAttached(p),
      })),
      // LEGACY(frontend-v1): the current MCP settings form has one list, so
      // a tenant admin also sees (and can attach) every tenant MCP there.
      // Remove when the new MCP settings ship.
      ...(user.role === "admin"
        ? tenant.map((p) => ({
            ...this.tenantMcpSummary(p),
            attached: isAttached(p),
          }))
        : []),
    ];
    return {
      profileIds: profiles.filter((p) => p.attached).map((p) => p.id),
      profiles,
      tenantProfiles: tenant
        .filter(isAttached)
        .map((p) => ({ ...this.tenantMcpSummary(p), attached: true })),
    };
  }
  // POST /api/agents/:id/mcp { profileIds }: the full set of the caller's
  // own user MCPs for this agent; other people's MCPs are never touched.
  // A tenant MCP id is 404 for a user.
  async setAgentMcp(agentId: string, ids: unknown) {
    const user = this.mcpCaller();
    const agentKey = await this.mcpAgentKey(agentId, "write");
    const own = { scope: "user", ownerId: user.id };
    const wanted = this.mcpIds(ids);
    if (user.role !== "admin") {
      await this.attach(
        agentKey,
        await this.attachable(agentKey, wanted, own),
        own,
      );
      return this.agentMcpFor(agentId);
    }
    // LEGACY(frontend-v1): an admin's form submits their own and the tenant's
    // MCPs in one list, so the ids are split by scope and each set replaced.
    // Remove when the new MCP settings ship (admins then use
    // POST /api/agents/:id/tenant-mcp).
    const tenantScope = { scope: "tenant" as const };
    const tenantIds = new Set(
      (
        await this.store.mcp
          .find(
            { ...tenantScope, _id: { $in: wanted.flatMap(idCandidates) } },
            { projection: { _id: 1 } },
          )
          .toArray()
      ).map((p) => String(p._id)),
    );
    const userChosen = await this.attachable(
      agentKey,
      wanted.filter((id) => !tenantIds.has(id)),
      own,
    );
    const tenantChosen = await this.attachable(
      agentKey,
      wanted.filter((id) => tenantIds.has(id)),
      tenantScope,
    );
    await this.attach(agentKey, userChosen, own);
    await this.attach(agentKey, tenantChosen, tenantScope);
    return this.agentMcpFor(agentId);
  }

  // Tenant admins (/api/tenant/mcp*): the same operations for scope "tenant".
  async listTenantMcp() {
    this.tenantAdmin();
    const tenant = await this.store.mcp
      .find({ scope: "tenant" })
      .sort({ name: 1 })
      .toArray();
    return { profiles: tenant.map((p) => this.tenantMcpSummary(p)) };
  }
  // The response says how many user MCPs the new name now shadows.
  async createTenantMcp(body: unknown) {
    const user = this.tenantAdmin();
    const { profile, warnings } = await this.insertMcp(
      body,
      { scope: "tenant" },
      user.id,
    );
    return this.withShadowed(profile, warnings);
  }
  async updateTenantMcp(id: string, body: unknown) {
    const existing = await this.tenantMcp(id);
    const { set, unset, profile } = mcpProfileUpdate(existing, body);
    const warnings = await checkMcpUrl(profile.url!);
    await this.saveUpdate(existing, set, unset);
    return this.withShadowed(profile, warnings);
  }
  private async withShadowed(profile: McpDocument, warnings: string[]) {
    const shadowedUserMcps = await this.shadowedCount(profile.name);
    return {
      ...this.tenantMcpSummary(profile, [
        ...warnings,
        ...(shadowedUserMcps
          ? [
              `${shadowedUserMcps} user MCP server${shadowedUserMcps === 1 ? " uses" : "s use"} the name ${profile.name}. Chats now use this tenant server and skip ${shadowedUserMcps === 1 ? "it" : "them"}.`,
            ]
          : []),
      ]),
      shadowedUserMcps,
    };
  }
  async deleteTenantMcp(id: string) {
    const existing = await this.tenantMcp(id);
    await this.store.mcp.deleteOne({ _id: existing._id });
    return { ok: true };
  }
  // Same shape as agentMcp, for the tenant's servers.
  async agentTenantMcp(agentId: string) {
    this.tenantAdmin();
    const agentKey = await this.mcpAgentKey(agentId, "read");
    const tenant = await this.store.mcp
      .find({ scope: "tenant" })
      .sort({ name: 1 })
      .toArray();
    const profiles = tenant.map((p) => ({
      ...this.tenantMcpSummary(p),
      attached: (p.agentIds || []).includes(agentKey),
    }));
    return {
      profileIds: profiles.filter((p) => p.attached).map((p) => p.id),
      profiles,
    };
  }
  async setAgentTenantMcp(agentId: string, ids: unknown) {
    this.tenantAdmin();
    const agentKey = await this.mcpAgentKey(agentId, "write");
    const scope = { scope: "tenant" };
    await this.attach(
      agentKey,
      await this.attachable(agentKey, this.mcpIds(ids), scope),
      scope,
    );
    return this.agentTenantMcpFor(agentId);
  }
  // Offboarding (Phase 5): removes a member's user MCPs in the current tenant.
  async deleteUserMcps(ownerId: string) {
    const { deletedCount } = await this.store.mcp.deleteMany({
      scope: "user",
      ownerId: userId(ownerId),
    });
    return { deleted: deletedCount };
  }
}
