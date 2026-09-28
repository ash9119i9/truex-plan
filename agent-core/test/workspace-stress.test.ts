import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles, workspaceLimits } from "../src/workspace-tools";

// Worst-case and hostile inputs for the workspace tools. Timings are logged so
// docs/WORKSPACE_TOOLS_TESTING.md can quote them.
async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), "truex-stress-"));
  t.after(async () => {
    // Undo any mode 000 folders before cleanup.
    execFileSync("chmod", ["-R", "u+rwx", base]);
    await rm(base, { recursive: true, force: true });
  });
  const published: { name: string; data: Buffer }[] = [];
  const files = new WorkspaceFiles(
    (id) => join(base, "ws", id),
    async (_thread, name, data) => {
      published.push({ name, data });
      return { id: "f" + published.length, name };
    },
  );
  const run = (name: string, args: any, thread = "a") =>
    files.execute(thread, name, args) as Promise<any>;
  await run("list_files", {});
  return {
    base,
    files,
    published,
    run,
    root: (id = "a") => join(base, "ws", id, "work"),
  };
}
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const within = <T>(promise: Promise<T>, limit: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`hung for ${limit} ms`)), limit),
    ),
  ]);

test("hard links to outside files are never read, edited, exported or copied", async (t) => {
  const { base, files, run, root, published } = await fixture(t);
  const outside = join(base, "secret.txt");
  await writeFile(outside, "TOPSECRET\n");
  await link(outside, join(root(), "hl.txt"));
  for (const [tool, args] of [
    ["read_file", { path: "hl.txt" }],
    ["append_file", { path: "hl.txt", content: "x" }],
    ["edit_file", { path: "hl.txt", old_string: "TOP", new_string: "x" }],
    ["export_workspace_file", { path: "hl.txt" }],
  ] as const)
    await assert.rejects(run(tool, args), /hard link/, tool);
  const search = await run("search_files", { pattern: "TOPSECRET" });
  assert.deepEqual(search.matches, []);
  await files.copy("a", "b");
  await assert.rejects(readFile(join(root("b"), "hl.txt")), /ENOENT/);
  assert.equal(published.length, 0);
  assert.equal(await readFile(outside, "utf8"), "TOPSECRET\n");
});

test("a folder locked by a script does not break the rest of the workspace", async (t) => {
  const { run, root, files } = await fixture(t);
  await run("write_file", { path: "locked/inner.txt", content: "x" });
  await run("write_file", { path: "ok.txt", content: "needle" });
  await chmod(join(root(), "locked"), 0o000);
  await run("write_file", { path: "new.txt", content: "y" });
  assert.ok((await run("list_files", {})).entries.length >= 2);
  assert.deepEqual((await run("search_files", { pattern: "needle" })).matches, [
    "ok.txt:1:needle",
  ]);
  await files.copy("a", "b");
  assert.equal(await readFile(join(root("b"), "ok.txt"), "utf8"), "needle");
  await assert.rejects(
    run("read_file", { path: "locked/inner.txt" }),
    (e: Error) => !/\/(private|var|tmp)\//.test(e.message),
  );
  await run("delete_file", { path: "locked" });
  await assert.rejects(readdir(join(root(), "locked")), /ENOENT/);
});

test("catastrophic regexes time out without blocking the process", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", {
    path: "evil.txt",
    content: ("a".repeat(45) + "!\n").repeat(20),
  });
  for (const pattern of ["(a|a)*b", "(a|aa)+$", "(a*)*b", "(x+x+)+y"]) {
    if (pattern === "(x+x+)+y")
      await run("write_file", {
        path: "evil.txt",
        content: "x".repeat(30) + "\n",
      });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 100);
    const start = process.hrtime.bigint();
    await assert
      .rejects(run("search_files", { pattern }), /simplify|nested/, pattern)
      .finally(() => clearInterval(timer));
    const took = ms(start);
    console.log(`regex ${pattern}: rejected after ${took.toFixed(0)} ms`);
    assert.ok(took < 3500, `${pattern} took ${took} ms`);
  }
  await run("write_file", { path: "fine.txt", content: "FORM calc.\n" });
  assert.deepEqual(
    (await run("search_files", { pattern: "^FORM \\w+" })).matches,
    ["fine.txt:1:FORM calc."],
  );
});

test("a leading BOM survives read, append and edit", async (t) => {
  const { run, root } = await fixture(t);
  await run("write_file", { path: "bom.txt", content: "\uFEFFhello\n" });
  await run("append_file", { path: "bom.txt", content: "world\n" });
  await run("edit_file", {
    path: "bom.txt",
    old_string: "hello",
    new_string: "hi",
  });
  const bytes = await readFile(join(root(), "bom.txt"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString("utf8"), "\uFEFFhi\nworld\n");
});

test("FIFOs are refused without hanging and delete removes them", async (t) => {
  const { run, root } = await fixture(t);
  try {
    execFileSync("mkfifo", [join(root(), "pipe")]);
  } catch {
    t.skip("mkfifo unavailable");
    return;
  }
  for (const [tool, args] of [
    ["read_file", { path: "pipe" }],
    ["append_file", { path: "pipe", content: "x" }],
    ["export_workspace_file", { path: "pipe" }],
  ] as const)
    await assert.rejects(within(run(tool, args), 2000), /regular|supported/);
  await within(run("search_files", { pattern: "x" }), 2000);
  await within(run("list_files", {}), 2000);
  await run("delete_file", { path: "pipe" });
  await assert.rejects(readdir(join(root(), "pipe")), /ENOENT/);
});

test("files grow in chunks to just under 2 MB and stop cleanly at the limit", async (t) => {
  const { run, root } = await fixture(t);
  const chunk = "DATA: lv_value = 'x'.\n".repeat(4096); // ~90 KB
  const start = process.hrtime.bigint();
  let calls = 0;
  while (
    Buffer.byteLength(chunk) * (calls + 1) <=
    workspaceLimits.fileBytes - 1
  ) {
    await run("append_file", { path: "big.abap", content: chunk });
    calls++;
  }
  console.log(
    `built ${calls} chunks (${((calls * chunk.length) / 1048576).toFixed(2)} MB) in ${ms(start).toFixed(0)} ms`,
  );
  const before = await readFile(join(root(), "big.abap"));
  await assert.rejects(
    run("append_file", { path: "big.abap", content: chunk }),
    /limited to 2 MB/,
  );
  assert.deepEqual(await readFile(join(root(), "big.abap")), before);
});

test("a 12,000-line file reads back page by page with every line exactly once", async (t) => {
  const { run } = await fixture(t);
  const lines = Array.from({ length: 12_000 }, (_, i) => `line ${i + 1}`);
  for (let i = 0; i < lines.length; i += 1000)
    await run("append_file", {
      path: "long.txt",
      content: lines.slice(i, i + 1000).join("\n") + "\n",
    });
  const seen: string[] = [];
  let offset: number | null = 1,
    pages = 0;
  while (offset) {
    const page = await run("read_file", {
      path: "long.txt",
      offset,
      limit: 777,
    });
    for (const row of page.content.split("\n"))
      seen.push(row.split("\t").slice(1).join("\t"));
    offset = page.nextOffset;
    pages++;
  }
  assert.equal(pages, Math.ceil(12_000 / 777));
  assert.deepEqual(seen, lines);
});

test("line endings, empty files and huge lines are handled", async (t) => {
  const { run } = await fixture(t);
  await run("write_file", { path: "crlf.txt", content: "a\r\nb\r\n" });
  assert.match((await run("read_file", { path: "crlf.txt" })).content, /a\r?/);
  await run("write_file", { path: "no-newline.txt", content: "a\nb" });
  assert.equal(
    (await run("read_file", { path: "no-newline.txt" })).totalLines,
    2,
  );
  await run("write_file", { path: "newlines.txt", content: "\n\n\n" });
  const nl = await run("read_file", { path: "newlines.txt" });
  assert.ok(nl.totalLines >= 3);
  const one = "z".repeat(1_000_000);
  await run("write_file", { path: "oneline.txt", content: one + "\n" });
  const read = await run("read_file", { path: "oneline.txt" });
  assert.match(read.content, /line truncated, 1000000 characters/);
  assert.ok(read.content.length < 10_000);
  const hit = await run("search_files", { pattern: "zzz", literal: true });
  assert.ok(hit.matches[0].length < 1000);
});

test("the workspace stops cleanly at the file count limit", async (t) => {
  const { run } = await fixture(t);
  const start = process.hrtime.bigint();
  const times: number[] = [];
  for (let i = 0; i < workspaceLimits.files; i++) {
    const one = process.hrtime.bigint();
    await run("write_file", { path: `d${i % 40}/f${i}.txt`, content: "x" });
    if (i % 500 === 499) times.push(ms(one));
  }
  console.log(
    `${workspaceLimits.files} files in ${ms(start).toFixed(0)} ms; write time at 500/1000/1500/2000 files: ${times.map((t) => t.toFixed(1)).join("/")} ms`,
  );
  await assert.rejects(
    run("write_file", { path: "extra.txt", content: "x" }),
    /limited to 2000 files/,
  );
  let s = process.hrtime.bigint();
  const list = await run("list_files", {});
  console.log(`list_files at 2000 files: ${ms(s).toFixed(0)} ms`);
  assert.equal(list.truncated, true);
  s = process.hrtime.bigint();
  const found = await run("search_files", { pattern: "x", literal: true });
  console.log(`search_files at 2000 files: ${ms(s).toFixed(0)} ms`);
  assert.equal(found.truncated, true);
});

test("200 mixed operations at once leave a consistent state", async (t) => {
  const { run, root } = await fixture(t);
  await run("write_file", { path: "log.txt", content: "" });
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 200; i++) {
    const kind = i % 5;
    if (kind === 0)
      ops.push(run("append_file", { path: "log.txt", content: `${i}\n` }));
    else if (kind === 1)
      ops.push(run("write_file", { path: `w/${i}.txt`, content: `${i}` }));
    else if (kind === 2)
      ops.push(run("read_file", { path: "log.txt" }).catch(() => {}));
    else if (kind === 3)
      ops.push(run("delete_file", { path: `w/${i - 2}.txt` }).catch(() => {}));
    else ops.push(run("list_files", {}));
  }
  await Promise.all(ops);
  const log = (await readFile(join(root(), "log.txt"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  assert.deepEqual(
    log,
    Array.from({ length: 40 }, (_, i) => i * 5),
  );
  const left = (await readdir(join(root(), "w"))).sort();
  assert.equal(left.length, 0);
  assert.deepEqual(
    (await readdir(root())).filter((n) => n.startsWith(".truex-partial")),
    [],
  );
});

test("50 threads in parallel stay isolated", async (t) => {
  const { run } = await fixture(t);
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      run("write_file", { path: "me.txt", content: `thread ${i}` }, `t${i}`),
    ),
  );
  for (let i = 0; i < 50; i++) {
    const read = await run("read_file", { path: "me.txt" }, `t${i}`);
    assert.match(read.content, new RegExp(`thread ${i}$`));
  }
});

test("clearTemp and copy racing writes never crash or copy partial files", async (t) => {
  const { run, files, root } = await fixture(t);
  await assert.rejects(files.copy("a", "a"), /onto itself/);
  const work: Promise<unknown>[] = [];
  // Opposite copies at once must not deadlock.
  await run("list_files", {}, "z");
  work.push(files.copy("a", "z"), files.copy("z", "a"));
  for (let i = 0; i < 50; i++) {
    work.push(run("write_file", { path: `tmp/${i}.txt`, content: "x" }));
    if (i % 10 === 0) work.push(files.clearTemp("a"));
    if (i % 10 === 5) work.push(files.copy("a", `c${i}`));
  }
  await Promise.all(work);
  for (let i = 5; i < 50; i += 10) {
    const names = await readdir(join(root(`c${i}`))).catch(() => []);
    assert.ok(!names.some((n) => n.startsWith(".truex-partial")));
  }
});

test("multibyte text split across appends stays byte exact", async (t) => {
  const { run, root } = await fixture(t);
  const text = "Kunde: Müller – 東京 – 🚀 ✓\n".repeat(200);
  const pieces = text.match(/[\s\S]{1,37}/gu)!;
  for (const piece of pieces)
    await run("append_file", { path: "utf8.txt", content: piece });
  assert.equal(await readFile(join(root(), "utf8.txt"), "utf8"), text);
  await writeFile(join(root(), "bad.txt"), Buffer.from([0x61, 0xff, 0xfe]));
  await assert.rejects(run("read_file", { path: "bad.txt" }), /UTF-8|text/);
  await assert.rejects(
    run("append_file", { path: "bad.txt", content: "x" }),
    /UTF-8|text/,
  );
  assert.deepEqual(
    [...(await readFile(join(root(), "bad.txt")))],
    [0x61, 0xff, 0xfe],
  );
});

test("about 1,000 hostile paths never escape the workspace", async (t) => {
  const { base, run, root } = await fixture(t);
  await writeFile(join(base, "outside.txt"), "OUTSIDE");
  await mkdir(join(base, "ws", "b", "work"), { recursive: true });
  await writeFile(join(base, "ws", "b", "work", "other.txt"), "OTHER");
  const snapshot = async () =>
    JSON.stringify([
      (await readdir(base)).sort(),
      (await readdir(join(base, "ws"))).sort(),
    ]);
  const before = await snapshot();
  const seeds = [
    "..",
    "../outside.txt",
    "../../outside.txt",
    "tmp/../..",
    "tmp/../../outside.txt",
    "a/../../b/work/other.txt",
    "/etc/passwd",
    "//etc/passwd",
    "C:/Windows/win.ini",
    "c:\\x",
    "\\\\server\\share",
    "..\\outside.txt",
    "./../outside.txt",
    "a/./../../..",
    "\u2025/outside.txt",
    "\uFF0E\uFF0E/outside.txt",
    "%2e%2e/outside.txt",
    "a\0b",
    "a\nb",
    "\u202E..",
    "~/.ssh/id_rsa",
    "$HOME/x",
    "a/" + "b/".repeat(200),
    "x".repeat(400),
    "é".repeat(200),
    "",
    " ",
    ".",
    "./",
    "a//b",
    "a/b/",
    "__proto__",
    "constructor/prototype",
  ];
  const paths = new Set(seeds);
  for (const a of seeds)
    for (const b of ["", "/", "/..", "/../outside.txt", "tmp/"])
      (paths.add(a + b), paths.add(b + a));
  const n = seeds.length;
  for (let i = 0; paths.size < 1000 && i < 100_000; i++)
    paths.add(
      [seeds[i % n], seeds[Math.floor(i / n) % n], String(i)].join(
        i % 2 ? "/" : "/../",
      ),
    );
  assert.ok(paths.size >= 1000);
  for (const path of paths) {
    for (const [tool, args] of [
      ["write_file", { path, content: "PWN" }],
      ["read_file", { path }],
      ["export_workspace_file", { path }],
      ["delete_file", { path }],
    ] as const) {
      const result = await run(tool, args).catch(() => undefined);
      assert.doesNotMatch(
        JSON.stringify(result ?? ""),
        /OUTSIDE|OTHER/,
        `${tool} ${JSON.stringify(path)}`,
      );
    }
  }
  assert.equal(await snapshot(), before);
  assert.equal(await readFile(join(base, "outside.txt"), "utf8"), "OUTSIDE");
  assert.equal(
    await readFile(join(base, "ws", "b", "work", "other.txt"), "utf8"),
    "OTHER",
  );
  await symlink(base, join(root(), "escape"));
  await assert.rejects(run("read_file", { path: "escape/outside.txt" }));
});

test("malformed arguments are rejected", async (t) => {
  const { run } = await fixture(t);
  for (const [tool, args] of [
    ["write_file", { path: 1, content: "x" }],
    ["write_file", { path: "a" }],
    ["write_file", { path: "a", content: "x", extra: 1 }],
    [
      "write_file",
      JSON.parse('{"path":"a","content":"x","__proto__":{"x":1}}'),
    ],
    ["read_file", { path: "a", offset: -1 }],
    ["read_file", { path: "a", limit: 1e9 }],
    ["edit_file", { path: "a", old_string: "", new_string: "x" }],
    ["search_files", { pattern: "x".repeat(10_000) }],
    ["nope", {}],
    ["write_file", null],
    ["write_file", "string"],
  ] as const)
    await assert.rejects(run(tool as string, args), Error, tool);
  await assert.rejects(
    run("write_file", {
      path: "huge.txt",
      content: "x".repeat(workspaceLimits.contentBytes + 1),
    }),
    /MB|limit/,
  );
  assert.equal(({} as any).x, undefined);
});
