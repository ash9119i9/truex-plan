import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ObjectId, type Collection } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import type { FilesConfig } from "../../config/files-config";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import { toWireId } from "../../database/object-id";
import { CHAT_FILES_COLLECTION } from "./chat";
import {
  AdapterRefusal,
  type ChatRef,
  type RuntimeClient,
} from "./runtime-client";

// Files a chat's runs produce. The runtime's workspace is temporary (an
// AgentCore session ends), so after each run the platform copies every new or
// changed file into object storage as a new version. Nothing is ever
// overwritten: a version the model later deletes or rewrites can still be
// opened. Members only ever read files from here, never from the runtime.

// Per run: at most this many files are stored, and this many bytes in total.
// The rest wait for the next run's capture.
export const MAX_FILES_PER_RUN = 20;
export const MAX_RUN_FILE_BYTES = 100 * 1024 * 1024;
// A capture taking longer than this is cut short; the run is saved anyway.
export const CAPTURE_TIMEOUT_MS = 30_000;
// Versions listed for one chat.
const MAX_LISTED = 300;

export interface ChatFileDoc {
  _id: ObjectId;
  chatId: ObjectId;
  ownerId: ObjectId;
  // The run whose capture stored this version; for an upload, the run its
  // message started (or would have).
  runId: ObjectId;
  // "upload": a file the member attached, not one the assistant made.
  // Absent for captured files.
  source?: "upload";
  // Workspace-relative, "/"-separated, as the runtime reported it.
  path: string;
  version: number;
  size: number;
  sha256: string;
  contentType: string;
  storageKey: string;
  // The file's modification time in the runtime, to skip unchanged files
  // without reading them.
  sourceModifiedAt: number;
  createdAt: Date;
}

export interface ChatFileView {
  readonly id: string;
  readonly runId: string;
  readonly path: string;
  readonly name: string;
  readonly version: number;
  readonly size: number;
  readonly contentType: string;
  readonly createdAt: string;
  readonly source?: "upload";
}

// Where file bytes live. S3 in deployments; memory in tests.
export interface FileStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  // Null when the object is missing.
  get(key: string): Promise<Readable | null>;
}

export const FILE_STORE = Symbol("FILE_STORE");

export class S3FileStore implements FileStore {
  private readonly client: S3Client;

  constructor(private readonly config: FilesConfig) {
    this.client = new S3Client({ region: config.region });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.config.prefix + key,
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
        ChecksumAlgorithm: "SHA256",
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async get(key: string): Promise<Readable | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: this.config.prefix + key,
        }),
      );
      return res.Body instanceof Readable ? res.Body : null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }
}

export class MemoryFileStore implements FileStore {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  // Tests: every put fails with this until it is cleared.
  failPuts: Error | null = null;

  put(key: string, data: Buffer, contentType: string): Promise<void> {
    if (this.failPuts) return Promise.reject(this.failPuts);
    this.objects.set(key, { data: Buffer.from(data), contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<Readable | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object ? Readable.from([object.data]) : null);
  }
}

export function fileStoreFor(config: AppConfig): FileStore | null {
  if (!config.files) return null;
  return config.files.store ?? new S3FileStore(config.files);
}

// Unsaved paths kept per run.
export const MAX_UNSAVED = 50;

export interface CaptureScope {
  // Paths whose failure is reported: the files the run wrote.
  readonly report?: ReadonlySet<string>;
  // Capture only these paths, reporting each that fails (a retry).
  readonly only?: ReadonlySet<string>;
}

export interface CaptureResult {
  readonly stored: ChatFileView[];
  // Reported paths that couldn't be stored, at most MAX_UNSAVED.
  readonly unsaved: string[];
}

export interface CaptureTarget {
  readonly dbName: string;
  readonly tenantId: string;
  readonly chatId: ObjectId;
  readonly ownerId: ObjectId;
  readonly runId: ObjectId;
  readonly ref: ChatRef;
}

@Injectable()
export class ChatFilesService {
  private readonly logger = new Logger("ChatFiles");

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(FILE_STORE)
    private readonly store: FileStore | null = null,
  ) {}

  get configured(): boolean {
    return this.store !== null;
  }

  // Stores every file in the run's workspace that is new or changed since
  // its last stored version, and returns the versions stored. Never throws:
  // a file that can't be read or stored (or doesn't fit the run's limits) is
  // skipped and logged. Skipped files in `scope.report` are returned as
  // `unsaved`, so the member sees them and can retry; others wait for the
  // next run's capture. `scope.only` captures just those paths (a retry)
  // and reports each one that still fails. A path no longer in the chat is
  // neither stored nor unsaved.
  async capture(
    target: CaptureTarget,
    client: RuntimeClient,
    scope: CaptureScope = {},
    signal: AbortSignal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  ): Promise<CaptureResult> {
    if (!this.store) return { stored: [], unsaved: [] };
    const report = scope.only ?? scope.report ?? new Set<string>();
    const stored: ChatFileView[] = [];
    const unsaved = new Set<string>();
    const skipped = (path: string) => {
      if (report.has(path)) unsaved.add(path);
    };
    // The reported paths still in the chat, once the listing is read.
    let present: Set<string> | null = null;
    try {
      const listed = (await client.files(target.ref)).files;
      const files = scope.only
        ? listed.filter((f) => scope.only!.has(f.path))
        : listed;
      present = new Set(files.map((f) => f.path));
      if (files.length === 0) return { stored, unsaved: [] };
      const latest = await this.latestVersions(
        target.dbName,
        target.chatId,
        files.map((f) => f.path),
      );
      let bytes = 0;
      for (const file of files) {
        const last = latest.get(file.path);
        if (
          last &&
          last.size === file.size &&
          last.sourceModifiedAt === file.modifiedAt
        )
          continue;
        if (
          signal.aborted ||
          stored.length >= MAX_FILES_PER_RUN ||
          bytes + file.size > MAX_RUN_FILE_BYTES
        ) {
          skipped(file.path);
          continue;
        }
        const view = await this.captureOne(target, client, file, last).catch(
          (error: unknown) => {
            this.logger.warn(
              `file capture skipped a file: ${errorName(error)}`,
            );
            skipped(file.path);
            return null;
          },
        );
        if (view) {
          stored.push(view);
          bytes += view.size;
        }
      }
    } catch (error) {
      this.logger.warn(`file capture failed: ${errorName(error)}`);
      // Whatever was not stored by then is unsaved.
      const done = new Set(stored.map((f) => f.path));
      for (const path of report)
        if (!done.has(path) && (!present || present.has(path)))
          unsaved.add(path);
    }
    return { stored, unsaved: [...unsaved].slice(0, MAX_UNSAVED) };
  }

  // Every stored version of the chat's files, newest first. The caller has
  // already checked the chat is the member's.
  async list(dbName: string, chatId: ObjectId): Promise<ChatFileView[]> {
    if (!this.store) return [];
    const docs = await this.files(dbName)
      .find({ chatId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_LISTED)
      .toArray();
    return docs.map(fileView);
  }

  // One version's bytes, for the chat's owner only.
  async open(
    dbName: string,
    chatId: ObjectId,
    ownerId: ObjectId,
    fileId: ObjectId,
  ): Promise<{ doc: ChatFileDoc; body: Readable }> {
    const doc = this.store
      ? await this.files(dbName).findOne({ _id: fileId, chatId, ownerId })
      : null;
    if (!doc) throw new DomainError("NOT_FOUND", FILE_NOT_FOUND);
    const body = await this.store!.get(doc.storageKey);
    if (!body) {
      this.logger.error(`stored file object is missing: ${toWireId(doc._id)}`);
      throw new DomainError("NOT_FOUND", FILE_NOT_FOUND);
    }
    return { doc, body };
  }

  private async captureOne(
    target: CaptureTarget,
    client: RuntimeClient,
    file: { path: string; size: number; modifiedAt: number },
    last: ChatFileDoc | undefined,
  ): Promise<ChatFileView | null> {
    let data: Buffer;
    try {
      data = await client.file(target.ref, file.path);
    } catch (error) {
      // Deleted or replaced since the listing: nothing to store.
      if (error instanceof AdapterRefusal && error.code === "FILE_NOT_FOUND")
        return null;
      throw error;
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (last?.sha256 === sha256) {
      // Touched, not changed: remember the new time so it isn't read again.
      await this.files(target.dbName).updateOne(
        { _id: last._id },
        { $set: { sourceModifiedAt: file.modifiedAt } },
      );
      return null;
    }
    const id = new ObjectId();
    const contentType = contentTypeOf(file.path);
    const storageKey = `t/${target.tenantId}/c/${toWireId(target.chatId)}/f/${toWireId(id)}`;
    await this.store!.put(storageKey, data, contentType);
    const doc: ChatFileDoc = {
      _id: id,
      chatId: target.chatId,
      ownerId: target.ownerId,
      runId: target.runId,
      path: file.path,
      version: (last?.version ?? 0) + 1,
      size: data.length,
      sha256,
      contentType,
      storageKey,
      sourceModifiedAt: file.modifiedAt,
      createdAt: new Date(),
    };
    try {
      await this.files(target.dbName).insertOne(doc);
    } catch (error) {
      // Another capture stored this version first; its object is the one
      // kept. This one's object is left unreferenced.
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
    return fileView(doc);
  }

  // Copies a message's attached files from storage into the chat's runtime
  // workspace, before its run starts. Throws on the first one that fails
  // (AdapterRefusal, AdapterUnreachable, or a storage error).
  async copyAttachments(
    dbName: string,
    ref: ChatRef,
    client: RuntimeClient,
    attachments: ReadonlyArray<{ fileId: ObjectId; name: string }>,
  ): Promise<void> {
    if (!this.store) throw new Error("file storage is not configured");
    const docs = await this.files(dbName)
      .find({ _id: { $in: attachments.map((a) => a.fileId) } })
      .toArray();
    const byId = new Map(docs.map((d) => [toWireId(d._id), d]));
    const copies: Array<{ fileId: ObjectId; modifiedAt: number }> = [];
    for (const attachment of attachments) {
      const doc = byId.get(toWireId(attachment.fileId));
      const body = doc ? await this.store.get(doc.storageKey) : null;
      if (!doc || !body) throw new Error("attached file is missing");
      const data = await readAll(body);
      const { modifiedAt } = await client.putUpload(
        ref,
        attachment.name,
        doc.sha256,
        data,
      );
      copies.push({ fileId: doc._id, modifiedAt });
    }
    await this.markCopied(dbName, copies).catch((error: unknown) =>
      this.logger.warn(`attachment copy not recorded: ${errorName(error)}`),
    );
  }

  // The newest stored version number of each path.
  async latestVersionNumbers(
    dbName: string,
    chatId: ObjectId,
    paths: string[],
  ): Promise<Map<string, number>> {
    if (paths.length === 0) return new Map();
    const latest = await this.latestVersions(dbName, chatId, paths);
    return new Map([...latest].map(([path, doc]) => [path, doc.version]));
  }

  // Records where the run's copy of an attached file stands, so the next
  // capture doesn't read it back to find it unchanged.
  async markCopied(
    dbName: string,
    copies: ReadonlyArray<{ fileId: ObjectId; modifiedAt: number }>,
  ): Promise<void> {
    if (copies.length === 0) return;
    await this.files(dbName).bulkWrite(
      copies.map((c) => ({
        updateOne: {
          filter: { _id: c.fileId },
          update: { $set: { sourceModifiedAt: c.modifiedAt } },
        },
      })),
      { ordered: false },
    );
  }

  // The newest stored version of each path, in one query.
  private async latestVersions(
    dbName: string,
    chatId: ObjectId,
    paths: string[],
  ): Promise<Map<string, ChatFileDoc>> {
    const docs = await this.files(dbName)
      .aggregate<ChatFileDoc>([
        { $match: { chatId, path: { $in: paths } } },
        { $sort: { path: 1, version: -1 } },
        { $group: { _id: "$path", doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
      ])
      .toArray();
    return new Map(docs.map((doc) => [doc.path, doc]));
  }

  private files(dbName: string): Collection<ChatFileDoc> {
    return this.database
      .tenantDb(dbName)
      .collection<ChatFileDoc>(CHAT_FILES_COLLECTION);
  }
}

const FILE_NOT_FOUND = "This file does not exist or you cannot see it.";

export function fileView(doc: ChatFileDoc): ChatFileView {
  return {
    id: toWireId(doc._id),
    runId: toWireId(doc.runId),
    path: doc.path,
    name: doc.path.slice(doc.path.lastIndexOf("/") + 1),
    version: doc.version,
    size: doc.size,
    contentType: doc.contentType,
    createdAt: doc.createdAt.toISOString(),
    ...(doc.source ? { source: doc.source } : {}),
  };
}

const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};
const BINARY_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  zip: "application/zip",
};
// Source files are shown as text.
const CODE = new Set([
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
  "log",
]);

// The type a stored file is described with. Responses never trust it to be
// rendered: content is always sent as an attachment with nosniff.
export function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext =
    dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : "";
  if (TEXT_TYPES[ext]) return `${TEXT_TYPES[ext]}; charset=utf-8`;
  if (BINARY_TYPES[ext]) return BINARY_TYPES[ext];
  if (CODE.has(ext)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function errorName(error: unknown): string {
  if (error instanceof AdapterRefusal) return error.code;
  return error instanceof Error ? error.name : typeof error;
}
