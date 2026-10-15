import { Inject, Injectable } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import { TenantsService } from "../tenants/tenants.service";
import {
  MEMBERSHIPS_COLLECTION,
  type JoinedVia,
  type MembershipDoc,
  type Role,
} from "./membership";

export interface JoinInput {
  userId: ObjectId;
  tenantId: ObjectId;
  joinedVia: Exclude<JoinedVia, "operator">;
  inviteId?: ObjectId;
}

// Membership lifecycle. Joining always creates a "user" membership: the role
// is never taken from the caller, and only the operator path grants admin.
@Injectable()
export class MembershipsService {
  private indexesReady?: Promise<void>;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  private memberships(): Collection<MembershipDoc> {
    return this.database
      .catalog()
      .collection<MembershipDoc>(MEMBERSHIPS_COLLECTION);
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.memberships().createIndexes([
      {
        key: { userId: 1, tenantId: 1 },
        name: "user_tenant_unique",
        unique: true,
      },
      // Active memberships by user (tenant list) and by tenant (member list).
      {
        key: { userId: 1, status: 1 },
        name: "by_user_status",
      },
      {
        key: { tenantId: 1, status: 1 },
        name: "by_tenant_status",
      },
    ]);
  }

  // Adds the user to a usable tenant as "user". Repeating it returns the same
  // membership. A removed membership stays removed: ordinary joining never
  // restores access an admin or operator took away.
  async join(
    input: JoinInput,
    session?: ClientSession,
  ): Promise<MembershipDoc> {
    await this.ensureIndexes();
    if (!(await this.tenants.findUsable(input.tenantId, session)))
      throw new DomainError("NOT_FOUND", "The tenant is not available.");

    const now = new Date();
    const fields: Omit<MembershipDoc, "_id"> = {
      userId: input.userId,
      tenantId: input.tenantId,
      role: "user",
      status: "active",
      joinedVia: input.joinedVia,
      createdAt: now,
      updatedAt: now,
      ...(input.inviteId ? { inviteId: input.inviteId } : {}),
    };

    let membership: MembershipDoc | null;
    try {
      membership = await this.memberships().findOneAndUpdate(
        { userId: input.userId, tenantId: input.tenantId },
        { $setOnInsert: { _id: new ObjectId(), ...fields } },
        { upsert: true, returnDocument: "after", session },
      );
    } catch (error) {
      // Two concurrent upserts can both miss and race on the unique index;
      // the loser reads the winner's row.
      if (!isDuplicateKeyError(error) || session) throw error;
      membership = await this.find(input.userId, input.tenantId);
    }
    if (!membership) throw new Error("Membership upsert returned no document.");
    if (membership.status === "removed")
      throw new DomainError(
        "FORBIDDEN",
        "Your access to this tenant was removed.",
      );
    return membership;
  }

  // Operator-only: sets the role of an existing user in an exact tenant,
  // creating the membership if needed. Not reachable from any HTTP route.
  async assignRoleAsOperator(
    userId: ObjectId,
    tenantId: ObjectId,
    role: Role,
    session?: ClientSession,
  ): Promise<{ membership: MembershipDoc; previousRole: Role | null }> {
    if (role !== "user" && role !== "admin")
      throw new DomainError("INVALID_INPUT", 'Role must be "user" or "admin".');
    await this.ensureIndexes();
    if (!(await this.tenants.findUsable(tenantId, session)))
      throw new DomainError("NOT_FOUND", "The tenant is not available.");

    const before = await this.find(userId, tenantId, session);
    if (before?.status === "removed")
      throw new DomainError(
        "CONFLICT",
        "This membership was removed; restoring it needs a separate decision.",
      );

    const now = new Date();
    let membership: MembershipDoc | null;
    try {
      membership = await this.memberships().findOneAndUpdate(
        { userId, tenantId, status: "active" },
        {
          $set: { role, updatedAt: now },
          $setOnInsert: {
            _id: new ObjectId(),
            status: "active",
            joinedVia: "operator",
            createdAt: now,
          },
        },
        { upsert: true, returnDocument: "after", session },
      );
    } catch (error) {
      // Lost an insert race, or the membership was removed in between.
      if (!isDuplicateKeyError(error)) throw error;
      throw new DomainError(
        "CONFLICT",
        "The membership changed while assigning the role. Run it again.",
      );
    }
    if (!membership) throw new Error("Role assignment returned no document.");
    return { membership, previousRole: before?.role ?? null };
  }

  find(
    userId: ObjectId,
    tenantId: ObjectId,
    session?: ClientSession,
  ): Promise<MembershipDoc | null> {
    return this.memberships().findOne({ userId, tenantId }, { session });
  }

  // The membership that grants access right now, or null.
  findActive(
    userId: ObjectId,
    tenantId: ObjectId,
    session?: ClientSession,
  ): Promise<MembershipDoc | null> {
    return this.memberships().findOne(
      { userId, tenantId, status: "active" },
      { session },
    );
  }

  async listActiveForUser(userId: ObjectId): Promise<MembershipDoc[]> {
    return this.memberships()
      .find({ userId, status: "active" })
      .sort({ createdAt: 1, _id: 1 })
      .limit(500)
      .toArray();
  }
}
