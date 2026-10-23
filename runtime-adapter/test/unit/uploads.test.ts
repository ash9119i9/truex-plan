import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { AdapterError } from "../../src/errors";
import { chatWorkspace, MAX_FILE_BYTES } from "../../src/runtime/files";
import { checkedUploadName, writeUpload } from "../../src/runtime/uploads";

const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("uploads into the workspace", () => {
  let root = "";
  let ws = "";
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "adapter-uploads-"));
    ws = chatWorkspace(root, { tenantId: "t1", chatId: "c1" });
  });
  after(() => rm(root, { recursive: true, force: true }));

  test("writes uploads/<name>, creating the workspace, and replaces an earlier file", async () => {
    const first = await writeUpload(
      ws,
      "Report Q3.docx",
      sha("one"),
      Readable.from([Buffer.from("one")]),
    );
    assert.equal(first.path, "uploads/Report Q3.docx");
    assert.equal(first.size, 3);
    assert.ok(Number.isSafeInteger(first.modifiedAt));
    const again = await writeUpload(
      ws,
      "Report Q3.docx",
      sha("second"),
      Readable.from([Buffer.from("sec"), Buffer.from("ond")]),
    );
    assert.equal(again.size, 6);
    assert.equal(
      await readFile(join(ws, "uploads", "Report Q3.docx"), "utf8"),
      "second",
    );
    // No temporary file is left behind.
    assert.deepEqual(await readdir(join(ws, "uploads")), ["Report Q3.docx"]);
  });

  test("a body that doesn't match its sha256 leaves nothing", async () => {
    await refused(
      writeUpload(ws, "a.txt", sha("other"), Readable.from([Buffer.from("a")])),
      "INVALID_REQUEST",
    );
    await refused(
      writeUpload(ws, "a.txt", "nothex", Readable.from([Buffer.from("a")])),
      "INVALID_REQUEST",
    );
    assert.deepEqual(await readdir(join(ws, "uploads")), ["Report Q3.docx"]);
  });

  test("a body over the file limit is refused and removed", async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1);
    await refused(
      writeUpload(ws, "big.bin", sha(big), Readable.from([big])),
      "PAYLOAD_TOO_LARGE",
    );
    assert.deepEqual(await readdir(join(ws, "uploads")), ["Report Q3.docx"]);
  });

  test("names must be one visible path segment", () => {
    for (const name of [
      "",
      ".env",
      "..",
      "a/b.txt",
      "..\\x",
      "a\u0000b",
      "a\nb",
      "evil\u202Etxt.exe",
      " padded.txt",
      "x".repeat(256),
      "e\u0301.txt", // not NFC
    ])
      assert.throws(() => checkedUploadName(name), AdapterError, name);
    assert.equal(checkedUploadName("Résumé (final).pdf"), "Résumé (final).pdf");
  });

  test("an uploads folder replaced by a symlink is never followed", async () => {
    const other = chatWorkspace(root, { tenantId: "t1", chatId: "c2" });
    await mkdir(other, { recursive: true });
    const ws3 = chatWorkspace(root, { tenantId: "t1", chatId: "c3" });
    await mkdir(ws3, { recursive: true });
    await symlink(other, join(ws3, "uploads"));
    await refused(
      writeUpload(ws3, "a.txt", sha("a"), Readable.from([Buffer.from("a")])),
      "UPLOAD_CONFLICT",
    );
    assert.deepEqual(await readdir(other), []);
  });

  test("a folder with the file's name is a conflict, not overwritten", async () => {
    await mkdir(join(ws, "uploads", "notes.md"));
    await writeFile(join(ws, "uploads", "notes.md", "keep.txt"), "keep");
    await refused(
      writeUpload(ws, "notes.md", sha("x"), Readable.from([Buffer.from("x")])),
      "UPLOAD_CONFLICT",
    );
    assert.equal(
      await readFile(join(ws, "uploads", "notes.md", "keep.txt"), "utf8"),
      "keep",
    );
  });
});
