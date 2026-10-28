import { Inject, Injectable } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { CATALOG_STALE_MS, TtlCache } from "../../common/ttl-cache";
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

// Built-in agents. Writes come only from the operator CLI; members read them
// through a short-lived cache of the whole set (at most MAX_BUILTINS, with
// instructions), so the picker, the sidebar and starting a chat with a
// built-in usually cost no catalog query.
@Injectable()
export class BuiltinAgentsService {
  private indexesReady?: Promise<void>;
  private readonly cache = new TtlCache<BuiltinAgentDoc[]>(
    () => this.loadAll(),
    BUILTIN_CACHE_TTL_MS,
    Date.now,
    CATALOG_STALE_MS,
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
      this.cache.clear();
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
    this.cache.clear();
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
    this.cache.clear();
    return { agent: updated, changed: true };
  }

  // Every built-in without instructions, read now, for the operator listing.
  listAll(): Promise<BuiltinListing[]> {
    return this.builtins()
      .find({}, { projection: NO_INSTRUCTIONS })
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_BUILTINS)
      .toArray();
  }

  // Every built-in, enabled or not, possibly up to BUILTIN_CACHE_TTL_MS old.
  // Display fields only.
  async cachedListings(): Promise<BuiltinListing[]> {
    return (await this.cache.get()).map(listingOf);
  }

  // Enabled built-ins in display order, possibly up to BUILTIN_CACHE_TTL_MS old.
  async enabledAgents(): Promise<BuiltinListing[]> {
    return (await this.cache.get()).filter((b) => b.enabled).map(listingOf);
  }

  // A built-in as the cache knows it, instructions included: a disabled one
  // keeps starting chats for up to BUILTIN_CACHE_TTL_MS + CATALOG_STALE_MS
  // after the product team disables it. "unknown" when the cache has never
  // seen the ID: a user agent, or a built-in added since the cache loaded
  // (read it fresh then).
  async cachedById(
    id: ObjectId,
  ): Promise<BuiltinAgentDoc | "disabled" | "unknown"> {
    const builtin = (await this.cache.get()).find((b) => b._id.equals(id));
    if (!builtin) return "unknown";
    return builtin.enabled ? builtin : "disabled";
  }

  // One enabled built-in with its instructions, read now.
  findEnabledWithInstructions(id: ObjectId): Promise<BuiltinAgentDoc | null> {
    return this.builtins().findOne({ _id: id, enabled: true });
  }

  // Enabled or not, without instructions, read now: for display fields of
  // built-ins the cache does not know yet.
  findListings(ids: readonly ObjectId[]): Promise<BuiltinListing[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.builtins()
      .find({ _id: { $in: [...ids] } }, { projection: NO_INSTRUCTIONS })
      .limit(MAX_BUILTINS)
      .toArray();
  }

  private loadAll(): Promise<BuiltinAgentDoc[]> {
    return this.builtins()
      .find({})
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_BUILTINS)
      .toArray();
  }
}

// The cache holds instructions; nothing outside a chat's prompt gets them.
function listingOf(agent: BuiltinAgentDoc): BuiltinListing {
  const { instructions: _instructions, ...listing } = agent;
  return listing;
}
