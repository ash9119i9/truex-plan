import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Tenant folders hold workspaces; at most 32 characters, so never a UUID.
const TENANT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOUR = 3_600_000;
// Tolerated clock skew before a future mtime is treated as bogus.
const SKEW_MS = 60_000;

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const denied = (error: unknown) =>
  ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");

// Newest mtime of a path and everything beneath it; symlinks are never followed.
// Anything that cannot be fully inspected counts as brand new, so it is never
// deleted. A future mtime (clock skew, or a script pinning its workspace with
// `touch`) is replaced by the inode change time, which scripts cannot forge,
// so it ages out instead of pinning the tree forever.
async function newest(path: string, now: number): Promise<number> {
  const stats = await lstat(path);
  let latest = stats.mtimeMs;
  if (latest > now + SKEW_MS) latest = Math.min(stats.ctimeMs, now);
  if (!stats.isDirectory()) return latest;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (denied(error)) return Infinity;
    throw error;
  }
  for (const entry of entries)
    try {
      latest = Math.max(latest, await newest(join(path, entry.name), now));
    } catch (error) {
      if (denied(error)) return Infinity;
      if (!missing(error)) throw error;
    }
  return latest;
}

async function directory(path: string) {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

type SweepOptions = {
  tempTtlMs: number;
  workspaceTtlMs?: number;
  now?: number;
};
type SweepResult = { tempCleared: number; workspacesRemoved: number };

// Root layout: <tenant>/<uuid> workspaces, plus flat <uuid> workspaces of
// threads created before tenancy. Tenant folders themselves are never removed;
// only the workspaces inside them age out. Symlinks are never followed.
export async function sweepWorkspaces(
  root: string,
  opts: SweepOptions,
): Promise<SweepResult> {
  const now = opts.now ?? Date.now(),
    result = { tempCleared: 0, workspacesRemoved: 0 };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return result;
    throw error;
  }
  await sweepLevel(
    root,
    entries.filter((e) => e.isDirectory() && UUID.test(e.name)),
    opts,
    now,
    result,
  );
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      UUID.test(entry.name) ||
      !TENANT.test(entry.name)
    )
      continue;
    const tenant = join(root, entry.name);
    let workspaces;
    try {
      workspaces = await readdir(tenant, { withFileTypes: true });
    } catch (error) {
      if (!missing(error))
        console.error(`Workspace sweep failed for tenant ${entry.name}`, error);
      continue;
    }
    await sweepLevel(
      tenant,
      workspaces.filter((e) => e.isDirectory() && UUID.test(e.name)),
      opts,
      now,
      result,
    );
  }
  return result;
}

async function sweepLevel(
  root: string,
  entries: { name: string }[],
  opts: SweepOptions,
  now: number,
  result: SweepResult,
) {
  for (const entry of entries) {
    const workspace = join(root, entry.name);
    try {
      if (
        opts.workspaceTtlMs !== undefined &&
        (await newest(workspace, now)) < now - opts.workspaceTtlMs
      ) {
        await rm(workspace, { recursive: true, force: true });
        result.workspacesRemoved++;
        continue;
      }
      const tmp = join(workspace, "work", "tmp");
      if (
        (await directory(join(workspace, "work"))) &&
        (await directory(tmp)) &&
        (await newest(tmp, now)) < now - opts.tempTtlMs
      ) {
        await rm(tmp, { recursive: true, force: true });
        result.tempCleared++;
      }
    } catch (error) {
      if (!missing(error))
        console.error(`Workspace sweep failed for ${entry.name}`, error);
    }
  }
}

const positive = (value: string | undefined) => {
  const number = Number(value);
  return value?.trim() && Number.isFinite(number) && number > 0
    ? number
    : undefined;
};

export function startWorkspaceSweeper(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const tempTtlMs = (positive(env.WORKSPACE_TEMP_TTL_HOURS) ?? 24) * HOUR,
    days = positive(env.WORKSPACE_TTL_DAYS),
    workspaceTtlMs = days === undefined ? undefined : days * 24 * HOUR;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await sweepWorkspaces(root, { tempTtlMs, workspaceTtlMs });
    } catch (error) {
      console.error("Workspace sweep failed", error);
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), HOUR);
  timer.unref();
  return () => clearInterval(timer);
}
