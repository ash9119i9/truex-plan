import { Inject, Injectable } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { canonicalJson } from "../../common/canonical-json";
import { DomainError } from "../../common/domain-error";
import { TtlCache } from "../../common/ttl-cache";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import {
  MODEL_IDENTITY_FIELDS,
  MODELS_COLLECTION,
  type ModelDoc,
  type ModelSpec,
} from "./model";

// Members' reads tolerate this much staleness after the product team changes
// a model. Writes that depend on a model (creating an agent) read it fresh.
export const MODEL_CACHE_TTL_MS = 60_000;
// The catalog holds a handful of models; this only bounds a mistake.
const MAX_MODELS = 500;

// Optional settings. A put is the whole definition, so one that leaves a
// setting out removes it.
const OPTIONAL_FIELDS = [
  "apiKeySecretArn",
  "apiKey",
  "thinking",
  "firstByteTimeoutMs",
  "reasoningEffort",
  "promptCache",
] as const satisfies readonly (keyof ModelSpec)[];

// Never loaded into the shared cache or returned from a listing.
const SECRET_PROJECTION = { apiKey: 0, apikey: 0, apiKeySecretArn: 0 } as const;

export type PutOutcome = "created" | "updated" | "unchanged";

export interface PutModelResult {
  model: ModelDoc;
  outcome: PutOutcome;
}

function specOf(doc: ModelDoc): ModelSpec {
  const spec: Record<string, unknown> = {
    slug: doc.slug,
    displayName: doc.displayName,
    shortLabel: doc.shortLabel,
    family: doc.family,
    wireApi: doc.wireApi,
    baseUrl: doc.baseUrl,
    modelName: doc.modelName,
    maxOutputTokens: doc.maxOutputTokens,
    contextWindow: doc.contextWindow,
    autoCompactTokenLimit: doc.autoCompactTokenLimit,
    sortOrder: doc.sortOrder,
  };
  for (const field of OPTIONAL_FIELDS) spec[field] = doc[field];
  return spec as unknown as ModelSpec;
}

// The model catalog. Writes come only from the operator CLI; members read
// enabled models through a short-lived cache.
@Injectable()
export class ModelsService {
  private indexesReady?: Promise<void>;
  private readonly enabledCache = new TtlCache<ModelDoc[]>(
    () => this.loadEnabled(),
    MODEL_CACHE_TTL_MS,
  );

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private models(): Collection<ModelDoc> {
    return this.database.catalog().collection<ModelDoc>(MODELS_COLLECTION);
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.models().createIndexes([
      {
        key: { slug: 1 },
        name: "slug_unique",
        unique: true,
        // Hand-made gateway profiles without a slug may share the collection.
        partialFilterExpression: { slug: { $type: "string" } },
      },
    ]);
  }

  // Creates the model, or brings an existing one with the same slug up to
  // this definition. Identical definitions change nothing.
  async put(
    spec: ModelSpec,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<PutModelResult> {
    const existing = await this.models().findOne(
      { slug: spec.slug },
      { session },
    );
    const now = new Date();
    if (!existing) {
      const doc: ModelDoc = {
        _id: new ObjectId(),
        ...spec,
        enabled: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        updatedBy,
      };
      try {
        await this.models().insertOne(doc, { session });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        throw new DomainError(
          "CONFLICT",
          "Another change to this model ran at the same time. Run it again.",
        );
      }
      this.enabledCache.clear();
      return { model: doc, outcome: "created" };
    }

    for (const field of MODEL_IDENTITY_FIELDS)
      if (existing[field] !== spec[field])
        throw new DomainError(
          "CONFLICT",
          `${field} of "${spec.slug}" cannot change: existing chats use this model. Add a new model with a new slug and disable this one.`,
        );
    if (canonicalJson(specOf(existing)) === canonicalJson(spec))
      return { model: existing, outcome: "unchanged" };

    const $unset: Record<string, ""> = {};
    for (const field of OPTIONAL_FIELDS)
      if (spec[field] === undefined) $unset[field] = "";
    const updated = await this.models().findOneAndUpdate(
      { _id: existing._id, revision: existing.revision },
      {
        $set: { ...spec, updatedAt: now, updatedBy },
        $inc: { revision: 1 },
        ...(Object.keys($unset).length > 0 ? { $unset } : {}),
      },
      { returnDocument: "after", session },
    );
    if (!updated)
      throw new DomainError(
        "CONFLICT",
        "The model changed while saving. Run it again.",
      );
    this.enabledCache.clear();
    return { model: updated, outcome: "updated" };
  }

  // Enabling or disabling is the only removal: chats keep the model's ID.
  async setEnabled(
    slug: string,
    enabled: boolean,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<{ model: ModelDoc; changed: boolean }> {
    const existing = await this.models().findOne({ slug }, { session });
    if (!existing)
      throw new DomainError("NOT_FOUND", `No model has the slug "${slug}".`);
    if (existing.enabled === enabled)
      return { model: existing, changed: false };
    const updated = await this.models().findOneAndUpdate(
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
        "The model changed while saving. Run it again.",
      );
    this.enabledCache.clear();
    return { model: updated, changed: true };
  }

  findBySlug(slug: string, session?: ClientSession): Promise<ModelDoc | null> {
    return this.models().findOne(
      { slug },
      { session, projection: SECRET_PROJECTION },
    );
  }

  // Every model with a slug, for the operator listing. No secrets.
  listAll(): Promise<ModelDoc[]> {
    return this.models()
      .find({ slug: { $type: "string" } }, { projection: SECRET_PROJECTION })
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_MODELS)
      .toArray();
  }

  // Enabled models in display order, possibly up to MODEL_CACHE_TTL_MS old.
  enabledModels(): Promise<ModelDoc[]> {
    return this.enabledCache.get();
  }

  // An enabled model, for starting a turn: from the cache, so a model the
  // product team disables keeps starting turns for up to MODEL_CACHE_TTL_MS.
  // One the cache does not know (added since it loaded) is read now.
  async enabledById(modelId: ObjectId): Promise<ModelDoc | null> {
    const cached = (await this.enabledModels()).find((model) =>
      model._id.equals(modelId),
    );
    return cached ?? this.findEnabled(modelId);
  }

  // An enabled model read now, for writes that must not use a stale answer.
  findEnabled(
    modelId: ObjectId,
    session?: ClientSession,
  ): Promise<ModelDoc | null> {
    return this.models().findOne(
      { _id: modelId, enabled: true, slug: { $type: "string" } },
      { session, projection: SECRET_PROJECTION },
    );
  }

  // Enabled models among `modelIds`, read now. For references the cache may
  // not know yet, such as a model added since it was loaded.
  findEnabledMany(modelIds: readonly ObjectId[]): Promise<ModelDoc[]> {
    if (modelIds.length === 0) return Promise.resolve([]);
    return this.models()
      .find(
        {
          _id: { $in: [...modelIds] },
          enabled: true,
          slug: { $type: "string" },
        },
        { projection: SECRET_PROJECTION },
      )
      .limit(MAX_MODELS)
      .toArray();
  }

  private loadEnabled(): Promise<ModelDoc[]> {
    return this.models()
      .find(
        { enabled: true, slug: { $type: "string" } },
        { projection: SECRET_PROJECTION },
      )
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_MODELS)
      .toArray();
  }
}
