import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  ObjectId,
  type AnyClientBulkWriteModel,
  type ClientBulkWriteResult,
  type Collection,
  type Document,
} from "mongodb";
import type { TenantContext } from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DatabaseService } from "../../database/database.service";
import { toWireId } from "../../database/object-id";
import {
  CHAT_UPLOADS_COLLECTION,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment,
} from "./chat";
import {
  contentTypeOf,
  FILE_STORE,
  type ChatFileDoc,
  type FileStore,
} from "./chat-files";

// Files a member attaches to a message. Each one is uploaded on its own
// before the message is sent ("staged"): the bytes go straight to file
// storage and a small record remembers who sent what. Sending the message
// claims its staged uploads in the same transaction that saves it, and the
// run copies them into the chat's workspace (`uploads/<name>`) before the
// model starts. A staged upload never sent expires after a day.

// Decision 3 of tasks/coding-agent-plan.md.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_UPLOAD_BYTES = 500 * 1024 * 1024;
// Staged and not yet sent, per member.
export const MAX_STAGED_UPLOADS = 30;
export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
// Uploads being received at once, per member and per process. Each holds up
// to MAX_UPLOAD_BYTES in memory until it is stored.
const IN_FLIGHT_PER_MEMBER = 3;
const IN_FLIGHT_PER_PROCESS = 16;
// Bytes of a UTF-8 name, the usual filesystem limit.
const MAX_NAME_BYTES = 255;
const UNSAFE_NAME = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;

// What can be attached: documents the toolchain reads, text, code, images.
const OFFICE = ["docx", "xlsx", "pptx"] as const;
const IMAGES = ["png", "jpg", "jpeg", "gif", "webp"] as const;
const TEXT = [
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "html",
  "htm",
  "log",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "java",
  "go",
  "rs",
  "rb",
  "php",
  "c",
  "h",
  "cpp",
  "cs",
  "kt",
  "swift",
  "sh",
  "sql",
  "css",
  "scss",
  "toml",
  "ini",
  "abap",
] as const;
export const UPLOAD_EXTENSIONS: readonly string[] = [
  "pdf",
  ...OFFICE,
  ...IMAGES,
  ...TEXT,
];

export interface ChatUploadDoc {
  _id: ObjectId;
  ownerId: ObjectId;
  // As shown and as written into the workspace: one NFC path segment.
  name: string;
  size: number;
  sha256: string;
  contentType: string;
  storageKey: string;
  state: "staged" | "attached";
  // Set when sent.
  chatId?: ObjectId;
  messageId?: ObjectId;
  // Staged only: the TTL index removes the record then.
  expiresAt?: Date;
  createdAt: Date;
}

export interface UploadView {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
}

export interface UploadSettings {
  readonly enabled: boolean;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly extensions: readonly string[];
}

// Uploads need somewhere to keep the bytes, and a runtime that can open
// them (coding on: CHAT_UPLOADS_ENABLED=1, matching the adapter's flag).
export function uploadsEnabled(config: AppConfig): boolean {
  return config.chat !== undefined && config.files?.uploads === true;
}

// The name as the member's browser sent it, made safe to show and to write:
// NFC, trimmed, one path segment, a known extension. Refused otherwise.
export function uploadName(raw: unknown): string {
  if (typeof raw !== "string") invalidName();
  const name = raw.normalize("NFC").trim();
  if (
    name.length === 0 ||
    Buffer.byteLength(name) > MAX_NAME_BYTES ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    UNSAFE_NAME.test(name)
  )
    invalidName();
  if (!UPLOAD_EXTENSIONS.includes(extensionOf(name)))
    throw new DomainError(
      "INVALID_INPUT",
      "This kind of file can't be attached. Attach PDF, Word, Excel, PowerPoint, text, code or image files.",
    );
  return name;
}

// The bytes must be what the extension says: a renamed executable or
// archive is refused. Office files are ZIP containers; text and code are
// UTF-8 without NUL bytes.
export function contentMatches(name: string, data: Buffer): boolean {
  const ext = extensionOf(name);
  const starts = (bytes: number[], at = 0) =>
    bytes.every((byte, i) => data[at + i] === byte);
  if (ext === "pdf") return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
  if ((OFFICE as readonly string[]).includes(ext))
    return starts([0x50, 0x4b, 0x03, 0x04]);
  if (ext === "png") return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  if (ext === "jpg" || ext === "jpeg") return starts([0xff, 0xd8, 0xff]);
  if (ext === "gif") return starts([0x47, 0x49, 0x46, 0x38]);
  if (ext === "webp")
    return (
      starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)
    );
  if (data.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

// Names unique within one message: "a.pdf", "a (2).pdf", ...
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 2; taken.has(candidate.toLowerCase()); n++)
      candidate = `${stem} (${n})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function invalidName(): never {
  throw new DomainError(
    "INVALID_INPUT",
    "The file name is not valid. Rename the file and attach it again.",
  );
}

export function uploadView(doc: ChatUploadDoc): UploadView {
  return {
    id: toWireId(doc._id),
    name: doc.name,
    size: doc.size,
    contentType: doc.contentType,
  };
}

@Injectable()
export class ChatUploadsService {
  private readonly logger = new Logger("ChatUploads");
  private readonly inFlight = new Map<string, number>();
  private inFlightTotal = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(FILE_STORE)
    private readonly store: FileStore | null = null,
  ) {}

  get enabled(): boolean {
    return this.store !== null && uploadsEnabled(this.config);
  }

  settings(): UploadSettings {
    return {
      enabled: this.enabled,
      maxFileBytes: MAX_UPLOAD_BYTES,
      maxFiles: MAX_MESSAGE_ATTACHMENTS,
      extensions: UPLOAD_EXTENSIONS,
    };
  }

  // Admits one upload for the member, before its body is read. The returned
  // function must be called once the upload has finished, either way.
  admit(context: TenantContext): () => void {
    this.requireEnabled();
    const key = `${toWireId(context.tenantId)}:${toWireId(context.userId)}`;
    const mine = this.inFlight.get(key) ?? 0;
    if (
      mine >= IN_FLIGHT_PER_MEMBER ||
      this.inFlightTotal >= IN_FLIGHT_PER_PROCESS
    )
      throw new DomainError(
        "RATE_LIMITED",
        "Too many files are uploading at once. Wait for them to finish.",
      );
    this.inFlight.set(key, mine + 1);
    this.inFlightTotal++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlightTotal--;
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left > 0) this.inFlight.set(key, left);
      else this.inFlight.delete(key);
    };
  }

  // Stores a staged upload. `name` is from uploadName.
  async stage(
    context: TenantContext,
    name: string,
    data: Buffer,
  ): Promise<UploadView> {
    this.requireEnabled();
    if (data.length === 0)
      throw new DomainError("INVALID_INPUT", "The file is empty.");
    if (data.length > MAX_UPLOAD_BYTES) throw tooLarge();
    if (!contentMatches(name, data))
      throw new DomainError(
        "INVALID_INPUT",
        "The file's contents don't match its type. Check the file and attach it again.",
      );
    const uploads = this.uploads(context.dbName);
    const staged = await uploads.countDocuments(
      { ownerId: context.userId, state: "staged" },
      { limit: MAX_STAGED_UPLOADS },
    );
    if (staged >= MAX_STAGED_UPLOADS)
      throw new DomainError(
        "LIMIT_REACHED",
        "You have too many attached files waiting to be sent. Send or remove some first.",
      );
    const id = new ObjectId();
    const now = new Date();
    const doc: ChatUploadDoc = {
      _id: id,
      ownerId: context.userId,
      name,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      contentType: contentTypeOf(name),
      storageKey: `t/${toWireId(context.tenantId)}/u/${toWireId(context.userId)}/${toWireId(id)}`,
      state: "staged",
      expiresAt: new Date(now.getTime() + STAGED_TTL_MS),
      createdAt: now,
    };
    try {
      await this.store!.put(doc.storageKey, data, doc.contentType);
    } catch (error) {
      this.logger.warn(
        `upload store failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      throw new DomainError(
        "UNAVAILABLE",
        "The file couldn't be saved. Try attaching it again.",
      );
    }
    await uploads.insertOne(doc);
    return uploadView(doc);
  }

  // Removes a staged upload the member took off a message before sending.
  // A sent one is part of the chat and stays. Its stored bytes are left for
  // the bucket's lifecycle rule (the platform can't delete objects).
  async discard(context: TenantContext, id: ObjectId): Promise<void> {
    this.requireEnabled();
    const result = await this.uploads(context.dbName).deleteOne({
      _id: id,
      ownerId: context.userId,
      state: "staged",
    });
    if (result.deletedCount === 0)
      throw new DomainError(
        "NOT_FOUND",
        "This attached file does not exist or was already sent.",
      );
  }

  // The member's staged uploads with these IDs, in the given order, for a
  // message being saved. Refuses when any is missing, sent or not theirs.
  async staged(
    context: TenantContext,
    ids: readonly ObjectId[],
  ): Promise<ChatUploadDoc[]> {
    if (ids.length === 0) return [];
    this.requireEnabled();
    const docs = await this.uploads(context.dbName)
      .find({
        _id: { $in: [...ids] },
        ownerId: context.userId,
        state: "staged",
      })
      .toArray();
    const byId = new Map(docs.map((d) => [toWireId(d._id), d]));
    const ordered = ids.map((id) => byId.get(toWireId(id)));
    if (ordered.some((d) => !d)) throw attachmentsGone();
    return ordered as ChatUploadDoc[];
  }

  collection(dbName: string): Collection<ChatUploadDoc> {
    return this.uploads(dbName);
  }

  private requireEnabled(): void {
    if (!this.enabled)
      throw new DomainError(
        "UNAVAILABLE",
        "Attaching files is not available on this server.",
      );
  }

  private uploads(dbName: string): Collection<ChatUploadDoc> {
    return this.database
      .tenantDb(dbName)
      .collection<ChatUploadDoc>(CHAT_UPLOADS_COLLECTION);
  }
}

// What saving a message with attachments writes, alongside the message:
// each upload becomes the next version of `uploads/<name>` in the chat's
// files (pointing at the bytes already stored), and its staged record is
// claimed for the message. `claims` are the indexes of the claim writes in
// `writes`; each must match exactly one staged record, or the save aborts.
export interface AttachmentPlan {
  readonly attachments: MessageAttachment[];
  readonly bytes: number;
  readonly paths: string[];
  readonly writes: AnyClientBulkWriteModel<Document>[];
  readonly claims: number[];
}

export function planAttachments(input: {
  readonly uploads: readonly ChatUploadDoc[];
  readonly chatId: ObjectId;
  readonly ownerId: ObjectId;
  readonly runId: ObjectId;
  readonly messageId: ObjectId;
  // The newest stored version of each path, when the chat has one.
  readonly latest: ReadonlyMap<string, number>;
  readonly now: Date;
  readonly uploadsNamespace: string;
  readonly filesNamespace: string;
  // Index of the plan's first write in the whole bulk write.
  readonly offset: number;
}): AttachmentPlan {
  const names = uniqueNames(input.uploads.map((u) => u.name));
  const attachments: MessageAttachment[] = [];
  const writes: AnyClientBulkWriteModel<Document>[] = [];
  const claims: number[] = [];
  let bytes = 0;
  input.uploads.forEach((upload, i) => {
    const name = names[i]!;
    const path = `uploads/${name}`;
    const file: ChatFileDoc = {
      _id: new ObjectId(),
      chatId: input.chatId,
      ownerId: input.ownerId,
      runId: input.runId,
      path,
      version: (input.latest.get(path) ?? 0) + 1,
      size: upload.size,
      sha256: upload.sha256,
      contentType: upload.contentType,
      storageKey: upload.storageKey,
      // Unknown until the run copies it; capture then compares by sha256.
      sourceModifiedAt: 0,
      source: "upload",
      createdAt: input.now,
    };
    attachments.push({
      fileId: file._id,
      name,
      path,
      size: upload.size,
      contentType: upload.contentType,
    });
    bytes += upload.size;
    writes.push({
      namespace: input.filesNamespace,
      name: "insertOne",
      document: file,
    });
    claims.push(input.offset + writes.length);
    writes.push({
      namespace: input.uploadsNamespace,
      name: "updateOne",
      filter: { _id: upload._id, ownerId: input.ownerId, state: "staged" },
      update: {
        $set: {
          state: "attached",
          chatId: input.chatId,
          messageId: input.messageId,
        },
        $unset: { expiresAt: "" },
      },
    });
  });
  return {
    attachments,
    bytes,
    paths: attachments.map((a) => a.path),
    writes,
    claims,
  };
}

// Throws attachmentsGone when a claim matched nothing (a staged upload was
// sent with another message or removed meanwhile), aborting the save.
export function checkClaims(
  result: ClientBulkWriteResult,
  claims: readonly number[],
): void {
  for (const index of claims)
    if (result.updateResults?.get(index)?.matchedCount !== 1)
      throw attachmentsGone();
}

// What the model reads with the message: the member's text, then where the
// attached files are.
export function runtimeText(
  text: string,
  attachments: readonly MessageAttachment[] | undefined,
): string {
  if (!attachments?.length) return text;
  const list = attachments
    .map((a) => `- ${a.path} (${sizeLabel(a.size)})`)
    .join("\n");
  const note = `Attached files, in the chat's files:\n${list}`;
  return text ? `${text}\n\n${note}` : note;
}

// The attached images the model is also shown as images, not only as files
// to open. The platform checked each one's contents against its type.
export function runtimeImages(
  attachments: readonly MessageAttachment[] | undefined,
): string[] {
  return (attachments ?? [])
    .filter((a) => {
      const dot = a.name.lastIndexOf(".");
      return (
        dot > 0 &&
        (IMAGES as readonly string[]).includes(
          a.name.slice(dot + 1).toLowerCase(),
        )
      );
    })
    .map((a) => a.path);
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function tooLarge(): DomainError {
  return new DomainError(
    "TOO_LARGE",
    `Files can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
  );
}

// A staged upload the message names is missing, sent already or not the
// member's. Its own class so a save can tell it from other refusals.
export class AttachmentsGoneError extends DomainError {
  constructor() {
    super(
      "INVALID_INPUT",
      "An attached file is no longer available. Remove it and attach it again.",
    );
  }
}

export function attachmentsGone(): DomainError {
  return new AttachmentsGoneError();
}
