import { httpError } from "../../shared/errors";
import { businessCapabilityParams } from "../../shared/business-capabilities";
import {
  publicGoal,
  publicSession,
  publicApproval,
  publicSnapshot,
  recentSnapshot,
  publicPlan,
  publicStoredPlan,
  withPlanFallback,
  publicSubAgent,
  publicSubAgentTranscript,
  SUB_AGENT_ID,
  POLICY_VERSION,
} from "./public";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "./store";
import { newAgent } from "./agents";
import { approvalMode, approvalModesConfig, effectiveMode } from "./features";
import { orderConversation } from "../../shared/command-history";
import { historyAnchor } from "./history-window";
import { readHistoryWindow } from "./history-read";
import { messageTextError } from "../../shared/message-input";
import type { RuntimeResumeOptions } from "../../shared/runtime-resume-options";
import {
  creationApprovalOptions,
  confirmRuntimeApproval,
} from "./session-creation";
import { isDeepStrictEqual } from "node:util";
import type { AnyBulkWriteOperation } from "mongodb";
import type {
  CommandRecord,
  Goal,
  GoalHistoryEntry,
  GoalReview,
  Message,
  MessageAcceptanceTiming,
  Project,
  Session,
  SessionGoal,
  AgentSummary,
  ModelOption,
} from "../../shared/contracts";
import {
  AGENT_LOOK_COUNT,
  AGENT_TINTS,
  DEFAULT_AGENT_LOOK,
  DEFAULT_AGENT_TINT,
} from "../../shared/contracts";
import { ApiError } from "./errors";
export { ApiError } from "./errors";
import { currentRequestId } from "./http";
import { errorFields, log } from "../../shared/logging";
// Owner failures the platform acts on (failover, orphaned/dead sessions) or
// that tell the user what to do; they keep their upstream status.
const OWNER_CODES = new Set([
  "CAPACITY",
  "DRAINING",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_OVERLOADED",
  "RPC_TIMEOUT",
  "THREAD_LOST",
]);
/** An agent-core rejection. 4xx passes through; an unexpected 5xx is a bad
 * gateway here, with the upstream status and code kept in the cause for logs. */
export function upstreamError(
  status: number,
  detail: any,
  fallback: string,
  fallbackCode: string,
  path?: string,
) {
  const message = typeof detail?.error === "string" ? detail.error : fallback;
  const code = typeof detail?.code === "string" ? detail.code : fallbackCode;
  if (status < 500 || OWNER_CODES.has(code))
    return new ApiError(status, message, code);
  const cause = Object.assign(new Error(message), {
    name: "UpstreamError",
    status,
    code,
    path,
  });
  log("warn", "assistant service failed", {
    requestId: currentRequestId(),
    path,
    upstreamStatus: status,
    upstreamCode: code,
  });
  return new ApiError(502, message, "UPSTREAM_FAILED", { cause });
}
import {
  attachedMcpInstructions,
  checkMcpProfile,
  checkMcpUrl,
  mcpConfig,
  mcpProfileUpdate,
  mcpSummary,
  newMcpProfile,
} from "./mcp";
import {
  idCandidates,
  type DatabaseId,
  type McpDocument,
  type ModelDocument,
} from "./documents";
import { gatewaySettings, resolveRoute, signGatewayToken } from "./model-route";
import { currentTenant, currentTenantId } from "./tenant";
import { currentUser, userId } from "./user";
import { requireAudit } from "./audit";
import type { DemoQuota, TurnKey } from "./quota";
import {
  RuntimeTransport,
  isAgentCoreRuntime,
  runtimeHosts,
} from "./runtime-transport";
import {
  chatVisibility,
  agentFilter,
  checkAgent,
  checkProject,
  checkSession,
  decideAgent,
  isPrivateWorkspace,
  ownerFilter,
  readsOthersPrivate,
  type Access,
  type AgentAccess,
} from "./access";
// Codex edits an objective in place, so the creation time identifies a goal.
function sameGoal(saved: SessionGoal | undefined, goal: Goal) {
  return !!saved && (saved.createdAt ?? null) === (goal.createdAt ?? null);
}
const GOAL_HISTORY_LIMIT = 60;
// What changed between the saved goal summary and the latest goal.
export function goalChanges(
  saved: SessionGoal | undefined,
  goal: Goal | null,
  at: string,
  turnId?: string,
): GoalHistoryEntry[] {
  const turn = turnId ? { turnId } : {};
  if (!goal)
    return saved
      ? [{ at, kind: "cleared", objective: saved.objective, ...turn }]
      : [];
  const tokens = Math.max(goal.tokensUsed, goal.tokensObserved ?? 0);
  const entry = (kind: GoalHistoryEntry["kind"]): GoalHistoryEntry => ({
    at,
    kind,
    objective: goal.objective,
    status: goal.status,
    tokens,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    ...turn,
  });
  if (!sameGoal(saved, goal)) return [entry("set")];
  const changes: GoalHistoryEntry[] = [];
  if (saved!.objective !== goal.objective) changes.push(entry("objective"));
  // Older summaries have no budget, so a budget change is only known once saved.
  if (
    saved!.tokenBudget !== undefined &&
    saved!.tokenBudget !== goal.tokenBudget
  )
    changes.push(entry("budget"));
  if (saved!.status !== goal.status) changes.push(entry("status"));
  return changes;
}
// Where a goal save came from. Event times come from agent-core, so they are
// only compared with each other, never with platform time.
export interface GoalSource {
  turnId?: string | null;
  eventAt?: string;
  // A durable record replayed by ingest, possibly out of order.
  replay?: boolean;
  // Creation time of the goal a replayed clear removed.
  clearedCreatedAt?: number | null;
}
// Whether saving this goal would roll back a newer saved state.
export function staleGoal(
  s: Pick<Session, "goal" | "goalCleared"> | null,
  goal: Goal | null,
  source: GoalSource,
) {
  // The live stream is ordered and command results are current.
  if (!source.replay) return false;
  const saved = s?.goal;
  const { eventAt } = source;
  const notAfter = (known?: string) => !!known && !!eventAt && eventAt <= known;
  if (!goal) {
    if (!saved) return false;
    const cleared = source.clearedCreatedAt;
    if (
      cleared != null &&
      saved.createdAt != null &&
      saved.createdAt !== cleared
    )
      return saved.createdAt > cleared;
    return notAfter(saved.goalEventAt);
  }
  if (!saved) {
    const cleared = s?.goalCleared;
    if (!cleared || cleared.createdAt == null || goal.createdAt == null)
      return false;
    if (goal.createdAt !== cleared.createdAt)
      return goal.createdAt < cleared.createdAt;
    // A new goal set in the same second as the clear is newer than it.
    return !cleared.eventAt || !eventAt || eventAt <= cleared.eventAt;
  }
  if (!sameGoal(saved, goal))
    return (
      saved.createdAt != null &&
      goal.createdAt != null &&
      goal.createdAt < saved.createdAt
    );
  const known = saved.goalUpdatedAt;
  if (known == null || goal.updatedAt == null) return false;
  if (goal.updatedAt !== known) return goal.updatedAt < known;
  // Codex times are whole seconds; the event time breaks a tie.
  return notAfter(saved.goalEventAt);
}
const DELEGATION_MODES = ["explicitRequestOnly", "proactive"];
// Optional helper-agent limits chosen when a conversation starts.
export function subAgentOptions(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "subAgents must be an object", "INVALID_INPUT");
  const { mode, maxConcurrent } = value as Record<string, unknown>;
  if (mode !== undefined && !DELEGATION_MODES.includes(mode as string))
    throw new ApiError(
      400,
      "subAgents.mode must be explicitRequestOnly or proactive",
      "INVALID_INPUT",
    );
  if (
    maxConcurrent !== undefined &&
    !(
      Number.isInteger(maxConcurrent) &&
      (maxConcurrent as number) >= 1 &&
      (maxConcurrent as number) <= 5
    )
  )
    throw new ApiError(
      400,
      "subAgents.maxConcurrent must be a whole number from 1 to 5",
      "INVALID_INPUT",
    );
  return {
    ...(mode !== undefined ? { mode: mode as string } : {}),
    ...(maxConcurrent !== undefined
      ? { maxConcurrent: maxConcurrent as number }
      : {}),
  };
}
// Same value with object keys sorted, so equal configs serialize equally.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as any)[key])]),
    );
  return value;
}
// sha256 of a thread's built mcp_servers.* entries (names, urls, headers and
// keys). Only this hash leaves the platform; agent-core reloads a loaded
// thread when it changes.
export function mcpFingerprint(config: Record<string, unknown>) {
  const servers = Object.keys(config)
    .filter((key) => key.startsWith("mcp_servers."))
    .sort()
    .map((key) => [key, canonical(config[key])]);
  return createHash("sha256").update(JSON.stringify(servers)).digest("hex");
}
// Agents one person may create in a private workspace (AGENTS_PER_USER_MAX).
function agentLimit(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.AGENTS_PER_USER_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 25;
}
// Connected tools one person may keep (MCP_PER_USER_MAX).
function mcpLimit(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.MCP_PER_USER_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 20;
}
// The saved goal summary, shaped like a live goal, for views that must not
// ask the runtime.
function storedGoal(goal?: SessionGoal): Goal | null {
  if (!goal) return null;
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensObserved ?? 0,
    timeUsedSeconds: 0,
    createdAt: goal.createdAt ?? null,
    updatedAt: goal.goalUpdatedAt ?? null,
    ...(goal.tokensObserved !== undefined
      ? { tokensObserved: goal.tokensObserved }
      : {}),
  };
}
function validAgentId(agentId: string) {
  if (typeof agentId !== "string" || !SUB_AGENT_ID.test(agentId))
    throw new ApiError(400, "Invalid helper agent id", "INVALID_INPUT");
  return agentId;
}
const PROJECT_ID = /^proj_[0-9a-f-]{36}$/;
function projectIdOf(id: unknown) {
  if (typeof id !== "string" || !PROJECT_ID.test(id))
    throw new ApiError(400, "Invalid project id", "INVALID_PROJECT");
  return id;
}
function projectName(name: unknown) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || trimmed.length > 80)
    throw new ApiError(
      400,
      "Project name must contain 1–80 characters",
      "INVALID_PROJECT",
    );
  return trimmed;
}
export class PlatformService {
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
    const agent = await this.store.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "AGENT_NOT_FOUND");
    // Starting a conversation with an agent needs permission to use it; a
    // resume of an existing conversation carries on with its stored agent.
    if (use) checkAgent(agent, "use");
    // Observe failures immediately, then consume results in the existing
    // validation order. A missing model still fails without waiting for MCPs
    // or skills, and those outstanding reads cannot reject unhandled.
    const settled = <T>(read: Promise<T>) =>
      read.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    const agentKey = String(agent._id);
    const enabled = { agentIds: agentKey, enabled: { $ne: false } };
    const modelRead = settled(this.store.findModel(agent.modelProfileId));
    const tenantMcpRead = settled(
      this.store.mcp
        .find({ scope: "tenant", ...enabled })
        .sort({ name: 1 })
        .toArray(),
    );
    const ownerMcpRead = settled(
      ownerId
        ? this.store.mcp
            .find({ scope: "user", ownerId, ...enabled })
            .sort({ name: 1 })
            .toArray()
        : Promise.resolve([]),
    );
    const skillsRead = settled(this.skills(agent.skillIds || []));
    const modelResult = await modelRead;
    if (modelResult.status === "rejected") throw modelResult.reason;
    const profile = modelResult.value;
    const apiKey = profile?.apiKey || profile?.apikey;
    if (!profile || !apiKey)
      throw new ApiError(
        422,
        "Agent requires a model profile with an API key",
        "MODEL_CONFIGURATION",
      );
    const { route } = resolveRoute(profile);
    if (!profile.baseUrl || !profile.modelName)
      throw new ApiError(
        422,
        "Model profile requires baseUrl and modelName",
        "MODEL_CONFIGURATION",
      );
    const provider =
      "profile_" + String(profile._id).replace(/[^a-zA-Z0-9_]/g, "_");
    const config: Record<string, any> =
      route === "direct"
        ? {
            web_search: profile.webSearch || "live",
            [`model_providers.${provider}`]: {
              name: profile.provider,
              base_url: profile.baseUrl,
              wire_api: "responses",
              experimental_bearer_token: apiKey,
            },
            ...(profile.reasoningEffort
              ? { model_reasoning_effort: profile.reasoningEffort }
              : {}),
          }
        : this.gatewayConfig(profile, provider);
    // Attachments live on the profiles (agentIds); agent.mcpProfileIds is
    // legacy and no longer read.
    const tenantMcpResult = await tenantMcpRead;
    if (tenantMcpResult.status === "rejected") throw tenantMcpResult.reason;
    const tenantMcps = tenantMcpResult.value;
    const ownerMcpResult = await ownerMcpRead;
    if (ownerMcpResult.status === "rejected") throw ownerMcpResult.reason;
    const userMcps = ownerMcpResult.value;
    // Tenant names are reserved tenant-wide (attached here or not), so a user
    // copy made before the tenant one existed is skipped, and the chat still
    // starts. The owner sees the same warning in MCP settings.
    const reserved = userMcps.length ? await this.tenantNames() : new Set();
    const names = new Set<string>();
    for (const mcp of [...tenantMcps, ...userMcps]) {
      if (
        names.has(mcp.name) ||
        (mcp.scope === "user" && reserved.has(mcp.name))
      ) {
        if (mcp.scope === "user") {
          log("warn", "user MCP skipped: a tenant MCP uses its name", {
            op: "configuration",
            agentId: agentKey,
            mcpId: String(mcp._id),
            name: mcp.name,
          });
          continue;
        }
        throw new ApiError(
          422,
          `Duplicate MCP server name: ${mcp.name}`,
          "CONNECTOR_CONFIGURATION",
        );
      }
      names.add(mcp.name);
      // The only place a stored key is decrypted.
      const server = mcpConfig(mcp);
      if (server.command)
        throw new ApiError(
          422,
          "Business connectors must use HTTP. Configure this connector on a separate service.",
          "CONNECTOR_POLICY",
        );
      // Re-checked on every build, so a DNS change since saving is caught.
      await checkMcpUrl(String(server.url), { atBuild: true });
      // Approval modes decide in agent-core, so Codex must ask for each call.
      if (this.approvalModes.enabled)
        server.default_tools_approval_mode = "prompt";
      config[`mcp_servers.${mcp.name}`] = server;
    }
    const skillsResult = await skillsRead;
    if (skillsResult.status === "rejected") throw skillsResult.reason;
    const skills = skillsResult.value;
    return {
      tenantId: currentTenantId(),
      model: profile.modelName,
      modelProvider: provider,
      config,
      baseInstructions:
        (agent.systemPrompt || "You are a helpful assistant.") +
        attachedMcpInstructions([...names]),
      ...(typeof agent.persona === "string" && agent.persona.trim()
        ? { persona: agent.persona }
        : {}),
      ...(agent.scope === "general" || agent.scope === "business"
        ? { scope: agent.scope }
        : {}),
      ...(profile.serviceTier && profile.serviceTier !== "auto"
        ? { serviceTier: profile.serviceTier }
        : {}),
      cwd:
        cwd || resolve(process.env.AGENT_WORKSPACE || "../.runtime/workspace"),
      sandbox: "read-only",
      approvalPolicy: "on-request",
      ...(skills.length ? { skills } : {}),
      mcpFingerprint: mcpFingerprint(config),
    };
  }
  // Catalog skills of an agent, in the agent's order. A missing, disabled or
  // not-allowed skill fails the configuration, like a missing MCP profile.
  private async skills(ids: DatabaseId[]) {
    if (!ids.length) return [];
    const found = await this.store.findSkills(ids);
    return ids.map((id) => {
      const skill = found.find((s) => String(s._id) === String(id));
      if (!skill)
        throw new ApiError(
          422,
          `Skill missing: ${String(id)}`,
          "SKILL_CONFIGURATION",
        );
      return {
        name: skill.name,
        description: skill.description,
        body: skill.body,
        version: skill.version,
      };
    });
  }
  // Codex sees an ordinary Responses provider; the gateway holds the real key.
  private gatewayConfig(profile: ModelDocument, provider: string) {
    const gateway = gatewaySettings();
    if (!gateway)
      throw new ApiError(
        422,
        `Model profile ${String(profile._id)} needs the model gateway, which is not configured. Ask your administrator to set MODEL_GATEWAY_URL and MODEL_GATEWAY_SECRET.`,
        "GATEWAY_NOT_CONFIGURED",
      );
    const id = String(profile._id);
    if (this.hosts.some(isAgentCoreRuntime)) {
      let hostname: string;
      try {
        hostname = new URL(gateway.url).hostname.toLowerCase();
      } catch {
        throw new ApiError(
          422,
          "The model gateway address is invalid. Ask your administrator to configure it.",
          "GATEWAY_NOT_CONFIGURED",
        );
      }
      if (
        hostname === "localhost" ||
        hostname === "localhost." ||
        hostname === "[::1]" ||
        hostname === "0.0.0.0" ||
        /^127\./.test(hostname)
      )
        throw new ApiError(
          422,
          "The model gateway address cannot be reached from the deployed assistant. Ask your administrator to configure a reachable gateway.",
          "GATEWAY_UNREACHABLE",
        );
    }
    return {
      // Codex's built-in web search runs only on OpenAI's Responses backend.
      web_search:
        profile.wireApi && profile.wireApi !== "responses"
          ? "disabled"
          : profile.webSearch || "live",
      [`model_providers.${provider}`]: {
        name: profile.provider,
        base_url: `${gateway.url}/p/${encodeURIComponent(id)}/v1`,
        wire_api: "responses",
        experimental_bearer_token: signGatewayToken(
          id,
          gateway.secret,
          currentTenantId(),
        ),
      },
      ...(profile.reasoningEffort
        ? { model_reasoning_effort: profile.reasoningEffort }
        : {}),
      ...(profile.contextWindow
        ? { model_context_window: profile.contextWindow }
        : {}),
      ...(profile.autoCompactTokenLimit
        ? { model_auto_compact_token_limit: profile.autoCompactTokenLimit }
        : {}),
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
    const user = currentUser();
    const priv = isPrivateWorkspace();
    // An admin listing agents that are not theirs is reading private content,
    // and sees who made each one: handles repeat across creators, so the
    // name (one batched lookup, never one per agent) tells them apart.
    const others = agents.filter((a) => readsOthersPrivate(a.createdBy));
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
        ...(a.createdBy && names.has(a.createdBy)
          ? { creatorName: names.get(a.createdBy) }
          : {}),
        canUse: decideAgent(a.createdBy, "use", user, priv) === "allow",
        canWrite: decideAgent(a.createdBy, "write", user, priv) === "allow",
      };
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
    return {
      id: String(agent._id),
      name: agent.name,
      description: agent.description || "",
      provider: profile.provider,
      model: profile.modelName,
      sandbox: agent.sandbox!,
      handle: agent.handle,
      look: agent.look!,
      tint: agent.tint!,
      builtin: false,
      ...(agent.createdBy ? { createdBy: agent.createdBy } : {}),
      canUse: true,
      canWrite: true,
    };
  }
  // --- MCP profiles: tenant scope (admins) and user scope (the owner). ---
  // Only apiKeyEnc is stored; responses carry hasKey, never a key. Someone
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
    const agent = await this.store.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "AGENT_NOT_FOUND");
    checkAgent(agent, mode);
    if (mode === "read" && readsOthersPrivate(agent.createdBy))
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
  private async tenantNames() {
    const tenant = await this.store.mcp
      .find({ scope: "tenant" }, { projection: { name: 1 } })
      .toArray();
    return new Set(tenant.map((p) => p.name));
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
      return this.agentMcp(agentId);
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
    return this.agentMcp(agentId);
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
    return this.agentTenantMcp(agentId);
  }
  // Offboarding (Phase 5): removes a member's user MCPs in the current tenant.
  async deleteUserMcps(ownerId: string) {
    const { deletedCount } = await this.store.mcp.deleteMany({
      scope: "user",
      ownerId: userId(ownerId),
    });
    return { deleted: deletedCount };
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
    const projects = await this.store.projects
      .find(ownerFilter("ownerId"))
      .sort({ updatedAt: -1 })
      .limit(500)
      .toArray();
    if (projects.some((p) => readsOthersPrivate(p.ownerId)))
      await this.auditRead("project", "list", undefined, "list");
    return projects;
  }
  async project(id: unknown, mode: Access = "read") {
    const project = await this.store.projects.findOne({ _id: projectIdOf(id) });
    if (!project)
      throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND");
    return checkProject(project, mode);
  }
  async createProject(name: unknown) {
    const now = new Date().toISOString();
    const owner = currentUser()?.id;
    const project: Project = {
      _id: "proj_" + randomUUID(),
      ...(owner ? { ownerId: owner } : {}),
      name: projectName(name),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.projects.insertOne(project);
    return project;
  }
  async renameProject(id: unknown, name: unknown) {
    const next = projectName(name);
    const { _id } = await this.project(id, "write");
    const project = await this.store.projects.findOneAndUpdate(
      { _id },
      { $set: { name: next, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    if (!project)
      throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND");
    return project;
  }
  // Its sessions stay, as normal conversations.
  async deleteProject(id: unknown) {
    const project = await this.project(id, "write");
    await this.store.sessions.updateMany(
      { projectId: project._id },
      { $unset: { projectId: "" } },
    );
    await this.store.projects.deleteOne({ _id: project._id });
    return { ok: true };
  }
  // Moves a session into a project, or out of any with null.
  async setSessionProject(id: string, projectId: unknown) {
    const session = await this.sessionFor(id, "write");
    if (projectId === null) {
      await this.store.sessions.updateOne(
        { _id: id },
        { $unset: { projectId: "" } },
      );
      const { projectId: _, ...rest } = session;
      return publicSession(rest, this.approvalModes);
    }
    const project = await this.project(projectId, "write");
    await this.store.sessions.updateOne(
      { _id: id },
      { $set: { projectId: project._id } },
    );
    await this.touchProject(project._id);
    return publicSession(
      { ...session, projectId: project._id },
      this.approvalModes,
    );
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
    // The command response and the live event stream both save goal changes.
    // Each write only applies if the summary is still the one it read, so two
    // savers can't both log the same change; the loser re-reads and retries.
    for (let attempt = 0; ; attempt++) {
      const session = await this.store.sessions.findOne({ _id: id });
      const saved = session?.goal;
      // A replayed record never rolls back a newer saved state.
      if (staleGoal(session, goal, source)) return goal;
      // A save without an event time (snapshot, command) keeps the saved one
      // while Codex reports the same update.
      const eventAt =
        source.eventAt ??
        (goal &&
        sameGoal(saved, goal) &&
        saved?.goalUpdatedAt === goal.updatedAt
          ? saved?.goalEventAt
          : undefined);
      const changes = goalChanges(
        saved,
        goal,
        new Date().toISOString(),
        source.turnId || undefined,
      );
      // After a few lost races, save the summary without history rather than fail.
      const guarded = attempt < 5;
      const history =
        guarded && changes.length
          ? {
              $push: {
                goalHistory: { $each: changes, $slice: -GOAL_HISTORY_LIMIT },
              },
            }
          : {};
      const tokensObserved = goal
        ? Math.max(
            goal.tokensObserved ?? 0,
            sameGoal(saved, goal) ? (saved?.tokensObserved ?? 0) : 0,
          )
        : 0;
      const update = goal
        ? {
            $set: {
              goal: {
                objective: goal.objective,
                status: goal.status,
                createdAt: goal.createdAt,
                tokensObserved,
                tokenBudget: goal.tokenBudget,
                updatedAt: new Date().toISOString(),
                goalUpdatedAt: goal.updatedAt,
                ...(eventAt ? { goalEventAt: eventAt } : {}),
              },
            },
            ...history,
          }
        : {
            $unset: { goal: "" as const },
            ...(saved
              ? {
                  $set: {
                    goalCleared: {
                      createdAt: saved.createdAt ?? null,
                      ...(source.eventAt ? { eventAt: source.eventAt } : {}),
                    },
                  },
                }
              : {}),
            ...history,
          };
      const result = await this.store.sessions.updateOne(
        guarded
          ? { _id: id, goal: saved === undefined ? { $exists: false } : saved }
          : { _id: id },
        update,
      );
      if (result.matchedCount || !guarded) {
        // An agent-core restart loses its tally; keep the larger saved count.
        return goal ? { ...goal, tokensObserved } : goal;
      }
      if (!(await this.store.sessions.findOne({ _id: id }))) return goal;
    }
  }
  async goalHistory(id: string) {
    return {
      entries: (await this.sessionFor(id, "read")).goalHistory || [],
    };
  }
  // The agent marks a goal complete; the user then accepts it or reopens it
  // with feedback. Reopening makes the goal active again for the agent.
  async reviewGoal(
    id: string,
    body: { decision?: unknown; feedback?: unknown },
  ) {
    const decision = body?.decision;
    if (decision !== "accepted" && decision !== "reopened")
      throw new ApiError(400, "Choose accepted or reopened", "INVALID_REVIEW");
    const feedback =
      typeof body.feedback === "string" ? body.feedback.trim() : "";
    if (feedback.length > 4000)
      throw new ApiError(400, "Feedback is too long", "INVALID_REVIEW");
    const session = await this.sessionFor(id, "write");
    const { goal } = await this.capability(id, "thread/goal/get", {}, session);
    if (!goal || goal.status !== "complete")
      throw new ApiError(
        409,
        "Only a goal the assistant has completed can be reviewed",
        "GOAL_NOT_COMPLETE",
      );
    const review: GoalReview = {
      objective: goal.objective,
      goalCreatedAt: goal.createdAt,
      decision,
      ...(feedback ? { feedback } : {}),
      at: new Date().toISOString(),
    };
    const entry: GoalHistoryEntry = {
      at: review.at,
      kind: decision,
      objective: goal.objective,
      status: goal.status,
      tokens: Math.max(goal.tokensUsed, goal.tokensObserved ?? 0),
      ...(feedback ? { feedback } : {}),
    };
    const log = {
      $push: { goalHistory: { $each: [entry], $slice: -GOAL_HISTORY_LIMIT } },
    };
    if (decision === "reopened") {
      await this.store.sessions.updateOne({ _id: id }, log);
      const reopened = await this.capability(
        id,
        "thread/goal/set",
        { status: "active" },
        session,
      );
      return { goal: reopened.goal, review };
    }
    await this.store.sessions.updateOne(
      { _id: id },
      { $set: { goalReview: review }, ...log },
    );
    return { goal, review };
  }
}
