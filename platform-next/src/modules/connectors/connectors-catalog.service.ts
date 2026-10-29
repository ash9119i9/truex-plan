import { Inject, Injectable } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { canonicalJson } from "../../common/canonical-json";
import { DomainError } from "../../common/domain-error";
import { CATALOG_STALE_MS, TtlCache } from "../../common/ttl-cache";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import {
  CONNECTORS_COLLECTION,
  CONNECTOR_IDENTITY_FIELDS,
  type ConnectorDoc,
  type ConnectorSpec,
} from "./connector";

// Members' reads tolerate this much staleness, plus CATALOG_STALE_MS, after
// the product team changes a connector; a connect reads the connector fresh
// (it needs the exact revision for the flow cookie).
export const CONNECTOR_CACHE_TTL_MS = 60_000;
// The catalog holds a handful of connectors; this only bounds a mistake.
const MAX_CONNECTORS = 200;

export type PutOutcome = "created" | "updated" | "unchanged";

export interface PutConnectorResult {
  connector: ConnectorDoc;
  outcome: PutOutcome;
}

function specOf(doc: ConnectorDoc): ConnectorSpec {
  const spec: ConnectorSpec = {
    slug: doc.slug,
    displayName: doc.displayName,
    description: doc.description,
    icon: doc.icon,
    url: doc.url,
    fixedHeaders: doc.fixedHeaders,
    auth: doc.auth,
    toolTimeoutSec: doc.toolTimeoutSec,
    startupTimeoutSec: doc.startupTimeoutSec,
    sortOrder: doc.sortOrder,
  };
  if (doc.allowedTools !== undefined) spec.allowedTools = doc.allowedTools;
  if (doc.writeTools !== undefined) spec.writeTools = doc.writeTools;
  if (doc.toolHashes !== undefined) spec.toolHashes = doc.toolHashes;
  if (doc.toolTokenEstimate !== undefined)
    spec.toolTokenEstimate = doc.toolTokenEstimate;
  if (doc.egress !== undefined) spec.egress = doc.egress;
  return spec;
}

// The connector catalog. Writes come only from the operator CLI; members read
// enabled connectors through a short-lived cache. Connectors are disabled,
// never deleted: connections pin a connector's ID.
@Injectable()
export class ConnectorsCatalogService {
  private indexesReady?: Promise<void>;
  private readonly enabledCache = new TtlCache<ConnectorDoc[]>(
    () => this.loadEnabled(),
    CONNECTOR_CACHE_TTL_MS,
    Date.now,
    CATALOG_STALE_MS,
  );

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private connectors(): Collection<ConnectorDoc> {
    return this.database
      .catalog()
      .collection<ConnectorDoc>(CONNECTORS_COLLECTION);
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.connectors().createIndexes([
      { key: { slug: 1 }, name: "slug_unique", unique: true },
    ]);
  }

  // Creates the connector, or brings an existing one with the same slug up to
  // this definition. Identical definitions change nothing. The slug can never
  // change (it is the Codex server name); a different slug is a new connector.
  async put(
    spec: ConnectorSpec,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<PutConnectorResult> {
    const existing = await this.connectors().findOne(
      { slug: spec.slug },
      { session },
    );
    const now = new Date();
    if (!existing) {
      const doc: ConnectorDoc = {
        _id: new ObjectId(),
        ...spec,
        enabled: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        updatedBy,
      };
      try {
        await this.connectors().insertOne(doc, { session });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        throw new DomainError(
          "CONFLICT",
          "Another change to this connector ran at the same time. Run it again.",
        );
      }
      this.enabledCache.clear();
      return { connector: doc, outcome: "created" };
    }

    for (const field of CONNECTOR_IDENTITY_FIELDS)
      if (existing[field] !== spec[field])
        throw new DomainError(
          "CONFLICT",
          `${field} of "${spec.slug}" cannot change: existing connections use this connector.`,
        );
    if (canonicalJson(specOf(existing)) === canonicalJson(spec))
      return { connector: existing, outcome: "unchanged" };

    // A put is the whole definition, so settings left out are removed.
    const $unset: Record<string, ""> = {};
    if (spec.allowedTools === undefined) $unset.allowedTools = "";
    if (spec.writeTools === undefined) $unset.writeTools = "";
    if (spec.toolHashes === undefined) $unset.toolHashes = "";
    if (spec.toolTokenEstimate === undefined) $unset.toolTokenEstimate = "";
    if (spec.egress === undefined) $unset.egress = "";
    const updated = await this.connectors().findOneAndUpdate(
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
        "The connector changed while saving. Run it again.",
      );
    this.enabledCache.clear();
    return { connector: updated, outcome: "updated" };
  }

  // Disabling is the only removal: a disabled connector leaves the API but its
  // connections stay readable.
  async setEnabled(
    slug: string,
    enabled: boolean,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<{ connector: ConnectorDoc; changed: boolean }> {
    const existing = await this.connectors().findOne({ slug }, { session });
    if (!existing)
      throw new DomainError(
        "NOT_FOUND",
        `No connector has the slug "${slug}".`,
      );
    if (existing.enabled === enabled)
      return { connector: existing, changed: false };
    const updated = await this.connectors().findOneAndUpdate(
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
        "The connector changed while saving. Run it again.",
      );
    this.enabledCache.clear();
    return { connector: updated, changed: true };
  }

  // An enabled connector read fresh, for the connect flow (it needs the exact
  // current revision to seal into the flow cookie).
  findEnabledBySlug(slug: string): Promise<ConnectorDoc | null> {
    return this.connectors().findOne({ slug, enabled: true });
  }

  // A connector by ID regardless of enabled state, for the callback and the
  // listing merge (a connection may reference a since-disabled connector).
  findById(id: ObjectId): Promise<ConnectorDoc | null> {
    return this.connectors().findOne({ _id: id });
  }

  // Every connector, for the operator listing.
  listAll(): Promise<ConnectorDoc[]> {
    return this.connectors()
      .find({})
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_CONNECTORS)
      .toArray();
  }

  // Enabled connectors in display order, possibly up to the cache TTL old.
  enabledConnectors(): Promise<ConnectorDoc[]> {
    return this.enabledCache.get();
  }

  private loadEnabled(): Promise<ConnectorDoc[]> {
    return this.connectors()
      .find({ enabled: true })
      .sort({ sortOrder: 1, slug: 1 })
      .limit(MAX_CONNECTORS)
      .toArray();
  }
}
