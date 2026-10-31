// Files a chat's replies made (platform-next chat files). Each is a stored
// version: the platform copies a run's new or changed files after it ends,
// and never overwrites one. Wire parsers, fetches and the plain rules the
// file card and viewer render with. File contents are model-written: text is
// shown as text, Markdown without raw HTML, and HTML only in a sandbox.

import { ApiRequestError, addressed, api, base } from "./api.ts";
import { auth } from "./auth.ts";
import { identityGeneration, notifyUnauthenticated } from "./identity.ts";
import type { LiveReply } from "./tenant-chat.ts";
import type { Activity } from "./tenant-coding.ts";

export interface ChatFile {
  id: string;
  runId: string;
  // Path in the chat ("docs/guide.md"); name is its last part.
  path: string;
  name: string;
  version: number;
  size: number;
  contentType: string;
  createdAt: string;
  // A file a member attached to a message, not one a reply made.
  upload?: true;
}

const MAX_PATH = 1024;
const MAX_FILES = 300;
const ID = /^[0-9a-f]{24}$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function parseChatFile(value: unknown): ChatFile | null {
  const f = record(value);
  if (
    !f ||
    typeof f.id !== "string" ||
    !ID.test(f.id) ||
    typeof f.runId !== "string" ||
    !ID.test(f.runId) ||
    typeof f.path !== "string" ||
    !f.path ||
    f.path.length > MAX_PATH ||
    typeof f.version !== "number" ||
    !Number.isSafeInteger(f.version) ||
    f.version < 1 ||
    typeof f.size !== "number" ||
    !Number.isSafeInteger(f.size) ||
    f.size < 0
  )
    return null;
  const name =
    typeof f.name === "string" && f.name
      ? f.name.slice(0, 255)
      : f.path.slice(f.path.lastIndexOf("/") + 1);
  return {
    id: f.id,
    runId: f.runId,
    path: f.path,
    name,
    version: f.version,
    size: f.size,
    contentType:
      typeof f.contentType === "string"
        ? f.contentType.slice(0, 200)
        : "application/octet-stream",
    createdAt: typeof f.createdAt === "string" ? f.createdAt : "",
    ...(f.source === "upload" ? { upload: true as const } : {}),
  };
}

// `{files: [...]}`: the list route, and a reply's `files` stream event.
export function parseFiles(value: unknown): ChatFile[] {
  const list = record(value)?.files;
  if (!Array.isArray(list)) return [];
  const out: ChatFile[] = [];
  for (const raw of list.slice(0, MAX_FILES)) {
    const file = parseChatFile(raw);
    if (file) out.push(file);
  }
  return out;
}

// Unsaved paths kept per reply (the platform's bound).
const MAX_UNSAVED = 50;

// The paths a reply wrote that couldn't be saved: a run's `unsavedFiles`,
// the `files` event's and a retry's `unsaved`. Also the paths too large to
// save (`tooLargeFiles`, `tooLarge`), bounded the same way.
export function parseUnsaved(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const path of value.slice(0, MAX_UNSAVED))
    if (
      typeof path === "string" &&
      path &&
      path.length <= MAX_PATH &&
      !out.includes(path)
    )
      out.push(path);
  return out;
}

// Asks the platform to save a reply's unsaved files again: the versions it
// stored, the paths that still failed, and those found too large to save.
export async function retryUnsavedFiles(
  chatId: string,
  runId: string,
): Promise<{ files: ChatFile[]; unsaved: string[]; tooLarge: string[] }> {
  const data = await api(
    `/api/v1/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(runId)}/files/retry`,
    {},
  );
  return {
    files: parseFiles(data),
    unsaved: parseUnsaved(record(data)?.unsaved),
    tooLarge: parseUnsaved(record(data)?.tooLarge),
  };
}

// Adds files to a chat's list once each, newest first.
export function withFiles(
  current: readonly ChatFile[],
  added: readonly ChatFile[],
): ChatFile[] {
  if (added.length === 0) return current as ChatFile[];
  const known = new Set(current.map((f) => f.id));
  const fresh = added.filter((f) => !known.has(f.id));
  if (fresh.length === 0) return current as ChatFile[];
  return [...fresh, ...current].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version,
  );
}

// The files one reply made: the newest version of each path it stored, in
// the order it stored them. Files attached to the message that started it
// share its run but are the member's, not the reply's.
export function filesOfRun(
  files: readonly ChatFile[],
  runId: string,
): ChatFile[] {
  return filesByRun(files).get(runId) ?? [];
}

// Every reply's files (as `filesOfRun`) in one pass over the chat's files,
// so a transcript can hand each reply the same array until the files change.
// Runs that made no files are absent.
export function filesByRun(
  files: readonly ChatFile[],
): Map<string, ChatFile[]> {
  const byRun = new Map<string, Map<string, ChatFile>>();
  for (const file of files) {
    if (file.upload) continue;
    let byPath = byRun.get(file.runId);
    if (!byPath) byRun.set(file.runId, (byPath = new Map()));
    const kept = byPath.get(file.path);
    if (!kept || file.version > kept.version) byPath.set(file.path, file);
  }
  const result = new Map<string, ChatFile[]>();
  for (const [runId, byPath] of byRun)
    result.set(
      runId,
      [...byPath.values()].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.path.localeCompare(b.path),
      ),
    );
  return result;
}

// Which file the viewer shows: a reply's file by path (the version it
// stored, or its text while it is written), or one exact stored version.
export interface ViewerTarget {
  runId: string;
  path: string;
  fileId?: string;
}

// What the viewer has for its target right now.
export type ViewerSubject =
  // The model is writing it: its text so far (new files only).
  | { state: "writing"; path: string; text: string; truncated: boolean }
  // Written, being stored once the reply ends.
  | { state: "saving"; path: string }
  | { state: "ready"; file: ChatFile }
  // The reply ended without storing it.
  | { state: "missing"; path: string };

export function resolveSubject(
  target: ViewerTarget,
  files: readonly ChatFile[],
  live: LiveReply | null,
): ViewerSubject {
  if (target.fileId) {
    const exact = files.find((f) => f.id === target.fileId);
    if (exact) return { state: "ready", file: exact };
  }
  const liveHere = live && live.runId === target.runId ? live : null;
  const writing = liveHere?.items.find(
    (i): i is Extract<Activity, { type: "file_change" }> =>
      i.type === "file_change" &&
      i.status === "inProgress" &&
      i.files.some((f) => f.path === target.path),
  );
  if (writing)
    return {
      state: "writing",
      path: target.path,
      text: writing.preview?.path === target.path ? writing.preview.text : "",
      truncated:
        writing.preview?.path === target.path && writing.preview.truncated,
    };
  const stored = filesOfRun(files, target.runId).find(
    (f) => f.path === target.path,
  );
  if (stored) return { state: "ready", file: stored };
  if (liveHere && !liveHere.saveFailed)
    return { state: "saving", path: target.path };
  return { state: "missing", path: target.path };
}

export async function fetchChatFiles(chatId: string): Promise<ChatFile[]> {
  return parseFiles(
    await api(`/api/v1/chats/${encodeURIComponent(chatId)}/files`),
  );
}

// One stored version's bytes. Fetched with the access token (a plain link
// would carry none), then shown or saved from memory.
export async function fetchFileContent(
  chatId: string,
  fileId: string,
): Promise<Blob> {
  const path = `/api/v1/chats/${encodeURIComponent(chatId)}/files/${encodeURIComponent(fileId)}/content`;
  const target = addressed(path);
  if (target instanceof ApiRequestError) throw target;
  const generation = identityGeneration();
  let outcome;
  try {
    outcome = await auth.request(base + target, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new ApiRequestError(
      "The file couldn't be loaded. Check your connection and try again.",
      0,
      "NETWORK_ERROR",
      { cause: error },
    );
  }
  if (outcome.kind === "signedOut") {
    notifyUnauthenticated();
    throw new ApiRequestError(
      "Sign in again to open this file.",
      401,
      "UNAUTHENTICATED",
    );
  }
  if (outcome.kind === "unavailable")
    throw new ApiRequestError(
      "Truex is temporarily unavailable. Try again in a moment.",
      503,
      "SESSION_UNAVAILABLE",
    );
  const res = outcome.response;
  if (generation !== identityGeneration())
    throw new ApiRequestError("This view is out of date.", 0, "STALE_IDENTITY");
  if (!res.ok)
    throw new ApiRequestError(
      res.status === 404
        ? "This file is no longer available."
        : "The file couldn't be loaded. Try again.",
      res.status,
      res.status === 404 ? "NOT_FOUND" : "FILE_UNAVAILABLE",
    );
  return res.blob();
}

// Stored versions never change, so their bytes are kept by id (a few), for
// the viewer and the image previews on sent messages.
const CACHE_SIZE = 12;
const contentCache = new Map<string, Promise<Blob>>();

const keepContent = (fileId: string, content: Promise<Blob>) => {
  contentCache.delete(fileId);
  contentCache.set(fileId, content);
  while (contentCache.size > CACHE_SIZE)
    contentCache.delete(contentCache.keys().next().value!);
};

export function cachedFileContent(
  chatId: string,
  fileId: string,
): Promise<Blob> {
  const kept = contentCache.get(fileId);
  if (kept) {
    keepContent(fileId, kept);
    return kept;
  }
  const request = fetchFileContent(chatId, fileId);
  keepContent(fileId, request);
  request.catch(() => {
    if (contentCache.get(fileId) === request) contentCache.delete(fileId);
  });
  return request;
}

// A stored version whose bytes are already here: a file this browser just
// attached and sent, so its preview isn't downloaded again.
export function seedFileContent(fileId: string, blob: Blob): void {
  if (ID.test(fileId)) keepContent(fileId, Promise.resolve(blob));
}

// Saves a stored version under its own name.
export async function downloadFile(
  chatId: string,
  file: ChatFile,
): Promise<void> {
  // The viewer's copy when it can preview the file (a stored version never
  // changes); a file it can't preview isn't kept in memory after its save.
  const blob =
    previewKind(file.name) === "none"
      ? await fetchFileContent(chatId, file.id)
      : await cachedFileContent(chatId, file.id);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // After the click has handed the URL to the download.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export type PreviewKind =
  | "markdown"
  | "csv"
  | "html"
  | "image"
  | "text"
  // Office files, parsed in a worker (lib/office).
  | "sheet"
  | "docx"
  | "slides"
  // Drawn page by page with pdf.js (lib/pdf.ts).
  | "pdf"
  // No preview in the browser: download only.
  | "none";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const TEXT = new Set([
  "txt",
  "log",
  "json",
  "xml",
  "yaml",
  "yml",
  "tsv",
  "toml",
  "ini",
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
  "abap",
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKind(name: string): PreviewKind {
  const ext = extensionOf(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "xlsx") return "sheet";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "slides";
  if (ext === "pdf") return "pdf";
  if (IMAGE.has(ext)) return "image";
  if (TEXT.has(ext)) return "text";
  return "none";
}

export const isImage = (name: string) => previewKind(name) === "image";

// Whether the viewer can show the file's raw text (the Source tab).
export const hasSource = (name: string) => {
  const kind = previewKind(name);
  return (
    kind === "markdown" || kind === "csv" || kind === "html" || kind === "text"
  );
};

// Whether the viewer previews the file by parsing its bytes in a worker.
export const isOffice = (
  kind: PreviewKind,
): kind is "sheet" | "docx" | "slides" =>
  kind === "sheet" || kind === "docx" || kind === "slides";

// The short tag on the file's tile ("MD", "XLSX") and its colour family.
export function fileTag(name: string): { label: string; tone: string } {
  const ext = extensionOf(name);
  const tone =
    ext === "docx" || ext === "doc"
      ? "docx"
      : ext === "xlsx" || ext === "xls"
        ? "xlsx"
        : ext === "csv"
          ? "csv"
          : ext === "html" || ext === "htm"
            ? "html"
            : ext === "pdf"
              ? "pdf"
              : "md";
  return { label: (ext || "file").slice(0, 4), tone };
}

// "Markdown", "Spreadsheet" … for the file's second line.
export function typeName(name: string): string {
  const ext = extensionOf(name);
  const names: Record<string, string> = {
    md: "Markdown",
    markdown: "Markdown",
    txt: "Text",
    csv: "CSV",
    json: "JSON",
    html: "HTML",
    htm: "HTML",
    pdf: "PDF",
    docx: "Word document",
    xlsx: "Spreadsheet",
    pptx: "Presentation",
    png: "Image",
    jpg: "Image",
    jpeg: "Image",
    gif: "Image",
    webp: "Image",
  };
  if (names[ext]) return names[ext];
  if (TEXT.has(ext)) return "Code";
  return ext ? ext.toUpperCase() : "File";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// Text the viewer previews at most; longer files are download-only.
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
// A CSV preview shows at most this many rows and columns.
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;

// CSV (RFC 4180: quoted fields, doubled quotes, CRLF) as rows of cells,
// bounded. `truncated` when rows or columns were left out.
export function parseCsv(text: string): {
  rows: string[][];
  truncated: boolean;
} {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  const endCell = () => {
    if (row.length < MAX_COLUMNS) row.push(cell);
    else truncated = true;
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= MAX_ROWS) {
        truncated = i < text.length - 1;
        return { rows, truncated };
      }
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) endRow();
  return { rows, truncated };
}

// An agent-made HTML page for a sandboxed srcdoc frame: no network at all,
// so it can neither load nor send anything. The frame has no same-origin
// access, so its scripts can't reach the app.
export function sandboxedHtml(html: string): string {
  const policy =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
}

// A Word document's HTML (lib/office/docx.ts) for a frame that runs no
// script: no network, only its own styles and data: images. It reads as a
// white page in either theme, like the document itself.
export function sandboxedDocx(html: string): string {
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  const style =
    "body{margin:0;padding:24px 28px;background:#fff;color:#1f2328;font:15px/1.55 system-ui,sans-serif;overflow-wrap:anywhere}" +
    "h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.2em 0 .5em}h1{font-size:1.6em}h2{font-size:1.3em}h3{font-size:1.1em}" +
    "p{margin:0 0 .75em}ul,ol{margin:0 0 .75em;padding-left:1.6em}" +
    "table{border-collapse:collapse;margin:0 0 1em;max-width:100%}td,th{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top}td p,th p{margin:0}" +
    "img{max-width:100%;height:auto}";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><style>${style}</style>${html}`;
}

// A DocumentCard size (DESIGN-SPEC 12.3): "2.4 MB" from 1 MB (no ".0"),
// "4.2 KB" under 10 KB (at least 0.1), otherwise whole KB with grouping.
export function docSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
    return `${mb.toLocaleString("en-US")} MB`;
  }
  const kb = bytes / 1024;
  if (kb < 10) return `${Math.max(0.1, Math.round(kb * 10) / 10)} KB`;
  return `${Math.round(kb).toLocaleString("en-US")} KB`;
}

// A file name split so its extension can stay visible while the base truncates;
// only an extension of up to 11 characters is pinned.
export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 11) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}
