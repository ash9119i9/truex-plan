import { resolve } from "node:path";
import { Store } from "../persistence/store";
import { ApiError } from "../core/errors";
import { log } from "../../../shared/logging";
import {
  attachedMcpInstructions,
  checkMcpUrl,
  mcpConfig,
} from "../mcp/profiles";
import {
  idCandidates,
  type DatabaseId,
  type ModelDocument,
  type AgentDocument,
} from "../persistence/configuration-documents";
import { gatewaySettings, resolveRoute, signGatewayToken } from "./model-route";
import { currentTenantId } from "../tenancy/tenant";
import { isAgentCoreRuntime } from "./transport";
import { checkAgent } from "../tenancy/access";
import type { ApprovalModesConfig } from "../../../shared/contracts";
import { mcpFingerprint } from "./mcp-fingerprint";
export class RuntimeConfiguration {
  constructor(
    private readonly store: Store,
    private readonly hosts: string[],
    private readonly approvalModes: ApprovalModesConfig,
    private readonly findAgent: (
      agentId: string,
    ) => Promise<AgentDocument | null>,
    private readonly tenantNames: () => Promise<Set<string>>,
  ) {}

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
    const agent = await this.findAgent(agentId);
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
    // Old attachments cannot authorize a connector, but must not disappear
    // silently when an operator has not run the scope migration.
    const legacyMcpRead = settled(
      agent.mcpProfileIds?.length
        ? this.store.mcp.findOne(
            {
              _id: { $in: agent.mcpProfileIds.flatMap(idCandidates) },
              scope: { $exists: false },
              enabled: { $ne: false },
            },
            { projection: { _id: 1 } },
          )
        : Promise.resolve(null),
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
    const legacyMcpResult = await legacyMcpRead;
    if (legacyMcpResult.status === "rejected") throw legacyMcpResult.reason;
    if (legacyMcpResult.value)
      throw new ApiError(
        422,
        "This agent's MCP attachments require migration. Ask your administrator to complete the connector migration, then retry.",
        "MCP_MIGRATION_REQUIRED",
      );
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
      // Credentials are included only in the runtime configuration.
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
}
