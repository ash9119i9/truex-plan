import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startWorkspaceSweeper,
  sweepWorkspaces,
} from "../src/workspace-sweeper";

const DAY = 86_400_000,
  now = Date.now();
const ids = {
  stale: "11111111-1111-4111-8111-111111111111",
  fresh: "22222222-2222-4222-8222-222222222222",
  old: "33333333-3333-4333-8333-333333333333",
  linked: "44444444-4444-4444-8444-444444444444",
};

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
async function age(path: string, ms: number) {
  const time = new Date(now - ms);
  await utimes(path, time, time);
}
async function workspace(root: string, id: string, ms: number) {
  const dir = join(root, id),
    tmp = join(dir, "work", "tmp");
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  await mkdir(join(dir, "files"), { mode: 0o700 });
  await writeFile(join(tmp, "scratch.txt"), "x", { mode: 0o600 });
  await writeFile(join(dir, "files", "doc.bin"), "x", { mode: 0o600 });
  for (const path of [
    join(tmp, "scratch.txt"),
    tmp,
    join(dir, "work"),
    join(dir, "files", "doc.bin"),
    join(dir, "files"),
    dir,
  ])
    await age(path, ms);
  return dir;
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "truex-sweeper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("clears stale temp directories and keeps conversation files unless a workspace TTL is set", async (t) => {
  const root = await fixture(t);
  const stale = await workspace(root, ids.stale, 2 * DAY),
    fresh = await workspace(root, ids.fresh, 1000),
    notUuid = await workspace(root, "not-a-workspace", 30 * DAY);
  assert.deepEqual(await sweepWorkspaces(root, { tempTtlMs: DAY, now }), {
    tempCleared: 1,
    workspacesRemoved: 0,
  });
  assert.equal(await exists(join(stale, "work", "tmp")), false);
  assert.equal(await exists(join(stale, "files", "doc.bin")), true);
  assert.equal(await exists(join(fresh, "work", "tmp", "scratch.txt")), true);
  assert.equal(await exists(join(notUuid, "work", "tmp")), true);

  // A recent file deep in an otherwise old workspace keeps the whole thing.
  const old = await workspace(root, ids.old, 40 * DAY);
  await age(join(old, "files", "doc.bin"), 1000);
  assert.deepEqual(
    await sweepWorkspaces(root, {
      tempTtlMs: DAY,
      workspaceTtlMs: 30 * DAY,
      now,
    }),
    { tempCleared: 1, workspacesRemoved: 0 },
  );
  assert.equal(await exists(join(old, "files", "doc.bin")), true);
  await age(join(old, "files", "doc.bin"), 40 * DAY);
  await age(join(old, "files"), 40 * DAY);
  await age(join(old, "work"), 40 * DAY);
  await age(old, 40 * DAY);
  assert.deepEqual(
    await sweepWorkspaces(root, {
      tempTtlMs: DAY,
      workspaceTtlMs: 30 * DAY,
      now,
    }),
    { tempCleared: 0, workspacesRemoved: 1 },
  );
  assert.equal(await exists(old), false);
  assert.equal(await exists(notUuid), true);
  assert.equal(await exists(fresh), true);
});

test("never follows symlinks out of the workspace root", async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  const target = await workspace(outside, ids.stale, 60 * DAY);
  await symlink(target, join(root, ids.linked));
  const dir = await workspace(root, ids.fresh, 1000);
  await rm(join(dir, "work", "tmp"), { recursive: true });
  const outsideTmp = join(outside, "tmp");
  await mkdir(outsideTmp);
  await age(outsideTmp, 60 * DAY);
  await symlink(outsideTmp, join(dir, "work", "tmp"));
  assert.deepEqual(
    await sweepWorkspaces(root, { tempTtlMs: DAY, workspaceTtlMs: DAY, now }),
    { tempCleared: 0, workspacesRemoved: 0 },
  );
  assert.equal(await exists(join(target, "work", "tmp", "scratch.txt")), true);
  assert.equal(await exists(outsideTmp), true);
});

test("a missing root is a no-op and the sweeper stops cleanly", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(
    await sweepWorkspaces(join(root, "missing"), { tempTtlMs: DAY }),
    { tempCleared: 0, workspacesRemoved: 0 },
  );
  const stale = await workspace(root, ids.stale, 3 * DAY);
  const stop = startWorkspaceSweeper(root, { WORKSPACE_TEMP_TTL_HOURS: "1" });
  stop();
  // The initial sweep runs immediately; wait for it to settle.
  for (let i = 0; i < 50 && (await exists(join(stale, "work", "tmp"))); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await exists(join(stale, "work", "tmp")), false);
  assert.equal(await exists(join(stale, "files", "doc.bin")), true);
});
