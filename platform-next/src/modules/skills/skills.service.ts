import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ObjectId, type ClientSession, type Collection } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { TtlCache } from "../../common/ttl-cache";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import type { FileStore } from "../chats/chat-files";
import {
  SKILL_VERSIONS_COLLECTION,
  SKILLS_COLLECTION,
  skillArchiveKey,
  type ChatSkill,
  type SkillDoc,
  type SkillVersionDoc,
} from "./skill";
import { MAX_ARCHIVE_BYTES, type SkillBundle } from "./skill-bundle";

// Where skill archives live: the chat files bucket (S3), under `skills/`.
// Null without CHAT_FILES_S3_BUCKET; then no skill can be published.
export const SKILL_STORE = Symbol("SKILL_STORE");

// Members' reads tolerate this much staleness after the product team
// publishes or disables a skill, like models.
export const SKILL_CACHE_TTL_MS = 60_000;
// The catalog holds a handful of skills; this only bounds a mistake.
const MAX_SKILLS = 500;
// Archives kept in memory. Each chat start pushes its skills to its runtime,
// so S3 is read once per version per platform process, not once per chat.
const ARCHIVE_CACHE_BYTES = 64 * 1024 * 1024;

export type PublishOutcome = "created" | "updated" | "unchanged";

export interface PublishResult {
  skill: SkillDoc;
  version: SkillVersionDoc;
  outcome: PublishOutcome;
}

// The skill catalog. Writes come only from the operator CLI.
@Injectable()
export class SkillsService {
  private indexesReady?: Promise<void>;
  // Every skill, enabled or not: agents keep IDs of disabled ones, which the
  // dialog shows as Unavailable.
  private readonly catalogCache = new TtlCache<SkillDoc[]>(
    () => this.loadAll(),
    SKILL_CACHE_TTL_MS,
  );
  private readonly archives = new Map<string, Buffer>();
  private archiveBytes = 0;
  private readonly loading = new Map<string, Promise<Buffer>>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(SKILL_STORE)
    private readonly store: FileStore | null = null,
  ) {}

  private skills(): Collection<SkillDoc> {
    return this.database.catalog().collection<SkillDoc>(SKILLS_COLLECTION);
  }

  private versions(): Collection<SkillVersionDoc> {
    return this.database
      .catalog()
      .collection<SkillVersionDoc>(SKILL_VERSIONS_COLLECTION);
  }

  get configured(): boolean {
    return this.store !== null;
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await Promise.all([
      this.skills().createIndexes([
        { key: { slug: 1 }, name: "slug_unique", unique: true },
      ]),
      this.versions().createIndexes([
        {
          key: { skillId: 1, version: 1 },
          name: "skill_version_unique",
          unique: true,
        },
        {
          key: { skillId: 1, sha256: 1 },
          name: "skill_sha256_unique",
          unique: true,
        },
      ]),
    ]);
  }

  // Stores the archive, then records it as the skill's newest version and
  // the one new chats get. The same bytes again change nothing; bytes an
  // earlier version had make that version current again. The archive is
  // written before the database, so a crash leaves at most an unreferenced
  // object, which a rerun reuses (keys are content-addressed).
  async publish(
    bundle: SkillBundle,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<PublishResult> {
    if (!this.store)
      throw new DomainError(
        "UNAVAILABLE",
        "Skills are stored in the chat files bucket; set CHAT_FILES_S3_BUCKET.",
      );
    const existing = await this.skills().findOne(
      { slug: bundle.slug },
      { session },
    );
    if (existing?.currentSha256 === bundle.sha256) {
      const version = await this.versions().findOne(
        { _id: existing.currentVersionId },
        { session },
      );
      if (version) return { skill: existing, version, outcome: "unchanged" };
    }
    const skillId = existing?._id ?? new ObjectId();
    const now = new Date();
    let version = existing
      ? await this.versions().findOne(
          { skillId, sha256: bundle.sha256 },
          { session },
        )
      : null;
    if (!version) {
      const key = skillArchiveKey(skillId, bundle.sha256);
      await this.store.put(key, bundle.archive, "application/gzip");
      const latest = existing
        ? await this.versions().findOne(
            { skillId },
            { session, sort: { version: -1 }, projection: { version: 1 } },
          )
        : null;
      version = {
        _id: new ObjectId(),
        skillId,
        version: (latest?.version ?? 0) + 1,
        sha256: bundle.sha256,
        sizeBytes: bundle.archive.length,
        fileCount: bundle.fileCount,
        s3Key: key,
        hasScripts: bundle.hasScripts,
        requires: bundle.requires,
        createdAt: now,
        createdBy: updatedBy,
      };
      try {
        await this.versions().insertOne(version, { session });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        throw conflict();
      }
    }

    const current = {
      displayName: bundle.displayName,
      description: bundle.description,
      hasScripts: version.hasScripts,
      currentVersionId: version._id,
      currentVersion: version.version,
      currentSha256: version.sha256,
      updatedAt: now,
      updatedBy,
    };
    if (!existing) {
      const skill: SkillDoc = {
        _id: skillId,
        slug: bundle.slug,
        enabled: true,
        revision: 1,
        createdAt: now,
        ...current,
      };
      try {
        await this.skills().insertOne(skill, { session });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        throw conflict();
      }
      this.catalogCache.clear();
      return { skill, version, outcome: "created" };
    }
    const updated = await this.skills().findOneAndUpdate(
      { _id: existing._id, revision: existing.revision },
      { $set: current, $inc: { revision: 1 } },
      { returnDocument: "after", session },
    );
    if (!updated) throw conflict();
    this.catalogCache.clear();
    return { skill: updated, version, outcome: "updated" };
  }

  // Disabling is the only removal: chats keep their versions, and agents
  // keep the ID (shown as Unavailable).
  async setEnabled(
    slug: string,
    enabled: boolean,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<{ skill: SkillDoc; changed: boolean }> {
    const existing = await this.skills().findOne({ slug }, { session });
    if (!existing)
      throw new DomainError("NOT_FOUND", `No skill has the slug "${slug}".`);
    if (existing.enabled === enabled)
      return { skill: existing, changed: false };
    const updated = await this.skills().findOneAndUpdate(
      { _id: existing._id, revision: existing.revision },
      {
        $set: { enabled, updatedAt: new Date(), updatedBy },
        $inc: { revision: 1 },
      },
      { returnDocument: "after", session },
    );
    if (!updated) throw conflict();
    this.catalogCache.clear();
    return { skill: updated, changed: true };
  }

  // Every skill, read now, for the operator listing.
  listAll(): Promise<SkillDoc[]> {
    return this.loadAll();
  }

  // Every skill, possibly up to SKILL_CACHE_TTL_MS old.
  catalog(): Promise<SkillDoc[]> {
    return this.catalogCache.get();
  }

  async enabledSkills(): Promise<SkillDoc[]> {
    return (await this.catalog()).filter((skill) => skill.enabled);
  }

  // The skills among `ids`, in that order, read now: for saving an agent,
  // which must not accept a skill disabled a moment ago.
  async findMany(
    ids: readonly ObjectId[],
    session?: ClientSession,
  ): Promise<SkillDoc[]> {
    if (ids.length === 0) return [];
    const found = await this.skills()
      .find({ _id: { $in: [...ids] } }, { session })
      .limit(MAX_SKILLS)
      .toArray();
    return ids.flatMap(
      (id) => found.find((skill) => skill._id.equals(id)) ?? [],
    );
  }

  // The versions a new chat gets for `ids`: each enabled skill's current
  // version, in the agent's order. Disabled or unknown skills are left out.
  // From the cache, so a publish reaches new chats within the TTL.
  async snapshot(ids: readonly ObjectId[]): Promise<ChatSkill[]> {
    if (ids.length === 0 || !this.store) return [];
    const catalog = await this.catalog();
    return ids.flatMap((id) => {
      const skill = catalog.find((entry) => entry._id.equals(id));
      if (!skill?.enabled) return [];
      return [
        {
          skillId: skill._id,
          versionId: skill.currentVersionId,
          slug: skill.slug,
          displayName: skill.displayName,
          sha256: skill.currentSha256,
        },
      ];
    });
  }

  // One version's archive bytes, checked against its digest. Kept in memory
  // (least recently used out first) so many chats with the same skill read
  // S3 once.
  async archive(skill: ChatSkill): Promise<Buffer> {
    const cached = this.archives.get(skill.sha256);
    if (cached) {
      this.archives.delete(skill.sha256);
      this.archives.set(skill.sha256, cached);
      return cached;
    }
    let loading = this.loading.get(skill.sha256);
    if (!loading) {
      loading = this.readArchive(skill).finally(() =>
        this.loading.delete(skill.sha256),
      );
      this.loading.set(skill.sha256, loading);
    }
    const data = await loading;
    if (!this.archives.has(skill.sha256)) {
      this.archives.set(skill.sha256, data);
      this.archiveBytes += data.length;
      for (const [sha256, kept] of this.archives) {
        if (this.archiveBytes <= ARCHIVE_CACHE_BYTES) break;
        this.archives.delete(sha256);
        this.archiveBytes -= kept.length;
      }
    }
    return data;
  }

  private async readArchive(skill: ChatSkill): Promise<Buffer> {
    if (!this.store) throw new Error("skill store not configured");
    const body = await this.store.get(
      skillArchiveKey(skill.skillId, skill.sha256),
    );
    if (!body) throw new Error("skill archive missing");
    const data = await readAll(body, MAX_ARCHIVE_BYTES);
    if (createHash("sha256").update(data).digest("hex") !== skill.sha256)
      throw new Error("skill archive does not match its digest");
    return data;
  }

  private loadAll(): Promise<SkillDoc[]> {
    return this.skills().find({}).sort({ slug: 1 }).limit(MAX_SKILLS).toArray();
  }
}

function conflict(): DomainError {
  return new DomainError(
    "CONFLICT",
    "The skill changed while saving. Run it again.",
  );
}

async function readAll(body: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > limit) {
      body.destroy();
      throw new Error("skill archive too large");
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}
