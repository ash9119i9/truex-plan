import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSendMessage,
  parseMessage,
  withPending,
} from "../lib/tenant-chat.ts";
import { filesOfRun, isImage, parseFiles } from "../lib/tenant-files.ts";
import {
  acceptList,
  fileProblem,
  filesNote,
  filesReady,
  parseAttachments,
  parseUploadSettings,
  pendingAttachments,
  previewSeeds,
  uploadIds,
  withDraftFile,
  UPLOADS_OFF,
  type DraftFile,
} from "../lib/tenant-uploads.ts";

const MB = 1024 * 1024;
const ON = parseUploadSettings({
  enabled: true,
  maxFileBytes: 20 * MB,
  maxFiles: 10,
  extensions: ["pdf", "docx", "xlsx", "txt"],
});
const ID = "6a0000000000000000000001";
const RUN = "6a0000000000000000000002";

const ready = (key: string, name = `${key}.pdf`): DraftFile => ({
  key,
  name,
  size: 10,
  state: "ready",
  uploadId: ID,
});
const uploading: DraftFile = {
  key: "u",
  name: "u.pdf",
  size: 1,
  state: "uploading",
};
const failed: DraftFile = {
  key: "f",
  name: "f.pdf",
  size: 1,
  state: "failed",
  error: "no",
};

test("settings: off unless the platform says on with usable limits", () => {
  assert.deepEqual(parseUploadSettings(null), UPLOADS_OFF);
  assert.deepEqual(parseUploadSettings({ enabled: false }), UPLOADS_OFF);
  assert.deepEqual(
    parseUploadSettings({
      enabled: true,
      maxFileBytes: 0,
      maxFiles: 10,
      extensions: ["pdf"],
    }),
    UPLOADS_OFF,
  );
  assert.deepEqual(
    parseUploadSettings({
      enabled: true,
      maxFileBytes: 1,
      maxFiles: 1,
      extensions: [],
    }),
    UPLOADS_OFF,
    "no known type is the same as off",
  );
  assert.equal(ON.enabled, true);
  // Bad entries are dropped; the file count never exceeds the platform's 10.
  const odd = parseUploadSettings({
    enabled: true,
    maxFileBytes: 5,
    maxFiles: 99,
    extensions: ["pdf", "../x", 4, "TXT", "docx"],
  });
  assert.deepEqual(odd.extensions, ["pdf", "docx"]);
  assert.equal(odd.maxFiles, 10);
  assert.equal(acceptList(ON), ".pdf,.docx,.xlsx,.txt");
});

test("a picked file is refused before upload for type, size, name and count", () => {
  assert.equal(fileProblem({ name: "a.pdf", size: 5 }, ON, 0), null);
  assert.equal(
    fileProblem({ name: "A.PDF", size: 5 }, ON, 0),
    null,
    "extension case",
  );
  assert.match(
    fileProblem({ name: "a.exe", size: 5 }, ON, 0)!,
    /can't be attached/,
  );
  assert.match(
    fileProblem({ name: "pdf", size: 5 }, ON, 0)!,
    /can't be attached/,
  );
  assert.match(fileProblem({ name: ".env.txt", size: 5 }, ON, 0)!, /Rename/);
  assert.match(fileProblem({ name: "a.pdf", size: 0 }, ON, 0)!, /empty/);
  assert.match(
    fileProblem({ name: "a.pdf", size: 20 * MB + 1 }, ON, 0)!,
    /at most 20 MB/,
  );
  assert.equal(
    fileProblem({ name: "a.pdf", size: 20 * MB }, ON, 0),
    null,
    "the limit itself",
  );
  assert.match(
    fileProblem({ name: "a.pdf", size: 5 }, ON, 10)!,
    /at most 10 files/,
  );
  assert.match(
    fileProblem({ name: "a.pdf", size: 5 }, UPLOADS_OFF, 0)!,
    /not available/,
  );
});

test("a message sends with text, files or both; never while files upload or into a running reply", () => {
  assert.equal(canSendMessage("hi", [], false), true);
  assert.equal(canSendMessage("  ", [], false), false);
  assert.equal(canSendMessage("", [ready("a")], false), true, "files alone");
  assert.equal(canSendMessage("hi", [ready("a"), uploading], false), false);
  assert.equal(canSendMessage("hi", [ready("a"), failed], false), false);
  assert.equal(
    canSendMessage("hi", [ready("a")], true),
    false,
    "files wait for the reply",
  );
  assert.equal(canSendMessage("hi", [], true), true, "text alone steers");
  assert.equal(canSendMessage("x".repeat(32_001), [ready("a")], false), false);
  assert.equal(filesReady([ready("a")]), true);
  assert.deepEqual(filesNote([ready("a"), uploading]), {
    text: "Uploading files…",
    problem: false,
  });
  assert.equal(filesNote([failed])!.problem, true);
  assert.match(filesNote([failed])!.text, /Remove/);
  // A failed file needs action, so it is shown over an upload in progress.
  assert.equal(filesNote([uploading, failed])!.problem, true);
  assert.equal(filesNote([ready("a")]), null);
});

test("draft files: IDs in order, removal, and what the pending message shows", () => {
  const list = [
    ready("a", "a.pdf"),
    uploading,
    { ...ready("b", "b.txt"), uploadId: RUN },
  ];
  assert.deepEqual(uploadIds(list), [ID, RUN]);
  assert.deepEqual(
    pendingAttachments(list).map((a) => a.path),
    ["uploads/a.pdf", "uploads/b.txt"],
  );
  assert.deepEqual(
    withDraftFile(list, "u", null).map((f) => f.key),
    ["a", "b"],
  );
  const swapped = withDraftFile(list, "u", ready("u"));
  assert.equal(swapped[1]!.state, "ready");
  assert.equal(swapped.length, 3);
});

test("saved user messages carry their attachments; bad ones are dropped", () => {
  const base = {
    id: ID,
    seq: 1,
    runId: RUN,
    role: "user",
    text: "",
    createdAt: "2026-10-23T00:00:00.000Z",
  };
  const good = {
    fileId: ID,
    name: "report.docx",
    path: "uploads/report.docx",
    size: 1200,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const message = parseMessage({
    ...base,
    attachments: [
      good,
      { ...good, fileId: "nope" },
      { ...good, path: "../etc" },
    ],
  });
  assert.deepEqual(message?.attachments, [good]);
  // Only a user message has them.
  assert.equal(
    parseMessage({ ...base, role: "assistant", attachments: [good] })
      ?.attachments,
    undefined,
  );
  assert.equal(parseMessage(base)?.attachments, undefined);
  assert.equal(parseAttachments(Array(20).fill(good)).length, 10);
});

test("a pending message shows its files; uploads are not a reply's files", () => {
  const thread = {
    chat: { id: ID } as never,
    messages: [],
    runs: {},
    hasMore: false,
  };
  const shown = withPending(thread, {
    key: ID,
    text: "",
    clientMessageId: "c1",
    since: 0,
    attachments: pendingAttachments([ready("a", "a.pdf")]),
  });
  assert.equal(shown.messages[0]!.attachments?.[0]?.name, "a.pdf");

  const files = parseFiles({
    files: [
      {
        id: ID,
        runId: RUN,
        path: "uploads/a.pdf",
        version: 1,
        size: 3,
        source: "upload",
        createdAt: "a",
      },
      {
        id: RUN,
        runId: RUN,
        path: "summary.md",
        version: 1,
        size: 3,
        createdAt: "b",
      },
    ],
  });
  assert.equal(files[0]!.upload, true);
  assert.deepEqual(
    filesOfRun(files, RUN).map((f) => f.path),
    ["summary.md"],
  );
});

test("a sent image keeps its bytes until saved, then seeds its saved version", () => {
  const png = new Blob(["png"]);
  const jpg = new Blob(["jpg"]);
  const sent: DraftFile[] = [
    { ...ready("a", "a.png"), preview: png },
    ready("b", "b.pdf"),
    { ...ready("c", "c.jpg"), preview: jpg },
  ];
  // Pending: images carry their bytes, other files don't.
  const pending = pendingAttachments(sent);
  assert.equal(pending[0]!.preview, png);
  assert.equal("preview" in pending[1]!, false);
  // Saved in the order sent: each image pairs with its saved version.
  const saved = sent.map((f, i) => ({
    fileId: `6a000000000000000000001${i}`,
    name: f.name,
    path: `uploads/${f.name}`,
    size: f.size,
    contentType: "",
  }));
  assert.deepEqual(previewSeeds(sent, saved), [
    { fileId: saved[0]!.fileId, blob: png },
    { fileId: saved[2]!.fileId, blob: jpg },
  ]);
  // Any mismatch pairs nothing: a missing file, a changed size, no ID.
  assert.deepEqual(previewSeeds(sent, saved.slice(1)), []);
  assert.deepEqual(
    previewSeeds(
      sent,
      saved.map((a, i) => (i ? a : { ...a, size: 11 })),
    ),
    [],
  );
  assert.deepEqual(
    previewSeeds(
      sent,
      saved.map((a, i) => (i ? a : { ...a, fileId: "" })),
    ),
    [],
  );
  // Files still uploading or failed aren't sent, so aren't paired.
  assert.deepEqual(
    previewSeeds(
      [...sent, { key: "u", name: "u.png", size: 1, state: "uploading" }],
      saved,
    ).length,
    2,
  );
});

test("only raster images get a picture preview", () => {
  for (const name of ["a.png", "B.JPG", "c.jpeg", "d.gif", "e.webp"])
    assert.equal(isImage(name), true, name);
  for (const name of ["f.svg", "g.pdf", "png", "h.png.txt"])
    assert.equal(isImage(name), false, name);
});
