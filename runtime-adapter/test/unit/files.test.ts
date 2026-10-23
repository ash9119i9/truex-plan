import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  MAX_PREVIEW_CHARS,
  MAX_PREVIEW_PIECE_CHARS,
  previewUpdate,
  type PreviewState,
} from "../../src/codex/activity";
import { AdapterError } from "../../src/errors";
import {
  chatWorkspace,
  listWorkspace,
  MAX_FILE_BYTES,
  readWorkspaceFile,
} from "../../src/runtime/files";

describe("workspace files", () => {
  let root = "";
  let ws = "";
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "adapter-files-"));
    ws = chatWorkspace(root, { tenantId: "t1", chatId: "c1" });
    await mkdir(join(ws, "docs", "deep"), { recursive: true });
    await writeFile(join(ws, "guide.md"), "# Guide\n");
    await writeFile(join(ws, "docs", "a.txt"), "alpha");
    await writeFile(join(ws, "docs", "deep", "b.csv"), "x,y\n");
    await mkdir(join(ws, ".git"));
    await writeFile(join(ws, ".git", "config"), "secret");
    await writeFile(join(ws, ".env"), "TOKEN=1");
    await mkdir(join(ws, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(ws, "node_modules", "pkg", "index.js"), "");
    // Outside the workspace: another chat's file.
    const other = chatWorkspace(root, { tenantId: "t1", chatId: "c2" });
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "secret.txt"), "OTHER");
    await symlink(join(other, "secret.txt"), join(ws, "link.txt"));
    await symlink(other, join(ws, "linkdir"));
    await utimes(join(ws, "guide.md"), 1_700_000_000, 1_700_000_000);
  });
  after(() => rm(root, { recursive: true, force: true }));

  test("lists visible regular files, skipping dot entries, symlinks and installed trees", async () => {
    const { files, truncated } = await listWorkspace(ws);
    assert.equal(truncated, false);
    assert.deepEqual(
      files.map((f) => f.path),
      ["guide.md", "docs/a.txt", "docs/deep/b.csv"],
    );
    const guide = files[0]!;
    assert.equal(guide.size, 8);
    assert.equal(guide.modifiedAt, 1_700_000_000_000);
  });

  test("a chat that never ran has no files", async () => {
    const empty = chatWorkspace(root, { tenantId: "t1", chatId: "none" });
    assert.deepEqual(await listWorkspace(empty), {
      files: [],
      truncated: false,
    });
  });

  test("reads a listed file", async () => {
    const data = await readWorkspaceFile(ws, "docs/a.txt");
    assert.equal(data.toString(), "alpha");
  });

  for (const path of [
    "../c2/workspace/secret.txt",
    "/etc/passwd",
    "docs/../guide.md",
    "./guide.md",
    "docs//a.txt",
    ".env",
    ".git/config",
    "docs\\a.txt",
    "guide.md\0",
    "",
  ])
    test(`refuses the path ${JSON.stringify(path)}`, async () => {
      await assert.rejects(
        readWorkspaceFile(ws, path),
        (error: unknown) =>
          error instanceof AdapterError && error.code === "INVALID_REQUEST",
      );
    });

  for (const path of ["link.txt", "linkdir/secret.txt", "missing.md", "docs"])
    test(`${path} is not a workspace file`, async () => {
      await assert.rejects(
        readWorkspaceFile(ws, path),
        (error: unknown) =>
          error instanceof AdapterError && error.code === "FILE_NOT_FOUND",
      );
    });

  test("refuses a file over the size limit", async () => {
    await writeFile(join(ws, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1));
    await assert.rejects(
      readWorkspaceFile(ws, "big.bin"),
      (error: unknown) =>
        error instanceof AdapterError && error.code === "PAYLOAD_TOO_LARGE",
    );
    await rm(join(ws, "big.bin"));
  });
});

describe("live preview of a new file", () => {
  const add = (path: string, diff: string) => [
    { path: `/w/${path}`, kind: { type: "add" }, diff },
  ];

  test("sends each new piece once, from where the last one ended", () => {
    const first = previewUpdate(add("a.md", "# Ti"), "/w", undefined);
    assert.deepEqual(first?.update, {
      path: "a.md",
      offset: 0,
      text: "# Ti",
      truncated: false,
    });
    const second = previewUpdate(add("a.md", "# Title\n"), "/w", first!.state);
    assert.deepEqual(second?.update, {
      path: "a.md",
      offset: 4,
      text: "tle\n",
      truncated: false,
    });
    assert.equal(
      previewUpdate(add("a.md", "# Title\n"), "/w", second!.state),
      null,
      "nothing new",
    );
  });

  test("edits and files outside the workspace have no preview", () => {
    const update = [{ path: "/w/a.md", kind: { type: "update" }, diff: "+x" }];
    assert.equal(previewUpdate(update, "/w", undefined), null);
    assert.equal(previewUpdate(add("../x.md", "x"), "/w", undefined), null);
  });

  test("stays on the first file of a patch", () => {
    const state: PreviewState = { path: "a.md", sent: 1, truncated: false };
    assert.equal(previewUpdate(add("b.md", "bb"), "/w", state), null);
  });

  test("a whole file at once is sent in bounded pieces, up to the limit", () => {
    const long = "x".repeat(MAX_PREVIEW_CHARS + 10);
    let state: PreviewState | undefined;
    let sent = "";
    const pieces: number[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const next = previewUpdate(add("a.md", long), "/w", state);
      if (!next) break;
      assert.equal(next.update.offset, sent.length);
      pieces.push(next.update.text.length);
      sent += next.update.text;
      state = next.state;
    }
    assert.ok(pieces.length > 1, "more than one piece");
    assert.ok(pieces.every((n) => n <= MAX_PREVIEW_PIECE_CHARS));
    assert.equal(sent.length, MAX_PREVIEW_CHARS);
    assert.equal(state?.truncated, true);
  });

  test("never splits a surrogate pair", () => {
    const next = previewUpdate(add("a.md", "hi \uD83D"), "/w", undefined);
    assert.equal(next?.update.text, "hi ");
    const rest = previewUpdate(
      add("a.md", "hi \uD83D\uDE00"),
      "/w",
      next!.state,
    );
    assert.equal(rest?.update.text, "\uD83D\uDE00");
  });
});
