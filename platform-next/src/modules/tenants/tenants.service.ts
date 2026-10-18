import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientSession, Collection, ObjectId } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import {
  TENANTS_COLLECTION,
  dbNameFor,
  normalizeTenantName,
  type TenantDoc,
  type TenantKind,
} from "./tenant";
import { createTenantIndexes, TENANT_INDEX_VERSION } from "./tenant-indexes";

// Ready tenants whose indexes were built for an older release, or never
// recorded (provisioned before indexes were built at provisioning).
function staleIndexes() {
  return {
    provisioningStatus: "ready" as const,
    indexVersion: { $not: { $gte: TENANT_INDEX_VERSION } },
  };
}

// Each tenant database holds one ownership marker naming the tenant that owns
// it. Provisioning refuses to adopt a database owned by anyone else.
const OWNER_COLLECTION = "_owner";
const OWNER_MARKER_ID = "owner";

interface OwnerMarker {
  _id: typeof OWNER_MARKER_ID;
  tenantId: ObjectId;
  createdAt: Date;
}

export interface ProvisionTenantInput {
  tenantId: ObjectId;
  name: string;
  kind: TenantKind;
}

// The tenant registry. Provisioning is operator-driven and safe to repeat: a
// crash at any step leaves a record that the next run picks up and finishes.
@Injectable()
export class TenantsService {
  private readonly logger = new Logger("Tenants");
  private indexesReady?: Promise<void>;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private tenants(): Collection<TenantDoc> {
    return this.database.catalog().collection<TenantDoc>(TENANTS_COLLECTION);
  }

  // Created once per process on first use, so the app can start while MongoDB
  // is down. A failed attempt is retried by the next caller.
  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.tenants().createIndexes([
      { key: { dbName: 1 }, name: "dbName_unique", unique: true },
      {
        key: { kind: 1 },
        name: "one_default_tenant",
        unique: true,
        partialFilterExpression: { kind: "default" },
      },
    ]);
  }

  async provision(input: ProvisionTenantInput): Promise<TenantDoc> {
    const name = normalizeTenantName(input.name);
    if (!name)
      throw new DomainError(
        "INVALID_INPUT",
        "Tenant name must be 1-100 visible characters.",
      );
    await this.ensureIndexes();

    const tenant = await this.registerPending(input.tenantId, name, input.kind);
    if (tenant.provisioningStatus === "ready") return tenant;

    try {
      await this.claimStorage(tenant);
    } catch (error) {
      if (error instanceof DomainError) await this.markFailed(tenant, error);
      throw error;
    }
    // Before it is marked ready: a tenant anyone can enter always has its
    // indexes. A failure leaves it pending, and the next run retries.
    await createTenantIndexes(this.database.tenantDb(tenant.dbName));

    const now = new Date();
    const ready = await this.tenants().findOneAndUpdate(
      { _id: tenant._id },
      {
        $set: { provisioningStatus: "ready", updatedAt: now },
        $max: { indexVersion: TENANT_INDEX_VERSION },
        $unset: { provisioningError: "" },
      },
      { returnDocument: "after" },
    );
    if (!ready) throw new Error("Tenant record vanished during provisioning.");
    this.logger.log({
      message: "tenant provisioned",
      tenantId: tenant._id.toHexString(),
      kind: tenant.kind,
    });
    return ready;
  }

  // Builds a ready tenant's indexes and records the version. For tenants
  // provisioned before an index change (provision returns early for those).
  // Safe to repeat; never lowers a version a newer release recorded.
  async ensureIndexesOf(tenantId: ObjectId): Promise<TenantDoc> {
    const tenant = await this.tenants().findOne({
      _id: tenantId,
      provisioningStatus: "ready",
    });
    if (!tenant)
      throw new DomainError(
        "NOT_FOUND",
        "No provisioned tenant has this ID. Provision it instead.",
      );
    await createTenantIndexes(this.database.tenantDb(tenant.dbName));
    const updated = await this.tenants().findOneAndUpdate(
      { _id: tenant._id },
      { $max: { indexVersion: TENANT_INDEX_VERSION } },
      { returnDocument: "after" },
    );
    if (!updated) throw new Error("Tenant record vanished during the update.");
    return updated;
  }

  // IDs of ready tenants whose indexes are behind this release, oldest
  // first. Bounded by the number of tenants; read once per command.
  async staleIndexTenantIds(): Promise<ObjectId[]> {
    const stale = await this.tenants()
      .find(staleIndexes(), { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .toArray();
    return stale.map((t) => t._id);
  }

  // One query at startup, whatever the number of tenants.
  countStaleIndexes(): Promise<number> {
    return this.tenants().countDocuments(staleIndexes());
  }

  // Inserts the registry record as pending, or returns the existing one when
  // it matches. Settings that decide storage can never change on a re-run.
  private async registerPending(
    tenantId: ObjectId,
    name: string,
    kind: TenantKind,
  ): Promise<TenantDoc> {
    const dbName = dbNameFor(kind, tenantId);
    const now = new Date();
    let tenant: TenantDoc | null;
    try {
      tenant = await this.tenants().findOneAndUpdate(
        { _id: tenantId },
        {
          $setOnInsert: {
            name,
            dbName,
            kind,
            status: "active",
            provisioningStatus: "pending",
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // A concurrent run inserted the same ID first, or the record collides
      // with another tenant's database or the single default tenant.
      tenant = await this.tenants().findOne({ _id: tenantId });
      if (!tenant)
        throw new DomainError(
          "CONFLICT",
          kind === "default"
            ? "A different default tenant already exists."
            : "Another tenant already uses this database.",
        );
    }
    if (!tenant) throw new Error("Tenant upsert returned no document.");
    if (tenant.kind !== kind || tenant.dbName !== dbName)
      throw new DomainError(
        "CONFLICT",
        "This tenant ID already exists with different settings.",
      );
    return tenant;
  }

  private async claimStorage(tenant: TenantDoc): Promise<void> {
    const db = this.database.tenantDb(tenant.dbName);
    const owners = db.collection<OwnerMarker>(OWNER_COLLECTION);

    let marker = await owners.findOne({ _id: OWNER_MARKER_ID });
    if (!marker) {
      const existing = await db
        .listCollections({}, { nameOnly: true })
        .toArray();
      if (existing.length > 0)
        throw new DomainError(
          "CONFLICT",
          "The tenant database already holds data with no owner; refusing to adopt it.",
        );
      try {
        await owners.insertOne({
          _id: OWNER_MARKER_ID,
          tenantId: tenant._id,
          createdAt: new Date(),
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
      marker = await owners.findOne({ _id: OWNER_MARKER_ID });
    }
    if (!marker?.tenantId.equals(tenant._id))
      throw new DomainError(
        "CONFLICT",
        "The tenant database is owned by another tenant.",
      );
  }

  // Records why provisioning stopped. A later run re-checks and can recover
  // once an operator resolves the cause; transient errors leave it pending.
  private async markFailed(tenant: TenantDoc, error: DomainError) {
    await this.tenants().updateOne(
      { _id: tenant._id, provisioningStatus: { $ne: "ready" } },
      {
        $set: {
          provisioningStatus: "failed",
          provisioningError: error.message,
          updatedAt: new Date(),
        },
      },
    );
    this.logger.warn({
      message: "tenant provisioning failed",
      tenantId: tenant._id.toHexString(),
      reason: error.message,
    });
  }

  findById(
    tenantId: ObjectId,
    session?: ClientSession,
  ): Promise<TenantDoc | null> {
    return this.tenants().findOne({ _id: tenantId }, { session });
  }

  // A tenant that can be entered: active and fully provisioned.
  findUsable(
    tenantId: ObjectId,
    session?: ClientSession,
  ): Promise<TenantDoc | null> {
    return this.tenants().findOne(
      { _id: tenantId, status: "active", provisioningStatus: "ready" },
      { session },
    );
  }

  // The usable tenants among the given IDs, in no particular order.
  findUsableByIds(tenantIds: readonly ObjectId[]): Promise<TenantDoc[]> {
    if (tenantIds.length === 0) return Promise.resolve([]);
    return this.tenants()
      .find({
        _id: { $in: [...tenantIds] },
        status: "active",
        provisioningStatus: "ready",
      })
      .toArray();
  }

  // The shared tenant direct signup joins, when it is usable.
  findDefaultUsable(session?: ClientSession): Promise<TenantDoc | null> {
    return this.tenants().findOne(
      { kind: "default", status: "active", provisioningStatus: "ready" },
      { session },
    );
  }
}
