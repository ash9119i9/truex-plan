import { Inject, Injectable } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { TtlCache } from "../../common/ttl-cache";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import { ModelsService } from "../models/models.service";
import {
  BUILTIN_AGENTS_COLLECTION,
  type BuiltinAgentDoc,
  type BuiltinAgentSpec,
} from "./builtin-agent";

export const BUILTIN_CACHE_TTL_MS = 60_000;
const MAX_BUILTINS = 200;

// The picker never needs the product-written prompt.
const NO_INSTRUCTIONS = { instructions: 0 } as const;

export type BuiltinListing = Omit<BuiltinAgentDoc, "instructions">;

// Built-in agents. Writes come only from the operator CLI; members read the
// enabled ones through a short-lived cache, so the picker usually costs no
// catalog query.
@Injectable()
export class BuiltinAgentsService {
  private indexesReady?: Promise<void>;
  private readonly enabledCache = new TtlCache<BuiltinListing[]>(
    () => this.loadEnabled(),
    BUILTIN_CACHE_TTL_MS,
  );

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ModelsService) private readonly models: ModelsService,
  ) {}

  private builtins(): Collection<BuiltinAgentDoc> {
    return this.database
      .catalog()
      .collection<BuiltinAgentDoc>(BUILTIN_AGENTS_COLLECTION);
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.builtins().createIndexes([
      { key: { slug: 1 }, name: "slug_unique", unique: true },
    ]);
  }

  async put(
    spec: BuiltinAgentSpec,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<{
    agent: BuiltinAgentDoc;
    outcome: "created" | "updated" | "unchanged";
  }> {
    const model = await this.models.findBySlug(spec.model, session);
    if (!model)
      throw new DomainError(
        "MODEL_UNAVAILABLE",
        `No model has the slug "${spec.model}".`,
      );
    const { model: _slug, ...fields } = spec;
    const next = { ...fields, modelId: model._id };
    const existing = await this.builtins().findOne(
      { slug: spec.slug },
      { session },
    );
    const now = new Date();
    if (!existing) {
      const doc: BuiltinAgentDoc = {
        _id: new ObjectId(),
        ...next,
        enabled: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        updatedBy,
      };
      try {
        await this.builtins().insertOne(doc, { session });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        throw new DomainError(
          "CONFLICT",
          "Another change to this agent ran at the same time. Run it again.",
        );
      }
      this.enabledCache.clear();
      return { agent: doc, outcome: "created" };
    }

    const same =
      existing.name === next.name &&
      existing.description === next.description &&
      existing.instructions === next.instructions &&
      existing.modelId.equals(next.modelId) &&
      existing.look === next.look &&
      existing.tint === next.tint &&
      existing.sortOrder === next.sortOrder;
    if (same) return { agent: existing, outcome: "unchanged" };

    const updated = await this.builtins().findOneAndUpdate(
      { _id: existing._id, revision: existing.revision },
      {
        $set: { ...next, updatedAt: now, updatedBy },
        $inc: { revision: 1 },
      },
      { returnDocument: "after", session },
    );
    if (!updated)
      throw new DomainError(
        "CONFLICT",
        "The agent changed while saving. Run it again.",
      );
    this.enabledCache.clear();
    return { agent: updated, outcome: "updated" };
  }

  async setEnabled(
    slug: string,
    enabled: boolean,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<{ agent: BuiltinAgentDoc; changed: boolean }> {
    const existing = await this.builtins().findOne({ slug }, { session });
    if (!existing)
      throw new DomainError(
        "NOT_FOUND",
        `No built-in agent has the slug "${slug}".`,
      );
    if (existing.enabled === enabled)
      return { agent: existing, changed: false };
    const updated = await this.builtins().findOneAndUpdate(
      { _id: existing._id, revision: existing.revision },
      {
        $set: { enabled, updatedAt: new Date(), updatedBy },
        $inc: { revision: 1 },
      },
      { returnDocument: "after", session },
    );
    if (!updated)
      throw new DomainError(
        "CONFLICT",
        "The agent changed while saving. Run it again.",
      );
    this.enabledCache.clear();
    return { agent: updated, changed: true };
  }

  listAll(): Promise<BuiltinListing[]> {
    return this.builtins()
      .find({}, { projection: NO_INSTRUCTIONS })
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_BUILTINS)
      .toArray();
  }

  // Enabled built-ins in display order, possibly up to BUILTIN_CACHE_TTL_MS old.
  enabledAgents(): Promise<BuiltinListing[]> {
    return this.enabledCache.get();
  }

  private loadEnabled(): Promise<BuiltinListing[]> {
    return this.builtins()
      .find({ enabled: true }, { projection: NO_INSTRUCTIONS })
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_BUILTINS)
      .toArray();
  }
}
