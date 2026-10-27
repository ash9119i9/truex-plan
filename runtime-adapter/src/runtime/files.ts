import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ChatRef } from "../contract";
import { AdapterError } from "../errors";

// Read-only access to a chat's workspace for the platform, which copies the
// files a run produced into chat storage. Only regular, visible files are
// offered: dot entries, symlinks and dependency or cache folders are skipped,
// and every read is confined to the workspace.

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Files listed per call; the rest are reported as truncated.
const MAX_LISTED = 500;
// Directory entries examined per call, so a huge tree can't stall a list.
const MAX_VISITED = 5_000;
const MAX_DEPTH = 16;
const MAX_PATH = 1024;
// Generated or installed trees, never the user's files.
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "venv"]);

export interface WorkspaceFile {
  // Workspace-relative, "/"-separated.
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface WorkspaceListing {
  readonly files: WorkspaceFile[];
  readonly truncated: boolean;
}

// The same layout ChatRuntime uses; the ids are validated by the contract.
export function chatWorkspace(stateDir: string, ref: ChatRef): string {
  return join(stateDir, "t", ref.tenantId, "c", ref.chatId, "workspace");
}

export async function listWorkspace(
  workspace: string,
): Promise<WorkspaceListing> {
  const files: WorkspaceFile[] = [];
  let visited = 0;
  let truncated = false;
  // Breadth first, names sorted, so a truncated listing is deterministic.
  let level: string[] = [""];
  for (let depth = 0; level.length > 0 && depth <= MAX_DEPTH; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let names: string[];
      try {
        names = (await readdir(join(workspace, dir))).sort();
      } catch (error) {
        if (dir === "" && isMissing(error)) return { files, truncated };
        continue;
      }
      for (const name of names) {
        if (++visited > MAX_VISITED) return { files, truncated: true };
        if (name.startsWith(".")) continue;
        const rel = dir ? `${dir}/${name}` : name;
        if (rel.length > MAX_PATH) continue;
        const stat = await lstat(join(workspace, rel)).catch(() => null);
        if (!stat || stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (!SKIPPED_DIRS.has(name)) next.push(rel);
        } else if (stat.isFile()) {
          if (files.length >= MAX_LISTED) return { files, truncated: true };
          files.push({
            path: rel,
            size: stat.size,
            modifiedAt: Math.floor(stat.mtimeMs),
          });
        }
      }
    }
    if (depth === MAX_DEPTH && next.length > 0) truncated = true;
    level = next;
  }
  return { files, truncated };
}

// A listed file's bytes. Refuses anything the listing would skip, anything
// that resolves outside the workspace, and files over MAX_FILE_BYTES.
export async function readWorkspaceFile(
  workspace: string,
  path: string,
): Promise<Buffer> {
  const segments = checkedSegments(path);
  const root = await realpath(workspace).catch((error: unknown) => {
    if (isMissing(error)) throw notFound();
    throw error;
  });
  const full = join(root, ...segments);
  // Every parent must be a real directory: no symlinked folder.
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = await lstat(current).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw notFound();
  }
  // O_NOFOLLOW refuses a symlink as the file itself; O_NONBLOCK keeps a FIFO
  // from blocking the open.
  const handle = await open(
    full,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw notFound();
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw notFound();
    if (stat.size > MAX_FILE_BYTES) throw tooLarge();
    // A parent swapped for a symlink between the checks and the open would
    // still resolve elsewhere: confirm where the opened file actually is.
    const opened = await openedPath(handle.fd, full);
    if (!opened.startsWith(root + sep)) throw notFound();
    const data = await handle.readFile();
    if (data.length > MAX_FILE_BYTES) throw tooLarge();
    return data;
  } finally {
    await handle.close();
  }
}

// The opened descriptor's real path: exact on Linux (the AgentCore runtime);
// elsewhere the path's resolution right after the open.
async function openedPath(fd: number, full: string): Promise<string> {
  if (process.platform === "linux")
    return readlink(`/proc/self/fd/${fd}`).catch(() => realpath(full));
  return realpath(full);
}

function checkedSegments(path: string): string[] {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_PATH ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/")
  )
    throw invalidPath();
  const segments = path.split("/");
  for (const segment of segments)
    if (segment === "" || segment.startsWith(".")) throw invalidPath();
  return segments;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function invalidPath() {
  return new AdapterError("INVALID_REQUEST", "path is not a workspace file.");
}

function notFound() {
  return new AdapterError("FILE_NOT_FOUND");
}

function tooLarge() {
  return new AdapterError("PAYLOAD_TOO_LARGE", "The file is too large.");
}
