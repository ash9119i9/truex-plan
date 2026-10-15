import { Inject, Injectable } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { DatabaseService } from "../../database/database.service";
import { AUDIT_COLLECTION, type AuditDoc, type AuditEvent } from "./audit";

// Append-only security audit trail in the catalog. Pass the session of the
// change being audited so the change and its record commit together.
@Injectable()
export class AuditService {
  private indexesReady?: Promise<void>;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private events(): Collection<AuditDoc> {
    return this.database.catalog().collection<AuditDoc>(AUDIT_COLLECTION);
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.events().createIndexes([
      { key: { at: -1 }, name: "by_time" },
      { key: { tenantId: 1, at: -1 }, name: "by_tenant_time" },
    ]);
  }

  async record(event: AuditEvent, session?: ClientSession): Promise<void> {
    await this.ensureIndexes();
    await this.events().insertOne(
      { _id: new ObjectId(), at: new Date(), ...event },
      { session, ignoreUndefined: true },
    );
  }
}
