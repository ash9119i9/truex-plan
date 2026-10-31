import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStreamEvent, liveReply, parseRun } from "../lib/tenant-chat.ts";
import type { Activity } from "../lib/tenant-coding.ts";
import {
  filesByRun,
  filesOfRun,
  fileTag,
  lineCount,
  parseCsv,
  parseFiles,
  parseUnsaved,
  previewKind,
  resolveSubject,
  sandboxedHtml,
  withFiles,
  type ChatFile,
} from "../lib/tenant-files.ts";

type FileChange = Extract<Activity, { type: "file_change" }>;

const RUN = "6a0000000000000000000001";
const OTHER_RUN = "6a0000000000000000000002";
let next = 0;
function file(over: Partial<ChatFile> = {}): ChatFile {
  next++;
  return {
    id: (0x6b0000000000 + next).toString(16).padStart(24, "0"),
    runId: RUN,
    path: "guide.md",
    name: "guide.md",
    version: 1,
    size: 10,
    contentType: "text/markdown; charset=utf-8",
    createdAt: `2026-10-22T10:00:${String(next % 60).padStart(2, "0")}.000Z`,
    ...over,
  };
}

test("file lists parse strictly and drop malformed entries", () => {
  const good = file();
  const parsed = parseFiles({
    files: [
      good,
      { ...good, id: "nope" },
      { ...good, path: "" },
      { ...good, version: 0 },
      { ...good, size: -1 },
      null,
    ],
  });
  assert.deepEqual(parsed, [good]);
  assert.deepEqual(parseFiles({}), []);
  assert.deepEqual(parseFiles(null), []);
});

test("withFiles adds each version once, newest first", () => {
  const a = file({ createdAt: "2026-10-22T10:00:01.000Z" });
  const b = file({ createdAt: "2026-10-22T10:00:02.000Z", version: 2 });
  const list = withFiles([a], [b, a]);
  assert.deepEqual(
    list.map((f) => f.id),
    [b.id, a.id],
  );
  assert.equal(withFiles(list, [a]), list, "nothing new: same array");
});

test("a reply's files: the newest version of each path it stored", () => {
  const v1 = file({ version: 1, createdAt: "2026-10-22T10:00:01.000Z" });
  const v2 = file({ version: 2, createdAt: "2026-10-22T10:00:03.000Z" });
  const csv = file({
    path: "data/a.csv",
    name: "a.csv",
    createdAt: "2026-10-22T10:00:02.000Z",
  });
  const elsewhere = file({ runId: OTHER_RUN, path: "x.md" });
  assert.deepEqual(
    filesOfRun([v2, csv, v1, elsewhere], RUN).map((f) => [f.path, f.version]),
    [
      ["data/a.csv", 1],
      ["guide.md", 2],
    ],
  );
});

test("files by run: each reply's files in one pass, as filesOfRun gives them", () => {
  const v1 = file({ version: 1, createdAt: "2026-10-22T10:00:01.000Z" });
  const v2 = file({ version: 2, createdAt: "2026-10-22T10:00:03.000Z" });
  const csv = file({
    path: "data/a.csv",
    name: "a.csv",
    createdAt: "2026-10-22T10:00:02.000Z",
  });
  const other = file({ runId: OTHER_RUN, path: "x.md", name: "x.md" });
  const upload = file({ runId: OTHER_RUN, path: "in.pdf", upload: true });
  const all = [v2, other, csv, upload, v1];
  const byRun = filesByRun(all);
  assert.deepEqual([...byRun.keys()].sort(), [RUN, OTHER_RUN].sort());
  for (const runId of [RUN, OTHER_RUN])
    assert.deepEqual(byRun.get(runId), filesOfRun(all, runId));
  assert.deepEqual(
    byRun.get(OTHER_RUN)?.map((f) => f.path),
    ["x.md"],
    "the member's uploads are not the reply's files",
  );
  // A run with only uploads made no files and is absent, not an empty list.
  assert.equal(filesByRun([upload]).has(OTHER_RUN), false);
  assert.equal(filesByRun([]).size, 0);
});

test("previews by type; legacy office files and unknown ones are download-only", () => {
  assert.equal(previewKind("a.MD"), "markdown");
  assert.equal(previewKind("a.csv"), "csv");
  assert.equal(previewKind("index.html"), "html");
  assert.equal(previewKind("app.py"), "text");
  assert.equal(previewKind("chart.png"), "image");
  assert.equal(previewKind("plan.docx"), "docx");
  assert.equal(previewKind("plan.doc"), "none");
  assert.equal(previewKind("Makefile"), "none");
  assert.deepEqual(fileTag("plan.xlsx"), { label: "xlsx", tone: "xlsx" });
  assert.deepEqual(fileTag("Makefile"), { label: "file", tone: "md" });
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\nb"), 2);
  assert.equal(lineCount(""), 0);
});

test("CSV: quotes, doubled quotes, CRLF and a bounded grid", () => {
  const { rows, truncated } = parseCsv(
    'name,note\r\n"Smith, J","said ""hi"""\r\nLee,\n',
  );
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Smith, J", 'said "hi"'],
    ["Lee", ""],
  ]);
  assert.equal(truncated, false);
  const big = parseCsv(
    Array.from({ length: 600 }, (_, i) => `${i},x`).join("\n"),
  );
  assert.equal(big.rows.length, 500);
  assert.equal(big.truncated, true);
  const wide = parseCsv(Array.from({ length: 60 }, () => "c").join(","));
  assert.equal(wide.rows[0]!.length, 50);
  assert.equal(wide.truncated, true);
});

test("an HTML preview gets a policy that blocks all network access", () => {
  const doc = sandboxedHtml("<p>hi</p>");
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /default-src 'none'/);
  assert.ok(doc.endsWith("<p>hi</p>"));
});

test("a new file's text streams in order; a snapshot carries all of it", () => {
  const files = [{ path: "guide.md", kind: "add" }];
  const piece = (offset: number, text: string) => ({
    itemId: "call_f1",
    files,
    lines: 1,
    preview: { path: "guide.md", offset, text, truncated: false },
  });
  let reply = liveReply(RUN);
  const progress = (data: Record<string, unknown>) =>
    (reply = applyStreamEvent(reply, { type: "progress", data }));
  progress(piece(0, "# Gui"));
  progress(piece(5, "de\n"));
  const writing = () => reply.items[0] as FileChange;
  assert.equal(writing().preview?.text, "# Guide\n");
  // A gap (a piece that doesn't start where the text ends) is ignored.
  progress(piece(40, "lost"));
  assert.equal(writing().preview?.text, "# Guide\n");
  // Progress without text keeps the text so far.
  progress({ itemId: "call_f1", files, lines: 2 });
  assert.equal(writing().preview?.text, "# Guide\n");
  // A reconnect snapshot replaces it with the whole text.
  reply = applyStreamEvent(reply, {
    type: "snapshot",
    data: {
      runId: RUN,
      phase: "streaming",
      items: [],
      writing: [
        {
          ...piece(0, "# Guide\nBody\n"),
          preview: {
            path: "guide.md",
            offset: 0,
            text: "# Guide\nBody\n",
            truncated: false,
          },
        },
      ],
    },
  });
  assert.equal(writing().preview?.text, "# Guide\nBody\n");
  // Bounded: a piece past the limit is refused.
  progress(piece(13, "x".repeat(256 * 1024)));
  assert.equal(writing().preview?.text, "# Guide\nBody\n");
});

test("the files event adds the reply's stored versions once", () => {
  const stored = file();
  let reply = liveReply(RUN);
  reply = applyStreamEvent(reply, {
    type: "files",
    data: { files: [stored] },
  });
  reply = applyStreamEvent(reply, {
    type: "files",
    data: { files: [stored] },
  });
  assert.deepEqual(reply.files, [stored]);
  assert.equal(
    applyStreamEvent(reply, { type: "files", data: { files: "x" } }),
    reply,
  );
});

test("unsaved files: the files event and a saved run carry them, bounded", () => {
  let reply = liveReply(RUN);
  reply = applyStreamEvent(reply, {
    type: "files",
    data: {
      files: [],
      unsaved: ["plan.md", "", 7, "plan.md", "x".repeat(2000)],
    },
  });
  assert.deepEqual(reply.unsaved, ["plan.md"]);
  assert.deepEqual(reply.files, []);
  assert.deepEqual(
    parseUnsaved(Array.from({ length: 80 }, (_, i) => `f${i}.md`)).length,
    50,
  );
  assert.deepEqual(parseUnsaved("plan.md"), []);
  const run = parseRun({
    id: RUN,
    status: "completed",
    timings: { acceptedAt: "2026-10-22T09:00:00.000Z" },
    unsavedFiles: ["plan.md"],
  });
  assert.deepEqual(run?.unsavedFiles, ["plan.md"]);
  const clean = parseRun({
    id: RUN,
    status: "completed",
    timings: { acceptedAt: "2026-10-22T09:00:00.000Z" },
  });
  assert.equal(clean && "unsavedFiles" in clean, false);
});

test("the viewer: writing, then saving, then the stored version", () => {
  const target = { runId: RUN, path: "guide.md" };
  let reply = liveReply(RUN);
  reply = applyStreamEvent(reply, {
    type: "progress",
    data: {
      itemId: "call_f1",
      files: [{ path: "guide.md", kind: "add" }],
      lines: 1,
      preview: { path: "guide.md", offset: 0, text: "# G", truncated: false },
    },
  });
  assert.deepEqual(resolveSubject(target, [], reply), {
    state: "writing",
    path: "guide.md",
    text: "# G",
    truncated: false,
  });
  // The patch is applied: the change is done, the reply still running.
  reply = applyStreamEvent(reply, {
    type: "activity",
    data: {
      type: "file_change",
      itemId: "call_f1",
      files: [{ path: "guide.md", kind: "add" }],
      status: "completed",
    },
  });
  assert.deepEqual(resolveSubject(target, [], reply), {
    state: "saving",
    path: "guide.md",
  });
  const stored = file();
  assert.deepEqual(resolveSubject(target, [stored], reply), {
    state: "ready",
    file: stored,
  });
  // After the reply, a path it never stored.
  assert.deepEqual(resolveSubject({ runId: RUN, path: "x.md" }, [], null), {
    state: "missing",
    path: "x.md",
  });
  // An exact version wins over the newest.
  const v2 = file({ version: 2 });
  assert.deepEqual(
    resolveSubject({ ...target, fileId: stored.id }, [v2, stored], null),
    { state: "ready", file: stored },
  );
});

test("too-large files: the files event and a saved run carry them, bounded", () => {
  let reply = liveReply(RUN);
  reply = applyStreamEvent(reply, {
    type: "files",
    data: { files: [], unsaved: [], tooLarge: ["dump.sqlite", 3, ""] },
  });
  // A files event with only too-large files still reaches the reply.
  assert.deepEqual(reply.tooLarge, ["dump.sqlite"]);
  assert.deepEqual(reply.unsaved, []);
  const run = parseRun({
    id: RUN,
    status: "completed",
    timings: { acceptedAt: "2026-10-22T09:00:00.000Z" },
    tooLargeFiles: Array.from({ length: 80 }, (_, i) => `big${i}.bin`),
  });
  assert.equal(run?.tooLargeFiles?.length, 50);
  const clean = parseRun({
    id: RUN,
    status: "completed",
    timings: { acceptedAt: "2026-10-22T09:00:00.000Z" },
  });
  assert.equal(clean && "tooLargeFiles" in clean, false);
});

test("a cut-short file check reaches the reply and the saved run", () => {
  let reply = liveReply(RUN);
  assert.equal(reply.filesTruncated, false);
  reply = applyStreamEvent(reply, {
    type: "files",
    data: { files: [], unsaved: [], tooLarge: [], truncated: true },
  });
  // A files event with nothing but the flag still reaches the reply.
  assert.equal(reply.filesTruncated, true);
  // A later files event without it doesn't clear it.
  reply = applyStreamEvent(reply, {
    type: "files",
    data: { files: [], unsaved: ["a.md"], tooLarge: [] },
  });
  assert.equal(reply.filesTruncated, true);
  const run = parseRun({
    id: RUN,
    status: "completed",
    timings: { acceptedAt: "2026-10-22T09:00:00.000Z" },
    filesTruncated: true,
  });
  assert.equal(run?.filesTruncated, true);
  const odd = parseRun({
    id: RUN,
    status: "completed",
    timings: { acceptedAt: "2026-10-22T09:00:00.000Z" },
    filesTruncated: "yes",
  });
  assert.equal(odd && "filesTruncated" in odd, false);
});
