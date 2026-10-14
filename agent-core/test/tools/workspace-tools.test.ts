import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
  readFile,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles } from "../../src/tools/workspace/files";
import {
  workspaceLimits,
  workspaceTools,
} from "../../src/tools/workspace/specs";

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), "truex-workspace-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const published: { threadId: string; name: string; data: Buffer }[] = [];
  const files = new WorkspaceFiles(
    (id) => join(base, id),
    async (threadId, name, data) => {
      published.push({ threadId, name, data });
      return { id: "file-" + published.length, name };
    },
  );
  const run = (name: string, args: any, thread = "a") =>
    files.execute(thread, name, args) as Promise<any>;
  return {
    base,
    files,
    published,
    run,
    root: (id = "a") => join(base, id, "work"),
  };
}

test("exports tool specs for every workspace tool", () => {
  assert.deepEqual(
    workspaceTools.map((t) => (t.type === "function" ? t.name : "")),
    [
      "write_file",
      "append_file",
      "edit_file",
      "read_file",
      "list_files",
      "search_files",
      "delete_file",
      "export_workspace_file",
    ],
  );
});

test("write, read, overwrite and nested folders with private permissions", async (t) => {
  const { run, root } = await fixture(t);
  const written = await run("write_file", {
    path: "src/prog/main.abap",
    content: "REPORT zmain.\nWRITE 'hi'.\n",
  });
  assert.deepEqual(written, {
    path: "src/prog/main.abap",
    bytes: 26,
    lines: 2,
  });
  const read = await run("read_file", { path: "src/prog/main.abap" });
  assert.equal(read.content, "     1\tREPORT zmain.\n     2\tWRITE 'hi'.");
  assert.equal(read.totalLines, 2);
  assert.equal(read.truncated, false);
  assert.equal(read.nextOffset, null);
  await run("write_file", { path: "./src//prog/main.abap", content: "x" });
  assert.equal(await readFile(join(root(), "src/prog/main.abap"), "utf8"), "x");
  assert.equal(
    (await stat(join(root(), "src/prog/main.abap"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(join(root(), "src"))).mode & 0o777, 0o700);
  assert.equal((await stat(root())).mode & 0o777, 0o700);
  await run("write_file", { path: "empty.txt", content: "" });
  assert.equal((await run("read_file", { path: "empty.txt" })).totalLines, 0);
  await assert.rejects(
    run("read_file", { path: "missing.txt" }),
    (e: any) => e.status === 404,
  );
  await assert.rejects(
    run("write_file", { path: "src", content: "x" }),
    /folder/,
  );
  await assert.rejects(
    run("write_file", { path: "src/prog/main.abap/child", content: "x" }),
    /is a file, not a folder/,
  );
});

test("append_file builds a large file in chunks and read_file paginates it", async (t) => {
  const { run } = await fixture(t);
  for (let chunk = 0; chunk < 5; chunk++) {
    let text = "";
    for (let i = 1; i <= 1000; i++) text += `* line ${chunk * 1000 + i}\n`;
    const result = await run("append_file", {
      path: "big.abap",
      content: text,
    });
    assert.equal(result.lines, (chunk + 1) * 1000);
  }
  const first = await run("read_file", { path: "big.abap" });
  assert.equal(first.totalLines, 5000);
  assert.equal(first.endLine, 2000);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 2001);
  assert.match(first.content.split("\n")[1999], /^  2000\t\* line 2000$/);
  const second = await run("read_file", {
    path: "big.abap",
    offset: first.nextOffset,
    limit: 10,
  });
  assert.equal(second.content.split("\n")[0], "  2001\t* line 2001");
  assert.equal(second.nextOffset, 2011);
  const last = await run("read_file", { path: "big.abap", offset: 4999 });
  assert.equal(last.endLine, 5000);
  assert.equal(last.nextOffset, null);
  await assert.rejects(
    run("read_file", { path: "big.abap", offset: 6000 }),
    /beyond the end/,
  );
  await assert.rejects(
    run("read_file", { path: "big.abap", offset: 0 }),
    /Invalid/,
  );
  await assert.rejects(
    run("read_file", { path: "big.abap", limit: 5001 }),
    /Invalid/,
  );
});

test("read_file truncates very long lines", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", { path: "long.txt", content: "y".repeat(10000) });
  const read = await run("read_file", { path: "long.txt" });
  assert.match(read.content, /line truncated, 10000 characters/);
  assert.ok(read.content.length < 5000);
});

test("edit_file replaces unique strings and reports ambiguity", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", {
    path: "a.abap",
    content: "DATA lv TYPE i.\nlv = 1.\nlv = 1.\n",
  });
  await assert.rejects(
    run("edit_file", {
      path: "a.abap",
      old_string: "lv = 1.",
      new_string: "lv = 2.",
    }),
    /matches 2 times/,
  );
  await assert.rejects(
    run("edit_file", { path: "a.abap", old_string: "nope", new_string: "x" }),
    /not found/,
  );
  await assert.rejects(
    run("edit_file", { path: "a.abap", old_string: "lv", new_string: "lv" }),
    /identical/,
  );
  await assert.rejects(
    run("edit_file", { path: "missing", old_string: "a", new_string: "b" }),
    (e: any) => e.status === 404,
  );
  const unique = await run("edit_file", {
    path: "a.abap",
    old_string: "TYPE i.",
    new_string: "TYPE $& string.",
  });
  assert.equal(unique.replacements, 1);
  const all = await run("edit_file", {
    path: "a.abap",
    old_string: "lv = 1.",
    new_string: "lv = 3.",
    replace_all: true,
  });
  assert.equal(all.replacements, 2);
  assert.equal(
    (await run("read_file", { path: "a.abap" })).content,
    "     1\tDATA lv TYPE $& string.\n     2\tlv = 3.\n     3\tlv = 3.",
  );
});

test("list_files reports recursive entries, sizes, usage and truncation", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", { path: "b.txt", content: "bb" });
  await run("write_file", { path: "a/one.txt", content: "1" });
  await run("write_file", { path: "a/deep/two.txt", content: "22" });
  const list = await run("list_files", {});
  assert.deepEqual(list.entries, [
    { path: "a", type: "folder", size: 0 },
    { path: "a/deep", type: "folder", size: 0 },
    { path: "a/deep/two.txt", type: "file", size: 2 },
    { path: "a/one.txt", type: "file", size: 1 },
    { path: "b.txt", type: "file", size: 2 },
  ]);
  assert.equal(list.truncated, false);
  assert.deepEqual(
    {
      files: list.usage.files,
      folders: list.usage.folders,
      bytes: list.usage.bytes,
    },
    { files: 3, folders: 2, bytes: 5 },
  );
  const sub = await run("list_files", { path: "a/deep" });
  assert.deepEqual(
    sub.entries.map((e: any) => e.path),
    ["a/deep/two.txt"],
  );
  await assert.rejects(
    run("list_files", { path: "zzz" }),
    (e: any) => e.status === 404,
  );
});

test("list_files caps entries", async (t) => {
  const { run, root } = await fixture(t);
  await run("list_files", {});
  await Promise.all(
    Array.from({ length: workspaceLimits.listEntries + 5 }, (_, i) =>
      writeFile(join(root(), `f${i}.txt`), "x"),
    ),
  );
  const list = await run("list_files", {});
  assert.equal(list.entries.length, workspaceLimits.listEntries);
  assert.equal(list.truncated, true);
});

test("search_files supports regex, literal, case, path and glob filters", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", {
    path: "src/a.abap",
    content: "REPORT za.\nSELECT * FROM mara.\n",
  });
  await run("write_file", {
    path: "src/sub/b.abap",
    content: "select matnr from mara.\n",
  });
  await run("write_file", {
    path: "notes.md",
    content: "mara (material master)\n",
  });
  await run("write_file", { path: "bin.dat", content: "mara\u0000" });
  assert.deepEqual(
    (await run("search_files", { pattern: "FROM mara" })).matches,
    ["src/a.abap:2:SELECT * FROM mara."],
  );
  assert.deepEqual(
    (await run("search_files", { pattern: "from mara", ignore_case: true }))
      .matches,
    [
      "src/a.abap:2:SELECT * FROM mara.",
      "src/sub/b.abap:1:select matnr from mara.",
    ],
  );
  assert.deepEqual(
    (await run("search_files", { pattern: "mara (", literal: true })).matches,
    ["notes.md:1:mara (material master)"],
  );
  await assert.rejects(
    run("search_files", { pattern: "mara (" }),
    /Invalid search pattern/,
  );
  assert.equal(
    (await run("search_files", { pattern: "mara", glob: "*.abap" })).count,
    2,
  );
  assert.equal(
    (await run("search_files", { pattern: "mara", glob: "src/*.abap" })).count,
    1,
  );
  assert.equal(
    (await run("search_files", { pattern: "mara", glob: "src/**/*.abap" }))
      .count,
    2,
  );
  assert.equal(
    (await run("search_files", { pattern: "mara", glob: "**/b.ab?p" })).count,
    1,
  );
  assert.equal(
    (await run("search_files", { pattern: "mara", path: "src/sub" })).count,
    1,
  );
  assert.equal(
    (await run("search_files", { pattern: "mara", path: "notes.md" })).count,
    1,
  );
  const all = await run("search_files", { pattern: "mara" });
  assert.deepEqual(all.skipped, ["bin.dat"]);
  await assert.rejects(
    run("search_files", { pattern: "(a+)+$" }),
    /Nested repeated/,
  );
  await assert.rejects(
    run("search_files", {
      pattern: "a".repeat(workspaceLimits.patternLength + 1),
    }),
    /Invalid/,
  );
});

test("search_files caps matches and truncates long lines", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", { path: "many.txt", content: "hit\n".repeat(500) });
  await run("write_file", {
    path: "wide.txt",
    content: "z".repeat(1000) + "WIDE\n",
  });
  const many = await run("search_files", { pattern: "hit" });
  assert.equal(many.count, workspaceLimits.searchMatches);
  assert.equal(many.truncated, true);
  const wide = await run("search_files", { pattern: "WIDE" });
  assert.ok(wide.matches[0].length < 400);
  assert.ok(wide.matches[0].endsWith("…"));
});

test("delete_file removes files and folders but never the root", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", { path: "keep.txt", content: "k" });
  await run("write_file", { path: "dir/x/y.txt", content: "y" });
  assert.deepEqual(await run("delete_file", { path: "dir" }), {
    path: "dir",
    deleted: "folder",
  });
  assert.deepEqual(await run("delete_file", { path: "keep.txt" }), {
    path: "keep.txt",
    deleted: "file",
  });
  assert.deepEqual((await run("list_files", {})).entries, []);
  await assert.rejects(
    run("delete_file", { path: "keep.txt" }),
    (e: any) => e.status === 404,
  );
  for (const path of ["", ".", "./", "a/.."])
    await assert.rejects(
      run("delete_file", { path }),
      (e: any) => e.status === 400,
    );
});

test("export_workspace_file publishes the file contents", async (t) => {
  const { run, published } = await fixture(t);
  await run("write_file", { path: "out/zreport.abap", content: "REPORT z." });
  assert.deepEqual(
    await run("export_workspace_file", { path: "out/zreport.abap" }),
    {
      id: "file-1",
      name: "zreport.abap",
    },
  );
  assert.deepEqual(
    await run("export_workspace_file", {
      path: "out/zreport.abap",
      name: "Z.txt",
    }),
    {
      id: "file-2",
      name: "Z.txt",
    },
  );
  assert.equal(published[0].threadId, "a");
  assert.equal(published[0].data.toString(), "REPORT z.");
  await assert.rejects(
    run("export_workspace_file", { path: "out/zreport.abap", name: "../x" }),
    /download name/,
  );
  await assert.rejects(run("export_workspace_file", { path: "out" }), /folder/);
  await assert.rejects(
    run("export_workspace_file", { path: "nope" }),
    (e: any) => e.status === 404,
  );
});

test("clearTemp removes only tmp", async (t) => {
  const { run, files } = await fixture(t);
  await run("write_file", { path: "tmp/scratch/a.txt", content: "a" });
  await run("write_file", { path: "PLAN.md", content: "plan" });
  await files.clearTemp("a");
  assert.deepEqual(
    (await run("list_files", {})).entries.map((e: any) => e.path),
    ["PLAN.md"],
  );
  await files.clearTemp("never-used");
});

test("copy duplicates a workspace into another thread; threads stay isolated", async (t) => {
  const { run, files } = await fixture(t);
  await run("write_file", { path: "src/a.txt", content: "one" });
  assert.deepEqual((await run("list_files", {}, "b")).entries, []);
  await assert.rejects(
    run("read_file", { path: "src/a.txt" }, "b"),
    (e: any) => e.status === 404,
  );
  await files.copy("a", "fork");
  assert.match(
    (await run("read_file", { path: "src/a.txt" }, "fork")).content,
    /one/,
  );
  await run("write_file", { path: "src/a.txt", content: "changed" }, "fork");
  assert.match((await run("read_file", { path: "src/a.txt" })).content, /one/);
  await files.copy("empty", "fork2");
  assert.deepEqual((await run("list_files", {}, "fork2")).entries, []);
});

test("rejects path escapes and malformed paths", async (t) => {
  const { run } = await fixture(t);
  const bad = [
    "/etc/passwd",
    "../secret",
    "a/../../secret",
    "a/..",
    "..",
    "a\\b",
    "..\\secret",
    "a\u0000b",
    "a\nb",
    "C:/windows",
    "x".repeat(301),
    "a/" + "b".repeat(256),
    ".truex-partial-abc",
  ];
  for (const path of bad) {
    await assert.rejects(
      run("write_file", { path, content: "x" }),
      (e: any) => e.status === 400,
      path,
    );
    await assert.rejects(
      run("read_file", { path }),
      (e: any) => e.status === 400,
      path,
    );
  }
  await assert.rejects(
    run("write_file", { path: "", content: "x" }),
    /Invalid/,
  );
  await assert.rejects(
    run("write_file", { path: "a", content: "x", extra: 1 }),
    /Invalid/,
  );
  await assert.rejects(run("write_file", { path: "a", content: 5 }), /Invalid/);
  await assert.rejects(run("shell", {}), /Unknown workspace tool/);
  await assert.rejects(run("list_files", { path: "../" }), /'\.\.'/);
  await assert.rejects(
    run("search_files", { pattern: "x", path: "/etc" }),
    /absolute/,
  );
});

test("refuses symbolic links anywhere in the path", async (t) => {
  const { run, root, base } = await fixture(t);
  await run("write_file", { path: "real/file.txt", content: "inside" });
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root(), "linkdir"));
  await symlink(join(outside, "secret.txt"), join(root(), "link.txt"));
  await symlink(join(root(), "real/file.txt"), join(root(), "inner.txt"));
  for (const path of [
    "linkdir/secret.txt",
    "link.txt",
    "inner.txt",
    "linkdir",
  ]) {
    await assert.rejects(run("read_file", { path }), /Symbolic links/, path);
    await assert.rejects(
      run("write_file", { path, content: "x" }),
      /Symbolic links/,
      path,
    );
    await assert.rejects(
      run("append_file", { path, content: "x" }),
      /Symbolic links/,
      path,
    );
    await assert.rejects(
      run("export_workspace_file", { path }),
      /Symbolic links/,
      path,
    );
  }
  await assert.rejects(
    run("write_file", { path: "linkdir/new.txt", content: "x" }),
    /Symbolic/,
  );
  await assert.rejects(run("list_files", { path: "linkdir" }), /Symbolic/);
  // delete_file removes a planted link itself and never follows it.
  for (const path of ["link.txt", "linkdir"])
    assert.equal((await run("delete_file", { path })).path, path);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
  assert.equal(await readFile(join(root(), "real/file.txt"), "utf8"), "inside");
  const search = await run("search_files", { pattern: "secret|inside" });
  assert.deepEqual(search.matches, ["real/file.txt:1:inside"]);
  const listed = (await run("list_files", {})).entries.map((e: any) => e.path);
  assert.deepEqual(listed, ["real", "real/file.txt"]);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
});

test("clearTemp and copy do not follow symlinks", async (t) => {
  const { run, root, base, files } = await fixture(t);
  await run("write_file", { path: "a.txt", content: "a" });
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root(), "tmp"));
  await symlink(join(outside, "secret.txt"), join(root(), "s.txt"));
  await files.clearTemp("a");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
  await files.copy("a", "fork");
  const listed = (await run("list_files", {}, "fork")).entries.map(
    (e: any) => e.path,
  );
  assert.deepEqual(listed, ["a.txt"]);
});

test("rejects a workspace root that is a symlink", async (t) => {
  const { run, base } = await fixture(t);
  const outside = join(base, "outside");
  await mkdir(outside);
  await mkdir(join(base, "evil"));
  await symlink(outside, join(base, "evil", "work"));
  await assert.rejects(run("list_files", {}, "evil"), /unavailable/);
});

test("enforces content, file, workspace and file-count limits", async (t) => {
  const { run, root } = await fixture(t);
  const MB = 1_048_576;
  await assert.rejects(
    run("write_file", { path: "big.txt", content: "x".repeat(MB + 1) }),
    (e: any) => e.status === 413 && /1 MB per call/.test(e.message),
  );
  await assert.rejects(
    run("write_file", { path: "big.txt", content: "é".repeat(MB / 2 + 1) }),
    (e: any) => e.status === 413,
  );
  await run("write_file", { path: "big.txt", content: "x".repeat(MB) });
  await run("append_file", { path: "big.txt", content: "x".repeat(MB) });
  await assert.rejects(
    run("append_file", { path: "big.txt", content: "x" }),
    (e: any) => e.status === 413 && /2 MB/.test(e.message),
  );
  assert.equal((await stat(join(root(), "big.txt"))).size, 2 * MB);
  await writeFile(join(root(), "huge.txt"), Buffer.alloc(2 * MB + 1, 120));
  await assert.rejects(
    run("read_file", { path: "huge.txt" }),
    (e: any) => e.status === 413,
  );
  assert.deepEqual(
    (await run("search_files", { pattern: "x", path: "huge.txt" })).skipped,
    ["huge.txt"],
  );
  await rm(join(root(), "huge.txt"));
  await writeFile(join(root(), "bin"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(run("read_file", { path: "bin" }), /not a UTF-8 text/);
  await assert.rejects(
    run("edit_file", { path: "bin", old_string: "a", new_string: "b" }),
    /not a UTF-8/,
  );
  await rm(join(root(), "bin"));
  const filler = Buffer.alloc(2 * MB, 120);
  for (let i = 0; i < 23; i++)
    await writeFile(join(root(), `fill${i}.txt`), filler);
  await run("write_file", { path: "last.txt", content: "x".repeat(MB) });
  await run("append_file", { path: "last.txt", content: "x".repeat(MB - 10) });
  await assert.rejects(
    run("write_file", { path: "over.txt", content: "x".repeat(100) }),
    (e: any) => e.status === 413 && /50 MB/.test(e.message),
  );
  await run("write_file", { path: "last.txt", content: "shrink" });
  for (let i = 0; i < 24; i++)
    await rm(join(root(), i < 23 ? `fill${i}.txt` : "big.txt"));
  await Promise.all(
    Array.from({ length: workspaceLimits.files - 1 }, (_, i) =>
      writeFile(join(root(), `n${i}`), ""),
    ),
  );
  await assert.rejects(
    run("write_file", { path: "one-more.txt", content: "x" }),
    (e: any) => e.status === 413 && /2000 files/.test(e.message),
  );
  await run("write_file", { path: "last.txt", content: "overwrite is fine" });
});

test("serializes concurrent appends per thread", async (t) => {
  const { run } = await fixture(t);
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      run("append_file", { path: "log.txt", content: `${i}\n` }),
    ),
  );
  const read = await run("read_file", { path: "log.txt" });
  assert.equal(read.totalLines, 50);
  const numbers = read.content
    .split("\n")
    .map((l: string) => Number(l.split("\t")[1]));
  assert.deepEqual(
    numbers,
    Array.from({ length: 50 }, (_, i) => i),
  );
});
