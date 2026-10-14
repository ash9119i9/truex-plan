import { httpError } from "../../../shared/errors";
import { businessCapabilityParams } from "../../../shared/business-capabilities";
import {
  publicGoal,
  publicSession,
  publicSnapshot,
  recentSnapshot,
  publicPlan,
  publicStoredPlan,
  withPlanFallback,
  publicSubAgent,
  publicSubAgentTranscript,
} from "../public/conversation";
import { publicApproval } from "../public/approvals";
import { POLICY_VERSION } from "../public/policy";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Store } from "../persistence/store";
import { generalAgent, hasGeneralAgent } from "../agents/agents";
import { GENERAL_AGENT_ID } from "../../../shared/contracts";
import {
  approvalMode,
  approvalModesConfig,
  effectiveMode,
} from "../core/features";
import { orderConversation } from "../../../shared/command-history";
import { historyAnchor } from "../conversations/history-window";
import { readHistoryWindow } from "../conversations/history-read";
import { messageTextError } from "../../../shared/message-input";
import type { RuntimeResumeOptions } from "../../../shared/runtime-resume-options";
import {
  creationApprovalOptions,
  confirmRuntimeApproval,
} from "../conversations/session-creation";
import { isDeepStrictEqual } from "node:util";
import type { AnyBulkWriteOperation } from "mongodb";
import type {
  CommandRecord,
  Goal,
  Message,
  MessageAcceptanceTiming,
  Project,
  Session,
  AgentSummary,
  AgentDetails,
  ModelOption,
} from "../../../shared/contracts";
import { ApiError } from "../core/errors";
import { currentRequestId } from "../http/handlers";
import { errorFields, log } from "../../../shared/logging";
import { type AgentDocument } from "../persistence/configuration-documents";
import { currentTenant, currentTenantId } from "../tenancy/tenant";
import { currentUser, userId } from "../identity/user";
import { requireAudit } from "../tenancy/audit";
import type { DemoQuota, TurnKey } from "../demo/quota";
import {
  RuntimeTransport,
  isAgentCoreRuntime,
  runtimeHosts,
} from "../runtime/transport";
import {
  chatVisibility,
  checkSession,
  ownerFilter,
  readsOthersPrivate,
  type Access,
} from "../tenancy/access";

import { AgentCatalog } from "../agents/catalog";
import { RuntimeConfiguration } from "../runtime/configuration";
import { ConnectorService } from "../mcp/management";
import { ProjectService } from "../projects/operations";
import { GoalService } from "../conversations/goals";
import { upstreamError } from "../runtime/errors";
import { subAgentOptions, validAgentId } from "../runtime/subagents";
import { projectIdOf } from "../projects/validation";
import { storedGoal, type GoalSource } from "../conversations/goal-state";
export { upstreamError } from "../runtime/errors";
export { subAgentOptions } from "../runtime/subagents";
export { mcpFingerprint } from "../runtime/mcp-fingerprint";
export {
  goalChanges,
  staleGoal,
  type GoalSource,
} from "../conversations/goal-state";
export { ApiError } from "../core/errors";
export class PlatformService {
  private readonly agentCatalog: AgentCatalog;
  private readonly runtimeConfiguration: RuntimeConfiguration;
  private readonly connectorService: ConnectorService;
  private readonly projectService: ProjectService;
  private readonly goalService: GoalService;
  readonly hosts: string[];
  // Only active recovery work is shared. Persisted reads and authorization
  // remain per request, and no conversation response survives this promise.
  private historyRecoveries = new Map<
    string,
    Promise<{
      snapshot: any;
      recoveryError: string | null;
      recoveryErrorRef: { code: string; requestId?: string } | null;
    }>
  >();
  private polling = false;
  private timer?: NodeJS.Timeout;
  private nextHost = 0;
  /** Set when the public demo is enabled; limits new turns in its tenant. */
  quota?: DemoQuota;
  /**
   * Re-confirms, just before work is handed to the runtime, that the caller is
   * still allowed (account active, membership active, workspace enabled). A
   * request authorised at its start can wait on a runtime resume; this stops
   * it from launching a turn after access was withdrawn. Set in Google mode.
   */
  dispatchGuard?: () => Promise<void>;
  constructor(
    readonly store: Store,
    hosts = runtimeHosts(),
    readonly approvalModes = approvalModesConfig(),
    readonly transport = new RuntimeTransport(),
  ) {
    this.hosts = hosts.map((x) => x.trim().replace(/\/$/, ""));

    // Resolve callbacks at call time so public method overrides keep working.
    const findAgent = (agentId: string) => this.findAgent(agentId);
    const auditRead = (
      type: string,
      id: string,
      ownerId?: string,
      action?: "read" | "list",
    ) => this.auditRead(type, id, ownerId, action);
    const sessionFor = (id: string, mode: Access) => this.sessionFor(id, mode);
    const tenantNames = () => this.tenantNames();
    this.agentCatalog = new AgentCatalog(store, findAgent, auditRead);
    this.runtimeConfiguration = new RuntimeConfiguration(
      store,
      this.hosts,
      approvalModes,
      findAgent,
      tenantNames,
    );
    this.connectorService = new ConnectorService(
      store,
      findAgent,
      auditRead,
      tenantNames,
      (agentId) => this.agentMcp(agentId),
      (agentId) => this.agentTenantMcp(agentId),
    );
    this.projectService = new ProjectService(
      store,
      approvalModes,
      auditRead,
      sessionFor,
      (id, mode) => this.project(id, mode),
      (id) => this.touchProject(id),
    );
    this.goalService = new GoalService(
      store,
      sessionFor,
      (id, method, params, loaded) =>
        this.capability(id, method, params, loaded),
    );
  }
  async call(
    host: string,
    path: string,
    method = "GET",
    body?: unknown,
    runtimeSessionId?: string,
  ): Promise<any> {
    if (!this.hosts.includes(host))
      throw new ApiError(
        503,
        "This conversation's runtime is not configured. Start a new conversation.",
        "OWNER_UNCONFIGURED",
      );
    let response: Response;
    try {
      response = await this.transport.request({
        owner: host,
        path,
        method,
        body,
        requestId: currentRequestId(),
        sessionId: runtimeSessionId,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
      )
        throw new ApiError(
          504,
          "The assistant service timed out. Check the conversation before retrying; the request may have been accepted.",
          "OWNER_TIMEOUT",
          { cause: error },
        );
      throw new ApiError(
        503,
        "The assistant service is unavailable. Try again later or ask your administrator to check the service.",
        "OWNER_UNAVAILABLE",
        { cause: error },
      );
    }
    let result: any;
    try {
      result = await response.json();
    } catch (error) {
      throw new ApiError(
        502,
        `The assistant service returned an unreadable response (HTTP ${response.status}). Check the conversation before retrying.`,
        "INVALID_UPSTREAM_RESPONSE",
        { cause: error },
      );
    }
    if (!result || typeof result !== "object")
      throw new ApiError(
        502,
        "The assistant service returned an invalid response. Check the conversation before retrying.",
        "INVALID_UPSTREAM_RESPONSE",
      );
    if (!response.ok)
      throw upstreamError(
        response.status,
        result,
        `The assistant service rejected the request (HTTP ${response.status}).`,
        "UPSTREAM_FAILED",
        path,
      );
    return result;
  }
  async session(id: string, mode?: Access) {
    const session = await this.store.sessions.findOne({ _id: id });
    if (!session)
      throw new ApiError(404, "Session not found", "SESSION_NOT_FOUND");
    // Before the legacy check, so a hidden chat never answers 409.
    if (mode) checkSession(session, mode);
    // An admin reading someone else's private conversation leaves a record,
    // and is refused if the record cannot be written.
    if (mode === "read" && readsOthersPrivate(session.userId))
      await this.auditRead("session", session._id, session.userId);
    if (session.runtimePolicyVersion !== POLICY_VERSION)
      throw new ApiError(
        409,
        "This conversation predates the Truex access policy. Start a new conversation.",
        "LEGACY_SESSION",
      );
    return session;
  }
  private async auditRead(
    type: string,
    id: string,
    ownerId?: string,
    action: "read" | "list" = "read",
  ) {
    const user = currentUser()!;
    await requireAudit(this.store, {
      actor: user.id,
      actorRole: user.role,
      action: `${type}.${action}`,
      tenantId: currentTenantId(),
      target: { type, id, ...(ownerId ? { ownerId } : {}) },
      requestId: currentRequestId(),
    });
  }
  /**
   * True when the caller is looking at someone else's private conversation.
   * That view is served from what is already stored: it never resumes the
   * owner's runtime, reconciles, ingests or otherwise writes the
   * conversation, and it never uses the owner's credentials.
   */
  isPassiveView(session: Pick<Session, "userId">) {
    return readsOthersPrivate(session.userId);
  }
  // Loads a session for a request and applies the ownership rules (see
  // access.ts). Every /api/sessions/:id route goes through this, directly or
  // through a service method that calls it.
  async sessionFor(id: string, mode: Access) {
    return this.session(id, mode);
  }
  // Builds a thread's config. `ownerId` is the chat's owner, never whoever
  // triggered the build: create() passes the signed-in creator, resume()
  // the stored session.userId (also for cold resume and background work).
  // Without an owner only tenant MCPs load.
  async configuration(
    agentId: string,
    {
      cwd,
      ownerId,
      use,
    }: { cwd?: string; ownerId?: string; use?: boolean } = {},
  ) {
    return this.runtimeConfiguration.configuration(agentId, {
      cwd,
      ownerId,
      use,
    });
  }
  private async findAgent(agentId: string): Promise<AgentDocument | null> {
    if (agentId === GENERAL_AGENT_ID && hasGeneralAgent()) {
      const models = await this.models();
      const model =
        models.find((m) => m.id === "default") ||
        models.sort((a, b) => a.id.localeCompare(b.id))[0];
      return generalAgent(model?.id || "__general_model_unavailable__");
    }
    return this.store.findAgent(agentId);
  }

  async agents(): Promise<AgentSummary[]> {
    return this.agentCatalog.agents();
  }
  /** Models the agent dialog may offer: enabled, allowed, and usable. */
  async models(): Promise<ModelOption[]> {
    return this.agentCatalog.models();
  }
  async createAgent(body: unknown): Promise<AgentSummary> {
    return this.agentCatalog.createAgent(body);
  }

  async agentDetails(agentId: string): Promise<AgentDetails> {
    return this.agentCatalog.agentDetails(agentId);
  }

  async updateAgent(agentId: string, body: unknown): Promise<AgentSummary> {
    return this.agentCatalog.updateAgent(agentId, body);
  }
  private async tenantNames() {
    const tenant = await this.store.mcp
      .find({ scope: "tenant" }, { projection: { name: 1 } })
      .toArray();
    return new Set(tenant.map((p) => p.name));
  }

  // Main app: the caller's user MCPs (editable) plus the tenant's MCPs
  // (name, url host, attached agents; editable for admins only).
  async listMcp() {
    return this.connectorService.listMcp();
  }
  // POST /api/mcp: a user MCP owned by the caller. 409 on a name clash.
  async createMcp(body: unknown) {
    return this.connectorService.createMcp(body);
  }
  async updateMcp(id: string, body: unknown) {
    return this.connectorService.updateMcp(id, body);
  }
  async deleteMcp(id: string) {
    return this.connectorService.deleteMcp(id);
  }
  // GET /api/agents/:id/mcp. `profiles`/`profileIds` keep their original
  // meaning for the MCP settings form: the servers the caller may attach
  // (their own) and which of them are attached. Tenant MCPs attached to the
  // agent are listed read-only in tenantProfiles.
  async agentMcp(agentId: string) {
    return this.connectorService.agentMcp(agentId);
  }
  // POST /api/agents/:id/mcp { profileIds }: the full set of the caller's
  // own user MCPs for this agent; other people's MCPs are never touched.
  // A tenant MCP id is 404 for a user.
  async setAgentMcp(agentId: string, ids: unknown) {
    return this.connectorService.setAgentMcp(agentId, ids);
  }

  // Tenant admins (/api/tenant/mcp*): the same operations for scope "tenant".
  async listTenantMcp() {
    return this.connectorService.listTenantMcp();
  }
  // The response says how many user MCPs the new name now shadows.
  async createTenantMcp(body: unknown) {
    return this.connectorService.createTenantMcp(body);
  }
  async updateTenantMcp(id: string, body: unknown) {
    return this.connectorService.updateTenantMcp(id, body);
  }
  async deleteTenantMcp(id: string) {
    return this.connectorService.deleteTenantMcp(id);
  }
  // Same shape as agentMcp, for the tenant's servers.
  async agentTenantMcp(agentId: string) {
    return this.connectorService.agentTenantMcp(agentId);
  }
  async setAgentTenantMcp(agentId: string, ids: unknown) {
    return this.connectorService.setAgentTenantMcp(agentId, ids);
  }
  // Offboarding (Phase 5): removes a member's user MCPs in the current tenant.
  async deleteUserMcps(ownerId: string) {
    return this.connectorService.deleteUserMcps(ownerId);
  }
  async create(
    agentId: string,
    subAgents?: unknown,
    projectId?: unknown,
    requestedApprovalMode?: unknown,
  ) {
    const creationOptions = creationApprovalOptions(
      requestedApprovalMode,
      this.approvalModes,
    );
    if (typeof agentId !== "string")
      throw new ApiError(400, "agentId is required", "INVALID_INPUT");
    const delegation = subAgentOptions(subAgents);
    // Checked before the thread exists, so a bad project needs no rollback.
    if (projectId !== undefined && projectId !== null)
      await this.project(projectId, "write");
    const owner = currentUser()?.id;
    // A new chat belongs to its creator, so their user MCPs load.
    const config: any = await this.configuration(agentId, {
      ownerId: owner,
      use: true,
    });
    if (delegation) config.subAgents = delegation;
    Object.assign(config, creationOptions);
    let host = "",
      thread: any;
    const runtimeSessionId = randomUUID();
    for (let n = 0; n < this.hosts.length; n++) {
      host = this.hosts[this.nextHost++ % this.hosts.length];
      try {
        thread = await this.call(
          host,
          "/threads",
          "POST",
          config,
          runtimeSessionId,
        );
        break;
      } catch (e) {
        if (
          !(e instanceof ApiError && e.code === "CAPACITY") ||
          n === this.hosts.length - 1
        )
          throw e;
      }
    }
    const session: Session = {
      _id: "sess_" + randomUUID(),
      // Set once here and never changed.
      ...(owner ? { userId: owner } : {}),
      runtimePolicyVersion: POLICY_VERSION,
      agentId,
      threadId: thread.threadId,
      agentCoreHost: host,
      ...(isAgentCoreRuntime(host)
        ? { agentCoreSessionId: runtimeSessionId }
        : {}),
      status: "active",
      cwd: config.cwd,
      createdAt: new Date().toISOString(),
      approvals: [],
      timings: [],
      threadStartMs: thread.threadStartMs,
      runtimeStartup: thread.runtimeStartup,
      mcpFingerprint: config.mcpFingerprint,
      ...(creationOptions.approvalMode
        ? { approvalMode: creationOptions.approvalMode }
        : {}),
      ...(typeof projectId === "string" ? { projectId } : {}),
    };
    try {
      await confirmRuntimeApproval(thread, creationOptions, (mode) =>
        this.call(
          host,
          `/threads/${thread.threadId}/approval-mode`,
          "POST",
          { mode },
          runtimeSessionId,
        ),
      );
      await this.store.sessions.insertOne(session);
    } catch (e) {
      await this.call(
        host,
        `/threads/${thread.threadId}`,
        "DELETE",
        undefined,
        runtimeSessionId,
      ).catch((cleanupError) =>
        log("warn", "New conversation runtime cleanup failed", {
          op: "create.cleanup",
          threadId: thread.threadId,
          ...errorFields(cleanupError),
        }),
      );
      throw e;
    }
    if (session.projectId) await this.touchProject(session.projectId);
    return publicSession(session, this.approvalModes);
  }
  // Latest 100 sessions, optionally of one project. Untitled ones are named
  // after their first user message.
  async sessions(projectId?: unknown) {
    const filter: Record<string, unknown> = {
      archived: { $ne: true },
      runtimePolicyVersion: POLICY_VERSION,
      ...ownerFilter("userId"),
    };
    if (projectId !== undefined) filter.projectId = projectIdOf(projectId);
    const sessions = await this.store.sessions
      .find(filter, { projection: { approvals: 0, timings: 0 } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    if (sessions.some((s) => readsOthersPrivate(s.userId)))
      await this.auditRead("session", "list", undefined, "list");
    const untitled = sessions.filter((s) => !s.title).map((s) => s._id);
    if (untitled.length) {
      const firsts = await this.store.messages
        .aggregate<{ _id: string; text: string }>([
          { $match: { sessionId: { $in: untitled }, role: "user" } },
          { $sort: { at: 1, _id: 1 } },
          { $group: { _id: "$sessionId", text: { $first: "$text" } } },
        ])
        .toArray();
      const titles = new Map(firsts.map((f) => [f._id, f.text]));
      for (const s of sessions) {
        const first = titles.get(s._id)?.trim().replace(/\s+/g, " ");
        if (first)
          s.title =
            first.length > 80 ? first.slice(0, 79).trimEnd() + "…" : first;
      }
    }
    return sessions.map((s) => publicSession(s, this.approvalModes));
  }
  // --- Projects: named folders; a session belongs to at most one. ---
  // Ownership: the creator renames, deletes and files chats into a project.
  // Others may see it only where they may see chats (access.ts).
  async projects(): Promise<Project[]> {
    return this.projectService.projects();
  }
  async project(id: unknown, mode: Access = "read") {
    return this.projectService.project(id, mode);
  }
  async createProject(name: unknown) {
    return this.projectService.createProject(name);
  }
  async renameProject(id: unknown, name: unknown) {
    return this.projectService.renameProject(id, name);
  }
  // Its sessions stay, as normal conversations.
  async deleteProject(id: unknown) {
    return this.projectService.deleteProject(id);
  }
  // Moves a session into a project, or out of any with null.
  async setSessionProject(id: string, projectId: unknown) {
    return this.projectService.setSessionProject(id, projectId);
  }
  private async touchProject(id: string) {
    await this.store.projects.updateOne(
      { _id: id },
      { $set: { updatedAt: new Date().toISOString() } },
    );
  }
  async owned(session: Session, path: string, method = "GET", body?: any) {
    if (session.status === "dead")
      throw new ApiError(410, "Session is unrecoverable", "THREAD_LOST");
    // A passive viewer reads; whether the owner's thread is reachable is not
    // theirs to record.
    const passive = this.isPassiveView(session);
    try {
      return await this.call(
        session.agentCoreHost,
        `/threads/${session.threadId}${path}`,
        method,
        body,
        session.agentCoreSessionId,
      );
    } catch (e) {
      if (
        !passive &&
        e instanceof ApiError &&
        ["OWNER_UNAVAILABLE", "RUNTIME_UNAVAILABLE", "THREAD_LOST"].includes(
          e.code,
        )
      )
        await this.store.sessions.updateOne(
          { _id: session._id },
          { $set: { status: e.code === "THREAD_LOST" ? "dead" : "orphaned" } },
        );
      throw e;
    }
  }
  async subAgents(id: string) {
    const agents = await this.owned(
      await this.sessionFor(id, "read"),
      "/agents",
    );
    return (Array.isArray(agents) ? agents : [])
      .map(publicSubAgent)
      .filter(Boolean);
  }
  async events(
    session: Session,
    cursor: string,
    signal: AbortSignal,
    requestId?: string,
    options: { window?: boolean; sync?: "v1" } = {},
  ) {
    if (!this.hosts.includes(session.agentCoreHost))
      throw new ApiError(
        503,
        "Session owner is not configured",
        "OWNER_UNCONFIGURED",
      );
    return this.transport.request({
      owner: session.agentCoreHost,
      path: `/threads/${session.threadId}/events`,
      sessionId: session.agentCoreSessionId,
      cursor,
      requestId,
      signal,
      ...options,
    });
  }
  async subAgent(id: string, agentId: string) {
    const transcript = publicSubAgentTranscript(
      await this.owned(
        await this.sessionFor(id, "read"),
        "/agents/" + encodeURIComponent(validAgentId(agentId)),
      ),
    );
    if (!transcript) throw new ApiError(404, "Helper agent not found");
    return transcript;
  }
  async interruptAgent(id: string, agentId: string) {
    await this.owned(
      await this.sessionFor(id, "write"),
      "/agents/" + encodeURIComponent(validAgentId(agentId)) + "/interrupt",
      "POST",
      {},
    );
    return { ok: true };
  }
  // Thread fields for agent-core; none at all while the feature is off.
  private modeOptions(mode?: unknown) {
    if (!this.approvalModes.enabled) return {};
    return {
      approvalMode: effectiveMode(mode, this.approvalModes),
      approvalNameHeuristic: this.approvalModes.nameHeuristic,
    };
  }
  async setApprovalMode(id: string, mode: unknown) {
    if (!this.approvalModes.enabled)
      throw new ApiError(
        404,
        "Approval modes are not enabled",
        "FEATURE_DISABLED",
      );
    const session = await this.sessionFor(id, "write");
    const next = approvalMode(mode, this.approvalModes);
    // Saved first so a later resume applies it even if the live update fails.
    await this.store.sessions.updateOne(
      { _id: id },
      { $set: { approvalMode: next } },
    );
    const confirmation = await this.owned(session, "/approval-mode", "POST", {
      mode: next,
    });
    if (confirmation?.mode !== next)
      throw new ApiError(
        502,
        "The runtime did not confirm the requested approval mode. Retry before sending.",
        "INVALID_UPSTREAM_RESPONSE",
      );
    return { mode: next };
  }
  async resume(session: Session, options: RuntimeResumeOptions = {}) {
    // The stored owner, never the caller: resume also runs for admins reading
    // a chat, cold resume, and background work without a user.
    const config: any = await this.configuration(session.agentId, {
      cwd: session.cwd,
      ownerId: session.userId,
    });
    Object.assign(config, this.modeOptions(session.approvalMode));
    if (session.settings?.model) config.model = session.settings.model;
    if (session.settings?.effort)
      config.config.model_reasoning_effort = session.settings.effort;
    if (options.response) config.response = options.response;
    const snapshot = await this.owned(session, "/resume", "POST", config);
    await confirmRuntimeApproval(snapshot, config, (mode) =>
      this.owned(session, "/approval-mode", "POST", { mode }),
    );
    // A failed plan save must not block sending the message.
    await this.rememberSnapshotPlan(session._id, snapshot).catch((error) =>
      log("warn", "plan save failed", {
        sessionId: session._id,
        op: "rememberSnapshotPlan",
        ...errorFields(error),
      }),
    );
    if (session.settings && Object.keys(session.settings).length)
      await this.owned(session, "/capabilities", "POST", {
        method: "thread/settings/update",
        params: session.settings,
      });
    if (session.status !== "active")
      await this.store.sessions.updateOne(
        { _id: session._id },
        { $set: { status: "active" } },
      );
    // agent-core now holds (or has queued) this MCP config for the thread.
    if (session.mcpFingerprint !== config.mcpFingerprint) {
      await this.store.sessions.updateOne(
        { _id: session._id },
        { $set: { mcpFingerprint: config.mcpFingerprint } },
      );
      session.mcpFingerprint = config.mcpFingerprint;
    }
    return snapshot;
  }
  async message(id: string, text: string, clientId: string) {
    const started = performance.now();
    const inputError = messageTextError(text);
    if (inputError) throw new ApiError(400, inputError, "INVALID_INPUT");
    if (typeof clientId !== "string" || !/^[-\w]{1,100}$/.test(clientId))
      throw new ApiError(
        400,
        "A valid clientId is required for idempotency",
        "INVALID_INPUT",
      );
    const s = await this.sessionFor(id, "write");
    const authorized = performance.now();
    // Demo turns are counted before anything is dispatched.
    const reserved = await this.reserveTurn(id, clientId);
    const giveBack = () =>
      reserved
        ? this.quota!.release(reserved).catch((error) =>
            log("error", "demo turn release failed", {
              sessionId: id,
              ...errorFields(error),
            }),
          )
        : undefined;
    try {
      await this.resume(s, { response: "operational" });
      await this.dispatchGuard?.();
    } catch (e) {
      // Nothing was dispatched: the person keeps the turn.
      await giveBack();
      throw e;
    }
    const prepared = performance.now();
    const key = `${id}:user:${clientId}`;
    try {
      await this.store.messages.insertOne({
        _id: key,
        sessionId: id,
        role: "user",
        text,
        clientId,
        delivery: "pending",
        at: new Date().toISOString(),
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) {
        await giveBack();
        throw e;
      }
      const existing = await this.store.messages.findOne({ _id: key });
      if (existing?.delivery === "accepted")
        return {
          turnId: existing.turnId,
          steer: existing.steer,
          duplicate: true,
        };
      throw new ApiError(
        409,
        "This message was already submitted; check its delivery state before retrying",
        "DUPLICATE_MESSAGE",
      );
    }
    if (!s.title) await this.titleIfUntitled(id, text);
    const begin = performance.now();
    try {
      const result = await this.owned(s, "/turns", "POST", { text, clientId });
      const dispatched = performance.now();
      await this.store.messages.updateOne(
        { _id: key },
        {
          $set: {
            delivery: "accepted",
            turnId: result.turnId,
            steer: result.steer,
          },
        },
      );
      const accepted = performance.now();
      const platformTiming: MessageAcceptanceTiming = {
        authorizationMs: authorized - started,
        preparationMs: prepared - authorized,
        dispatchMs: dispatched - begin,
        receiptMs: begin - prepared + accepted - dispatched,
        totalMs: accepted - started,
      };
      return {
        ...result,
        platformRoundTripMs: accepted - begin,
        platformTiming,
      };
    } catch (e) {
      const definite = e instanceof ApiError && e.status < 500;
      await this.store.messages.updateOne(
        { _id: key },
        { $set: { delivery: definite ? "failed" : "unknown" } },
      );
      // Only a refusal proves the turn never ran. A timeout or a server error
      // may have been accepted, so its count stands.
      if (definite) await giveBack();
      throw e;
    }
  }
  // Reserves a demo turn: undefined outside the demo, for a submission already
  // on record (the normal duplicate handling follows), and for a retry of a
  // turn already reserved. Otherwise the key to release if the turn never runs.
  private async reserveTurn(
    conversationId: string,
    clientId: string,
  ): Promise<TurnKey | undefined> {
    const user = currentUser();
    const tenantId = currentTenantId();
    if (!user || !this.quota?.applies(tenantId)) return undefined;
    // The stored message is the durable record of an already-seen turn, long
    // after a reservation has expired or a UTC day has rolled over.
    if (
      await this.store.messages.findOne(
        { _id: `${conversationId}:user:${clientId}` },
        { projection: { _id: 1 } },
      )
    )
      return undefined;
    const key = { userId: user.id, tenantId, conversationId, clientId };
    const { duplicate } = await this.quota.reserve(key);
    return duplicate ? undefined : key;
  }
  async reconcile(s: Session) {
    let cursor: string | null = null,
      order = 0;
    const assistantIndexes = new Map<string, number>();
    do {
      const page = await this.owned(
        s,
        `/items${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      const users = page.data.filter(
        (entry: any) => entry.item.type === "userMessage",
      );
      const existingUsers = users.length
        ? await this.store.messages
            .find(
              {
                sessionId: s._id,
                $or: [
                  {
                    clientId: {
                      $in: users.map(
                        (entry: any) => entry.item.clientId || entry.item.id,
                      ),
                    },
                  },
                  { itemId: { $in: users.map((entry: any) => entry.item.id) } },
                ],
              },
              { projection: { _id: 1, clientId: 1, itemId: 1 } },
            )
            .toArray()
        : [];
      type Identity = Pick<Message, "_id" | "clientId" | "itemId">;
      const byClient = new Map<string, Identity>(
        existingUsers.filter((m) => m.clientId).map((m) => [m.clientId!, m]),
      );
      const byItem = new Map<string, Identity>(
        existingUsers.filter((m) => m.itemId).map((m) => [m.itemId!, m]),
      );
      let writes: AnyBulkWriteOperation<Message>[] = [];
      const flush = async () => {
        if (!writes.length) return;
        // Ordered writes preserve runtime ordering and stop on the first
        // failure. Retrying the whole reconciliation remains idempotent.
        await this.store.messages.bulkWrite(writes, { ordered: true });
        writes = [];
      };
      for (const entry of page.data) {
        const { item, turnId } = entry;
        if (item.type === "agentMessage") {
          const messageIndex = assistantIndexes.get(turnId) || 0;
          assistantIndexes.set(turnId, messageIndex + 1);
          writes.push({
            updateOne: {
              filter: { _id: `${s._id}:assistant:${turnId}:${messageIndex}` },
              update: {
                $set: { order: order++, runtimeItemId: item.id },
                $setOnInsert: {
                  sessionId: s._id,
                  role: "assistant",
                  text: item.text,
                  turnId,
                  messageIndex,
                  itemId: item.id,
                  at: s.createdAt,
                },
              },
              upsert: true,
            },
          });
        }
        if (item.type === "userMessage") {
          const clientId = item.clientId || item.id;
          const existing = byClient.get(clientId) || byItem.get(item.id);
          if (existing)
            writes.push({
              updateOne: {
                filter: { _id: existing._id },
                update: {
                  $set: {
                    itemId: item.id,
                    turnId,
                    delivery: "accepted",
                    order: order++,
                  },
                },
              },
            });
          if (!existing)
            writes.push({
              updateOne: {
                filter: { _id: `${s._id}:runtime-user:${item.id}` },
                update: {
                  $setOnInsert: {
                    sessionId: s._id,
                    role: "user",
                    text: (item.content || [])
                      .filter((c: any) => c.type === "text")
                      .map((c: any) => c.text)
                      .join("\n"),
                    turnId,
                    itemId: item.id,
                    at: s.createdAt,
                    delivery: "accepted",
                    order: order++,
                  },
                },
                upsert: true,
              },
            });
          // Model the identity fields after this queued write, so a later
          // item in the page sees the same aliases as item-by-item writes.
          if (existing?.itemId && byItem.get(existing.itemId) === existing)
            byItem.delete(existing.itemId);
          const identity: Identity = existing || {
            _id: `${s._id}:runtime-user:${item.id}`,
          };
          identity.itemId = item.id;
          byItem.set(item.id, identity);
        }
        if (writes.length >= 500) await flush();
      }
      await flush();
      cursor = page.nextCursor;
    } while (cursor);
  }
  // Saves the live plan from an agent-core snapshot. An empty snapshot plan
  // usually means agent-core restarted, so it never clears a saved plan.
  async rememberSnapshotPlan(id: string, snapshot: any) {
    const steps = publicPlan(snapshot?.plan);
    if (!steps.length) return;
    const saved = (await this.store.sessions.findOne({ _id: id }))?.plan;
    if (saved && isDeepStrictEqual(saved.steps, steps)) return;
    await this.store.savePlan(id, {
      plan: steps,
      cursor: typeof snapshot.cursor === "string" ? snapshot.cursor : undefined,
      at: new Date().toISOString(),
    });
  }
  private async recoverHistory(s: Session, window = false) {
    const id = s._id;
    let snapshot = null,
      recoveryError = null,
      recoveryErrorRef: { code: string; requestId?: string } | null = null;
    try {
      snapshot = await this.owned(
        s,
        window ? "/snapshot?window=1" : "/snapshot",
      );
      if (snapshot && "goal" in snapshot)
        snapshot = {
          ...snapshot,
          goal: await this.rememberGoal(id, publicGoal(snapshot.goal)),
        };
      await this.rememberSnapshotPlan(id, snapshot);
      await this.ingest(s);
      await this.reconcile(s);
    } catch (e) {
      const failure = httpError(e, "platform");
      recoveryError = failure.error;
      recoveryErrorRef = { code: failure.code, requestId: currentRequestId() };
      log("warn", "conversation recovery failed", {
        requestId: currentRequestId(),
        sessionId: id,
        code: failure.code,
        ...errorFields(e),
      });
    }
    return { snapshot, recoveryError, recoveryErrorRef };
  }
  async history(
    id: string,
    options: {
      persistedOnly?: boolean;
      window?: boolean;
      before?: unknown;
      onTiming?: (
        phase: "authorization" | "recovery" | "persisted",
        durationMs: number,
      ) => void;
    } = {},
  ) {
    let started = performance.now();
    const s = await this.sessionFor(id, "read");
    options.onTiming?.("authorization", performance.now() - started);
    if (!options.window && options.before !== undefined)
      throw new ApiError(
        400,
        "A history cursor requires a conversation window",
        "INVALID_HISTORY_CURSOR",
      );
    const anchor = options.window
      ? historyAnchor(id, options.before)
      : undefined;
    let snapshot = null,
      recoveryError = null,
      recoveryErrorRef: { code: string; requestId?: string } | null = null;
    const passive = this.isPassiveView(s);
    if (!options.persistedOnly && !passive) {
      const user = currentUser(),
        tenant = currentTenant();
      const key = JSON.stringify([
        tenant?.dbName ?? currentTenantId(),
        user?.id ?? null,
        user?.role ?? null,
        chatVisibility(),
        id,
        s.threadId,
        s.agentCoreHost,
        s.agentCoreSessionId ?? null,
        options.window === true,
      ]);
      started = performance.now();
      let recovery = this.historyRecoveries.get(key);
      if (!recovery) {
        recovery = this.recoverHistory(s, options.window).finally(() => {
          if (this.historyRecoveries.get(key) === recovery)
            this.historyRecoveries.delete(key);
        });
        this.historyRecoveries.set(key, recovery);
      }
      ({ snapshot, recoveryError, recoveryErrorRef } = await recovery);
      options.onTiming?.("recovery", performance.now() - started);
    }
    started = performance.now();
    // A persisted-only read never starts or waits for runtime recovery.
    const fresh = options.persistedOnly ? s : await this.session(id);
    const saved = fresh.plan;
    const page = options.window
      ? await readHistoryWindow(this.store.messages, id, anchor)
      : null;
    const selected =
      page?.messages ??
      orderConversation(
        await this.store.messages.find({ sessionId: id }).toArray(),
      );
    const visibleTurns = new Set(
      selected
        .map((message) => message.turnId)
        .filter((id): id is string => typeof id === "string"),
    );
    const projectedSnapshot = snapshot
      ? withPlanFallback(publicSnapshot(snapshot), saved)
      : null;
    const result = {
      session: publicSession(fresh, this.approvalModes),
      messages: selected,
      ...(page ? { historyWindow: page.historyWindow } : {}),
      snapshot:
        projectedSnapshot && options.window
          ? recentSnapshot(projectedSnapshot, visibleTurns)
          : projectedSnapshot,
      // Saved plan, also available when agent-core is unreachable.
      plan: publicStoredPlan(saved),
      approvals: (fresh.approvals || []).map(publicApproval).filter(Boolean),
      goalReview: fresh.goalReview || null,
      goalHistory: fresh.goalHistory || [],
      recoveryError: recoveryError
        ? `Conversation recovery: ${recoveryError}`
        : null,
      recoveryErrorRef,
      access: passive ? ("readOnly" as const) : ("owner" as const),
    };
    options.onTiming?.("persisted", performance.now() - started);
    return result;
  }
  async ingest(s: Session) {
    const records = await this.owned(s, "/records");
    for (const record of records) {
      const event = record.event;
      if (event?.type === "goal.updated" || event?.type === "goal.cleared") {
        const goal =
          event.type === "goal.updated" ? publicGoal(event.data?.goal) : null;
        if (event.type === "goal.cleared" || goal)
          await this.rememberGoal(s._id, goal, {
            turnId: event.turnId,
            eventAt: event.at,
            replay: true,
            clearedCreatedAt:
              typeof event.data?.goalCreatedAt === "number"
                ? event.data.goalCreatedAt
                : null,
          });
      }
      await this.store.persist(s._id, event);
    }
    if (records.length)
      await this.owned(s, "/records/ack", "POST", {
        keys: records.map((r: any) => r.key),
      });
  }
  startIngestion() {
    this.timer = setInterval(() => {
      // Unacknowledged records are retried on the next poll.
      void this.poll().catch((error) =>
        log("warn", "persistence ingestion failed", {
          op: "poll",
          ...errorFields(error),
        }),
      );
    }, 2000);
    this.timer.unref();
  }
  async poll() {
    if (this.polling || !this.store.db) return;
    this.polling = true;
    try {
      // Each tenant's sessions are ingested inside that tenant's context, so
      // every read and write lands in its own database.
      for (const tenant of await this.store.activeTenants())
        await this.store.withTenant(tenant, async () => {
          for await (const s of this.store.sessions.find({
            status: { $ne: "dead" },
            runtimePolicyVersion: POLICY_VERSION,
            agentCoreHost: { $in: this.hosts },
          }))
            await this.ingest(s).catch((error) =>
              log("warn", "persistence ingestion failed", {
                sessionId: s._id,
                tenantId: tenant.id,
                op: "ingest",
                ...errorFields(error),
              }),
            );
        });
    } finally {
      this.polling = false;
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.transport.close();
  }
  /**
   * After a member is removed or a workspace disabled: asks the runtime to
   * stop the turns of the most recent conversations (the removed person's, or
   * the workspace's). Best effort and honest about it: the outcome is counted
   * as stop requested, nothing running, or failed, and a remote tool call that
   * already happened is not undone. Runs in the tenant's context.
   */
  async interruptRecent(scope: { userId?: string }, limit = 25) {
    const sessions = await this.store.sessions
      .find({
        status: { $ne: "dead" },
        runtimePolicyVersion: POLICY_VERSION,
        ...(scope.userId ? { userId: scope.userId } : {}),
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    const outcome = {
      attempted: sessions.length,
      stopped: 0,
      idle: 0,
      failed: 0,
    };
    const queue = [...sessions];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift())
        try {
          await this.owned(s, "/interrupt", "POST", {});
          outcome.stopped++;
        } catch (error) {
          // "No running turn" (409) is a thread with nothing to stop.
          if (error instanceof ApiError && error.status === 409) outcome.idle++;
          else outcome.failed++;
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return outcome;
  }
  async command(
    id: string,
    method: string,
    params: unknown,
    request: { clientId: string; text: string },
  ) {
    if (
      !request ||
      typeof request.clientId !== "string" ||
      !/^[-\w]{1,100}$/.test(request.clientId) ||
      typeof request.text !== "string" ||
      !request.text.trim() ||
      request.text.length > 50000
    )
      throw new ApiError(
        400,
        "A command needs text and a valid clientId",
        "INVALID_INPUT",
      );
    if (method !== "help") {
      try {
        businessCapabilityParams(method, params);
      } catch (error) {
        throw new ApiError(
          403,
          "This operation or setting is not available in Truex",
          "CAPABILITY_DENIED",
          { cause: error },
        );
      }
    } else if (
      !params ||
      typeof params !== "object" ||
      Object.keys(params).length
    )
      throw new ApiError(400, "Help takes no arguments", "INVALID_INPUT");
    const session = await this.sessionFor(id, "write");
    const key = `${id}:command:${request.clientId}`;
    const existing = await this.store.messages.findOne({ _id: key });
    const replay = (message: Message) => {
      if (
        message.text !== request.text ||
        message.command?.method !== method ||
        !isDeepStrictEqual(message.command.params, params)
      )
        throw new ApiError(
          409,
          "This command ID already belongs to another request",
          "DUPLICATE_COMMAND",
        );
      return { commandMessage: message };
    };
    if (existing) return replay(existing);
    await this.resume(session);
    await this.ingest(session);
    await this.reconcile(session);
    const history = orderConversation(
      await this.store.messages.find({ sessionId: id }).toArray(),
    );
    const message: Message = {
      _id: key,
      sessionId: id,
      clientId: request.clientId,
      role: "user",
      text: request.text,
      at: new Date().toISOString(),
      delivery: "accepted",
      command: {
        method,
        params: params as Record<string, unknown>,
        state: "running",
        afterMessageId: history.at(-1)?._id,
      },
    };
    try {
      await this.store.messages.insertOne(message);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return replay((await this.store.messages.findOne({ _id: key }))!);
    }
    // Persist before dispatch: a retry must never repeat a fork or other mutation.
    let command: CommandRecord;
    try {
      const result =
        method === "help"
          ? {
              help: "/goal <objective> — Set a goal\n/goal show — View goal status\n/goal pause — Pause the goal\n/goal resume — Resume the goal\n/goal budget <tokens> — Set a token budget\n/goal clear — Clear the goal\n/fork — Create a conversation branch\n/compact — Compact context\n/model <identifier> — Change the model\n/effort <level> — Change reasoning effort\n/archive — Archive this conversation\n/unarchive — Restore this conversation\n\nPrefix a literal command with // to send it as a question.",
            }
          : await this.capability(id, method, params, session);
      command = {
        ...message.command!,
        state: "succeeded",
        result: {
          ...("help" in result ? { help: result.help } : {}),
          ...("goal" in result ? { goal: result.goal } : {}),
          ...("session" in result && result.session
            ? { sessionId: result.session._id }
            : {}),
        },
      };
    } catch (e) {
      const definite =
        e instanceof ApiError && e.status >= 400 && e.status < 500;
      command = {
        ...message.command!,
        state: definite ? "failed" : "unknown",
        error: `${httpError(e, "platform").error}${definite ? "" : " The command outcome could not be confirmed. Check the current state before trying again."}`,
      };
    }
    await this.store.messages.updateOne({ _id: key }, { $set: { command } });
    return { commandMessage: { ...message, command } };
  }
  // Reading the goal is the only read; every other operation changes the
  // conversation and is the owner's. `loaded` is a session the caller has
  // already checked for write, so it is not loaded twice.
  async capability(
    id: string,
    method: string,
    params: unknown,
    loaded?: Session,
  ) {
    try {
      businessCapabilityParams(method, params);
    } catch (error) {
      throw new ApiError(
        403,
        "This operation or setting is not available in Truex",
        "CAPABILITY_DENIED",
        { cause: error },
      );
    }
    const s =
      loaded ??
      (await this.sessionFor(
        id,
        method === "thread/goal/get" ? "read" : "write",
      ));
    // Someone else's private conversation: report the saved goal; never wake
    // the owner's runtime to ask.
    if (this.isPassiveView(s)) return { goal: storedGoal(s.goal) };
    // Starting or resuming a goal sets the assistant working on its own, so in
    // the demo it costs a turn like a message does. (Its follow-on turns are
    // not counted one by one; a goal's tokenBudget and the provider-side
    // spending cap are what bound those.)
    const startsWork =
      method === "thread/goal/set" &&
      !!params &&
      typeof params === "object" &&
      ((params as { objective?: unknown }).objective !== undefined ||
        (params as { status?: unknown }).status === "active");
    const reserved = startsWork
      ? await this.reserveTurn(s._id, `goal-${randomUUID()}`)
      : undefined;
    const giveBack = () =>
      reserved
        ? this.quota!.release(reserved).catch((error) =>
            log("error", "demo turn release failed", {
              sessionId: s._id,
              ...errorFields(error),
            }),
          )
        : undefined;
    let result: any;
    try {
      await this.resume(s);
      if (method !== "thread/goal/get") await this.dispatchGuard?.();
      result = await this.owned(s, "/capabilities", "POST", {
        method,
        params,
      });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status < 500) await giveBack();
      throw e;
    }
    if (method === "thread/fork") {
      const fork: Session = {
        ...s,
        _id: "sess_" + randomUUID(),
        threadId: result.thread.id,
        createdAt: new Date().toISOString(),
        timings: [],
        approvals: [],
        cursor: undefined,
        archived: false,
      };
      await this.store.sessions.insertOne(fork);
      return { session: publicSession(fork, this.approvalModes) };
    }
    if (method === "thread/archive" || method === "thread/unarchive")
      await this.store.sessions.updateOne(
        { _id: id },
        { $set: { archived: method === "thread/archive" } },
      );
    if (method === "thread/settings/update")
      await this.store.sessions.updateOne(
        { _id: id },
        { $set: { settings: { ...s.settings, ...(params as object) } } },
      );
    if (method.startsWith("thread/goal/")) {
      const update = params as { objective?: unknown; status?: unknown };
      // A new, edited, cleared or reopened goal invalidates an earlier review.
      if (
        method === "thread/goal/clear" ||
        (method === "thread/goal/set" &&
          (update.objective !== undefined ||
            (update.status !== undefined && update.status !== "complete")))
      )
        await this.store.sessions.updateOne(
          { _id: id },
          { $unset: { goalReview: "" } },
        );
      const goal = await this.rememberGoal(id, publicGoal(result.goal), {
        turnId: typeof result.turnId === "string" ? result.turnId : undefined,
      });
      // A goal-first conversation is named after its objective.
      if (
        !s.title &&
        method === "thread/goal/set" &&
        typeof update.objective === "string" &&
        update.objective.trim()
      )
        await this.titleIfUntitled(id, update.objective);
      return { goal };
    }
    return { ok: true };
  }
  private async titleIfUntitled(id: string, text: string) {
    const summary = text.trim().replace(/\s+/g, " ");
    await this.store.sessions.updateOne(
      { _id: id, $or: [{ title: { $exists: false } }, { title: "" }] },
      {
        $set: {
          title:
            summary.length > 80
              ? summary.slice(0, 79).trimEnd() + "…"
              : summary,
        },
      },
    );
  }
  // Latest goal summary for the conversation list. The runtime remains the
  // source of truth; this copy only drives list indicators and filters.
  async rememberGoal(id: string, goal: Goal | null, source: GoalSource = {}) {
    return this.goalService.rememberGoal(id, goal, source);
  }
  async goalHistory(id: string) {
    return this.goalService.goalHistory(id);
  }
  // The agent marks a goal complete; the user then accepts it or reopens it
  // with feedback. Reopening makes the goal active again for the agent.
  async reviewGoal(
    id: string,
    body: { decision?: unknown; feedback?: unknown },
  ) {
    return this.goalService.reviewGoal(id, body);
  }
}
