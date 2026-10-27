// Files a member attaches to a message (platform-next uploads). Each file is
// uploaded on its own as soon as it is picked ("staged"); the message then
// names the staged uploads, and the platform copies them into the chat's
// workspace (`uploads/<name>`) before the reply starts. Wire parsers, the
// upload and discard calls, and the plain rules the composer renders with.

import { ApiRequestError, addressed, api, base } from "./api.ts";
import { auth } from "./auth.ts";
import { identityGeneration, notifyUnauthenticated } from "./identity.ts";

export interface UploadSettings {
  enabled: boolean;
  maxFileBytes: number;
  maxFiles: number;
  // Lower case, without the dot.
  extensions: string[];
}

// Uploads are off until the platform says otherwise.
export const UPLOADS_OFF: UploadSettings = {
  enabled: false,
  maxFileBytes: 0,
  maxFiles: 0,
  extensions: [],
};

// A file attached to a sent message: a stored version in the chat's files.
export interface MessageAttachment {
  fileId: string;
  name: string;
  path: string;
  size: number;
  contentType: string;
  // An image's bytes still in this browser: only on a message just sent,
  // before the platform has saved it.
  preview?: Blob;
}

// A file in the composer, before its message is sent. An image keeps the
// picked file as `preview`, so it is shown without being downloaded.
export type DraftFile = {
  key: string;
  name: string;
  size: number;
  preview?: Blob;
} & (
  | { state: "uploading" }
  | { state: "ready"; uploadId: string }
  | { state: "failed"; error: string }
);

const ID = /^[0-9a-f]{24}$/;
const MAX_NAME = 255;
// The platform's own bounds; a reply claiming more is ignored.
const MAX_EXTENSIONS = 200;
const MAX_ATTACHMENTS = 10;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const size = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

export function parseUploadSettings(value: unknown): UploadSettings {
  const s = record(value);
  const maxFileBytes = size(s?.maxFileBytes);
  const maxFiles = size(s?.maxFiles);
  if (!s || s.enabled !== true || !maxFileBytes || !maxFiles)
    return UPLOADS_OFF;
  const extensions = Array.isArray(s.extensions)
    ? s.extensions
        .slice(0, MAX_EXTENSIONS)
        .filter(
          (e): e is string =>
            typeof e === "string" && /^[a-z0-9]{1,10}$/.test(e),
        )
    : [];
  if (extensions.length === 0) return UPLOADS_OFF;
  return {
    enabled: true,
    maxFileBytes,
    maxFiles: Math.min(maxFiles, MAX_ATTACHMENTS),
    extensions,
  };
}

export function parseAttachment(value: unknown): MessageAttachment | null {
  const a = record(value);
  if (
    !a ||
    typeof a.fileId !== "string" ||
    !ID.test(a.fileId) ||
    typeof a.name !== "string" ||
    !a.name ||
    a.name.length > MAX_NAME ||
    typeof a.path !== "string" ||
    !a.path.startsWith("uploads/") ||
    size(a.size) === null
  )
    return null;
  return {
    fileId: a.fileId,
    name: a.name,
    path: a.path,
    size: a.size as number,
    contentType:
      typeof a.contentType === "string"
        ? a.contentType.slice(0, 200)
        : "application/octet-stream",
  };
}

export function parseAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: MessageAttachment[] = [];
  for (const raw of value.slice(0, MAX_ATTACHMENTS)) {
    const parsed = parseAttachment(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const megabytes = (bytes: number) => `${Math.floor(bytes / (1024 * 1024))} MB`;

// Why a picked file can't be attached, before anything is uploaded; null
// when it can. `attached` counts the draft's files already there. The
// platform checks all of this again, and the contents as well.
export function fileProblem(
  file: { name: string; size: number },
  settings: UploadSettings,
  attached: number,
): string | null {
  if (!settings.enabled) return "Attaching files is not available here.";
  if (attached >= settings.maxFiles)
    return `A message can have at most ${settings.maxFiles} files.`;
  const name = file.name.normalize("NFC").trim();
  if (!name || name.startsWith("."))
    return `“${file.name}” can't be attached. Rename it and try again.`;
  if (!settings.extensions.includes(extensionOf(name)))
    return `“${name}” can't be attached. Attach PDF, Word, Excel, PowerPoint, text, code or image files.`;
  if (file.size === 0) return `“${name}” is empty.`;
  if (file.size > settings.maxFileBytes)
    return `“${name}” is too large. Files can be at most ${megabytes(settings.maxFileBytes)}.`;
  return null;
}

// The `accept` list for the file picker.
export const acceptList = (settings: UploadSettings): string =>
  settings.extensions.map((e) => `.${e}`).join(",");

// A draft can be sent when it has text or files, and every file is uploaded.
export function filesReady(files: readonly DraftFile[]): boolean {
  return files.every((f) => f.state === "ready");
}

// Why the draft's files hold up sending. A failed file needs the member to
// act, so it wins over uploads that are simply still running.
export function filesNote(
  files: readonly DraftFile[],
): { text: string; problem: boolean } | null {
  if (files.some((f) => f.state === "failed"))
    return {
      text: "Remove the files that couldn't be attached to send.",
      problem: true,
    };
  if (files.some((f) => f.state === "uploading"))
    return { text: "Uploading files…", problem: false };
  return null;
}

export const uploadIds = (files: readonly DraftFile[]): string[] =>
  files.flatMap((f) => (f.state === "ready" ? [f.uploadId] : []));

// What a message's attachments look like before the platform has saved it.
export const pendingAttachments = (
  files: readonly DraftFile[],
): MessageAttachment[] =>
  files.flatMap((f) =>
    f.state === "ready"
      ? [
          {
            fileId: "",
            name: f.name,
            path: `uploads/${f.name}`,
            size: f.size,
            contentType: "",
            ...(f.preview ? { preview: f.preview } : {}),
          },
        ]
      : [],
  );

// The sent images whose bytes are still here, paired with the saved
// versions they became. The platform saves a message's attachments in the
// order they were sent; any mismatch pairs nothing (the previews are then
// downloaded instead).
export function previewSeeds(
  sent: readonly DraftFile[],
  saved: readonly MessageAttachment[],
): Array<{ fileId: string; blob: Blob }> {
  const ready = sent.filter((f) => f.state === "ready");
  if (
    ready.length !== saved.length ||
    ready.some((f, i) => f.size !== saved[i]!.size || !saved[i]!.fileId)
  )
    return [];
  return ready.flatMap((f, i) =>
    f.preview ? [{ fileId: saved[i]!.fileId, blob: f.preview }] : [],
  );
}

export const withDraftFile = (
  files: readonly DraftFile[],
  key: string,
  next: DraftFile | null,
): DraftFile[] =>
  next
    ? files.map((f) => (f.key === key ? next : f))
    : files.filter((f) => f.key !== key);

export async function fetchUploadSettings(): Promise<UploadSettings> {
  return parseUploadSettings(await api("/api/v1/uploads"));
}

// Up to 20 MB on a slow link.
const UPLOAD_TIMEOUT_MS = 180_000;

// Uploads one file as the raw request body. Returns the staged upload's ID.
export async function uploadFile(
  file: Blob,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const target = addressed(`/api/v1/uploads?name=${encodeURIComponent(name)}`);
  if (target instanceof ApiRequestError) throw target;
  const generation = identityGeneration();
  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  let outcome;
  try {
    outcome = await auth.request(base + target, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted)
      throw new ApiRequestError("The upload was cancelled.", 0, "CANCELLED");
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ApiRequestError(
      timedOut
        ? "The upload took too long. Try again on a faster connection."
        : "The file couldn't be uploaded. Check your connection and try again.",
      0,
      timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
      { cause: error },
    );
  }
  if (outcome.kind === "signedOut") {
    notifyUnauthenticated();
    throw new ApiRequestError(
      "Sign in again to attach files.",
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
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* Handled below. */
  }
  if (generation !== identityGeneration())
    throw new ApiRequestError("This view is out of date.", 0, "STALE_IDENTITY");
  if (!res.ok) {
    const error = record(record(data)?.error);
    const message =
      typeof error?.message === "string" && error.message.trim()
        ? error.message
        : typeof record(data)?.error === "string"
          ? (record(data)!.error as string)
          : res.status === 413
            ? "The file is too large."
            : "The file couldn't be attached. Try again.";
    throw new ApiRequestError(
      message,
      res.status,
      typeof error?.code === "string"
        ? error.code
        : typeof record(data)?.code === "string"
          ? (record(data)!.code as string)
          : `HTTP_${res.status}`,
    );
  }
  const id = record(record(data)?.upload)?.id;
  if (typeof id !== "string" || !ID.test(id))
    throw new ApiRequestError(
      "The service returned an unreadable response. Attach the file again.",
      res.status,
      "INVALID_RESPONSE",
    );
  return id;
}

// Takes a staged file off a draft. A failure only leaves it to expire.
export async function discardUpload(uploadId: string): Promise<void> {
  try {
    await api(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}`,
      undefined,
      undefined,
      "DELETE",
    );
  } catch (error) {
    // Already sent, already gone, or unreachable: staged uploads expire.
    if (!(error instanceof ApiRequestError)) throw error;
  }
}
