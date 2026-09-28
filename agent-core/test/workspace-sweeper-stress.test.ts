// Worst-case stress tests for the workspace sweeper.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  startWorkspaceSweeper,
  sweepWorkspaces,
} from "../src/workspace-sweeper";

const DAY = 86_400_000;
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "sweeper-stress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
// A workspace whose every entry has the same age: work/tmp/scratch, files/doc.
async function workspace(
  root: string,
  name: string,
  ms: number,
  extra: string[] = [],
) {
  const dir = join(root, name);
  await mkdir(join(dir, "work", "tmp"), { recursive: true });
  await mkdir(join(dir, "files"));
  await writeFile(join(dir, "work", "tmp", "scratch"), "x");
  await writeFile(join(dir, "files", "doc"), "x");
  for (const path of extra) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), "x");
  }
  await ageTree(dir, ms);
  return dir;
}
async function ageTree(path: string, ms: number) {
  const { readdir } = await import("node:fs/promises");
  const s = await lstat(path);
  if (s.isDirectory())
    for (const entry of await readdir(path))
      await ageTree(join(path, entry), ms);
  const time = new Date(Date.now() - ms);
  await lutimes(path, time, time);
}

test(
  "sweeps ~20,000 files across 200 workspaces",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t);
    const now = Date.now();
    const time = (ms: number) => new Date(now - ms);
    // 200 workspaces x (4 dirs + 100 files) = 20,800 entries. Even ids are stale.
    for (let batch = 0; batch < 200; batch += 20)
      await Promise.all(
        Array.from({ length: 20 }, async (_, k) => {
          const n = batch + k;
          const dir = join(root, id(n));
          const deep = join(dir, "files", "a", "b", "c");
          await mkdir(join(dir, "work", "tmp"), { recursive: true });
          await mkdir(deep, { recursive: true });
          const ms = n % 2 ? 1_000 : 40 * DAY;
          const files = [
            ...Array.from({ length: 50 }, (_, i) =>
              join(dir, "work", "tmp", `t${i}`),
            ),
            ...Array.from({ length: 50 }, (_, i) => join(deep, `f${i}`)),
          ];
          await Promise.all(files.map((f) => writeFile(f, "x")));
          await Promise.all(files.map((f) => utimes(f, time(ms), time(ms))));
          for (const d of [
            join(dir, "work", "tmp"),
            join(dir, "work"),
            deep,
            join(dir, "files", "a", "b"),
            join(dir, "files", "a"),
            join(dir, "files"),
            dir,
          ])
            await utimes(d, time(ms), time(ms));
        }),
      );
    let started = performance.now();
    const inspect = await sweepWorkspaces(root, {
      tempTtlMs: 365 * DAY,
      workspaceTtlMs: 365 * DAY,
      now,
    });
    const inspectMs = performance.now() - started;
    assert.deepEqual(inspect, { tempCleared: 0, workspacesRemoved: 0 });
    started = performance.now();
    const result = await sweepWorkspaces(root, {
      tempTtlMs: DAY,
      workspaceTtlMs: 30 * DAY,
      now,
    });
    const sweepMs = performance.now() - started;
    console.log(
      `20,800 entries / 200 workspaces: inspect-only ${inspectMs.toFixed(0)} ms, sweep removing 100 ${sweepMs.toFixed(0)} ms`,
    );
    assert.deepEqual(result, { tempCleared: 0, workspacesRemoved: 100 });
    for (let n = 0; n < 200; n++)
      assert.equal(await exists(join(root, id(n))), n % 2 === 1);
    assert.ok(inspectMs < 20_000 && sweepMs < 20_000);
  },
);

test(
  "an unreadable subdirectory keeps the workspace but tmp is still cleared",
  { timeout: 10_000 },
  async (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores mode 000");
    const root = await fixture(t);
    const locked = await workspace(root, id(1), 60 * DAY, [
      "files/locked/secret",
    ]);
    const lockedDir = join(locked, "files", "locked");
    const lockedTmp = await workspace(root, id(2), 60 * DAY, [
      "work/tmp/locked/secret",
    ]);
    const lockedTmpDir = join(lockedTmp, "work", "tmp", "locked");
    const plain = await workspace(root, id(3), 60 * DAY);
    await chmod(lockedDir, 0o000);
    await chmod(lockedTmpDir, 0o000);
    t.after(async () => {
      await chmod(lockedDir, 0o700).catch(() => {});
      await chmod(lockedTmpDir, 0o700).catch(() => {});
    });
    const errors = mock.method(console, "error", () => {});
    t.after(() => errors.mock.restore());
    const now = Date.now();
    // Temp-only sweep: tmp outside the locked dir is cleared; a tmp that
    // contains an unreadable dir is left alone (rm could not finish it anyway).
    assert.deepEqual(await sweepWorkspaces(root, { tempTtlMs: DAY, now }), {
      tempCleared: 2,
      workspacesRemoved: 0,
    });
    assert.equal(await exists(join(locked, "work", "tmp")), false);
    assert.equal(await exists(join(plain, "work", "tmp")), false);
    assert.equal(await exists(join(lockedTmpDir)), true);
    // Workspace TTL: only the fully inspectable workspace is removed. Clearing
    // tmp touched work/, so judge it two days on.
    const later = now + 2 * DAY;
    assert.deepEqual(
      await sweepWorkspaces(root, {
        tempTtlMs: DAY,
        workspaceTtlMs: DAY,
        now: later,
      }),
      {
        tempCleared: 0,
        workspacesRemoved: 1,
      },
    );
    assert.equal(await exists(plain), false);
    assert.equal(await exists(join(locked, "files", "doc")), true);
    assert.equal(await exists(join(lockedTmp, "files", "doc")), true);
    assert.equal(errors.mock.callCount(), 0);
    // Once readable again, both age out normally.
    await chmod(lockedDir, 0o700);
    await chmod(lockedTmpDir, 0o700);
    await ageTree(locked, 60 * DAY);
    await ageTree(lockedTmp, 60 * DAY);
    assert.deepEqual(
      await sweepWorkspaces(root, { tempTtlMs: DAY, workspaceTtlMs: DAY }),
      {
        tempCleared: 0,
        workspacesRemoved: 2,
      },
    );
  },
);

test(
  "a workspace deleted mid-sweep is skipped silently",
  { timeout: 10_000 },
  async (t) => {
    const root = await fixture(t);
    for (let n = 0; n < 20; n++) await workspace(root, id(n), 60 * DAY);
    const errors = mock.method(console, "error", () => {});
    t.after(() => errors.mock.restore());
    // Delete workspaces and their subtrees concurrently with the sweep.
    const sweeping = sweepWorkspaces(root, {
      tempTtlMs: DAY,
      workspaceTtlMs: DAY,
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        n % 2
          ? rm(join(root, id(n)), { recursive: true, force: true })
          : rm(join(root, id(n), "files"), { recursive: true, force: true }),
      ),
    );
    const result = await sweeping;
    // Removing files/ bumps the workspace mtime, so an even workspace is either
    // removed (sweep got there first) or kept with its stale tmp cleared.
    assert.ok(result.tempCleared + result.workspacesRemoved <= 20);
    assert.ok(result.workspacesRemoved >= 1 || result.tempCleared >= 1);
    assert.equal(errors.mock.callCount(), 0);
    for (let n = 0; n < 20; n++) {
      assert.equal(await exists(join(root, id(n), "work", "tmp")), false);
      if (n % 2) assert.equal(await exists(join(root, id(n))), false);
    }
  },
);

test(
  "future mtimes cannot pin a workspace forever",
  { timeout: 10_000 },
  async (t) => {
    const root = await fixture(t);
    const dir = await workspace(root, id(1), 60 * DAY);
    const pinned = join(dir, "files", "doc");
    const future = new Date(Date.now() + 10 * 365 * DAY);
    await utimes(pinned, future, future);
    // Small skew within the tolerance is honoured as-is.
    const skewed = await workspace(root, id(2), 60 * DAY);
    const soon = new Date(Date.now() + 30_000);
    await utimes(join(skewed, "files", "doc"), soon, soon);

    // Real clock: the pinned file's ctime is "just now", so both workspaces are
    // fresh and kept (their stale tmp is still cleared). The sweeper only reads
    // timestamps; it never rewrites them.
    assert.deepEqual(
      await sweepWorkspaces(root, { tempTtlMs: DAY, workspaceTtlMs: DAY }),
      {
        tempCleared: 2,
        workspacesRemoved: 0,
      },
    );
    assert.equal((await stat(pinned)).mtimeMs, future.getTime());
    assert.ok((await stat(join(skewed, "files", "doc"))).mtimeMs > Date.now());

    // Two days later both age out, instead of the pinned one surviving ten years.
    const later = Date.now() + 2 * DAY;
    assert.deepEqual(
      await sweepWorkspaces(root, {
        tempTtlMs: DAY,
        workspaceTtlMs: DAY,
        now: later,
      }),
      {
        tempCleared: 0,
        workspacesRemoved: 2,
      },
    );
    assert.equal(await exists(dir), false);
    assert.equal(await exists(skewed), false);
  },
);

test(
  "symlinks inside the tree are never followed or deleted through",
  { timeout: 20_000 },
  async (t) => {
    const root = await fixture(t);
    const outside = await fixture(t);
    // A large, fresh directory outside the root.
    const huge = join(outside, "huge");
    await mkdir(huge);
    await Promise.all(
      Array.from({ length: 2_000 }, (_, i) =>
        writeFile(join(huge, `f${i}`), "x"),
      ),
    );
    const target = join(outside, "file");
    await writeFile(target, "keep");

    const dir = await workspace(root, id(1), 60 * DAY);
    await symlink(huge, join(dir, "files", "to-huge"));
    await symlink(target, join(dir, "work", "tmp", "to-file"));
    await symlink("/", join(dir, "files", "to-root"));
    await symlink(join(dir, "files"), join(dir, "files", "loop"));
    await symlink(join(outside, "missing"), join(dir, "files", "dangling"));
    for (const link of [
      "files/to-huge",
      "work/tmp/to-file",
      "files/to-root",
      "files/loop",
      "files/dangling",
    ])
      await lutimes(
        join(dir, link),
        new Date(Date.now() - 60 * DAY),
        new Date(Date.now() - 60 * DAY),
      );
    await ageTree(dir, 60 * DAY);

    const started = performance.now();
    const result = await sweepWorkspaces(root, {
      tempTtlMs: DAY,
      workspaceTtlMs: DAY,
    });
    const elapsed = performance.now() - started;
    // The fresh targets do not keep the workspace alive: links are judged by
    // their own mtime. Walking "/" or the huge dir would take far longer.
    assert.deepEqual(result, { tempCleared: 0, workspacesRemoved: 1 });
    assert.ok(elapsed < 2_000, `${elapsed} ms`);
    assert.equal(await exists(dir), false);
    assert.equal((await stat(huge)).isDirectory(), true);
    assert.equal(await exists(join(huge, "f1999")), true);
    assert.equal(await exists(target), true);
  },
);

test(
  "a workspace or tmp that is itself a symlink is ignored",
  { timeout: 10_000 },
  async (t) => {
    const root = await fixture(t);
    const outside = await fixture(t);
    const real = await workspace(outside, id(1), 60 * DAY);
    await symlink(real, join(root, id(1)));
    const dir = await workspace(root, id(2), 1_000);
    await rm(join(dir, "work"), { recursive: true });
    const outsideWork = join(outside, "work");
    await mkdir(join(outsideWork, "tmp"), { recursive: true });
    await ageTree(outsideWork, 60 * DAY);
    await symlink(outsideWork, join(dir, "work"));
    assert.deepEqual(
      await sweepWorkspaces(root, { tempTtlMs: DAY, workspaceTtlMs: 30 * DAY }),
      {
        tempCleared: 0,
        workspacesRemoved: 0,
      },
    );
    assert.equal(await exists(join(real, "work", "tmp", "scratch")), true);
    assert.equal(await exists(join(outsideWork, "tmp")), true);
  },
);

test(
  "startWorkspaceSweeper skips a run while the previous one is going",
  { timeout: 10_000 },
  async (t) => {
    const root = await fixture(t);
    await workspace(root, id(1), 1_000);
    // The CJS exports object is what the compiled sweeper reads at call time.
    const fs = createRequire(__filename)(
      "node:fs/promises",
    ) as typeof import("node:fs/promises");
    let reads = 0,
      release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = fs.readdir;
    // Hold the first sweep at its first directory listing of the root.
    const readdir = mock.method(fs, "readdir", async (...args: any[]) => {
      if (args[0] === root && reads++ === 0) await gate;
      return (original as any)(...args);
    });
    t.after(() => readdir.mock.restore());
    mock.timers.enable({ apis: ["setInterval"] });
    t.after(() => mock.timers.reset());
    const stop = startWorkspaceSweeper(root, {});
    // Three hourly ticks while the initial sweep is still blocked.
    mock.timers.tick(3 * 3_600_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(reads, 1);
    release();
    await new Promise((r) => setTimeout(r, 50));
    mock.timers.tick(3_600_000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(reads, 2);
    stop();
    mock.timers.tick(3 * 3_600_000);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reads, 2);
  },
);

test(
  "invalid env values fall back to safe defaults",
  { timeout: 10_000 },
  async (t) => {
    const root = await fixture(t);
    const errors = mock.method(console, "error", () => {});
    t.after(() => errors.mock.restore());
    const bad = [
      "",
      " ",
      "abc",
      "-1",
      "0",
      "NaN",
      "Infinity",
      "-Infinity",
      "1e400",
      "0x",
      "  ",
    ];
    for (const value of bad) {
      // An old workspace with 2-day-old tmp: the 24 h default clears tmp,
      // and an invalid WORKSPACE_TTL_DAYS must never remove the workspace.
      const dir = await workspace(root, id(1), 2 * DAY);
      const stop = startWorkspaceSweeper(root, {
        WORKSPACE_TEMP_TTL_HOURS: value,
        WORKSPACE_TTL_DAYS: value,
      });
      stop();
      for (let i = 0; i < 100 && (await exists(join(dir, "work", "tmp"))); i++)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        await exists(join(dir, "work", "tmp")),
        false,
        `temp default for ${JSON.stringify(value)}`,
      );
      assert.equal(
        await exists(join(dir, "files", "doc")),
        true,
        `workspace kept for ${JSON.stringify(value)}`,
      );
      await rm(dir, { recursive: true });
    }
    // Tiny but valid values are honoured. "0x10" is accepted by Number() as 16.
    const dir = await workspace(root, id(1), 2 * DAY);
    const stop = startWorkspaceSweeper(root, { WORKSPACE_TTL_DAYS: "0.5" });
    stop();
    for (let i = 0; i < 100 && (await exists(dir)); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(await exists(dir), false);
    assert.equal(errors.mock.callCount(), 0);
  },
);

test(
  "a missing or unreadable root does not crash the sweeper",
  { timeout: 10_000 },
  async (t) => {
    const root = await fixture(t);
    const errors = mock.method(console, "error", () => {});
    t.after(() => errors.mock.restore());
    const file = join(root, "not-a-dir");
    await writeFile(file, "");
    await assert.rejects(sweepWorkspaces(file, { tempTtlMs: DAY }), /ENOTDIR/);
    const stop = startWorkspaceSweeper(file, {});
    stop();
    for (let i = 0; i < 50 && errors.mock.callCount() === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(errors.mock.callCount(), 1);
    assert.match(
      String(errors.mock.calls[0].arguments[0]),
      /Workspace sweep failed/,
    );
    // A non-directory entry with a UUID name is ignored.
    await writeFile(join(root, id(9)), "");
    assert.deepEqual(
      await sweepWorkspaces(root, { tempTtlMs: DAY, workspaceTtlMs: DAY }),
      {
        tempCleared: 0,
        workspacesRemoved: 0,
      },
    );
  },
);
