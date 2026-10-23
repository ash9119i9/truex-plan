import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { Readable } from "node:stream";
import { join, sep } from "node:path";
import { AdapterError } from "../errors";
import { MAX_FILE_BYTES } from "./files";

// Files a member attached to a message, written by the platform into the
// chat's workspace before the run that reads them starts. They land in
// `uploads/` and nowhere else: the name is one visible path segment, the
// folder must be a real directory inside the workspace, and the bytes go to a
// hidden temporary file that is checked against the platform's SHA-256 and
// then renamed into place, so the model never sees half a file.

export const UPLOADS_DIR = "uploads";
// Bytes of a UTF-8 name, the usual filesystem limit.
const MAX_NAME_BYTES = 255;
// Control characters and the bidi controls that reorder what is shown.
const UNSAFE_NAME = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;

export interface WrittenUpload {
  // Workspace-relative, "/"-separated.
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export function checkedUploadName(name: string): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== name.normalize("NFC") ||
    name !== name.trim() ||
    Buffer.byteLength(name) > MAX_NAME_BYTES ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    UNSAFE_NAME.test(name)
  )
    throw new AdapterError("INVALID_REQUEST", "name is not a valid file name.");
  return name;
}

// Writes `body` to `uploads/<name>`, replacing an earlier file of that name.
// `sha256` is the hex digest the platform stored; a mismatch or a body over
// MAX_FILE_BYTES leaves nothing behind.
export async function writeUpload(
  workspace: string,
  name: string,
  sha256: string,
  body: Readable,
): Promise<WrittenUpload> {
  checkedUploadName(name);
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new AdapterError("INVALID_REQUEST", "sha256 must be a hex digest.");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const root = await realpath(workspace);
  const dir = join(root, UPLOADS_DIR);
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  // The model can replace the folder; never follow it anywhere else.
  const folder = await lstat(dir);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw conflict();
  const target = join(dir, name);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isDirectory()) throw conflict();

  const temp = join(dir, `.upload-${randomUUID()}`);
  const handle = await open(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let placed = false;
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of body as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) throw new AdapterError("PAYLOAD_TOO_LARGE");
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (hash.digest("hex") !== sha256)
      throw new AdapterError(
        "INVALID_REQUEST",
        "The file does not match its sha256.",
      );
    await handle.sync();
    await handle.close();
    // Swapped for a symlink since the check: stop before writing there.
    if (!(await realpath(dir)).startsWith(root + sep)) throw conflict();
    await rename(temp, target);
    placed = true;
    const written = await stat(target);
    return {
      path: `${UPLOADS_DIR}/${name}`,
      size: written.size,
      modifiedAt: Math.floor(written.mtimeMs),
    };
  } finally {
    await handle.close().catch(() => undefined);
    if (!placed) await rm(temp, { force: true }).catch(() => undefined);
  }
}

// Confirms each attached image the run will show the model is still the
// regular file the platform wrote. Codex reads these paths itself, outside
// the sandbox, so a symlink left by an earlier turn must never be followed.
// Returns the workspace-relative paths, in order: Codex runs in the
// workspace, and a relative path keeps host directories out of the label it
// shows the model next to each image.
export async function checkedImages(
  workspace: string,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const root = await realpath(workspace);
  const dir = join(root, UPLOADS_DIR);
  const folder = await lstat(dir).catch(() => null);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) throw missing();
  return Promise.all(
    paths.map(async (path) => {
      const name = checkedUploadName(path.slice(UPLOADS_DIR.length + 1));
      const file = await lstat(join(dir, name)).catch(() => null);
      if (!file?.isFile()) throw missing();
      return `${UPLOADS_DIR}/${name}`;
    }),
  );
}

function missing() {
  return new AdapterError(
    "INVALID_REQUEST",
    "An attached image is not in the chat's uploads.",
  );
}

function conflict() {
  return new AdapterError("UPLOAD_CONFLICT");
}
