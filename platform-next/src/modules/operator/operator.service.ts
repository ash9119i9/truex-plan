import { Inject, Injectable } from "@nestjs/common";
import type { ObjectId } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import { parseWireId } from "../../database/object-id";
import type { AuditActor } from "../audit/audit";
import { AuditService } from "../audit/audit.service";
import {
  isRole,
  type MembershipDoc,
  type Role,
} from "../memberships/membership";
import { MembershipsService } from "../memberships/memberships.service";
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
  ) {}

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
      tenantId: ObjectId;
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
