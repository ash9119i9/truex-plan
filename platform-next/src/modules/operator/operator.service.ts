import { Inject, Injectable } from "@nestjs/common";
import type { ObjectId } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import { parseWireId } from "../../database/object-id";
import { parseBuiltinAgentSpec } from "../agents/builtin-agent";
import {
  BuiltinAgentsService,
  type BuiltinListing,
} from "../agents/builtin-agents.service";
import type { AuditActor } from "../audit/audit";
import {
  buildFollowUpsReport,
  type FollowUpsReport,
} from "../chats/followups-report";
import {
  buildHelpersReport,
  type HelpersReport,
} from "../chats/helpers-report";
import { AuditService } from "../audit/audit.service";
import { parseConnectorSpec, type ConnectorDoc } from "../connectors/connector";
import {
  ConnectorsCatalogService,
  type PutOutcome as ConnectorPutOutcome,
} from "../connectors/connectors-catalog.service";
import {
  isRole,
  type MembershipDoc,
  type Role,
} from "../memberships/membership";
import { MembershipsService } from "../memberships/memberships.service";
import { parseModelSpec, type ModelDoc } from "../models/model";
import type { SkillDoc } from "../skills/skill";
import { packSkillFolder } from "../skills/skill-bundle";
import { SkillsService, type PublishOutcome } from "../skills/skills.service";
import { ModelsService, type PutOutcome } from "../models/models.service";
import type { TenantDoc, TenantKind } from "../tenants/tenant";
import { TenantsService } from "../tenants/tenants.service";
import { isValidEmail, type UserDoc } from "../users/user";
import { UsersService } from "../users/users.service";

// Who ran the command, recorded in the audit trail.
const OPERATOR_NAME = /^[A-Za-z0-9._@-]{1,64}$/;

export interface ProvisionTenantCommand {
  operator: string;
  tenantId: ObjectId;
  name: string;
  kind: TenantKind;
}

export interface AssignRoleCommand {
  operator: string;
  // The target account: its ID or its email address.
  user: string;
  tenantId: ObjectId;
  role: Role;
}

// One tenant, or (without tenantId) every ready tenant that is behind.
export interface EnsureTenantIndexesCommand {
  operator: string;
  tenantId?: ObjectId;
}

export interface FollowUpsReportCommand {
  operator: string;
  since: Date;
  // Absent scans every ready tenant.
  tenantId?: ObjectId;
  minSets: number;
  close: number;
}

export interface HelpersReportCommand {
  operator: string;
  since: Date;
  // Absent scans every ready tenant.
  tenantId?: ObjectId;
}

export interface PutModelCommand {
  operator: string;
  // The parsed JSON definition, validated here.
  definition: unknown;
  allowDevCredentials?: boolean;
}

export interface PutBuiltinAgentCommand {
  operator: string;
  definition: unknown;
}

export interface PutConnectorCommand {
  operator: string;
  definition: unknown;
}

export interface PutSkillCommand {
  operator: string;
  // A skill folder, named by the skill's slug.
  folder: string;
  // Python packages the runtime image ships; null when unknown.
  toolchain: ReadonlySet<string> | null;
}

export interface SetEnabledCommand {
  operator: string;
  slug: string;
  enabled: boolean;
}

// What an operator command prints about a model. Never its credentials.
export interface ModelSummary {
  id: string;
  slug: string;
  displayName: string;
  wireApi: string;
  modelName: string;
  enabled: boolean;
  revision: number;
}

export interface BuiltinAgentSummary {
  id: string;
  slug: string;
  name: string;
  modelId: string;
  enabled: boolean;
  revision: number;
}

// What an operator command prints about a connector. Never its auth secrets
// (the auth block is omitted entirely).
export interface ConnectorSummary {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
  revision: number;
  // The hosts sandbox commands may reach through this connector; absent when
  // it is MCP only.
  egressHosts?: string[];
}

export interface SkillSummary {
  id: string;
  slug: string;
  displayName: string;
  version: number;
  sha256: string;
  hasScripts: boolean;
  enabled: boolean;
  revision: number;
}

export function skillSummary(skill: SkillDoc): SkillSummary {
  return {
    id: skill._id.toHexString(),
    slug: skill.slug,
    displayName: skill.displayName,
    version: skill.currentVersion,
    sha256: skill.currentSha256,
    hasScripts: skill.hasScripts,
    enabled: skill.enabled,
    revision: skill.revision,
  };
}

export function modelSummary(model: ModelDoc): ModelSummary {
  return {
    id: model._id.toHexString(),
    slug: model.slug,
    displayName: model.displayName,
    wireApi: model.wireApi,
    modelName: model.modelName,
    enabled: model.enabled,
    revision: model.revision,
  };
}

export function builtinSummary(agent: BuiltinListing): BuiltinAgentSummary {
  return {
    id: agent._id.toHexString(),
    slug: agent.slug,
    name: agent.name,
    modelId: agent.modelId.toHexString(),
    enabled: agent.enabled,
    revision: agent.revision,
  };
}

export function connectorSummary(connector: ConnectorDoc): ConnectorSummary {
  return {
    id: connector._id.toHexString(),
    slug: connector.slug,
    displayName: connector.displayName,
    enabled: connector.enabled,
    revision: connector.revision,
    ...(connector.egress ? { egressHosts: [...connector.egress.hosts] } : {}),
  };
}

export interface AssignRoleResult {
  user: UserDoc;
  membership: MembershipDoc;
  previousRole: Role | null;
}

// Trusted platform-operator actions, run from the operator CLI only. Every
// attempt is audited, including refused ones.
@Injectable()
export class OperatorService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ModelsService) private readonly models: ModelsService,
    @Inject(BuiltinAgentsService)
    private readonly builtins: BuiltinAgentsService,
    @Inject(ConnectorsCatalogService)
    private readonly connectors: ConnectorsCatalogService,
    @Inject(SkillsService) private readonly skills: SkillsService,
  ) {}

  // Publishes a skill folder as the skill's newest version, creating the
  // skill on its first publish. Unchanged content changes nothing. New chats
  // get the version within SKILL_CACHE_TTL_MS; existing chats keep theirs.
  async putSkill(
    command: PutSkillCommand,
  ): Promise<{ skill: SkillSummary; outcome: PublishOutcome }> {
    const actor = operatorActor(command.operator);
    const base = { action: "skill.put", actor };
    try {
      const bundle = await packSkillFolder(command.folder, {
        toolchain: command.toolchain,
      });
      await Promise.all([
        this.skills.ensureIndexes(),
        this.audit.ensureIndexes(),
      ]);
      return await this.database.withTransaction(async (session) => {
        const { skill, version, outcome } = await this.skills.publish(
          bundle,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: {
              slug: skill.slug,
              skillId: skill._id.toHexString(),
              outcome,
              version: version.version,
              sha256: version.sha256,
              revision: skill.revision,
            },
          },
          session,
        );
        return { skill: skillSummary(skill), outcome };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  // Disabling is how a skill is removed: chats keep their versions, and
  // agents that use it show it as Unavailable.
  async setSkillEnabled(
    command: SetEnabledCommand,
  ): Promise<{ skill: SkillSummary; changed: boolean }> {
    const actor = operatorActor(command.operator);
    const base = {
      action: command.enabled ? "skill.enable" : "skill.disable",
      actor,
      details: { slug: String(command.slug).slice(0, 64) },
    };
    try {
      await this.audit.ensureIndexes();
      return await this.database.withTransaction(async (session) => {
        const { skill, changed } = await this.skills.setEnabled(
          command.slug,
          command.enabled,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: { ...base.details, changed, revision: skill.revision },
          },
          session,
        );
        return { skill: skillSummary(skill), changed };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  async listSkills(): Promise<SkillSummary[]> {
    return (await this.skills.listAll()).map(skillSummary);
  }

  // Adds a model, or updates the one with the same slug. Its identity
  // (wireApi, baseUrl, modelName) can never change.
  async putModel(
    command: PutModelCommand,
  ): Promise<{ model: ModelSummary; outcome: PutOutcome }> {
    const actor = operatorActor(command.operator);
    const base = { action: "model.put", actor };
    try {
      const spec = parseModelSpec(command.definition, {
        allowDevCredentials: command.allowDevCredentials,
      });
      await Promise.all([
        this.models.ensureIndexes(),
        this.audit.ensureIndexes(),
      ]);
      return await this.database.withTransaction(async (session) => {
        const { model, outcome } = await this.models.put(
          spec,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: {
              slug: model.slug,
              modelId: model._id.toHexString(),
              outcome,
              revision: model.revision,
            },
          },
          session,
        );
        return { model: modelSummary(model), outcome };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  // Disabling is how a model is removed: chats keep its ID.
  async setModelEnabled(
    command: SetEnabledCommand,
  ): Promise<{ model: ModelSummary; changed: boolean }> {
    const actor = operatorActor(command.operator);
    const base = {
      action: command.enabled ? "model.enable" : "model.disable",
      actor,
      details: { slug: String(command.slug).slice(0, 64) },
    };
    try {
      await this.audit.ensureIndexes();
      return await this.database.withTransaction(async (session) => {
        const { model, changed } = await this.models.setEnabled(
          command.slug,
          command.enabled,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: { ...base.details, changed, revision: model.revision },
          },
          session,
        );
        return { model: modelSummary(model), changed };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  async putBuiltinAgent(
    command: PutBuiltinAgentCommand,
  ): Promise<{ agent: BuiltinAgentSummary; outcome: PutOutcome }> {
    const actor = operatorActor(command.operator);
    const base = { action: "builtin_agent.put", actor };
    try {
      const spec = parseBuiltinAgentSpec(command.definition);
      await Promise.all([
        this.builtins.ensureIndexes(),
        this.audit.ensureIndexes(),
      ]);
      return await this.database.withTransaction(async (session) => {
        const { agent, outcome } = await this.builtins.put(
          spec,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: {
              slug: agent.slug,
              agentId: agent._id.toHexString(),
              outcome,
              revision: agent.revision,
            },
          },
          session,
        );
        return { agent: builtinSummary(agent), outcome };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  async setBuiltinAgentEnabled(
    command: SetEnabledCommand,
  ): Promise<{ agent: BuiltinAgentSummary; changed: boolean }> {
    const actor = operatorActor(command.operator);
    const base = {
      action: command.enabled
        ? "builtin_agent.enable"
        : "builtin_agent.disable",
      actor,
      details: { slug: String(command.slug).slice(0, 64) },
    };
    try {
      await this.audit.ensureIndexes();
      return await this.database.withTransaction(async (session) => {
        const { agent, changed } = await this.builtins.setEnabled(
          command.slug,
          command.enabled,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: { ...base.details, changed, revision: agent.revision },
          },
          session,
        );
        return { agent: builtinSummary(agent), changed };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  async listModels(): Promise<ModelSummary[]> {
    return (await this.models.listAll()).map(modelSummary);
  }

  async listBuiltinAgents(): Promise<BuiltinAgentSummary[]> {
    return (await this.builtins.listAll()).map(builtinSummary);
  }

  // Adds a directory connector, or updates the one with the same slug. The
  // slug (the Codex server name) can never change. Refusals never echo the
  // auth block.
  async putConnector(
    command: PutConnectorCommand,
  ): Promise<{ connector: ConnectorSummary; outcome: ConnectorPutOutcome }> {
    const actor = operatorActor(command.operator);
    const base = { action: "connector.put", actor };
    try {
      const spec = parseConnectorSpec(command.definition);
      await Promise.all([
        this.connectors.ensureIndexes(),
        this.audit.ensureIndexes(),
      ]);
      return await this.database.withTransaction(async (session) => {
        const { connector, outcome } = await this.connectors.put(
          spec,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: {
              slug: connector.slug,
              connectorId: connector._id.toHexString(),
              outcome,
              revision: connector.revision,
            },
          },
          session,
        );
        return { connector: connectorSummary(connector), outcome };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  // Disabling is how a connector is removed: existing connections keep its ID.
  async setConnectorEnabled(
    command: SetEnabledCommand,
  ): Promise<{ connector: ConnectorSummary; changed: boolean }> {
    const actor = operatorActor(command.operator);
    const base = {
      action: command.enabled ? "connector.enable" : "connector.disable",
      actor,
      details: { slug: String(command.slug).slice(0, 64) },
    };
    try {
      await this.audit.ensureIndexes();
      return await this.database.withTransaction(async (session) => {
        const { connector, changed } = await this.connectors.setEnabled(
          command.slug,
          command.enabled,
          command.operator,
          session,
        );
        await this.audit.record(
          {
            ...base,
            result: "success",
            details: {
              ...base.details,
              changed,
              revision: connector.revision,
            },
          },
          session,
        );
        return { connector: connectorSummary(connector), changed };
      });
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  async listConnectors(): Promise<ConnectorSummary[]> {
    return (await this.connectors.listAll()).map(connectorSummary);
  }

  async provisionTenant(command: ProvisionTenantCommand): Promise<TenantDoc> {
    const actor = operatorActor(command.operator);
    const base = {
      action: "tenant.provision",
      actor,
      tenantId: command.tenantId,
    };
    try {
      const tenant = await this.tenants.provision(command);
      await this.audit.record({
        ...base,
        result: "success",
        details: { kind: tenant.kind, dbName: tenant.dbName },
      });
      return tenant;
    } catch (error) {
      await this.recordRefusal(base, error);
      throw error;
    }
  }

  // One read-only pass over the tenant databases. Prints counts and rates
  // only; never a suggestion's or a member's text. Not audited: it changes
  // nothing.
  async followUpsReport(
    command: FollowUpsReportCommand,
  ): Promise<FollowUpsReport> {
    const ready = await this.tenants.listReady();
    const selected = command.tenantId
      ? ready.filter((tenant) => tenant._id.equals(command.tenantId))
      : ready;
    if (command.tenantId && selected.length === 0)
      throw new DomainError("NOT_FOUND", "No provisioned tenant has this ID.");
    return buildFollowUpsReport(
      selected.map((tenant) => this.database.tenantDb(tenant.dbName)),
      {
        since: command.since,
        minSets: command.minSets,
        close: command.close,
      },
    );
  }

  async helpersReport(command: HelpersReportCommand): Promise<HelpersReport> {
    const ready = await this.tenants.listReady();
    const selected = command.tenantId
      ? ready.filter((tenant) => tenant._id.equals(command.tenantId))
      : ready;
    if (command.tenantId && selected.length === 0)
      throw new DomainError("NOT_FOUND", "No provisioned tenant has this ID.");
    return buildHelpersReport(
      selected.map((tenant) => this.database.tenantDb(tenant.dbName)),
      { since: command.since },
    );
  }

  // Brings one ready tenant's indexes, or every ready tenant behind this
  // release, up to TENANT_INDEX_VERSION. One tenant at a time: index builds
  // are a deploy step, not a race. Each tenant is audited.
  async ensureTenantIndexes(
    command: EnsureTenantIndexesCommand,
  ): Promise<TenantDoc[]> {
    const actor = operatorActor(command.operator);
    const ids = command.tenantId
      ? [command.tenantId]
      : await this.tenants.staleIndexTenantIds();
    const done: TenantDoc[] = [];
    for (const tenantId of ids) {
      const base = { action: "tenant.ensure_indexes", actor, tenantId };
      try {
        const tenant = await this.tenants.ensureIndexesOf(tenantId);
        await this.audit.record({
          ...base,
          result: "success",
          details: { indexVersion: tenant.indexVersion ?? 0 },
        });
        done.push(tenant);
      } catch (error) {
        await this.recordRefusal(base, error);
        throw error;
      }
    }
    return done;
  }

  // Sets an existing account's role in one exact tenant. Repeating it with
  // the same role changes nothing but is audited again.
  async assignRole(command: AssignRoleCommand): Promise<AssignRoleResult> {
    const actor = operatorActor(command.operator);
    const base = {
      action: "membership.assign_role",
      actor,
      tenantId: command.tenantId,
    };
    try {
      if (!isRole(command.role))
        throw new DomainError(
          "INVALID_INPUT",
          'Role must be "user" or "admin".',
        );
      // Index builds run outside the transaction, so finish them first.
      await Promise.all([
        this.users.ensureIndexes(),
        this.memberships.ensureIndexes(),
        this.audit.ensureIndexes(),
      ]);
      // The role change and its audit record commit together or not at all.
      return await this.database.withTransaction(async (session) => {
        const user = await this.resolveUser(command.user, session);
        const { membership, previousRole } =
          await this.memberships.assignRoleAsOperator(
            user._id,
            command.tenantId,
            command.role,
            session,
          );
        await this.audit.record(
          {
            ...base,
            result: "success",
            targetUserId: user._id,
            details: { role: membership.role, previousRole },
          },
          session,
        );
        return { user, membership, previousRole };
      });
    } catch (error) {
      await this.recordRefusal(
        { ...base, details: { role: String(command.role).slice(0, 32) } },
        error,
      );
      throw error;
    }
  }

  private async resolveUser(
    reference: string,
    session: Parameters<UsersService["findById"]>[1],
  ): Promise<UserDoc> {
    const userId = parseWireId(reference);
    let user: UserDoc | null;
    if (userId) user = await this.users.findById(userId, session);
    else if (isValidEmail(reference))
      user = await this.users.findByEmail(reference, session);
    else
      throw new DomainError(
        "INVALID_INPUT",
        "The user must be an account ID or an email address.",
      );
    if (!user)
      throw new DomainError(
        "NOT_FOUND",
        "No account matches. The person must sign in once before a role can be assigned.",
      );
    if (user.status !== "active")
      throw new DomainError("FORBIDDEN", "This account is disabled.");
    return user;
  }

  // Business-rule refusals are audited as denied. Unexpected errors are
  // audited as failed when the database still accepts the write.
  private async recordRefusal(
    base: {
      action: string;
      actor: AuditActor;
      tenantId?: ObjectId;
      details?: Record<string, string>;
    },
    error: unknown,
  ): Promise<void> {
    const denied = error instanceof DomainError;
    await this.audit
      .record({
        ...base,
        result: denied ? "denied" : "failed",
        reason: denied ? error.message : "unexpected error",
      })
      .catch(() => undefined);
  }
}

function operatorActor(name: string): AuditActor {
  if (typeof name !== "string" || !OPERATOR_NAME.test(name))
    throw new DomainError(
      "INVALID_INPUT",
      "Operator name must be 1-64 letters, digits or . _ @ - characters.",
    );
  return { kind: "operator", name };
}
