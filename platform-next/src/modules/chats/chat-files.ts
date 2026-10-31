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
  MAX_WORKSPACE_FILE_BYTES,
  type ChatRef,
  type RuntimeClient,
} from "./runtime-client";

// Files a chat's runs produce. The runtime's workspace is temporary (an
// AgentCore session ends), so after each run the platform copies every new or
// changed file into object storage as a new version. Nothing is ever
// overwritten: a version the model later deletes or rewrites can still be
// opened. Members only ever read files from here, never from the runtime.

// Per run: at most this many files are stored, and this many bytes in total.
// The rest are unsaved: the member can retry them, and the next run's
// capture stores them too.
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
  // `signal` ends a put that is still running.
  put(
    key: string,
    data: Buffer,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void>;
  // Null when the object is missing.
  get(key: string): Promise<Readable | null>;
}

export const FILE_STORE = Symbol("FILE_STORE");

export class S3FileStore implements FileStore {
  private readonly client: S3Client;

  constructor(private readonly config: FilesConfig) {
    this.client = new S3Client({ region: config.region });
  }

  async put(
    key: string,
    data: Buffer,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
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
      signal ? { abortSignal: signal } : undefined,
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
  // Tests: every put hangs until its signal aborts it.
  holdPuts = false;

  put(
    key: string,
    data: Buffer,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.failPuts) return Promise.reject(this.failPuts);
    if (this.holdPuts)
      return new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
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
  // The files the run's edits wrote: reported unsaved when the listing or
  // the version lookup fails, so capture can't tell which files are new.
  readonly report?: ReadonlySet<string>;
  // Capture only these paths, reporting each that fails (a retry).
  readonly only?: ReadonlySet<string>;
}

export interface CaptureResult {
  readonly stored: ChatFileView[];
  // New or changed files that couldn't be stored, the run's edits first, at
  // most MAX_UNSAVED. A retry may store them.
  readonly unsaved: string[];
  // Files over the runtime's per-file limit, at most MAX_UNSAVED. They can
  // never be stored, so they are never retried.
  readonly tooLarge: string[];
  // The runtime listed only part of the workspace: files past its limits
  // weren't checked. The run's edits still were, by path.
  readonly truncated: boolean;
}

// A workspace file as capture handles it. `unlisted`: a path a truncated
// listing missed, read by path; its size and time are unknown until then.
interface CaptureFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
  readonly unlisted?: boolean;
}

export interface CaptureTarget {
  readonly dbName: string;
  readonly tenantId: string;
  readonly chatId: ObjectId;
  readonly ownerId: ObjectId;
  readonly runId: ObjectId;
  readonly ref: ChatRef;
  // When the run started (ms): a too-large file last modified before it
  // was reported by an earlier run. Absent: every too-large file is.
  readonly since?: number;
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
  // its last stored version, and returns the versions stored. Never throws.
  // A new or changed file that can't be read or stored, or doesn't fit the
  // run's limits, is `unsaved`, whether an edit or a command wrote it, so
  // the member sees it and can retry. The run's edits go first, so a
  // command that writes many files can't crowd them out of the limits or
  // the unsaved list. A file over the runtime's per-file limit is
  // `tooLarge` instead: never retried, and shown only by the run that wrote
  // it. A truncated listing is reported, and the edits it missed are read
  // by path. `scope.only` captures just those paths (a retry) and reports
  // each one that still fails. A path no longer in the chat is in none of
  // the lists. The signal bounds the listing, every read and every upload.
  async capture(
    target: CaptureTarget,
    client: RuntimeClient,
    scope: CaptureScope = {},
    signal: AbortSignal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  ): Promise<CaptureResult> {
    const stored: ChatFileView[] = [];
    const unsaved = new Set<string>();
    const tooLarge = new Set<string>();
    let truncated = false;
    const result = (): CaptureResult => ({
      stored,
      unsaved: [...unsaved].slice(0, MAX_UNSAVED),
      tooLarge: [...tooLarge].slice(0, MAX_UNSAVED),
      truncated,
    });
    if (!this.store) return result();
    const report = scope.only ?? scope.report ?? new Set<string>();
    // A file too large to store is shown once: by the run that wrote it.
    const fresh = (file: CaptureFile) =>
      report.has(file.path) ||
      target.since === undefined ||
      file.modifiedAt >= target.since;
    // A member's attached upload is theirs, never a reply's file to report.
    let latest = new Map<string, ChatFileDoc>();
    const isUpload = (path: string) => latest.get(path)?.source === "upload";
    const oversize = (file: CaptureFile) => {
      if (fresh(file) && !isUpload(file.path)) tooLarge.add(file.path);
    };
    const skipped = (path: string) => {
      if (!isUpload(path)) unsaved.add(path);
    };
    // The paths still in the chat, once the listing is read.
    let present: Set<string> | null = null;
    try {
      const listing = await client.files(target.ref, signal);
      truncated = listing.truncated;
      if (truncated)
        this.logger.warn(
          `file capture got a truncated listing (${listing.files.length} files)`,
        );
      const listed: CaptureFile[] = scope.only
        ? listing.files.filter((f) => scope.only!.has(f.path))
        : listing.files;
      const all = new Set(listing.files.map((f) => f.path));
      const unlisted: CaptureFile[] = truncated
        ? [...report]
            .filter((path) => !all.has(path) && listable(path))
            .map((path) => ({ path, size: 0, modifiedAt: 0, unlisted: true }))
        : [];
      // The run's edits first; the sort is stable, so each group keeps the
      // listing's order.
      const files = [...listed, ...unlisted].sort(
        (a, b) => Number(report.has(b.path)) - Number(report.has(a.path)),
      );
      present = new Set(files.map((f) => f.path));
      if (files.length === 0) return result();
      latest = await withSignal(
        this.latestVersions(
          target.dbName,
          target.chatId,
          files.map((f) => f.path),
        ),
        signal,
      );
      let bytes = 0;
      for (const file of files) {
        const last = latest.get(file.path);
        if (
          !file.unlisted &&
          last &&
          last.size === file.size &&
          last.sourceModifiedAt === file.modifiedAt
        )
          continue;
        if (file.size > MAX_WORKSPACE_FILE_BYTES) {
          oversize(file);
          continue;
        }
        if (
          signal.aborted ||
          stored.length >= MAX_FILES_PER_RUN ||
          bytes + file.size > MAX_RUN_FILE_BYTES
        ) {
          // An edit the listing missed may be gone or unchanged: read it
          // (without storing it) before reporting it.
          const outcome =
            file.unlisted && !signal.aborted
              ? await this.probe(target, client, file, last, signal)
              : "unsaved";
          if (outcome === "tooLarge") oversize(file);
          else if (outcome === "unsaved") skipped(file.path);
          continue;
        }
        const view = await this.captureOne(
          target,
          client,
          file,
          last,
          signal,
          MAX_RUN_FILE_BYTES - bytes,
        ).catch((error: unknown) => {
          if (isTooLarge(error)) oversize(file);
          else {
            this.logger.warn(
              `file capture skipped a file: ${errorName(error)}`,
            );
            skipped(file.path);
          }
          return null;
        });
        if (view) {
          stored.push(view);
          bytes += view.size;
        }
      }
    } catch (error) {
      this.logger.warn(`file capture failed: ${errorName(error)}`);
      // The run's edits not stored by then are unsaved; which other files
      // are new isn't known.
      const done = new Set(stored.map((f) => f.path));
      for (const path of report)
        if (
          !done.has(path) &&
          !tooLarge.has(path) &&
          (!present || present.has(path))
        )
          skipped(path);
    }
    return result();
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
    file: CaptureFile,
    last: ChatFileDoc | undefined,
    signal: AbortSignal,
    // Bytes the run may still store.
    room: number,
  ): Promise<ChatFileView | null> {
    let data: Buffer;
    try {
      data = await client.file(target.ref, file.path, signal);
    } catch (error) {
      // Deleted or replaced since the listing, or a path the runtime never
      // reads: nothing to store, now or on a retry.
      if (nothingToStore(error)) return null;
      throw error;
    }
    // Grown since the listing, or never listed: it must still fit the run.
    if (data.length > room) throw new Error("over the run's byte limit");
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (last?.sha256 === sha256) {
      // Touched, not changed: remember the new time so it isn't read again.
      // An unlisted file's time isn't known; the next listing records it.
      if (!file.unlisted)
        await withSignal(
          this.files(target.dbName).updateOne(
            { _id: last._id },
            { $set: { sourceModifiedAt: file.modifiedAt } },
          ),
          signal,
        );
      return null;
    }
    const id = new ObjectId();
    const contentType = contentTypeOf(file.path);
    const storageKey = `t/${target.tenantId}/c/${toWireId(target.chatId)}/f/${toWireId(id)}`;
    await this.store!.put(storageKey, data, contentType, signal);
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
      // An insert cut short by the deadline may still land; the next capture
      // then finds this version and stores nothing twice.
      await withSignal(this.files(target.dbName).insertOne(doc), signal);
    } catch (error) {
      // Another capture stored this version first; its object is the one
      // kept. This one's object is left unreferenced.
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
    return fileView(doc);
  }

  // A file the listing missed, read but not stored, when the run's limits
  // leave no room for it: gone, refused or unchanged is nothing to report.
  private async probe(
    target: CaptureTarget,
    client: RuntimeClient,
    file: CaptureFile,
    last: ChatFileDoc | undefined,
    signal: AbortSignal,
  ): Promise<"skip" | "unsaved" | "tooLarge"> {
    try {
      const data = await client.file(target.ref, file.path, signal);
      const sha256 = createHash("sha256").update(data).digest("hex");
      return last?.sha256 === sha256 ? "skip" : "unsaved";
    } catch (error) {
      if (nothingToStore(error)) return "skip";
      return isTooLarge(error) ? "tooLarge" : "unsaved";
    }
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

// A path the runtime would list (runtime-adapter/src/runtime/files.ts): no
// dot segment and no installed tree. Others it never lists or reads.
const UNLISTED_DIRS = new Set(["node_modules", "__pycache__", "venv"]);
// The runtime's longest listed path (runtime-adapter/src/runtime/files.ts).
const MAX_WORKSPACE_PATH = 1024;
function listable(path: string): boolean {
  if (path.length > MAX_WORKSPACE_PATH || path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.every(
    (s, i) =>
      s !== "" &&
      !s.startsWith(".") &&
      (i === segments.length - 1 || !UNLISTED_DIRS.has(s)),
  );
}

// The runtime has nothing to give for the path: deleted, or a path it
// refuses to read. Neither is ever worth a retry.
function nothingToStore(error: unknown): boolean {
  return (
    error instanceof AdapterRefusal &&
    (error.code === "FILE_NOT_FOUND" || error.code === "INVALID_REQUEST")
  );
}

// Ends `work`'s wait when the capture's deadline passes. The work itself
// isn't cancelled; the capture just stops waiting for it.
function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// Over the runtime's per-file limit when it was read: it can never be stored.
function isTooLarge(error: unknown): boolean {
  return error instanceof AdapterRefusal && error.code === "PAYLOAD_TOO_LARGE";
}

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
